param(
    $domainName,
    $AdminEmail,
    $AdminPassword
)

# Add the domain using MgGraph
Write-Host "Adding domain $domainName to tenant..." -ForegroundColor Yellow
$params = @{ id = $domainName }
try {
    New-MgDomain -BodyParameter $params | Out-Null
    Write-Host "Domain $domainName added successfully." -ForegroundColor Green
} catch {
    if ($_.Exception.Message -like "*domain already exists*") {
        Write-Host "Domain $domainName already exists in the tenant." -ForegroundColor Yellow
    } else {
        Write-Error "Failed to add domain $domainName to tenant. Error: $_"
    }
}

# Retrieve the TXT record using MgGraph
$dnsRecords = Get-MgDomainVerificationDnsRecord -DomainId $domainName
$txtRecord = $dnsRecords | Where-Object { $_.RecordType -eq "TXT" }
$txtRecordValue = $txtRecord.AdditionalProperties['text']

python .\update_txt.py $domainName $txtRecordValue

Write-Host "Attempting to verify domain $domainName... in 10 seconds" -ForegroundColor Yellow
Start-Sleep -Seconds 10

Write-Host "Attempting to verify domain $domainName..." -ForegroundColor Yellow

$verificationRetries = 5
$verified = $false
    
for ($i = 0; $i -lt $verificationRetries; $i++) {
    try {
        Confirm-MgDomain -DomainId $domainName
        $verified = $true
        Write-Host "Domain $domainName verified successfully!" -ForegroundColor Green
        break
    } catch {
        Write-Warning "Verification attempt $($i+1) failed. Waiting 15 seconds before retry..."
        Start-Sleep -Seconds 15
    }
}

if (-not $verified) {
    Write-Error "Domain verification failed for $domainName."
}

$params = @{
	isDefault = $true
}

try {
    Update-MgDomain -DomainId $domainName -BodyParameter $params
    Write-Host "$domainName set as default domain successfully." -ForegroundColor Green
}
catch {
    Write-Error "Failed to set $domainName as default domain"
}

# Import ExchangeOnlineManagement module (version 3.7.1 required - NOT 3.7.2!)
Import-Module ExchangeOnlineManagement -RequiredVersion 3.7.1 -ErrorAction Stop

# Connect to Exchange Online
try {
    Write-Host "Connecting to Exchange Online..." -ForegroundColor Yellow
    $SecurePassword = ConvertTo-SecureString -String $AdminPassword -AsPlainText -Force
    $Credential = New-Object -TypeName System.Management.Automation.PSCredential -ArgumentList $AdminEmail, $SecurePassword
    Connect-ExchangeOnline -Credential $Credential -ShowBanner:$false -ErrorAction Stop
    Write-Host "Connected to Exchange Online successfully!" -ForegroundColor Green
}
catch {
    Write-Error "Failed to connect to Exchange Online. Error: $_"
    Write-Host ""
    Write-Host "If you see broker errors, you may have version 3.7.2 installed (broken)." -ForegroundColor Yellow
    Write-Host "Run: .\DOWNGRADE_TO_3.7.1.ps1 to fix." -ForegroundColor Yellow
    exit
}

try {
    Set-TransportConfig -SmtpClientAuthenticationDisabled $false
    Write-Host "SMTP Auth enabled successfully" -ForegroundColor Green
}
catch {
    Write-Host "Error enabling SMTP AUTH" -ForegroundColor Yellow
}

# Enable DKIM
Write-Host "Configuring DKIM for $domainName..." -ForegroundColor Yellow

try {
    # Create DKIM config (this will create if doesn't exist, or return warning if already exists)
    $newConfig = New-DkimSigningConfig -DomainName $domainName -Enabled $false -ErrorAction SilentlyContinue

    Write-Host "DKIM configuration created for $domainName" -ForegroundColor Green

    # Get the DKIM config to retrieve selector values
    $dkimConfig = Get-DkimSigningConfig -Identity $domainName

    $selector1Value = $dkimConfig.Selector1CNAME
    $selector2Value = $dkimConfig.Selector2CNAME

    Write-Host "DKIM Selectors retrieved:" -ForegroundColor Cyan
    Write-Host "  Selector1: $selector1Value" -ForegroundColor White
    Write-Host "  Selector2: $selector2Value" -ForegroundColor White

    # Disconnect from Exchange Online before calling Python
    Disconnect-ExchangeOnline -Confirm:$false

    # Call Python script to add DKIM records to Cloudflare
    Write-Host "Adding DKIM CNAME records to Cloudflare..." -ForegroundColor Yellow
    python .\update_dkim.py $domainName $selector1Value $selector2Value

    # Reconnect to Exchange Online to enable DKIM
    Write-Host "Reconnecting to Exchange Online to enable DKIM..." -ForegroundColor Yellow
    $SecurePassword = ConvertTo-SecureString -String $AdminPassword -AsPlainText -Force
    $Credential = New-Object -TypeName System.Management.Automation.PSCredential -ArgumentList $AdminEmail, $SecurePassword
    Connect-ExchangeOnline -Credential $Credential -ShowBanner:$false -ErrorAction Stop

    # Wait for DNS propagation
    Write-Host "Waiting 15 seconds for DNS propagation..." -ForegroundColor Yellow
    Start-Sleep -Seconds 15

    # Enable DKIM signing
    Set-DkimSigningConfig -Identity $domainName -Enabled $true

    # Verify DKIM is enabled
    $dkimStatus = Get-DkimSigningConfig -Identity $domainName

    if ($dkimStatus.Enabled) {
        Write-Host "DKIM enabled successfully for $domainName!" -ForegroundColor Green
    }
    else {
        Write-Host "DKIM config created but not enabled. DNS records may need time to propagate." -ForegroundColor Yellow
    }
}
catch {
    Write-Host "Error configuring DKIM: $_" -ForegroundColor Yellow
    Write-Host "This is non-critical - continuing..." -ForegroundColor Yellow
}

# Disconnect from Exchange Online
Disconnect-ExchangeOnline -Confirm:$false