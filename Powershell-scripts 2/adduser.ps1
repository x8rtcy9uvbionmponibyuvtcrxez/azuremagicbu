 param(
    $DomainName,
    $AdminEmail,
    $AdminPassword,
    $Alias
)

# Prompt the admin for the domain and full name (alias).
$domain = $DomainName
$alias = $Alias

# Prompt for the admin password (which will also be used for the new user).
$password = $AdminPassword
$securePassword = ConvertTo-SecureString $password -AsPlainText -Force

# Extract the first name from the alias and convert it to lowercase.
$firstName = $alias.Split(" ")[0].ToLower()

# Construct the UserPrincipalName using only the first name.
$userPrincipalName = $firstName + "@" + $domain

# Construct the MailNickname by removing spaces from the alias.
$mailNickname = $alias -replace "\s+", ""

# Define the parameters for the new user.
$userParams = @{
    AccountEnabled    = $true   
    DisplayName       = $alias
    MailNickname      = $mailNickname
    UserPrincipalName = $userPrincipalName
    UsageLocation     = "US"  # Set usage location to United States.
    PasswordProfile   = @{
        ForceChangePasswordNextSignIn = $false
        Password                      = $password
    }
}

# Create the new user mailbox.
$newUser = New-MgUser -BodyParameter $userParams
Write-Host "User created successfully. User Id:" $newUser.Id

# Retrieve the available license. This example assumes there is only one available license.
$sku = Get-MgSubscribedSku | Select-Object -First 1

if ($null -eq $sku) {
    Write-Host "No available license found to assign."
} else {
    # Prepare the license assignment object.
    $licenseAssignment = @{
        addLicenses    = @(@{ skuId = $sku.SkuId })
        removeLicenses = @()
    }
    # Assign the license to the new user.
    Set-MgUserLicense -UserId $newUser.Id -BodyParameter $licenseAssignment
    Write-Host "License assigned successfully."
} 