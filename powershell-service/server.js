require('dotenv').config();
const express = require("express");
const { spawn } = require("child_process");
const fs = require("fs");
const path = require("path");
const os = require("os");

const app = express();
app.use(express.json());

const PORT = process.env.PS_SERVICE_PORT || 3099;
const delegationJobs = new Map();
const mailboxCreationJobs = new Map();

function escapePowerShellString(value) {
  return String(value || "")
    .replace(/`/g, "``")
    .replace(/"/g, '`"');
}

function stripAnsi(str) {
  return str.replace(/\u001b\[[0-9;]*m/g, "");
}

function parseJsonFromPowerShellOutput(output) {
  const cleaned = stripAnsi(String(output || "")).trim();
  if (!cleaned) {
    throw new Error("PowerShell returned empty output");
  }

  try {
    return JSON.parse(cleaned);
  } catch {}

  const lines = cleaned.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const line = lines[i];
    if (!(line.startsWith("[") || line.startsWith("{"))) continue;
    try {
      return JSON.parse(line);
    } catch {}
  }

  const candidateStarts = [cleaned.lastIndexOf("["), cleaned.lastIndexOf("{")]
    .filter((index) => index >= 0)
    .sort((a, b) => b - a);
  for (const start of candidateStarts) {
    const candidate = cleaned.slice(start).trim();
    try {
      return JSON.parse(candidate);
    } catch {}
  }

  throw new Error(`Unable to parse JSON payload from PowerShell output: ${cleaned.slice(0, 300)}`);
}

function parseDelegationResultsFromLogs(output) {
  const cleaned = stripAnsi(String(output || ""));
  const lines = cleaned.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const results = [];

  for (const line of lines) {
    const match = line.match(/\[\d+\s*\/\s*\d+\]\s+(.+?)\s+->\s+([a-zA-Z]+)/);
    if (!match) continue;

    const email = match[1].trim();
    const status = match[2].trim().toLowerCase();
    if (!email) continue;

    results.push({ email, status });
  }

  return results;
}

function runPowerShell(script, timeout = 1200000) {
  return new Promise((resolve, reject) => {
    const spawnOptions = { env: { ...process.env } };
    if (Number.isFinite(timeout) && timeout > 0) {
      spawnOptions.timeout = timeout;
    }
    const ps = spawn("pwsh", ["-NoProfile", "-NonInteractive", "-Command", script], spawnOptions);

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

function runPowerShellStreaming(script, { timeout = null, inactivityTimeout = 1200000, onStdout, onStderr } = {}) {
  return new Promise((resolve, reject) => {
    const ps = spawn("pwsh", ["-NoProfile", "-NonInteractive", "-Command", script], {
      env: { ...process.env }
    });

    let stdout = "";
    let stderr = "";
    let timeoutReason = null;
    let runtimeTimer = null;
    let inactivityTimer = null;

    const clearTimers = () => {
      if (runtimeTimer) {
        clearTimeout(runtimeTimer);
      }
      if (inactivityTimer) {
        clearTimeout(inactivityTimer);
      }
    };

    const killPowerShell = (reason) => {
      timeoutReason = reason;
      try {
        ps.kill("SIGTERM");
      } catch {}
    };

    const resetInactivityTimer = () => {
      if (!Number.isFinite(inactivityTimeout) || inactivityTimeout <= 0) return;
      if (inactivityTimer) {
        clearTimeout(inactivityTimer);
      }
      inactivityTimer = setTimeout(() => {
        killPowerShell("inactivity");
      }, inactivityTimeout);
    };

    if (Number.isFinite(timeout) && timeout > 0) {
      runtimeTimer = setTimeout(() => {
        killPowerShell("runtime");
      }, timeout);
    }
    resetInactivityTimer();

    ps.stdout.on("data", (data) => {
      const text = stripAnsi(data.toString());
      stdout += text;
      resetInactivityTimer();
      if (typeof onStdout === "function") {
        onStdout(text);
      }
    });

    ps.stderr.on("data", (data) => {
      const text = stripAnsi(data.toString());
      stderr += text;
      resetInactivityTimer();
      if (typeof onStderr === "function") {
        onStderr(text);
      }
    });

    ps.on("close", (code) => {
      clearTimers();
      if (timeoutReason === "runtime") {
        reject(new Error(`PowerShell timed out after ${Math.round(timeout / 1000)}s`));
        return;
      }
      if (timeoutReason === "inactivity") {
        reject(new Error(`PowerShell stalled with no output for ${Math.round(inactivityTimeout / 1000)}s`));
        return;
      }

      if (code !== 0) {
        reject(new Error(`PowerShell exited with code ${code}: ${stripAnsi(stderr)}`));
      } else {
        resolve(stripAnsi(stdout.trim()));
      }
    });

    ps.on("error", (error) => {
      clearTimers();
      reject(error);
    });
  });
}

function parseEnvInt(value, fallback) {
  const parsed = Number.parseInt(String(value || ""), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function getMailboxStallTimeoutMs() {
  return parseEnvInt(process.env.MAILBOX_STALL_TIMEOUT_MS, 1800000);
}

function getDelegationStallTimeoutMs() {
  return parseEnvInt(process.env.DELEGATION_STALL_TIMEOUT_MS, 1800000);
}

function upsertMailboxResult(job, state, result) {
  if (!state || !(state.resultsByEmail instanceof Map)) return;
  if (!result || typeof result !== "object") return;
  const email = typeof result.email === "string" ? result.email.trim().toLowerCase() : "";
  if (!email) return;

  const status = typeof result.status === "string" ? result.status.trim().toLowerCase() : "";
  if (!status) return;

  const existing = state.resultsByEmail.get(email) || { email, error: null };
  const merged = {
    ...existing,
    email,
    status,
    error: result.error == null ? (existing.error ?? null) : String(result.error)
  };

  state.resultsByEmail.set(email, merged);
  job.results = Array.from(state.resultsByEmail.values());
}

function mergeMailboxResults(job, state, results) {
  if (!Array.isArray(results)) return;
  for (const result of results) {
    upsertMailboxResult(job, state, result);
  }
}

function updateProgressFromChunk(job, chunk, state) {
  state.buffer += String(chunk || "");
  const parts = state.buffer.split(/\r?\n/);
  state.buffer = parts.pop() || "";

  for (const line of parts) {
    const progressMatch = line.match(/\[(\d+)\s*\/\s*(\d+)\]/);
    if (!progressMatch) continue;
    const completed = Number(progressMatch[1]);
    const total = Number(progressMatch[2]);
    if (Number.isFinite(total) && total > 0) {
      job.total = total;
    }
    if (Number.isFinite(completed) && completed >= 0) {
      job.completed = Math.max(job.completed || 0, completed);
    }

    const resultMatch = line.match(/\[\d+\s*\/\s*\d+\]\s+(.+?)\s+->\s+([a-zA-Z]+)/);
    if (resultMatch) {
      upsertMailboxResult(job, state, {
        email: resultMatch[1],
        status: resultMatch[2]
      });
    }
  }
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
  $errMsg = $null
  try {
    # Check if mailbox already exists (idempotent on retry).
    $existing = $null
    try { $existing = Get-Mailbox -Identity $mb.email -ErrorAction SilentlyContinue } catch {}
    $nameParts = $mb.displayName.Trim() -split '\\s+', 2
    $firstName = $nameParts[0]
    $lastName = if ($nameParts.Length -gt 1) { $nameParts[1] } else { $nameParts[0] }

    if ($existing) {
      # Already exists - treat as success
      try { Set-Mailbox -Identity $mb.email -DisplayName $mb.displayName } catch {}
      try { Set-User -Identity $mb.email -FirstName $firstName -LastName $lastName } catch {}
      $results += @{ email = $mb.email; status = "exists"; error = $null }
    } else {
      # Use the email local-part as the AD Name (uniquely derived from the email,
      # which is guaranteed unique). The old counter-based name ("kunal Goyal 1",
      # "kunal Goyal 2", ...) resets every request and collides with AD Names
      # created on previous runs — Microsoft then returns "already exists" and the
      # catch-block heuristic silently mapped it to status=exists, leaving ghosts.
      $tempName = $mb.email.Split("@")[0]
      New-Mailbox -Name $tempName -Shared -PrimarySmtpAddress $mb.email -DisplayName $mb.displayName
      Start-Sleep -Seconds 2
      try { Set-Mailbox -Identity $mb.email -DisplayName $mb.displayName } catch {}
      try { Set-User -Identity $mb.email -FirstName $firstName -LastName $lastName } catch {}
      $results += @{ email = $mb.email; status = "created"; error = $null }
    }
  } catch {
    $errMsg = $_.Exception.Message
    # Don't trust the error text to decide existence. Ask Exchange directly.
    $verify = $null
    try { $verify = Get-Mailbox -Identity $mb.email -ErrorAction SilentlyContinue } catch {}
    if ($verify) {
      # Something went wrong mid-config but the mailbox itself is there.
      # Preserve the error message so we can diagnose.
      $results += @{ email = $mb.email; status = "exists"; error = $errMsg }
    } else {
      # Genuine failure - mailbox does not exist in Exchange.
      $results += @{ email = $mb.email; status = "failed"; error = $errMsg }
    }
  }
  [Console]::Error.WriteLine("[$counter/$($mailboxData.Count)] $($mb.email) -> $($results[-1].status)$(if ($errMsg) { ' (' + $errMsg.Substring(0, [Math]::Min(120, $errMsg.Length)) + ')' } else { '' })")
  $counter++
}

Disconnect-ExchangeOnline -Confirm:$false 2>$null
$results | ConvertTo-Json -Compress
`;

    const output = await runPowerShell(script, null);
    const parsed = parseJsonFromPowerShellOutput(output);
    const results = Array.isArray(parsed)
      ? parsed
      : (Array.isArray(parsed?.results) ? parsed.results : null);

    if (!results) {
      return res.status(502).json({
        error: "PowerShell returned an unexpected mailbox result payload",
        details: typeof parsed === "object" ? parsed : String(parsed)
      });
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

app.post("/start-create-shared-mailboxes", async (req, res) => {
  let tmpFile;
  try {
    const { adminUpn, adminPassword, organizationId, mailboxes } = req.body;

    if (!adminUpn || !adminPassword || !organizationId || !Array.isArray(mailboxes) || mailboxes.length === 0) {
      return res.status(400).json({ error: "Missing required fields" });
    }

    const jobId = `create-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const job = { status: "running", completed: 0, total: mailboxes.length, error: null, results: [] };
    mailboxCreationJobs.set(jobId, job);

    res.json({ success: true, jobId, status: "started", total: mailboxes.length });

    tmpFile = path.join(os.tmpdir(), `mailboxes-${jobId}.json`);
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
  $errMsg = $null
  try {
    # Check if mailbox already exists (idempotent on retry).
    $existing = $null
    try { $existing = Get-Mailbox -Identity $mb.email -ErrorAction SilentlyContinue } catch {}
    $nameParts = $mb.displayName.Trim() -split '\\s+', 2
    $firstName = $nameParts[0]
    $lastName = if ($nameParts.Length -gt 1) { $nameParts[1] } else { $nameParts[0] }

    if ($existing) {
      # Already exists - treat as success
      try { Set-Mailbox -Identity $mb.email -DisplayName $mb.displayName } catch {}
      try { Set-User -Identity $mb.email -FirstName $firstName -LastName $lastName } catch {}
      $results += @{ email = $mb.email; status = "exists"; error = $null }
    } else {
      # Use the email local-part as the AD Name (uniquely derived from the email,
      # which is guaranteed unique). The old counter-based name ("kunal Goyal 1",
      # "kunal Goyal 2", ...) resets every request and collides with AD Names
      # created on previous runs — Microsoft then returns "already exists" and the
      # catch-block heuristic silently mapped it to status=exists, leaving ghosts.
      $tempName = $mb.email.Split("@")[0]
      New-Mailbox -Name $tempName -Shared -PrimarySmtpAddress $mb.email -DisplayName $mb.displayName
      Start-Sleep -Seconds 2
      try { Set-Mailbox -Identity $mb.email -DisplayName $mb.displayName } catch {}
      try { Set-User -Identity $mb.email -FirstName $firstName -LastName $lastName } catch {}
      $results += @{ email = $mb.email; status = "created"; error = $null }
    }
  } catch {
    $errMsg = $_.Exception.Message
    # Don't trust the error text to decide existence. Ask Exchange directly.
    $verify = $null
    try { $verify = Get-Mailbox -Identity $mb.email -ErrorAction SilentlyContinue } catch {}
    if ($verify) {
      # Something went wrong mid-config but the mailbox itself is there.
      # Preserve the error message so we can diagnose.
      $results += @{ email = $mb.email; status = "exists"; error = $errMsg }
    } else {
      # Genuine failure - mailbox does not exist in Exchange.
      $results += @{ email = $mb.email; status = "failed"; error = $errMsg }
    }
  }
  [Console]::Error.WriteLine("[$counter/$($mailboxData.Count)] $($mb.email) -> $($results[-1].status)$(if ($errMsg) { ' (' + $errMsg.Substring(0, [Math]::Min(120, $errMsg.Length)) + ')' } else { '' })")
  $counter++
}

Disconnect-ExchangeOnline -Confirm:$false 2>$null
$results | ConvertTo-Json -Compress
`;

    const progressState = { buffer: "", resultsByEmail: new Map() };
    runPowerShellStreaming(script, {
      timeout: null,
      inactivityTimeout: getMailboxStallTimeoutMs(),
      onStdout: (text) => updateProgressFromChunk(job, text, progressState),
      onStderr: (text) => updateProgressFromChunk(job, text, progressState)
    })
      .then((output) => {
        const parsed = parseJsonFromPowerShellOutput(output);
        const results = Array.isArray(parsed)
          ? parsed
          : (Array.isArray(parsed?.results) ? parsed.results : []);
        mergeMailboxResults(job, progressState, results);
        job.status = "completed";
        job.completed = job.total;
      })
      .catch((error) => {
        job.status = "failed";
        job.error = error.message || String(error);
      })
      .finally(() => {
        if (tmpFile) {
          try {
            fs.unlinkSync(tmpFile);
          } catch {}
        }
      });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get("/create-shared-mailboxes-status/:jobId", (req, res) => {
  const job = mailboxCreationJobs.get(req.params.jobId);
  if (!job) return res.status(404).json({ error: "Job not found" });
  res.json(job);
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
    const parsed = parseJsonFromPowerShellOutput(output);
    const results = Array.isArray(parsed) ? parsed : (Array.isArray(parsed?.results) ? parsed.results : []);
    res.json({ success: true, results });
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

app.post("/start-delegation", async (req, res) => {
  try {
    const { adminUpn, adminPassword, licensedUserUpn, staleDelegateUpn, emails } = req.body;
    if (!adminUpn || !adminPassword || !licensedUserUpn || !Array.isArray(emails) || emails.length === 0) {
      return res.status(400).json({ error: "Missing required fields" });
    }

    const jobId = Date.now().toString();
    const job = { status: "running", completed: 0, total: emails.length, errors: [], results: [] };
    delegationJobs.set(jobId, job);

    // Respond immediately with jobId
    res.json({ success: true, jobId, status: "started", total: emails.length });

    // Run delegation in background (don't await in the request handler)
    const tmpFile = path.join(os.tmpdir(), `delegation-${jobId}.json`);
    fs.writeFileSync(tmpFile, JSON.stringify(emails));

    const escapedAdminUpn = escapePowerShellString(adminUpn);
    const escapedAdminPassword = escapePowerShellString(adminPassword);
    const escapedLicensedUser = escapePowerShellString(licensedUserUpn);
    const escapedStaleDelegate = escapePowerShellString(staleDelegateUpn || "");
    const escapedTmpFile = escapePowerShellString(tmpFile);

    const script = `
$ErrorActionPreference = "Continue"
$securePassword = ConvertTo-SecureString "${escapedAdminPassword}" -AsPlainText -Force
$credential = New-Object System.Management.Automation.PSCredential("${escapedAdminUpn}", $securePassword)
Connect-ExchangeOnline -Credential $credential -ShowBanner:$false

$licensedUser = "${escapedLicensedUser}"
$staleDelegate = "${escapedStaleDelegate}"
$results = @()
$emails = Get-Content -Raw -Path "${escapedTmpFile}" | ConvertFrom-Json
$counter = 1

$delegateRecipient = $null
try {
  $delegateRecipient = Get-Recipient -Identity $licensedUser -ErrorAction Stop
} catch {}

if (-not $delegateRecipient) {
  throw "Delegation principal '$licensedUser' was not found in Exchange. Wait for user propagation and retry."
}

function Test-DelegationState {
  param(
    [string]$MailboxIdentity,
    [string]$DelegateUpn
  )

  $fullAccess = $false
  $sendAs = $false
  $sendOnBehalf = $false
  $delegateLower = $DelegateUpn.ToLower()

  try {
    $fullAccess = @(
      Get-MailboxPermission -Identity $MailboxIdentity -User $DelegateUpn -ErrorAction SilentlyContinue |
      Where-Object { $_.AccessRights -contains "FullAccess" -and -not $_.Deny }
    ).Count -gt 0
  } catch {}

  try {
    $sendAs = @(
      Get-RecipientPermission -Identity $MailboxIdentity -Trustee $DelegateUpn -ErrorAction SilentlyContinue |
      Where-Object { $_.AccessRights -contains "SendAs" -and -not $_.Deny }
    ).Count -gt 0
  } catch {}

  try {
    $mailbox = Get-Mailbox -Identity $MailboxIdentity -ErrorAction SilentlyContinue
    if ($mailbox) {
      $sendOnBehalf = @($mailbox.GrantSendOnBehalfTo | ForEach-Object { $_.ToString().ToLower() }) -contains $delegateLower
    }
  } catch {}

  return @{
    fullAccess = $fullAccess
    sendAs = $sendAs
    sendOnBehalf = $sendOnBehalf
  }
}

foreach ($email in $emails) {
  $stepErrors = @()

  if ($staleDelegate -and $staleDelegate.ToLower() -ne $licensedUser.ToLower()) {
    try { Remove-MailboxPermission -Identity $email -User $staleDelegate -AccessRights FullAccess -Confirm:$false -ErrorAction SilentlyContinue | Out-Null } catch {}
    try { Remove-RecipientPermission -Identity $email -Trustee $staleDelegate -AccessRights SendAs -Confirm:$false -ErrorAction SilentlyContinue | Out-Null } catch {}
    try {
      $mbExisting = Get-Mailbox -Identity $email -ErrorAction SilentlyContinue
      if ($mbExisting) {
        $existingDelegates = @($mbExisting.GrantSendOnBehalfTo | ForEach-Object { $_.ToString() })
        if ($existingDelegates.Count -gt 0) {
          $updatedDelegates = @($existingDelegates | Where-Object { $_.ToLower() -ne $staleDelegate.ToLower() })
          Set-Mailbox -Identity $email -GrantSendOnBehalfTo $updatedDelegates -ErrorAction SilentlyContinue | Out-Null
        }
      }
    } catch {}
  }

  try { Add-MailboxPermission -Identity $email -User $licensedUser -AccessRights FullAccess -InheritanceType All -AutoMapping $false -Confirm:$false -ErrorAction Stop | Out-Null }
  catch { if ($_.Exception.Message -notmatch 'already|duplicate') { $stepErrors += "FullAccess: $($_.Exception.Message)" } }

  try { Add-RecipientPermission -Identity $email -Trustee $licensedUser -AccessRights SendAs -Confirm:$false -ErrorAction Stop | Out-Null }
  catch { if ($_.Exception.Message -notmatch 'already|duplicate') { $stepErrors += "SendAs: $($_.Exception.Message)" } }

  try { Set-Mailbox -Identity $email -GrantSendOnBehalfTo $licensedUser -ErrorAction Stop | Out-Null }
  catch { if ($_.Exception.Message -notmatch 'already|duplicate') { $stepErrors += "SendOnBehalf: $($_.Exception.Message)" } }

  if ($stepErrors.Count -eq 0) {
    $results += @{ email = $email; status = "applied"; errors = $null }
  } else {
    $results += @{ email = $email; status = "partial"; errors = ($stepErrors -join "; ") }
  }

  Write-Host "[$counter/$($emails.Count)] $email -> $($results[-1].status)"
  $counter++
}

# Give Exchange time to converge permission writes before final verification.
Start-Sleep -Seconds 10

$verifyCounter = 1
foreach ($result in $results) {
  $email = $result.email
  $verification = Test-DelegationState -MailboxIdentity $email -DelegateUpn $licensedUser
  $verified = $verification.fullAccess -and $verification.sendAs

  if ($verified) {
    $result.status = "delegated"
    $result.errors = $null
  } else {
    $verifyError = "Verification failed: FullAccess=$($verification.fullAccess), SendAs=$($verification.sendAs), SendOnBehalf=$($verification.sendOnBehalf)"
    if ($result.errors) {
      $result.errors = "$($result.errors); $verifyError"
    } else {
      $result.errors = $verifyError
    }
    $result.status = "partial"
  }

  $result.verification = $verification
  [Console]::Error.WriteLine("[$verifyCounter/$($results.Count)] $email -> $($result.status)")
  $verifyCounter++
}

Disconnect-ExchangeOnline -Confirm:$false 2>$null
$results | ConvertTo-Json -Compress
`;

    const progressState = { buffer: "", resultsByEmail: new Map() };
    runPowerShellStreaming(script, {
      timeout: null,
      inactivityTimeout: getDelegationStallTimeoutMs(),
      onStdout: (text) => updateProgressFromChunk(job, text, progressState),
      onStderr: (text) => updateProgressFromChunk(job, text, progressState)
    })
      .then((output) => {
        job.status = "completed";
        job.completed = emails.length;
        try {
          const parsed = parseJsonFromPowerShellOutput(output);
          const parsedResults = Array.isArray(parsed) ? parsed : [];
          mergeMailboxResults(job, progressState, parsedResults);
          if (Array.isArray(parsed) && parsed.length > 0) {
            job.results = parsed;
          }
        } catch {
          const parsedFromLogs = parseDelegationResultsFromLogs(output);
          job.results = parsedFromLogs;
          if (parsedFromLogs.length === 0) {
            job.errors = ["Delegation output could not be parsed into structured results"];
          }
        }
        console.log(`Delegation job ${jobId} completed: ${emails.length} mailboxes`);
      })
      .catch((error) => {
        job.status = "failed";
        job.error = error.message;
        console.error(`Delegation job ${jobId} failed:`, error.message);
      })
      .finally(() => {
        try { fs.unlinkSync(tmpFile); } catch {}
      });

  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get("/delegation-status/:jobId", (req, res) => {
  const job = delegationJobs.get(req.params.jobId);
  if (!job) return res.status(404).json({ error: "Job not found" });
  res.json(job);
});

app.post("/verify-delegation", async (req, res) => {
  let tmpFile;
  try {
    const { adminUpn, adminPassword, licensedUserUpn, emails } = req.body;
    if (!adminUpn || !adminPassword || !licensedUserUpn || !Array.isArray(emails) || emails.length === 0) {
      return res.status(400).json({ error: "Missing required fields" });
    }

    tmpFile = path.join(os.tmpdir(), `delegation-verify-${Date.now()}-${Math.random().toString(36).slice(2)}.json`);
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
$delegateLower = $licensedUser.ToLower()
$emails = Get-Content -Raw -Path "${escapedTmpFile}" | ConvertFrom-Json
$results = @()

foreach ($email in $emails) {
  $fullAccess = $false
  $sendAs = $false
  $sendOnBehalf = $false

  try {
    $fullAccess = @(
      Get-MailboxPermission -Identity $email -User $licensedUser -ErrorAction SilentlyContinue |
      Where-Object { $_.AccessRights -contains "FullAccess" -and -not $_.Deny }
    ).Count -gt 0
  } catch {}

  try {
    $sendAs = @(
      Get-RecipientPermission -Identity $email -Trustee $licensedUser -ErrorAction SilentlyContinue |
      Where-Object { $_.AccessRights -contains "SendAs" -and -not $_.Deny }
    ).Count -gt 0
  } catch {}

  try {
    $mailbox = Get-Mailbox -Identity $email -ErrorAction SilentlyContinue
    if ($mailbox) {
      $sendOnBehalf = @($mailbox.GrantSendOnBehalfTo | ForEach-Object { $_.ToString().ToLower() }) -contains $delegateLower
    }
  } catch {}

  if ($fullAccess -and $sendAs) {
    $results += @{ email = $email; status = "delegated"; errors = $null; verification = @{ fullAccess = $fullAccess; sendAs = $sendAs; sendOnBehalf = $sendOnBehalf } }
  } else {
    $results += @{ email = $email; status = "partial"; errors = "Verification failed: FullAccess=$fullAccess, SendAs=$sendAs, SendOnBehalf=$sendOnBehalf"; verification = @{ fullAccess = $fullAccess; sendAs = $sendAs; sendOnBehalf = $sendOnBehalf } }
  }
}

Disconnect-ExchangeOnline -Confirm:$false 2>$null
$results | ConvertTo-Json -Compress
`;

    const output = await runPowerShell(script, 300000);
    const parsed = parseJsonFromPowerShellOutput(output);
    const results = Array.isArray(parsed) ? parsed : [];
    res.json({ success: true, results });
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
  New-DkimSigningConfig -DomainName $domain -Enabled $false | Out-Null
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
    const parsed = parseJsonFromPowerShellOutput(output);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return res.status(502).json({
        error: "PowerShell returned an unexpected DKIM payload",
        details: String(output).slice(0, 500)
      });
    }

    res.json({ success: true, ...parsed });
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

Set-DkimSigningConfig -Identity "${escapedDomain}" -Enabled $true | Out-Null

Disconnect-ExchangeOnline -Confirm:$false 2>$null
@{ status = "enabled"; domain = "${escapedDomain}" } | ConvertTo-Json -Compress
`;

    const output = await runPowerShell(script, 120000);
    const parsed = parseJsonFromPowerShellOutput(output);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return res.status(502).json({
        error: "PowerShell returned an unexpected DKIM enable payload",
        details: String(output).slice(0, 500)
      });
    }

    res.json({ success: true, ...parsed });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ──────────────────────────────────────
// Teardown: Remove shared mailboxes
// ──────────────────────────────────────
app.post("/remove-shared-mailboxes", async (req, res) => {
  const { adminUpn, adminPassword, organizationId, emails } = req.body;
  if (!adminUpn || !adminPassword || !emails || !Array.isArray(emails) || emails.length === 0) {
    return res.status(400).json({ error: "adminUpn, adminPassword, and emails[] required" });
  }

  const safeAdminUpn = escapePowerShellString(adminUpn);
  const safeAdminPassword = escapePowerShellString(adminPassword);
  const safeOrgId = organizationId ? escapePowerShellString(organizationId) : "";

  const emailList = emails.map((e) => `"${escapePowerShellString(e)}"`).join(",");

  const orgParam = safeOrgId
    ? `-Organization "${safeOrgId}"`
    : "";

  const script = `
$ErrorActionPreference = "Continue"
$password = ConvertTo-SecureString "${safeAdminPassword}" -AsPlainText -Force
$cred = New-Object System.Management.Automation.PSCredential("${safeAdminUpn}", $password)
Connect-ExchangeOnline -Credential $cred ${orgParam} -ShowBanner:$false

$emails = @(${emailList})
$results = @()
foreach ($email in $emails) {
  try {
    Remove-Mailbox -Identity $email -Confirm:$false -Force -ErrorAction Stop
    $results += @{ email = $email; status = "removed" }
    Write-Host "Removed: $email"
  } catch {
    $results += @{ email = $email; status = "failed"; error = $_.Exception.Message }
    Write-Host "Failed: $email - $($_.Exception.Message)"
  }
}

Disconnect-ExchangeOnline -Confirm:$false -ErrorAction SilentlyContinue
$results | ConvertTo-Json -Depth 3
`;

  try {
    const result = await new Promise((resolve, reject) => {
      const tmpFile = path.join(os.tmpdir(), `ps-remove-mbx-${Date.now()}.ps1`);
      fs.writeFileSync(tmpFile, script);

      const child = spawn("pwsh", ["-NoProfile", "-NonInteractive", "-File", tmpFile]);
      let stdout = "";
      let stderr = "";

      child.stdout.on("data", (data) => { stdout += data.toString(); });
      child.stderr.on("data", (data) => { stderr += data.toString(); });

      child.on("close", (code) => {
        fs.unlinkSync(tmpFile);
        if (code !== 0) {
          reject(new Error(`PowerShell exited with code ${code}: ${stripAnsi(stderr || stdout).trim()}`));
        } else {
          resolve(stdout);
        }
      });
    });

    let parsed;
    try {
      parsed = parseJsonFromPowerShellOutput(result);
    } catch {
      parsed = { raw: stripAnsi(String(result)).trim() };
    }

    res.json({ ok: true, results: Array.isArray(parsed) ? parsed : [parsed] });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.listen(PORT, () => {
  console.log(`Exchange PowerShell service running on port ${PORT}`);
});
