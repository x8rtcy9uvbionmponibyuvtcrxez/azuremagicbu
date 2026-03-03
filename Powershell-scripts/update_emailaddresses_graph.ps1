param(
    $CsvPath,
    $TenantId  # Tenant ID required for Microsoft Graph authentication
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

# Define the log file path
$logPath = "$env:USERPROFILE\Desktop\PowershellScripts\MgGraphUpdateLog.txt"

# Check if log file path's directory exists; if not, create it
$logDir = Split-Path -Path $logPath -Parent
if (-not (Test-Path -Path $logDir)) {
    New-Item -ItemType Directory -Path $logDir
}

# Load users from CSV
$users = Import-Csv -Path $CsvPath

# Loop through each user in the CSV
foreach ($user in $users) {
    try {
        # Since all 99 mailboxes have the same DisplayName, we need to search by unique identifiers
        # Try searching by UserPrincipalName or Mail (EmailAddress should be unique)
        # Note: For shared mailboxes with numbers in display name, the mail should be unique

        # First, try to find by UserPrincipalName (which should match EmailAddress)
        $filter = "userPrincipalName eq '$($user.EmailAddress)'"

        # Get user - do NOT use -Property parameter, it causes Id to be null
        # Instead, let Graph return default properties which includes Id
        $matchedUsers = @(Get-MgUser -Filter $filter -ErrorAction Stop)

        # If not found by UPN, try by Mail
        if (-not $matchedUsers -or $matchedUsers.Count -eq 0) {
            Write-Host "Not found by UPN, trying by Mail for $($user.EmailAddress)" -ForegroundColor Yellow
            $filter = "mail eq '$($user.EmailAddress)'"
            $matchedUsers = @(Get-MgUser -Filter $filter -ErrorAction Stop)
        }

        # Log the count of users found
        Write-Host "Found users: $($matchedUsers.Count) for $($user.EmailAddress)" -ForegroundColor Cyan

        # Check if exactly one user is found
        if ($matchedUsers -and $matchedUsers.Count -eq 1) {
            $matchedUser = $matchedUsers[0]

            # Validate that the user has an Id
            if (-not $matchedUser.Id) {
                "User found but 'Id' is null or empty for $($user.DisplayName) / $($user.EmailAddress)." | Out-File -FilePath $logPath -Append
                Write-Host "Warning: User Id is empty for $($user.DisplayName)" -ForegroundColor Yellow
                continue
            }

            Write-Host "  User Id: $($matchedUser.Id)" -ForegroundColor White

            # Update the UserPrincipalName and MailNickname to match the EmailAddress
            try {
                $mailNickname = $user.EmailAddress.Split('@')[0]

                # Update user properties
                Update-MgUser -UserId $matchedUser.Id -UserPrincipalName $user.EmailAddress -MailNickname $mailNickname -ErrorAction Stop

                "Successfully updated UPN and MailNickname for $($user.DisplayName) to match $($user.EmailAddress)" | Out-File -FilePath $logPath -Append
                Write-Host "Updated: $($user.DisplayName) -> $($user.EmailAddress)" -ForegroundColor Green
            }
            catch {
                "Failed to update UPN and MailNickname for $($user.DisplayName) with error: $_" | Out-File -FilePath $logPath -Append
                Write-Host "Failed: $($user.DisplayName) - $_" -ForegroundColor Red
            }
        }
        elseif ($matchedUsers -and $matchedUsers.Count -gt 1) {
            "Multiple users found for EmailAddress: $($user.EmailAddress). Manual review required." | Out-File -FilePath $logPath -Append
            Write-Host "Warning: Multiple users found for $($user.EmailAddress)" -ForegroundColor Yellow
        }
        else {
            "No matching user found for EmailAddress: $($user.EmailAddress)." | Out-File -FilePath $logPath -Append
            Write-Host "Warning: No user found for $($user.EmailAddress)" -ForegroundColor Yellow
        }
    }
    catch {
        "Failed to find user: $($user.DisplayName) / $($user.EmailAddress) with error: $_" | Out-File -FilePath $logPath -Append
        Write-Host "Error processing $($user.DisplayName): $_" -ForegroundColor Red
    }
}

# Disconnect from Microsoft Graph
Disconnect-MgGraph

# Inform the user about the log
Write-Host "The operation has completed. Please check the log file at $logPath for details."
