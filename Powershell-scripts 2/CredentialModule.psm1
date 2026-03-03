# CredentialModule.psm1
# Purpose: Centralized credential management for Microsoft Graph and other services
# Usage: Import-Module ./CredentialModule.psm1

<#
.SYNOPSIS
    Loads environment variables from a .env file

.DESCRIPTION
    Parses a .env file and returns a hashtable of key-value pairs
    Supports comments (lines starting with #) and ignores empty lines

.PARAMETER EnvFilePath
    Path to the .env file. Defaults to .env in the same directory as this module

.EXAMPLE
    $env = Get-EnvFileContent
    $env = Get-EnvFileContent -EnvFilePath "C:\path\to\.env"
#>
function Get-EnvFileContent {
    param (
        [string]$EnvFilePath = (Join-Path $PSScriptRoot ".env")
    )

    if (-not (Test-Path $EnvFilePath)) {
        throw ".env file not found at: $EnvFilePath`nPlease create a .env file or run fill_credentials.py to generate one."
    }

    $envVars = @{}

    Get-Content $EnvFilePath | ForEach-Object {
        $line = $_.Trim()

        # Skip empty lines and comments
        if ($line -and -not $line.StartsWith('#')) {
            # Match KEY=VALUE pattern
            if ($line -match '^([^=]+)=(.*)$') {
                $key = $matches[1].Trim()
                $value = $matches[2].Trim()
                $envVars[$key] = $value
            }
        }
    }

    return $envVars
}

<#
.SYNOPSIS
    Retrieves Microsoft Graph API credentials from .env file

.DESCRIPTION
    Returns a hashtable containing Graph App ID, Client ID, and Client Secret
    Validates that all required credentials are present in the .env file

.EXAMPLE
    $creds = Get-GraphCredentials
    $appId = $creds.AppId
    $clientId = $creds.ClientId
    $clientSecret = $creds.ClientSecret
#>
function Get-GraphCredentials {
    $env = Get-EnvFileContent

    # Validate required Graph credentials exist
    $requiredKeys = @('GRAPH_APP_ID', 'GRAPH_CLIENT_ID', 'GRAPH_CLIENT_SECRET')
    $missingKeys = @()

    foreach ($key in $requiredKeys) {
        if (-not $env.ContainsKey($key) -or [string]::IsNullOrWhiteSpace($env[$key])) {
            $missingKeys += $key
        }
    }

    if ($missingKeys.Count -gt 0) {
        throw "Missing required Graph credentials in .env file: $($missingKeys -join ', ')`nPlease run fill_credentials.py to configure these values."
    }

    return @{
        AppId        = $env['GRAPH_APP_ID']
        ClientId     = $env['GRAPH_CLIENT_ID']
        ClientSecret = $env['GRAPH_CLIENT_SECRET']
    }
}

# Export functions
Export-ModuleMember -Function Get-EnvFileContent, Get-GraphCredentials
