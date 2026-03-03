# Install Microsoft Graph Modules - Version 2.25.0
# This script installs all required Microsoft.Graph modules at version 2.25.0
# Some functionality only works with this specific version

Write-Host "========================================" -ForegroundColor Cyan
Write-Host "Installing Microsoft Graph Modules v2.25.0" -ForegroundColor Cyan
Write-Host "========================================" -ForegroundColor Cyan
Write-Host ""

# List of all Microsoft.Graph modules to install at version 2.25.0
$modules = @(
    "Microsoft.Graph",
    "Microsoft.Graph.Applications",
    "Microsoft.Graph.Authentication",
    "Microsoft.Graph.BackupRestore",
    "Microsoft.Graph.Bookings",
    "Microsoft.Graph.Calendar",
    "Microsoft.Graph.ChangeNotifications",
    "Microsoft.Graph.CloudCommunications",
    "Microsoft.Graph.Compliance",
    "Microsoft.Graph.CrossDeviceExperiences",
    "Microsoft.Graph.DeviceManagement",
    "Microsoft.Graph.DeviceManagement.Actions",
    "Microsoft.Graph.DeviceManagement.Administration",
    "Microsoft.Graph.DeviceManagement.Enrollment",
    "Microsoft.Graph.DeviceManagement.Functions",
    "Microsoft.Graph.Devices.CloudPrint",
    "Microsoft.Graph.Devices.CorporateManagement",
    "Microsoft.Graph.Devices.ServiceAnnouncement",
    "Microsoft.Graph.DirectoryObjects",
    "Microsoft.Graph.Education",
    "Microsoft.Graph.Files",
    "Microsoft.Graph.Groups",
    "Microsoft.Graph.Identity.DirectoryManagement",
    "Microsoft.Graph.Identity.Governance",
    "Microsoft.Graph.Identity.Partner",
    "Microsoft.Graph.Identity.SignIns",
    "Microsoft.Graph.Mail",
    "Microsoft.Graph.Notes",
    "Microsoft.Graph.People",
    "Microsoft.Graph.PersonalContacts",
    "Microsoft.Graph.Planner",
    "Microsoft.Graph.Reports",
    "Microsoft.Graph.SchemaExtensions",
    "Microsoft.Graph.Search",
    "Microsoft.Graph.Security",
    "Microsoft.Graph.Sites",
    "Microsoft.Graph.Teams",
    "Microsoft.Graph.Users",
    "Microsoft.Graph.Users.Actions",
    "Microsoft.Graph.Users.Functions"
)

$version = "2.25.0"
$successCount = 0
$failureCount = 0
$skippedCount = 0

Write-Host "Checking and installing $($modules.Count) modules..." -ForegroundColor Yellow
Write-Host ""

foreach ($moduleName in $modules) {
    Write-Host "Processing: $moduleName" -ForegroundColor White

    # Check if module is already installed at the correct version
    $installedModule = Get-InstalledModule -Name $moduleName -RequiredVersion $version -ErrorAction SilentlyContinue

    if ($installedModule) {
        Write-Host "  [OK] Already installed (v$version)" -ForegroundColor Green
        $skippedCount++
    }
    else {
        try {
            Write-Host "  Installing v$version..." -ForegroundColor Yellow
            Install-Module -Name $moduleName -RequiredVersion $version -Scope CurrentUser -Force -AllowClobber -ErrorAction Stop
            Write-Host "  [OK] Successfully installed" -ForegroundColor Green
            $successCount++
        }
        catch {
            Write-Host "  [ERROR] Failed to install: $_" -ForegroundColor Red
            $failureCount++
        }
    }
}

Write-Host ""
Write-Host "========================================" -ForegroundColor Cyan
Write-Host "INSTALLATION SUMMARY" -ForegroundColor Cyan
Write-Host "========================================" -ForegroundColor Cyan
Write-Host "Total modules: $($modules.Count)" -ForegroundColor White
Write-Host "Already installed: $skippedCount" -ForegroundColor Green
Write-Host "Newly installed: $successCount" -ForegroundColor Green
Write-Host "Failed: $failureCount" -ForegroundColor $(if ($failureCount -gt 0) { "Red" } else { "White" })
Write-Host ""

if ($failureCount -eq 0) {
    Write-Host "All Microsoft Graph modules v2.25.0 are ready!" -ForegroundColor Green
}
else {
    Write-Host "Some modules failed to install. Please review errors above." -ForegroundColor Yellow
}

Write-Host ""
Write-Host "To verify installation, run:" -ForegroundColor Cyan
Write-Host "Get-Module Microsoft.Graph* -ListAvailable" -ForegroundColor White
