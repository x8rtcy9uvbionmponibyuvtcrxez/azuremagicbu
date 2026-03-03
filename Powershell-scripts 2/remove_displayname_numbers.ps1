param(
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

# Retrieve all shared mailboxes
$sharedMailboxes = Get-Mailbox -ResultSize Unlimited -RecipientTypeDetails SharedMailbox

foreach ($mailbox in $sharedMailboxes) {
    $newDisplayName = ($mailbox.DisplayName -replace '\d','').Trim()
    
    if ($newDisplayName -ne $mailbox.DisplayName) {
        Set-Mailbox -Identity $mailbox.Identity -DisplayName $newDisplayName
        Write-Host "Updated display name for $($mailbox.DisplayName) to $newDisplayName"
    }
}

# Disconnect from Exchange Online
Disconnect-ExchangeOnline -Confirm:$false