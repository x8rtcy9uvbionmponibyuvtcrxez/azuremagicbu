# Assign Cloud Application Administrator Role to All Shared Mailboxes
# This script can be run standalone or called by another script with parameters

param(
    [string]$AdminEmail,
    [string]$AdminPassword,
    [string]$TenantID,
    [string]$TenantName
)

# Import required modules
Import-Module ExchangeOnlineManagement -RequiredVersion 3.7.1 -ErrorAction Stop
Import-Module (Join-Path $PSScriptRoot "CredentialModule.psm1") -Force

# Get Graph credentials from .env
$graphCreds = Get-GraphCredentials

# Step 1: Get credentials (either from parameters or prompt)
Write-Host "========================================" -ForegroundColor Cyan
Write-Host "CLOUD APPLICATION ADMINISTRATOR ROLE ASSIGNMENT" -ForegroundColor Cyan
Write-Host "========================================" -ForegroundColor Cyan
Write-Host ""

# If parameters not provided, retrieve from monday.com
if (-not $AdminEmail -or -not $AdminPassword -or -not $TenantID) {
    # Prompt for tenant name if not provided
    if (-not $TenantName) {
        $TenantName = Read-Host "Enter Tenant name"
    }

    # Call the Python script to get credentials
    Write-Host "`nRetrieving tenant credentials from Airtable..." -ForegroundColor Yellow
    $pythonScriptPath = Join-Path $PSScriptRoot "retrieve_domain_credentials_airtable.py"

    try {
        $jsonOutput = python $pythonScriptPath $TenantName
        $credentials = $jsonOutput | ConvertFrom-Json

        if ($credentials.error) {
            Write-Error "Error retrieving credentials: $($credentials.error)"
            exit 1
        }

        # Extract credentials
        $AdminEmail = $credentials.AdminEmail
        $AdminPassword = $credentials.AdminPassword
        $TenantID = $credentials.TenantID
        $DomainName = $credentials.domainName

        Write-Host "Successfully retrieved credentials for tenant: $TenantName" -ForegroundColor Green
        Write-Host "  Domain: $DomainName" -ForegroundColor White
        Write-Host "  Admin Email: $AdminEmail" -ForegroundColor White
        Write-Host "  Tenant ID: $TenantID" -ForegroundColor White
    }
    catch {
        Write-Error "Failed to retrieve credentials from Airtable: $_"
        exit 1
    }
}
else {
    Write-Host "Using provided credentials" -ForegroundColor Green
    if ($TenantName) {
        Write-Host "  Tenant: $TenantName" -ForegroundColor White
    }
    Write-Host "  Admin Email: $AdminEmail" -ForegroundColor White
    Write-Host "  Tenant ID: $TenantID" -ForegroundColor White
}

# Step 2: Connect to Exchange Online to retrieve shared mailboxes
Write-Host "`nConnecting to Exchange Online..." -ForegroundColor Yellow

try {
    $SecurePassword = ConvertTo-SecureString -String $AdminPassword -AsPlainText -Force
    $Credential = New-Object -TypeName System.Management.Automation.PSCredential -ArgumentList $AdminEmail, $SecurePassword
    Connect-ExchangeOnline -Credential $Credential -ShowBanner:$false -ErrorAction Stop
    Write-Host "Connected to Exchange Online successfully" -ForegroundColor Green
}
catch {
    Write-Error "Failed to connect to Exchange Online: $_"
    exit 1
}

# Retrieve all shared mailboxes
Write-Host "`nRetrieving shared mailboxes..." -ForegroundColor Cyan
try {
    $sharedMailboxes = Get-EXOMailbox -ResultSize Unlimited -RecipientTypeDetails SharedMailbox -ErrorAction Stop
    Write-Host "Found $($sharedMailboxes.Count) shared mailbox(es)" -ForegroundColor Green
}
catch {
    Write-Host "Error retrieving shared mailboxes: $_" -ForegroundColor Red
    Disconnect-ExchangeOnline -Confirm:$false
    exit 1
}

# Check if there are shared mailboxes
if ($sharedMailboxes.Count -eq 0) {
    Write-Host "No shared mailboxes found. Exiting script." -ForegroundColor Yellow
    Disconnect-ExchangeOnline -Confirm:$false
    exit 0
}

Write-Host "`nShared mailboxes found:" -ForegroundColor White
foreach ($mailbox in $sharedMailboxes) {
    Write-Host "  - $($mailbox.PrimarySmtpAddress)" -ForegroundColor White
}

# Step 3: Connect to Microsoft Graph using Client Credentials flow
Write-Host "`nConnecting to Microsoft Graph..." -ForegroundColor Yellow

