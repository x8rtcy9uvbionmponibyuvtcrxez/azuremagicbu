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

# Import the CSV file
$users = Import-Csv -Path $CsvPath

Write-Host "Processing $($users.Count) users from CSV..." -ForegroundColor Cyan

foreach ($user in $users) {
    $emailAddress = $user.EmailAddress
    $password = $user.password

    Write-Host "`nProcessing: $emailAddress" -ForegroundColor Yellow

    try {
        # Find the user object by UserPrincipalName (email address)
        $filter = "userPrincipalName eq '$emailAddress'"
        $matchedUsers = @(Get-MgUser -Filter $filter -ErrorAction Stop)

        # Log the count of users found
        Write-Host "  Found users: $($matchedUsers.Count)" -ForegroundColor Cyan

        if ($matchedUsers -and $matchedUsers.Count -eq 1) {
            $matchedUser = $matchedUsers[0]

            # Validate that the user has an Id
            if (-not $matchedUser.Id) {
                Write-Host "  Warning: User Id is empty for $emailAddress" -ForegroundColor Yellow
                continue
            }

            Write-Host "  User Id: $($matchedUser.Id)" -ForegroundColor White

            # Reset the user's password using Microsoft Graph
            # Create password profile
            $passwordProfile = @{
                Password = $password
                ForceChangePasswordNextSignIn = $false
            }

            try {
                Update-MgUser -UserId $matchedUser.Id -PasswordProfile $passwordProfile -ErrorAction Stop
                Write-Host "  Password reset for $emailAddress" -ForegroundColor Green
            }
            catch {
                Write-Host "  Failed to reset password for $emailAddress : $_" -ForegroundColor Red
            }
        }
        elseif ($matchedUsers -and $matchedUsers.Count -gt 1) {
            Write-Host "  Warning: Multiple users found for $emailAddress" -ForegroundColor Yellow
        }
        else {
            Write-Host "  Warning: User not found for email address: $emailAddress" -ForegroundColor Yellow
        }
    }
    catch {
        Write-Host "  Error finding user $emailAddress : $_" -ForegroundColor Red
    }
}

# Disconnect from Microsoft Graph
Disconnect-MgGraph

Write-Host "`nPassword reset operation completed." -ForegroundColor Green
