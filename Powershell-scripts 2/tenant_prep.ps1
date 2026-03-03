# Import credential module
Import-Module (Join-Path $PSScriptRoot "CredentialModule.psm1") -Force

# Get Graph credentials from .env
$graphCreds = Get-GraphCredentials
$graphAppId = $graphCreds.AppId

# Prompt for tenant name
$tenant = Read-Host "Enter Tenant name"

function Disable-SecurityDefaults {
    try {
        # Step 1: Connect to Microsoft Graph with additional scope for role management
        Write-Host "Please authenticate using the device code..." -ForegroundColor Cyan
        Connect-MgGraph -Scopes "Policy.Read.All", "Policy.ReadWrite.ConditionalAccess", "Domain.ReadWrite.All", 
                        "Directory.ReadWrite.All", "RoleManagement.ReadWrite.Directory", "Application.ReadWrite.All" -DeviceCode
        
        $maxRetries = 3
        $retryCount = 0
        $success = $false
        
        while (-not $success -and $retryCount -lt $maxRetries) {
            # Step 2: Disable Security Defaults
            Write-Host "Attempting to disable Security Defaults..." -ForegroundColor Cyan
            Update-MgPolicyIdentitySecurityDefaultEnforcementPolicy -IsEnabled:$false

            Write-Host "Checking 2FA Status in 10 seconds"

            Start-Sleep -Seconds 10
            
            # Step 3: Check Security Defaults status
            $securityDefaultsStatus = Get-MgPolicyIdentitySecurityDefaultEnforcementPolicy | Select-Object DisplayName, IsEnabled
            Write-Host "Current Security Defaults status:" -ForegroundColor Cyan
            $securityDefaultsStatus | Format-Table
            
            # Check the result and act accordingly
            if ($securityDefaultsStatus.IsEnabled -eq $false) {
                Write-Host "2FA disabled." -ForegroundColor Green
                $success = $true
            } else {
                $retryCount++
                if ($retryCount -lt $maxRetries) {
                    Write-Host "2FA Update failed, retrying in 10 seconds... (Attempt $retryCount of $maxRetries)" -ForegroundColor Yellow
                    Start-Sleep -Seconds 10  # Small delay before retry
                } else {
                    Write-Host "Failed to disable Security Defaults after $maxRetries attempts." -ForegroundColor Red
                }
            }
        }
        
        # Retrieve the organization ID
        $global:orgId = Get-MgOrganization | Select-Object -ExpandProperty Id
        Write-Host "Organization ID retrieved: $orgId" -ForegroundColor Green

        # Create service principal
        Write-Host "Creating service principal..." -ForegroundColor Cyan
        New-MgServicePrincipal -AppId $graphAppId

        # Get the service principal we just created
        Write-Host "Retrieving service principal..." -ForegroundColor Cyan
        $sp = Get-MgServicePrincipal -Filter "appId eq '$graphAppId'"
        
        if ($sp) {
            Write-Host "Service Principal found with ID: $($sp.Id)" -ForegroundColor Green
            
            # Get Global Administrator role
            Write-Host "Retrieving Global Administrator role..." -ForegroundColor Cyan
            $role = Get-MgDirectoryRole -Filter "displayName eq 'Global Administrator'"
            
            # If role returns null, activate the role first
            if (!$role) {
                Write-Host "Global Administrator role not active, activating..." -ForegroundColor Yellow
                $template = Get-MgDirectoryRoleTemplate -Filter "displayName eq 'Global Administrator'"
                $role = New-MgDirectoryRole -RoleTemplateId $template.Id
            }
            
            # Assign role to service principal
            Write-Host "Assigning Global Administrator role to service principal..." -ForegroundColor Cyan
            $body = @{
                "@odata.id" = "https://graph.microsoft.com/v1.0/directoryObjects/$($sp.Id)"
            }
            
            New-MgDirectoryRoleMemberByRef -DirectoryRoleId $role.Id -BodyParameter $body
            Write-Host "Role assigned successfully!" -ForegroundColor Green
        } else {
            Write-Host "Service Principal not found. Role assignment skipped." -ForegroundColor Red
        }
        
        # Disconnect from Microsoft Graph
        Write-Host "Disconnecting from Microsoft Graph..." -ForegroundColor Yellow
        Disconnect-MgGraph
        Write-Host "Disconnected from Microsoft Graph." -ForegroundColor Cyan
        
    } catch {
        Write-Host "An error occurred: $_" -ForegroundColor Red
        # Ensure we disconnect even if there's an error
        if (Get-MgContext) {
            Disconnect-MgGraph
            Write-Host "Disconnected from Microsoft Graph due to error." -ForegroundColor Cyan
        }
    }
}

# Execute the function
Disable-SecurityDefaults

# Run the Python script 'update_org_id_airtable.py' and pass the organization ID and tenant as arguments
Write-Host "Running update_org_id_airtable.py with Org ID and Tenant..."
python update_org_id_airtable.py $tenant $orgId
