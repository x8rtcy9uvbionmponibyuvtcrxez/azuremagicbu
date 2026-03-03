# --- script2_nov.ps1 - Microsoft Graph Migration Version (Airtable) ---
# This script uses Microsoft Graph instead of AzureAD module
# Compatible with tenants that have Azure AD Graph API blocked

# --- Step 0: Retrieve domain credentials from Airtable via Python script ---

# Prompt the user for the Tenant name.
$tenant = Read-Host "Enter Tenant name"

# Call the external Python script and pass the tenant value as an argument.
$pythonOutput = python .\retrieve_domain_credentials_airtable.py $tenant

try {
    $domainInfo = $pythonOutput | ConvertFrom-Json
} catch {
    Write-Host "Error parsing JSON output from retrieve_domain_credentials_airtable.py"
    exit 1
}

if ($domainInfo.error) {
    Write-Host "Error retrieving domain credentials: $($domainInfo.error)"
    exit 1
}

$item_id       = $domainInfo.itemId
$domainName    = $domainInfo.domainName
$adminEmail    = $domainInfo.AdminEmail
$adminPassword = $domainInfo.AdminPassword
$InboxNames    = $domainInfo.InboxNames
$Platform      = $domainInfo.Client  # Airtable uses "Client" field instead of "Platform"
$subitem_id    = $domainInfo.subitemId
$tenantId      = $domainInfo.TenantID  # Required for Microsoft Graph authentication

Write-Host "Retrieved values from Airtable:"
Write-Host "  Domain Name   : $domainName"
Write-Host "  Admin Email   : $AdminEmail"
Write-Host "  Admin Password: $AdminPassword"
Write-Host "  Inbox Names   : $InboxNames"
Write-Host "  Client        : $Platform"
Write-Host "  Record ID     : $item_id"
Write-Host "  Tenant ID     : $tenantId"

# Check if Tenant ID was retrieved
if (-not $tenantId) {
    Write-Host "Error: Tenant ID not found in Airtable. Required for Microsoft Graph authentication." -ForegroundColor Red
    exit 1
}

# --- Continue with the rest of the script ---

python csvgen_airtable.py $tenant $domainName $InboxNames $item_id

# Prompt for the CSV file path
$csvPath = Read-Host "Enter the path to the CSV file (without quotes)"
$csvPath = $csvPath.Trim('"')

Write-Host "`n========================================" -ForegroundColor Cyan
Write-Host "STARTING MAILBOX CREATION" -ForegroundColor Cyan
Write-Host "========================================" -ForegroundColor Cyan

# Run the create_shared_mailbox.ps1 script (uses Exchange Online - no Graph migration needed)
.\create_shared_mailboxes.ps1 -CsvPath $csvPath -AdminEmail $adminEmail -AdminPassword $adminPassword

Write-Host "Mailboxes created for $tenant" -ForegroundColor Green

Write-Host "`n========================================" -ForegroundColor Cyan
Write-Host "REMOVING DISPLAY NAME NUMBERS" -ForegroundColor Cyan
Write-Host "========================================" -ForegroundColor Cyan

# Run the remove_displayname_number.ps1 script (uses Exchange Online - no Graph migration needed)
.\remove_displayname_numbers.ps1 -AdminEmail $adminEmail -AdminPassword $adminPassword

Write-Host "Display Name Numbers Removed" -ForegroundColor Green

Write-Host "`n========================================" -ForegroundColor Cyan
Write-Host "UPDATING EMAIL ADDRESSES (MICROSOFT GRAPH)" -ForegroundColor Cyan
Write-Host "========================================" -ForegroundColor Cyan

# Run the Microsoft Graph version - update_emailaddresses_graph.ps1
.\update_emailaddresses_graph.ps1 -CsvPath $csvPath -TenantId $tenantId

Write-Host "Email addresses updated" -ForegroundColor Green

Write-Host "`n========================================" -ForegroundColor Cyan
Write-Host "SETTING MAILBOX PASSWORDS (MICROSOFT GRAPH)" -ForegroundColor Cyan
Write-Host "========================================" -ForegroundColor Cyan

