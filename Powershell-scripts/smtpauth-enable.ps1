param(
    $CsvPath,
    $AdminEmail,
    $AdminPassword
)

# Connect to Exchange Online using password authentication
try {
    $SecurePassword = ConvertTo-SecureString -String $AdminPassword -AsPlainText -Force
    $Credential = New-Object -TypeName System.Management.Automation.PSCredential -ArgumentList $AdminEmail, $SecurePassword
    Connect-ExchangeOnline -Credential $Credential -ShowBanner:$false
}
catch {
    Write-Error "Failed to connect to Exchange Online. Error: $_"
    exit
}

# Import the CSV file
$csvData = Import-Csv -Path $CsvPath

# Extract the domain from the EmailAddress in the second row (index 1)
$emailAddress = $csvData[1].EmailAddress
$domain = $emailAddress -replace '^.*@', ''

Write-Host "Updating SMTP AUTH for all mailboxes on $domain."

# Find all mailboxes with the specified domain and enable SMTP Auth for them
$mailboxes = Get-Mailbox -Filter "EmailAddresses -like '*@$domain'"

foreach ($mailbox in $mailboxes) {
    # Enable SMTP Auth for the mailbox
    Set-CASMailbox -Identity $mailbox.Identity -SmtpClientAuthenticationDisabled $false
    Write-Host "Enabled SMTP Authentication for mailbox:" $mailbox.PrimarySmtpAddress
}

# Disconnect from Exchange Online
Disconnect-ExchangeOnline -Confirm:$false

Write-Host "SMTP Authentication has been enabled for all mailboxes with the domain $domain."
