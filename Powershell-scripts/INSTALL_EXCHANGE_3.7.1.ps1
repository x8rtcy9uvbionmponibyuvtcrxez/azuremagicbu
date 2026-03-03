# Install ExchangeOnlineManagement Module - Version 3.7.1
# Version 3.7.1 is required - Version 3.7.2 has a broker error that breaks functionality

Write-Host "========================================" -ForegroundColor Cyan
Write-Host "Installing ExchangeOnlineManagement v3.7.1" -ForegroundColor Cyan
Write-Host "========================================" -ForegroundColor Cyan
Write-Host ""

$moduleName = "ExchangeOnlineManagement"
$requiredVersion = "3.7.1"

# Check if version 3.7.1 is already installed
Write-Host "Checking for existing installation..." -ForegroundColor Yellow

$installedModule = Get-InstalledModule -Name $moduleName -RequiredVersion $requiredVersion -ErrorAction SilentlyContinue

if ($installedModule) {
    Write-Host "[OK] ExchangeOnlineManagement v$requiredVersion is already installed" -ForegroundColor Green
    Write-Host ""
    Write-Host "Module Details:" -ForegroundColor Cyan
    Write-Host "  Name: $($installedModule.Name)" -ForegroundColor White
    Write-Host "  Version: $($installedModule.Version)" -ForegroundColor White
    Write-Host "  Installed Location: $($installedModule.InstalledLocation)" -ForegroundColor White
}
else {
    Write-Host "[INFO] ExchangeOnlineManagement v$requiredVersion not found" -ForegroundColor Yellow

    # Check if any other version is installed
    $otherVersions = Get-InstalledModule -Name $moduleName -AllVersions -ErrorAction SilentlyContinue

    if ($otherVersions) {
        Write-Host ""
        Write-Host "Other versions found:" -ForegroundColor Yellow
        foreach ($ver in $otherVersions) {
            Write-Host "  - Version $($ver.Version)" -ForegroundColor White
        }
        Write-Host ""
        Write-Host "NOTE: Version 3.7.2 is known to have broker errors" -ForegroundColor Red
        Write-Host "We will install v3.7.1 alongside existing versions" -ForegroundColor Yellow
    }

    Write-Host ""
    Write-Host "Installing ExchangeOnlineManagement v$requiredVersion..." -ForegroundColor Yellow

    try {
        Install-Module -Name $moduleName -RequiredVersion $requiredVersion -Scope CurrentUser -Force -AllowClobber -ErrorAction Stop
        Write-Host "[OK] Successfully installed ExchangeOnlineManagement v$requiredVersion" -ForegroundColor Green

        # Verify installation
        $verifyModule = Get-InstalledModule -Name $moduleName -RequiredVersion $requiredVersion -ErrorAction SilentlyContinue

        if ($verifyModule) {
            Write-Host ""
            Write-Host "Installation verified:" -ForegroundColor Cyan
            Write-Host "  Name: $($verifyModule.Name)" -ForegroundColor White
            Write-Host "  Version: $($verifyModule.Version)" -ForegroundColor White
            Write-Host "  Installed Location: $($verifyModule.InstalledLocation)" -ForegroundColor White
        }
    }
    catch {
        Write-Host "[ERROR] Failed to install ExchangeOnlineManagement v$requiredVersion" -ForegroundColor Red
        Write-Host "Error: $_" -ForegroundColor Red
        exit 1
    }
}

Write-Host ""
Write-Host "========================================" -ForegroundColor Cyan
Write-Host "IMPORTANT NOTES" -ForegroundColor Cyan
Write-Host "========================================" -ForegroundColor Cyan
Write-Host "1. Always specify version 3.7.1 in your scripts:" -ForegroundColor Yellow
Write-Host "   Import-Module ExchangeOnlineManagement -RequiredVersion 3.7.1" -ForegroundColor White
Write-Host ""
Write-Host "2. Version 3.7.2 has a known broker error:" -ForegroundColor Yellow
Write-Host "   'Method not found: Microsoft.Identity.Client.Broker.BrokerExtension.WithBroker'" -ForegroundColor White
Write-Host ""
Write-Host "3. To verify the correct version is loaded:" -ForegroundColor Yellow
Write-Host "   Get-Module ExchangeOnlineManagement" -ForegroundColor White
Write-Host ""
Write-Host "Installation complete!" -ForegroundColor Green
