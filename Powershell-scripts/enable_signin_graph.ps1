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

            # Use Client Credentials flow
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

# Connect to Microsoft Graph
Connect-MgGraphWithRetry -TenantId $TenantId

# Import the CSV file
Write-Host "`nImporting CSV from: $CsvPath" -ForegroundColor Cyan
try {
    $users = Import-Csv -Path $CsvPath -ErrorAction Stop
    Write-Host "Successfully imported $($users.Count) users from CSV" -ForegroundColor Green
}
catch {
    Write-Host "Error importing CSV file: $_" -ForegroundColor Red
    Disconnect-MgGraph
    exit
}

# Process each user in the CSV
$successCount = 0
$failureCount = 0

Write-Host "`nEnabling sign-in for mailboxes..." -ForegroundColor Cyan

foreach ($user in $users) {
    $emailAddress = $user.EmailAddress

    Write-Host "`nProcessing: $emailAddress" -ForegroundColor Yellow

    try {
        # Search for the user by userPrincipalName (primary) or mail (fallback)
        $filter = "userPrincipalName eq '$emailAddress'"
        $matchedUsers = @(Get-MgUser -Filter $filter -ErrorAction Stop)

        # Fallback to mail if userPrincipalName didn't find the user
        if (-not $matchedUsers -or $matchedUsers.Count -eq 0) {
            Write-Host "  User not found by userPrincipalName, trying mail filter..." -ForegroundColor Yellow
            $filter = "mail eq '$emailAddress'"
            $matchedUsers = @(Get-MgUser -Filter $filter -ErrorAction Stop)
        }

        # Check if user was found
        if (-not $matchedUsers -or $matchedUsers.Count -eq 0) {
            Write-Host "  User not found in directory: $emailAddress" -ForegroundColor Red
            $failureCount++
            continue
        }

        if ($matchedUsers.Count -gt 1) {
            Write-Host "  Warning: Multiple users found for $emailAddress. Using first match." -ForegroundColor Yellow
        }

        $matchedUser = $matchedUsers[0]

        # Validate that User Id is not empty
        if (-not $matchedUser.Id) {
            Write-Host "  Warning: User Id is empty for $emailAddress. Skipping." -ForegroundColor Yellow
            $failureCount++
            continue
        }

        # Enable sign-in for the user
        Update-MgUser -UserId $matchedUser.Id -AccountEnabled:$true -ErrorAction Stop
        Write-Host "  Sign-in enabled for $emailAddress" -ForegroundColor Green
        $successCount++
    }
    catch {
        Write-Host "  Error enabling sign-in for ${emailAddress}: $_" -ForegroundColor Red
        $failureCount++
    }
}

# Disconnect from Microsoft Graph
Write-Host "`nDisconnecting from Microsoft Graph..." -ForegroundColor Yellow
Disconnect-MgGraph

# Display summary
Write-Host "`n========================================" -ForegroundColor Cyan
Write-Host "SIGN-IN ENABLEMENT SUMMARY" -ForegroundColor Cyan
Write-Host "========================================" -ForegroundColor Cyan
Write-Host "Total users processed: $($users.Count)" -ForegroundColor White
Write-Host "Successfully enabled: $successCount" -ForegroundColor Green
Write-Host "Failed: $failureCount" -ForegroundColor Red
Write-Host "`nSign-in enablement process completed." -ForegroundColor Green