try {
    # Get access token using Client Credentials flow
    $body = @{
        grant_type    = "client_credentials"
        client_id     = $graphCreds.ClientId
        client_secret = $graphCreds.ClientSecret
        scope         = "https://graph.microsoft.com/.default"
    }

    $tokenUrl = "https://login.microsoftonline.com/$TenantID/oauth2/v2.0/token"
    $tokenResponse = Invoke-RestMethod -Uri $tokenUrl -Method POST -Body $body -ErrorAction Stop
    $accessToken = $tokenResponse.access_token

    # Create headers for Graph API calls
    $graphHeaders = @{
        "Authorization" = "Bearer $accessToken"
        "Content-Type"  = "application/json"
    }

    Write-Host "Connected to Microsoft Graph successfully" -ForegroundColor Green
}
catch {
    Write-Error "Failed to authenticate with Microsoft Graph: $_"
    Disconnect-ExchangeOnline -Confirm:$false
    exit 1
}

# Step 4: Get the Cloud Application Administrator role definition
Write-Host "`nRetrieving Cloud Application Administrator role definition..." -ForegroundColor Cyan

$roleName = "Cloud Application Administrator"

try {
    # Get role definition using Graph API
    $roleUri = "https://graph.microsoft.com/v1.0/roleManagement/directory/roleDefinitions?`$filter=displayName eq '$roleName'"
    $roleResponse = Invoke-RestMethod -Uri $roleUri -Headers $graphHeaders -Method Get -ErrorAction Stop

    if ($roleResponse.value.Count -eq 0) {
        Write-Error "Cloud Application Administrator role not found"
        Disconnect-ExchangeOnline -Confirm:$false
        exit 1
    }

    $roleDefinitionId = $roleResponse.value[0].id
    Write-Host "Role Definition ID: $roleDefinitionId" -ForegroundColor Green
}
catch {
    Write-Error "Failed to retrieve role definition: $_"
    Disconnect-ExchangeOnline -Confirm:$false
    exit 1
}

# Step 5: Assign Cloud Application Administrator role to each shared mailbox
Write-Host "`nAssigning Cloud Application Administrator role to shared mailboxes..." -ForegroundColor Cyan
Write-Host ""

$successCount = 0
$failureCount = 0

foreach ($mailbox in $sharedMailboxes) {
    Write-Host "Processing: $($mailbox.PrimarySmtpAddress)..." -ForegroundColor Yellow

    try {
        # Get the user object ID for the shared mailbox
        $userUri = "https://graph.microsoft.com/v1.0/users/$($mailbox.PrimarySmtpAddress)"
        $userResponse = Invoke-RestMethod -Uri $userUri -Headers $graphHeaders -Method Get -ErrorAction Stop
        $userId = $userResponse.id

        # Check if the role is already assigned
        $existingAssignmentsUri = "https://graph.microsoft.com/v1.0/roleManagement/directory/roleAssignments?`$filter=principalId eq '$userId' and roleDefinitionId eq '$roleDefinitionId'"
        $existingAssignments = Invoke-RestMethod -Uri $existingAssignmentsUri -Headers $graphHeaders -Method Get -ErrorAction Stop

        if ($existingAssignments.value.Count -gt 0) {
            Write-Host "  Role already assigned - skipping" -ForegroundColor Yellow
            $successCount++
            continue
        }

        # Assign the role
        $assignmentUri = "https://graph.microsoft.com/v1.0/roleManagement/directory/roleAssignments"
        $assignmentBody = @{
            "@odata.type"      = "#microsoft.graph.unifiedRoleAssignment"
            principalId        = $userId
            roleDefinitionId   = $roleDefinitionId
            directoryScopeId   = "/"
        } | ConvertTo-Json

        $assignmentResponse = Invoke-RestMethod -Uri $assignmentUri -Headers $graphHeaders -Method Post -Body $assignmentBody -ErrorAction Stop
        Write-Host "  Successfully assigned role" -ForegroundColor Green
        $successCount++
    }
    catch {
        Write-Host "  Failed to assign role: $_" -ForegroundColor Red
        $failureCount++
    }
}

# Step 6: Disconnect from services
Write-Host "`nDisconnecting from services..." -ForegroundColor Yellow
Disconnect-ExchangeOnline -Confirm:$false

# Step 7: Display summary
Write-Host "`n========================================" -ForegroundColor Cyan
Write-Host "ROLE ASSIGNMENT SUMMARY" -ForegroundColor Cyan
Write-Host "========================================" -ForegroundColor Cyan
Write-Host "Total shared mailboxes: $($sharedMailboxes.Count)" -ForegroundColor White
Write-Host "Successfully assigned: $successCount" -ForegroundColor Green
Write-Host "Failed: $failureCount" -ForegroundColor $(if ($failureCount -gt 0) { "Red" } else { "White" })
Write-Host ""
Write-Host "Cloud Application Administrator role assignment completed." -ForegroundColor Green
