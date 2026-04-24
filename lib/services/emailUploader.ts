/**
 * Bridge from azure's tenant processor to the email-uploader Railway service.
 *
 * Called per-tenant once provisioning finishes (Phase 4 complete). Pulls the
 * batch-level uploader config captured in the bulk upload UI, builds the
 * mailbox CSV from the tenant's inbox names + encrypted admin password, and
 * POSTs to the uploader's /api/start. Returns the uploader's job_id so the
 * caller can store it and a poller can track progress.
 *
 * Credentials resolution is batch-only — no env-var fallbacks. Customers
 * must enter creds in the UI, which prevents accidentally leaking one
 * customer's workspace creds into another customer's batch.
 */

import { decryptSecret } from "@/lib/crypto";
import { prisma } from "@/lib/prisma";
import { logTenantEvent } from "@/lib/tenant-events";
import { generateEmailVariations } from "@/lib/services/email-generator";
import { parseInboxNamesValue } from "@/lib/utils";
import type { UploaderEsp } from "@prisma/client";

const UPLOADER_URL = (process.env.EMAIL_UPLOADER_URL || "").trim().replace(/\/$/, "");

// Worker count per upload job. Clamped 1..5 at the uploader (more than ~2
// Chromiums in a 1GB Hobby container OOMs). Bumping to a higher value when
// upgrading Railway plan is a single env-var change — no code redeploy.
const DEFAULT_WORKERS = (() => {
  const raw = Number(process.env.EMAIL_UPLOADER_DEFAULT_WORKERS || "2");
  if (!Number.isFinite(raw)) return 2;
  return Math.max(1, Math.min(5, Math.round(raw)));
})();

export type TriggerResult =
  | { ok: true; jobId: string }
  | { ok: true; skipped: true; reason: string }
  | { ok: false; error: string; retryable: boolean };

function safeDecrypt(value: string | null | undefined): string {
  if (!value) return "";
  try {
    return decryptSecret(value);
  } catch {
    // Fall back to plaintext — mirrors the adminPassword pattern elsewhere.
    return value;
  }
}

function buildMailboxCsv(tenant: {
  inboxNames: string;
  domain: string;
  inboxCount: number;
  adminPassword: string;
}): string {
  const names = parseInboxNamesValue(tenant.inboxNames);
  const variations = generateEmailVariations(names, tenant.domain, tenant.inboxCount);
  const password = safeDecrypt(tenant.adminPassword);

  const lines = ["DisplayName,EmailAddress,Password"];
  for (const v of variations) {
    const display = (v.displayName || v.email.split("@")[0]).replace(/,/g, " ");
    lines.push(`${display},${v.email},${password}`);
  }
  return lines.join("\n");
}

/**
 * Start an Instantly upload for a tenant. Returns the uploader's job_id on
 * success, a skip reason when config is absent, or a retryable/terminal
 * error. Does NOT write to the tenant row — caller owns DB state.
 */
async function startInstantlyUpload(opts: {
  tenantId: string;
  batchId: string;
  csv: string;
  filename: string;
  cfg: {
    instantlyEmail: string;
    instantlyPassword: string;
    instantlyV1Key: string;
    instantlyV2Key: string;
    instantlyWorkspace: string;
    instantlyApiVersion: string;
  };
}): Promise<TriggerResult> {
  const { cfg } = opts;
  if (!cfg.instantlyEmail || !cfg.instantlyPassword) {
    return { ok: false, error: "Instantly login email/password missing on batch", retryable: false };
  }
  if (!cfg.instantlyV1Key && !cfg.instantlyV2Key) {
    return { ok: false, error: "Instantly API key (v1 or v2) missing on batch", retryable: false };
  }

  const apiVersion = cfg.instantlyApiVersion === "v2" && cfg.instantlyV2Key ? "v2" : "v1";
  const apiKey = cfg.instantlyV1Key || cfg.instantlyV2Key;
  const mode = cfg.instantlyWorkspace ? "multi" : "single";
  const workers = DEFAULT_WORKERS;

  const form = new FormData();
  form.append("platform", "instantly");
  form.append("mode", mode);
  form.append("api_version", apiVersion);
  form.append("api_key", apiKey);
  form.append("v2_api_key", cfg.instantlyV2Key);
  form.append("instantly_email", cfg.instantlyEmail);
  form.append("instantly_password", cfg.instantlyPassword);
  form.append("workspace", cfg.instantlyWorkspace);
  form.append("workers", String(workers));
  form.append("csv_file", new Blob([opts.csv], { type: "text/csv" }), opts.filename);

  return postStart(opts.tenantId, opts.batchId, form);
}

async function startSmartleadUpload(opts: {
  tenantId: string;
  batchId: string;
  csv: string;
  filename: string;
  cfg: {
    smartleadApiKey: string;
    smartleadLoginUrl: string;
  };
}): Promise<TriggerResult> {
  const { cfg } = opts;
  if (!cfg.smartleadApiKey) {
    return { ok: false, error: "Smartlead API key missing on batch", retryable: false };
  }
  if (!cfg.smartleadLoginUrl) {
    return { ok: false, error: "Smartlead Microsoft OAuth login URL missing on batch", retryable: false };
  }

  const form = new FormData();
  form.append("platform", "smartlead_upload");
  form.append("api_key", cfg.smartleadApiKey);
  form.append("login_url", cfg.smartleadLoginUrl);
  form.append("csv_file", new Blob([opts.csv], { type: "text/csv" }), opts.filename);

  return postStart(opts.tenantId, opts.batchId, form);
}

