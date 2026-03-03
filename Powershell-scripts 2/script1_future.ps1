param(
    $domainName,
    $AdminEmail,
    $AdminPassword,
    $Alias,
    $item_id,
    $tenant_id,
    $tenant_name
)

# Import credential module
Import-Module (Join-Path $PSScriptRoot "CredentialModule.psm1") -Force

# Get Graph credentials from .env
$graphCreds = Get-GraphCredentials

Write-Host "Retrieved values from Airtable:"
Write-Host "  Domain Name   : $domainName"
Write-Host "  Admin Email   : $AdminEmail"
Write-Host "  Admin Password: $AdminPassword"
Write-Host "  Alias         : $Alias"
Write-Host "  Item          : $item_id"
Write-Host "  TenantID      : $tenant_id"
# Line break
Write-Host ""

Write-Host "Connecting to tenant: $tenant_name." -ForegroundColor Yellow

$body = @{
    grant_type    = "client_credentials"
    client_id     = $graphCreds.ClientId
    client_secret = $graphCreds.ClientSecret
    scope         = "https://graph.microsoft.com/.default"
}

$response = Invoke-RestMethod -Uri "https://login.microsoftonline.com/$tenant_id/oauth2/v2.0/token" -Method POST -Body $body
$accessToken = $response.access_token

# Convert the access token to a SecureString
$secureAccessToken = ConvertTo-SecureString $accessToken -AsPlainText -Force

# Use the SecureString with Connect-MgGraph
Connect-MgGraph -AccessToken $secureAccessToken
Write-Host "Connected to tenant: $tenant_name" -ForegroundColor Green

# Line break
Write-Host ""

Write-Host "Proceeding with domain setup for $domainName." -ForegroundColor Yellow

.\add_domain_mggraph.ps1 -DomainName $domainName -AdminEmail $adminEmail -AdminPassword $adminPassword -tenant $tenant_id

# Line break
Write-Host ""

Write-Host "$domainName setup complete." -ForegroundColor Green

# Line break
Write-Host ""

Write-Host "Proceeding with licensed user creation." -ForegroundColor Yellow

.\adduser.ps1 -DomainName $domainName -AdminEmail $AdminEmail -AdminPassword $AdminPassword -Alias $Alias

# Line break
Write-Host ""

Write-Host "User creation complete." -ForegroundColor Green

python .\move_group_domain_airtable.py $item_id

# Line break
Write-Host ""

Write-Host "$tenant_name domain setup and user creation complete." -ForegroundColor Green

Disconnect-MgGraph