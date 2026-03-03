param(
    $TenantId,  # Tenant ID required for Microsoft Graph authentication
    $AdminEmail,
    $AdminPassword
)

# Import credential module
Import-Module (Join-Path $PSScriptRoot "CredentialModule.psm1") -Force

# Get Graph credentials from .env
$graphCreds = Get-GraphCredentials

# Function to establish Microsoft Graph connection with retry using access token
function Connect-MgGraphWithRetry {
    param(
        $TenantId,
        $MaxRetries = 3,
        $RetryDelay = 5
    )

    # Get credentials from parent scope
    $clientId = $script:graphCreds.ClientId
    $clientSecret = $script:graphCreds.ClientSecret

    $retryCount = 0
    while ($retryCount -lt $MaxRetries) {
        try {
            Write-Host "Attempting to get access token..." -ForegroundColor White

            # Use Client Credentials flow (same as script1_future.ps1)
            $body = @{
                grant_type    = "client_credentials"
                client_id     = $clientId
                client_secret = $clientSecret
                scope         = "https://graph.microsoft.com/.default"
            }

            # Get access token
            $tokenUrl = "https://login.microsoftonline.com/$TenantId/oauth2/v2.0/token"
            $response = Invoke-RestMethod -Uri $tokenUrl -Method POST -Body $body -ErrorAction Stop
            $accessToken = $response.access_token

            # Convert the access token to a SecureString
            $secureAccessToken = ConvertTo-SecureString $accessToken -AsPlainText -Force

            # Use the SecureString with Connect-MgGraph
            Connect-MgGraph -AccessToken $secureAccessToken -NoWelcome -ErrorAction Stop

            Write-Host "Connected to Microsoft Graph successfully." -ForegroundColor Green
            return
        }
        catch {
            Write-Warning "Failed to connect to Microsoft Graph. Retrying in $RetryDelay seconds... (Attempt $($retryCount + 1)/$MaxRetries)"
            Write-Warning "Error: $_"
            Start-Sleep -Seconds $RetryDelay
            $retryCount++
        }
    }

    Write-Error "Failed to connect to Microsoft Graph after $MaxRetries attempts. Please check your credentials and try again."
    exit
}

# Connect to Microsoft Graph with retry
Connect-MgGraphWithRetry -TenantId $TenantId

# Retrieve all licensed users using Microsoft Graph
Write-Host "`nRetrieving licensed users from Microsoft Graph..." -ForegroundColor Cyan
try {
    # Get all users with assigned licenses
    $licensedUsers = @(Get-MgUser -All -Property "Id,UserPrincipalName,AssignedLicenses" -ErrorAction Stop | Where-Object { $_.AssignedLicenses.Count -gt 0 })
    Write-Host "Found $($licensedUsers.Count) licensed user(s)" -ForegroundColor Green
}
catch {
    Write-Host "Error retrieving licensed users: $_" -ForegroundColor Red
    Disconnect-MgGraph
    exit
}

# Ensure there is at least one licensed user
if ($licensedUsers.Count -lt 1) {
    Write-Host "Not enough licensed users found. Exiting script." -ForegroundColor Red
    Disconnect-MgGraph
    exit
}

Write-Host "`nLicensed users:" -ForegroundColor White
foreach ($user in $licensedUsers) {
    Write-Host "  - $($user.UserPrincipalName)" -ForegroundColor White
}

# Connect to Exchange Online for mailbox operations using password authentication
Write-Host "`nConnecting to Exchange Online for mailbox delegation..." -ForegroundColor Yellow

try {
    $SecurePassword = ConvertTo-SecureString -String $AdminPassword -AsPlainText -Force
    $Credential = New-Object -TypeName System.Management.Automation.PSCredential -ArgumentList $AdminEmail, $SecurePassword
    Connect-ExchangeOnline -Credential $Credential -ShowBanner:$false -ErrorAction Stop
    Write-Host "Connected to Exchange Online successfully" -ForegroundColor Green
}
catch {
    Write-Error "Failed to connect to Exchange Online. Error: $_"
    Disconnect-MgGraph
    exit
}