async function postStart(
  tenantId: string,
  batchId: string,
  form: FormData
): Promise<TriggerResult> {
  if (!UPLOADER_URL) {
    return { ok: true, skipped: true, reason: "EMAIL_UPLOADER_URL not set" };
  }

  let resp: Response;
  try {
    resp = await fetch(`${UPLOADER_URL}/api/start`, { method: "POST", body: form });
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    await logTenantEvent({
      batchId,
      tenantId,
      eventType: "uploader_trigger_failed",
      level: "warn",
      message: `uploader unreachable: ${msg}`
    });
    return { ok: false, error: `uploader unreachable: ${msg}`, retryable: true };
  }

  // 429 = concurrent-jobs cap reached on uploader side. Retryable.
  if (resp.status === 429) {
    return { ok: false, error: "uploader busy (429)", retryable: true };
  }

  const text = await resp.text();
  let data: { job_id?: string; error?: string } = {};
  try {
    data = JSON.parse(text);
  } catch {
    /* non-json body — fall through and surface raw text */
  }

  if (!resp.ok || !data.job_id) {
    const err = data.error || text.slice(0, 300) || `HTTP ${resp.status}`;
    // 5xx is likely transient; 4xx (other than 429) is our fault.
    const retryable = resp.status >= 500;
    return { ok: false, error: err, retryable };
  }

  return { ok: true, jobId: data.job_id };
}

/**
 * Main entry point called from the BullMQ upload worker. Resolves the
 * batch config, builds the CSV, dispatches to the right ESP-specific start
 * function, and logs an event on success.
 */
export async function triggerUploadForTenant(tenantDbId: string): Promise<TriggerResult> {
  const tenant = await prisma.tenant.findUnique({
    where: { id: tenantDbId },
    select: {
      id: true,
      batchId: true,
      tenantName: true,
      domain: true,
      inboxNames: true,
      inboxCount: true,
      adminPassword: true,
      uploaderJobId: true,
      uploaderStatus: true,
      batch: {
        select: {
          uploaderEsp: true,
          uploaderAutoTrigger: true,
          instantlyEmail: true,
          instantlyPassword: true,
          instantlyV1Key: true,
          instantlyV2Key: true,
          instantlyWorkspace: true,
          instantlyApiVersion: true,
          smartleadApiKey: true,
          smartleadLoginUrl: true
        }
      }
    }
  });

  if (!tenant) return { ok: false, error: "Tenant not found", retryable: false };
  if (!tenant.batch.uploaderAutoTrigger) {
    return { ok: true, skipped: true, reason: "batch.uploaderAutoTrigger is false" };
  }

  const esp: UploaderEsp | null = tenant.batch.uploaderEsp;
  if (!esp) {
    return { ok: true, skipped: true, reason: "batch has no uploaderEsp set" };
  }

  // Idempotency: skip if already queued/running/completed.
  if (tenant.uploaderJobId && tenant.uploaderStatus !== "idle" && tenant.uploaderStatus !== "failed") {
    return { ok: true, skipped: true, reason: `already ${tenant.uploaderStatus} (job ${tenant.uploaderJobId})` };
  }

  const csv = buildMailboxCsv({
    inboxNames: tenant.inboxNames,
    domain: tenant.domain,
    inboxCount: tenant.inboxCount,
    adminPassword: tenant.adminPassword
  });
  const filename = `${tenant.tenantName}-${tenant.domain}.csv`;

  let result: TriggerResult;
  if (esp === "instantly") {
    result = await startInstantlyUpload({
      tenantId: tenant.id,
      batchId: tenant.batchId,
      csv,
      filename,
      cfg: {
        instantlyEmail: (tenant.batch.instantlyEmail || "").trim(),
        instantlyPassword: safeDecrypt(tenant.batch.instantlyPassword),
        instantlyV1Key: safeDecrypt(tenant.batch.instantlyV1Key),
        instantlyV2Key: safeDecrypt(tenant.batch.instantlyV2Key),
        instantlyWorkspace: (tenant.batch.instantlyWorkspace || "").trim(),
        instantlyApiVersion: tenant.batch.instantlyApiVersion || "v1"
      }
    });
  } else {
    result = await startSmartleadUpload({
      tenantId: tenant.id,
      batchId: tenant.batchId,
      csv,
      filename,
      cfg: {
        smartleadApiKey: safeDecrypt(tenant.batch.smartleadApiKey),
        smartleadLoginUrl: (tenant.batch.smartleadLoginUrl || "").trim()
      }
    });
  }

  if (result.ok && !("skipped" in result)) {
    await logTenantEvent({
      batchId: tenant.batchId,
      tenantId: tenant.id,
      eventType: "uploader_triggered",
      message: `${esp} upload started (job ${result.jobId})`,
      details: { esp, jobId: result.jobId }
    });
  } else if (!result.ok) {
    await logTenantEvent({
      batchId: tenant.batchId,
      tenantId: tenant.id,
      eventType: "uploader_trigger_failed",
      level: result.retryable ? "warn" : "error",
      message: `${esp} upload failed to start: ${result.error}`,
      details: { esp, retryable: result.retryable }
    });
  }

  return result;
}

export const uploaderServiceConfigured = Boolean(UPLOADER_URL);
export { UPLOADER_URL };
