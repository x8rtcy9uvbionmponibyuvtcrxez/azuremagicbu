require('dotenv').config();
const express = require("express");
const { spawn } = require("child_process");
const fs = require("fs");
const path = require("path");
const os = require("os");

const app = express();
app.use(express.json());

const PORT = process.env.PS_SERVICE_PORT || 3099;

function escapePowerShellString(value) {
  return String(value || "")
    .replace(/`/g, "``")
    .replace(/"/g, '`"');
}

function stripAnsi(str) {
  return str.replace(/\u001b\[[0-9;]*m/g, "");
}

function runPowerShell(script, timeout = 1200000) {
  return new Promise((resolve, reject) => {
    const ps = spawn("pwsh", ["-NoProfile", "-NonInteractive", "-Command", script], {
      timeout,
      env: { ...process.env }
    });

    let stdout = "";
    let stderr = "";

    ps.stdout.on("data", (data) => {
      stdout += data.toString();
    });

    ps.stderr.on("data", (data) => {
      stderr += data.toString();
    });

    ps.on("close", (code) => {
      if (code !== 0) {
        reject(new Error(`PowerShell exited with code ${code}: ${stripAnsi(stderr)}`));
      } else {
        resolve(stripAnsi(stdout.trim()));
      }
    });

    ps.on("error", (error) => reject(error));
  });
}

app.get("/health", (_req, res) => {
  res.json({ status: "ok" });
});

app.post("/create-shared-mailboxes", async (req, res) => {
  let tmpFile;
  try {
    const { adminUpn, adminPassword, organizationId, mailboxes } = req.body;

    if (!adminUpn || !adminPassword || !organizationId || !Array.isArray(mailboxes) || mailboxes.length === 0) {
      return res.status(400).json({ error: "Missing required fields" });
    }

    tmpFile = path.join(os.tmpdir(), `mailboxes-${Date.now()}-${Math.random().toString(36).slice(2)}.json`);
    fs.writeFileSync(tmpFile, JSON.stringify(mailboxes));

    const escapedClientId = escapePowerShellString(process.env.GRAPH_CLIENT_ID || "");
    const escapedClientSecret = escapePowerShellString(process.env.GRAPH_CLIENT_SECRET || "");
    const escapedOrgId = escapePowerShellString(organizationId);
    const escapedAdminUpn = escapePowerShellString(adminUpn);
    const escapedAdminPassword = escapePowerShellString(adminPassword);
    const escapedTmpFile = escapePowerShellString(tmpFile);

    const script = `
$ErrorActionPreference = "Continue"

$clientId = "${escapedClientId}"
$clientSecret = "${escapedClientSecret}"
$orgId = "${escapedOrgId}"

$secureSecret = ConvertTo-SecureString $clientSecret -AsPlainText -Force
$credential = New-Object System.Management.Automation.PSCredential($clientId, $secureSecret)

try {
  Connect-ExchangeOnline -CertificateThumbprint $null -AppId $clientId -Organization $orgId -Credential $credential -ShowBanner:$false 2>$null
} catch {
$securePassword = ConvertTo-SecureString "${escapedAdminPassword}" -AsPlainText -Force
$userCredential = New-Object System.Management.Automation.PSCredential("${escapedAdminUpn}", $securePassword)
Connect-ExchangeOnline -Credential $userCredential -ShowBanner:$false
}

$results = @()
$mailboxData = Get-Content -Raw -Path "${escapedTmpFile}" | ConvertFrom-Json
$counter = 1

foreach ($mb in $mailboxData) {
  try {
    # Check if mailbox already exists
    $existing = $null
    try { $existing = Get-Mailbox -Identity $mb.email -ErrorAction SilentlyContinue } catch {}
    
    if ($existing) {
      # Already exists - treat as success
      try { Set-Mailbox -Identity $mb.email -DisplayName $mb.displayName } catch {}
      $results += @{ email = $mb.email; status = "exists"; error = $null }
    } else {
      $tempName = "$($mb.displayName) $counter"
      New-Mailbox -Name $tempName -Shared -PrimarySmtpAddress $mb.email -DisplayName $tempName
      Start-Sleep -Seconds 2
      try { Set-Mailbox -Identity $mb.email -DisplayName $mb.displayName } catch {}
      $results += @{ email = $mb.email; status = "created"; error = $null }
    }
  } catch {
    $msg = $_.Exception.Message
    if ($msg -like "*already*" -or $msg -like "*proxy address*") {
      $results += @{ email = $mb.email; status = "exists"; error = $null }
    } else {
      $results += @{ email = $mb.email; status = "failed"; error = $msg }
    }
  }
  Write-Host "[$counter/$($mailboxData.Count)] $($mb.email) -> $($results[-1].status)"
  $counter++
}

Disconnect-ExchangeOnline -Confirm:$false 2>$null
$results | ConvertTo-Json -Compress
`;

    const output = await runPowerShell(script, 600000);
    let results;
    try {
      results = JSON.parse(output);
    } catch {
      results = { raw: output };
    }

    res.json({ success: true, results });
  } catch (error) {
    console.error("Create shared mailboxes error:", error.message);
    res.status(500).json({ error: error.message });
  } finally {
    if (tmpFile) {
      try {
        fs.unlinkSync(tmpFile);
      } catch {}
    }
  }
});

app.post("/enable-smtp-auth", async (req, res) => {
  let tmpFile;
  try {
    const { adminUpn, adminPassword, emails } = req.body;
    if (!adminUpn || !adminPassword || !Array.isArray(emails) || emails.length === 0) {
      return res.status(400).json({ error: "Missing required fields" });
    }

    tmpFile = path.join(os.tmpdir(), `emails-${Date.now()}-${Math.random().toString(36).slice(2)}.json`);
    fs.writeFileSync(tmpFile, JSON.stringify(emails));

    const escapedAdminUpn = escapePowerShellString(adminUpn);
    const escapedAdminPassword = escapePowerShellString(adminPassword);
    const escapedTmpFile = escapePowerShellString(tmpFile);

    const script = `
$ErrorActionPreference = "Continue"
$securePassword = ConvertTo-SecureString "${escapedAdminPassword}" -AsPlainText -Force
$credential = New-Object System.Management.Automation.PSCredential("${escapedAdminUpn}", $securePassword)
Connect-ExchangeOnline -Credential $credential -ShowBanner:$false

Set-TransportConfig -SmtpClientAuthenticationDisabled $false

$results = @()
$emails = Get-Content -Raw -Path "${escapedTmpFile}" | ConvertFrom-Json

foreach ($email in $emails) {
  try {
    Set-CASMailbox -Identity $email -SmtpClientAuthenticationDisabled $false
    $results += @{ email = $email; status = "enabled" }
  } catch {
    $results += @{ email = $email; status = "failed"; error = $_.Exception.Message }
  }
}

Disconnect-ExchangeOnline -Confirm:$false 2>$null
$results | ConvertTo-Json -Compress
`;

    const output = await runPowerShell(script, 300000);
    res.json({ success: true, results: JSON.parse(output) });
  } catch (error) {
    res.status(500).json({ error: error.message });
  } finally {
    if (tmpFile) {
      try {
        fs.unlinkSync(tmpFile);
      } catch {}
    }
  }
});

app.post("/set-delegation", async (req, res) => {
  let tmpFile;
  try {
    const { adminUpn, adminPassword, licensedUserUpn, emails } = req.body;
    if (!adminUpn || !adminPassword || !licensedUserUpn || !Array.isArray(emails) || emails.length === 0) {
      return res.status(400).json({ error: "Missing required fields" });
    }

    tmpFile = path.join(os.tmpdir(), `delegation-emails-${Date.now()}-${Math.random().toString(36).slice(2)}.json`);
    fs.writeFileSync(tmpFile, JSON.stringify(emails));

    const escapedAdminUpn = escapePowerShellString(adminUpn);
    const escapedAdminPassword = escapePowerShellString(adminPassword);
    const escapedLicensedUser = escapePowerShellString(licensedUserUpn);
    const escapedTmpFile = escapePowerShellString(tmpFile);

    const script = `
$ErrorActionPreference = "Continue"
$securePassword = ConvertTo-SecureString "${escapedAdminPassword}" -AsPlainText -Force
$credential = New-Object System.Management.Automation.PSCredential("${escapedAdminUpn}", $securePassword)
Connect-ExchangeOnline -Credential $credential -ShowBanner:$false

$licensedUser = "${escapedLicensedUser}"
$results = @()
$emails = Get-Content -Raw -Path "${escapedTmpFile}" | ConvertFrom-Json
$counter = 1

foreach ($email in $emails) {
  try {
    Add-MailboxPermission -Identity $email -User $licensedUser -AccessRights FullAccess -InheritanceType All -AutoMapping $false -Confirm:$false | Out-Null
    Add-RecipientPermission -Identity $email -Trustee $licensedUser -AccessRights SendAs -Confirm:$false | Out-Null
    Set-Mailbox -Identity $email -GrantSendOnBehalfTo $licensedUser | Out-Null
    $results += @{ email = $email; status = "delegated" }
  } catch {
    $results += @{ email = $email; status = "failed"; error = $_.Exception.Message }
  }
  Write-Host "[$counter/$($emails.Count)] $email -> $($results[-1].status)"
  $counter++
}

Disconnect-ExchangeOnline -Confirm:$false 2>$null
$results | ConvertTo-Json -Compress
`;

    const output = await runPowerShell(script, 1200000);
    res.json({ success: true, results: JSON.parse(output) });
  } catch (error) {
    res.status(500).json({ error: error.message });
  } finally {
    if (tmpFile) {
      try {
        fs.unlinkSync(tmpFile);
      } catch {}
    }
  }
});

app.post("/configure-dkim", async (req, res) => {
  try {
    const { adminUpn, adminPassword, domain } = req.body;
    if (!adminUpn || !adminPassword || !domain) {
      return res.status(400).json({ error: "Missing required fields" });
    }

    const escapedAdminUpn = escapePowerShellString(adminUpn);
    const escapedAdminPassword = escapePowerShellString(adminPassword);
    const escapedDomain = escapePowerShellString(domain);

    const script = `
$ErrorActionPreference = "Stop"
$securePassword = ConvertTo-SecureString "${escapedAdminPassword}" -AsPlainText -Force
$credential = New-Object System.Management.Automation.PSCredential("${escapedAdminUpn}", $securePassword)
Connect-ExchangeOnline -Credential $credential -ShowBanner:$false

$domain = "${escapedDomain}"

try {
  New-DkimSigningConfig -DomainName $domain -Enabled $false
} catch {
  if (-not ($_.Exception.Message -like "*already exists*")) {
    throw $_
  }
}

$dkimConfig = Get-DkimSigningConfig -Identity $domain
$selector1 = $dkimConfig.Selector1CNAME
$selector2 = $dkimConfig.Selector2CNAME

$result = @{
  selector1CNAME = $selector1
  selector2CNAME = $selector2
  domain = $domain
}

Disconnect-ExchangeOnline -Confirm:$false 2>$null
$result | ConvertTo-Json -Compress
`;

    const output = await runPowerShell(script, 120000);
    res.json({ success: true, ...JSON.parse(output) });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post("/enable-dkim", async (req, res) => {
  try {
    const { adminUpn, adminPassword, domain } = req.body;
    if (!adminUpn || !adminPassword || !domain) {
      return res.status(400).json({ error: "Missing required fields" });
    }

    const escapedAdminUpn = escapePowerShellString(adminUpn);
    const escapedAdminPassword = escapePowerShellString(adminPassword);
    const escapedDomain = escapePowerShellString(domain);

    const script = `
$ErrorActionPreference = "Stop"
$securePassword = ConvertTo-SecureString "${escapedAdminPassword}" -AsPlainText -Force
$credential = New-Object System.Management.Automation.PSCredential("${escapedAdminUpn}", $securePassword)
Connect-ExchangeOnline -Credential $credential -ShowBanner:$false

Set-DkimSigningConfig -Identity "${escapedDomain}" -Enabled $true

Disconnect-ExchangeOnline -Confirm:$false 2>$null
@{ status = "enabled"; domain = "${escapedDomain}" } | ConvertTo-Json -Compress
`;

    const output = await runPowerShell(script, 120000);
    res.json({ success: true, ...JSON.parse(output) });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.listen(PORT, () => {
  console.log(`Exchange PowerShell service running on port ${PORT}`);
});