# Run the Microsoft Graph version - set_shared_mailbox_passwords_graph.ps1
.\set_shared_mailbox_passwords_graph.ps1 -CsvPath $csvPath -TenantId $tenantId

Write-Host "Mailbox passwords set" -ForegroundColor Green

Write-Host "`n========================================" -ForegroundColor Cyan
Write-Host "ENABLING SMTP AUTHENTICATION" -ForegroundColor Cyan
Write-Host "========================================" -ForegroundColor Cyan

# Only run smtpauth-enable.ps1 if Platform is NOT "Smartlead"
if ($Platform -ne "Smartlead") {
    .\smtpauth-enable.ps1 -CsvPath $csvPath -AdminEmail $adminEmail -AdminPassword $adminPassword
    Write-Host "SMTP authentication enabled" -ForegroundColor Green
} else {
    Write-Host "Skipping smtpauth-enable.ps1 because Platform is Smartlead." -ForegroundColor Yellow
}

Write-Host "`n========================================" -ForegroundColor Cyan
Write-Host "DELEGATING MAILBOXES (MICROSOFT GRAPH)" -ForegroundColor Cyan
Write-Host "========================================" -ForegroundColor Cyan

# Run the Microsoft Graph version - bulk_delegation_graph.ps1
.\bulk_delegation_graph.ps1 -TenantId $tenantId -AdminEmail $adminEmail -AdminPassword $adminPassword

Write-Host "Bulk delegation complete" -ForegroundColor Green

Write-Host "`n========================================" -ForegroundColor Cyan
Write-Host "ENABLING SIGN-IN (MICROSOFT GRAPH)" -ForegroundColor Cyan
Write-Host "========================================" -ForegroundColor Cyan

# Run the Microsoft Graph version - enable_signin_graph.ps1
.\enable_signin_graph.ps1 -CsvPath $csvPath -TenantId $tenantId

Write-Host "Sign-in enabled for $tenant" -ForegroundColor Green

Write-Host "`n========================================" -ForegroundColor Cyan
Write-Host "UPDATING MAILBOX SETUP STATUS" -ForegroundColor Cyan
Write-Host "========================================" -ForegroundColor Cyan

python .\movegroup_airtable.py $item_id

Write-Host "`n========================================" -ForegroundColor Cyan
Write-Host "ASSIGNING CLOUD APPLICATION ADMIN ROLE" -ForegroundColor Cyan
Write-Host "========================================" -ForegroundColor Cyan

# Navigate to parent directory to run assign_cloud_app_admin_role.ps1
$grandParentPath = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$roleScriptPath = Join-Path $grandParentPath "assign_cloud_app_admin_role.ps1"

if (Test-Path $roleScriptPath) {
    & $roleScriptPath -AdminEmail $adminEmail -AdminPassword $adminPassword -TenantID $tenantId -TenantName $tenant
    Write-Host "Cloud Application Administrator role assignment complete" -ForegroundColor Green
}
else {
    Write-Host "Warning: assign_cloud_app_admin_role.ps1 not found at $roleScriptPath" -ForegroundColor Yellow
    Write-Host "Skipping role assignment..." -ForegroundColor Yellow
}

Write-Host "`n========================================" -ForegroundColor Green
Write-Host "$tenant COMPLETED" -ForegroundColor Green
Write-Host "========================================" -ForegroundColor Green
Write-Host "Please check for errors above." -ForegroundColor Yellow
Write-Host ""
Write-Host "Scripts used (Microsoft Graph versions):" -ForegroundColor Cyan
Write-Host "  - update_emailaddresses_graph.ps1" -ForegroundColor White
Write-Host "  - set_shared_mailbox_passwords_graph.ps1" -ForegroundColor White
Write-Host "  - bulk_delegation_graph.ps1" -ForegroundColor White
Write-Host "  - enable_signin_graph.ps1" -ForegroundColor White
Write-Host "  - assign_cloud_app_admin_role.ps1" -ForegroundColor White
Write-Host ""
Write-Host "All scripts now using Microsoft Graph API - fully migrated!" -ForegroundColor Green
Write-Host ""