# Retrieve all shared mailboxes
Write-Host "`nRetrieving shared mailboxes..." -ForegroundColor Cyan
try {
    $sharedMailboxes = Get-EXOMailbox -ResultSize Unlimited -RecipientTypeDetails SharedMailbox -ErrorAction Stop
    Write-Host "Found $($sharedMailboxes.Count) shared mailbox(es)" -ForegroundColor Green
}
catch {
    Write-Host "Error retrieving shared mailboxes: $_" -ForegroundColor Red
    Disconnect-MgGraph
    Disconnect-ExchangeOnline -Confirm:$false
    exit
}

# Check if there are shared mailboxes to delegate
if ($sharedMailboxes.Count -eq 0) {
    Write-Host "No shared mailboxes found. Exiting script." -ForegroundColor Yellow
    Disconnect-MgGraph
    Disconnect-ExchangeOnline -Confirm:$false
    exit
}

Write-Host "`nShared mailboxes:" -ForegroundColor White
foreach ($mailbox in $sharedMailboxes) {
    Write-Host "  - $($mailbox.PrimarySmtpAddress)" -ForegroundColor White
}

# Hashtable to track delegated mailbox count for each licensed user
$delegationSummary = @{}

# Delegate shared mailboxes to a licensed user with the same domain
Write-Host "`nStarting delegation process..." -ForegroundColor Cyan

foreach ($mailbox in $sharedMailboxes) {
    $mailboxDomain = $mailbox.PrimarySmtpAddress.Split("@")[1]
    $licensedUser = $licensedUsers | Where-Object { $_.UserPrincipalName.Split("@")[1] -eq $mailboxDomain } | Select-Object -First 1

    if ($licensedUser) {
        Write-Host "`nDelegating $($mailbox.UserPrincipalName) to $($licensedUser.UserPrincipalName)..." -ForegroundColor Yellow

        try {
            # Add Full Access permission
            Add-MailboxPermission -Identity $mailbox.UserPrincipalName -User $licensedUser.UserPrincipalName -AccessRights FullAccess -AutoMapping:$true -ErrorAction Stop
            Write-Host "  Full Access granted" -ForegroundColor Green

            # Add Send As permission
            Add-RecipientPermission -Identity $mailbox.UserPrincipalName -Trustee $licensedUser.UserPrincipalName -AccessRights SendAs -Confirm:$false -ErrorAction Stop
            Write-Host "  Send As granted" -ForegroundColor Green

            # Add Send on Behalf permission
            Set-Mailbox -Identity $mailbox.UserPrincipalName -GrantSendOnBehalfTo $licensedUser.UserPrincipalName -ErrorAction Stop
            Write-Host "  Send on Behalf granted" -ForegroundColor Green

            Write-Host "  Successfully delegated permissions for $($mailbox.UserPrincipalName) to $($licensedUser.UserPrincipalName)" -ForegroundColor Green

            # Update delegation summary
            if ($delegationSummary.ContainsKey($licensedUser.UserPrincipalName)) {
                $delegationSummary[$licensedUser.UserPrincipalName] += 1
            } else {
                $delegationSummary[$licensedUser.UserPrincipalName] = 1
            }
        }
        catch {
            Write-Host "  Failed to delegate permissions for $($mailbox.UserPrincipalName) to $($licensedUser.UserPrincipalName): $_" -ForegroundColor Red
        }
    }
    else {
        Write-Host "`nNo licensed user found for domain $mailboxDomain. Skipping $($mailbox.UserPrincipalName)." -ForegroundColor Yellow
    }
}

# Disconnect from services
Write-Host "`nDisconnecting from services..." -ForegroundColor Yellow
Disconnect-MgGraph
Disconnect-ExchangeOnline -Confirm:$false

# Display summary
Write-Host "`n========================================" -ForegroundColor Cyan
Write-Host "DELEGATION SUMMARY" -ForegroundColor Cyan
Write-Host "========================================" -ForegroundColor Cyan

if ($delegationSummary.Count -gt 0) {
    foreach ($user in $delegationSummary.Keys) {
        Write-Host "${user}: $($delegationSummary[$user]) shared mailbox(es) delegated." -ForegroundColor Green
    }
} else {
    Write-Host "No delegations were completed." -ForegroundColor Yellow
}

Write-Host "`nBulk delegation process completed." -ForegroundColor Green
