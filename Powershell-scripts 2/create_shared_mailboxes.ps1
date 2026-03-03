param(
    $CsvPath,
    $AdminEmail,
    $AdminPassword
)

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

# Rest of the script remains the same
$mailboxes = Import-Csv -Path $CsvPath
$counter = 1

foreach ($mailbox in $mailboxes) {
    $displayName = $mailbox.DisplayName
    $emailAddress = $mailbox.EmailAddress
    
    $uniqueDisplayName = "$displayName $counter"
    $counter++
    
    if ($emailAddress) {
        Write-Host "Creating mailbox for $uniqueDisplayName with email $emailAddress"
        
        try {
            New-Mailbox -Name $uniqueDisplayName -Shared -PrimarySmtpAddress $emailAddress -DisplayName $uniqueDisplayName -ErrorAction Stop
        }
        catch {
            Write-Warning "Failed to create mailbox for $uniqueDisplayName with error: $_"
            Write-Warning "Error details: $($_.Exception.ToString())"
            Write-Warning "Stack trace: $($_.ScriptStackTrace)"
        }
    }
    else {
        Write-Warning "Skipping mailbox creation for $displayName due to missing email address."
    }
}

# Disconnect from Exchange Online
Disconnect-ExchangeOnline -Confirm:$false