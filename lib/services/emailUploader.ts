/**
 * Trigger the email-uploader service to push a tenant's shared mailboxes
 * into Instantly via the browser-OAuth path (through IPRoyal residential
 * proxy). Runs only when EMAIL_UPLOADER_URL env var is set.
 *
 * This is the bridge between azuremagicbu's tenant provisioning and the
 * email-uploader Railway service. After a tenant completes Phase 4 (DKIM
 * + optional API-based sequencer connect), we POST the tenant's mailbox
 * CSV to the uploader, which runs the full Instantly OAuth flow for each
 * account through residential IPs.
 *
 * Fire-and-forget: we store the returned job_id on the tenant row; the
 * uploader processes the job async. The uploader exposes /api/status/{id}
 * for polling — a future improvement would add a poller here that updates
 * tenant.uploaderStatus + counts. For now we just kick it off.
 */

import { decryptSecret } from "@/lib/crypto";
import { prisma } from "@/lib/prisma";
import { logTenantEvent } from "@/lib/tenant-events";
import { generateEmailVariations } from "@/lib/services/email-generator";
import { parseInboxNamesValue } from "@/lib/utils";

export interface TriggerUploadResult {
  ok: boolean;
  jobId?: string;
  skipped?: boolean;
  error?: string;
}

interface ResolvedUploaderCreds {
  url: string;
  email: string;
  password: string;
  v1Key: string;
  v2Key: string;
  workspace: string;
  workers: number;
  source: "batch" | "env" | "mixed";
}

/**
 * Try to decrypt a ciphertext; if decryption fails (e.g. the field was stored
 * plaintext during dev), fall back to the raw value. This mirrors the same
 * pattern used for Tenant.adminPassword elsewhere in the codebase.
 */
function safeDecrypt(value: string | null | undefined): string {
  if (!value) return "";
  try {
    return decryptSecret(value);
  } catch {
    return value;
  }
}

/**
 * Resolve Instantly creds for a batch. Priority:
 *   1. batch.instantly* fields (per-batch override, multi-tenant)
 *   2. INSTANTLY_* env vars (convenience default for single-customer deploys)
 *   3. Null / empty → caller should skip
 *
 * EMAIL_UPLOADER_URL is always env-only (it's infrastructure, not credential).
 * Never hardcode customer creds as service-wide env vars in production —
 * use the batch fields. Env vars are just a dev/staging convenience.
 */
function resolveUploaderCreds(batch: {
  instantlyEmail: string | null;
  instantlyPassword: string | null;
  instantlyV1Key: string | null;
  instantlyV2Key: string | null;
  instantlyWorkspace: string | null;
  instantlyWorkers: number | null;
}): ResolvedUploaderCreds {
  const envEmail = (process.env.INSTANTLY_EMAIL || "").trim();
  const envPass = (process.env.INSTANTLY_PASSWORD || "").trim();
  const envV1 = (process.env.INSTANTLY_V1_KEY || "").trim();
  const envV2 = (process.env.INSTANTLY_V2_KEY || "").trim();
  const envWs = (process.env.INSTANTLY_WORKSPACE || "").trim();
  const envWorkers = Number(process.env.EMAIL_UPLOADER_WORKERS || "2");

  const batchEmail = (batch.instantlyEmail || "").trim();
  const batchPass = safeDecrypt(batch.instantlyPassword);
  const batchV1 = safeDecrypt(batch.instantlyV1Key);
  const batchV2 = safeDecrypt(batch.instantlyV2Key);
  const batchWs = (batch.instantlyWorkspace || "").trim();

  const hasBatchCreds = Boolean(batchEmail && batchPass && (batchV1 || batchV2));
  const hasEnvCreds = Boolean(envEmail && envPass && (envV1 || envV2));

  const source: ResolvedUploaderCreds["source"] =
    hasBatchCreds && hasEnvCreds ? "mixed" : hasBatchCreds ? "batch" : "env";

  return {
    url: (process.env.EMAIL_UPLOADER_URL || "").trim(),
    email: batchEmail || envEmail,
    password: batchPass || envPass,
    v1Key: batchV1 || envV1,
    v2Key: batchV2 || envV2,
    workspace: batchWs || envWs,
    workers: batch.instantlyWorkers ?? envWorkers,
    source,
  };
}

/**
 * Build the mailbox CSV payload for the uploader. Matches the format the
 * uploader expects: DisplayName,EmailAddress,Password — same as what the
 * existing `/api/tenant/{id}/csv` endpoint produces. Built inline here so
 * we don't go through an HTTP roundtrip against our own service.
 */
function buildMailboxCsv(tenant: {
  inboxNames: string;
  domain: string;
  inboxCount: number;
  adminPassword: string;
  encryptionVersion: number;
}): string {
  const names = parseInboxNamesValue(tenant.inboxNames);
  const variations = generateEmailVariations(names, tenant.domain, tenant.inboxCount);

  const password = (() => {
    try {
      return decryptSecret(tenant.adminPassword);
    } catch {
      return tenant.adminPassword;
    }
  })();

  const lines = ["DisplayName,EmailAddress,Password"];
  for (const v of variations) {
    const display = (v.displayName || v.email.split("@")[0]).replace(/,/g, " ");
    lines.push(`${display},${v.email},${password}`);
  }
  return lines.join("\n");
}

export async function triggerInstantlyUpload(tenantDbId: string): Promise<TriggerUploadResult> {
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
      encryptionVersion: true,
      uploaderJobId: true,
      uploaderStatus: true,
      batch: {
        select: {
          instantlyEmail: true,
          instantlyPassword: true,
          instantlyV1Key: true,
          instantlyV2Key: true,
          instantlyWorkspace: true,
          instantlyWorkers: true,
          instantlyAutoUploadOptIn: true,
        },
      },
    },
  });
  if (!tenant) return { ok: false, error: "Tenant not found" };

  // Opt-in gate: per-batch choice. Default is OFF so existing batches are
  // unaffected by the rollout. Operator sets this to true when they want
  // azure to auto-trigger the uploader after provisioning.
  if (!tenant.batch.instantlyAutoUploadOptIn) {
    return { ok: true, skipped: true, error: "batch.instantlyAutoUploadOptIn is false" };
  }

  const cfg = resolveUploaderCreds(tenant.batch);
  if (!cfg.url) {
    return { ok: true, skipped: true, error: "EMAIL_UPLOADER_URL not set" };
  }
  if (!cfg.email || !cfg.password || (!cfg.v1Key && !cfg.v2Key)) {
    return {
      ok: false,
      error: `email-uploader credentials missing (source=${cfg.source}). ` +
        `Either set batch.instantly{Email,Password,V1Key,V2Key} per batch, or set ` +
        `INSTANTLY_EMAIL / INSTANTLY_PASSWORD / INSTANTLY_V1_KEY or INSTANTLY_V2_KEY env vars as defaults.`,
    };
  }

  // Idempotency: skip if already queued/running/completed
  if (tenant.uploaderJobId && tenant.uploaderStatus && tenant.uploaderStatus !== "failed") {
    return { ok: true, skipped: true, jobId: tenant.uploaderJobId };
  }

  const csv = buildMailboxCsv(tenant);
  const apiVersion = cfg.v2Key ? "v2" : "v1";
  const mode = cfg.workspace ? "multi" : "single";
  const workers = Math.max(1, Math.min(5, cfg.workers || 2));

  const form = new FormData();
  form.append("platform", "instantly");
  form.append("mode", mode);
  form.append("api_version", apiVersion);
  form.append("api_key", cfg.v1Key || cfg.v2Key);
  form.append("v2_api_key", cfg.v2Key);
  form.append("instantly_email", cfg.email);
  form.append("instantly_password", cfg.password);
  form.append("workspace", cfg.workspace);
  form.append("workers", String(workers));
  form.append("csv_file", new Blob([csv], { type: "text/csv" }), `${tenant.tenantName}.csv`);

  try {
    const resp = await fetch(`${cfg.url.replace(/\/$/, "")}/api/start`, {
      method: "POST",
      body: form
    });

    if (resp.status === 429) {
      // Uploader semaphore full — mark as queued, azure could retry later
      await prisma.tenant.update({
        where: { id: tenant.id },
        data: { uploaderStatus: "queued" }
      });
      await logTenantEvent({
        batchId: tenant.batchId,
        tenantId: tenant.id,
        eventType: "uploader_queued",
        level: "warn",
        message: "email-uploader busy (429), will retry on next worker pass"
      });
      return { ok: false, error: "uploader busy (429)" };
    }

    const text = await resp.text();
    let data: { job_id?: string; error?: string } = {};
    try { data = JSON.parse(text); } catch { /* non-json */ }

    if (!resp.ok || !data.job_id) {
      const err = data.error || text.slice(0, 200) || `HTTP ${resp.status}`;
      await prisma.tenant.update({
        where: { id: tenant.id },
        data: { uploaderStatus: "failed" }
      });
      await logTenantEvent({
        batchId: tenant.batchId,
        tenantId: tenant.id,
        eventType: "uploader_trigger_failed",
        level: "error",
        message: `email-uploader trigger failed: ${err}`
      });
      return { ok: false, error: err };
    }

    await prisma.tenant.update({
      where: { id: tenant.id },
      data: {
        uploaderJobId: data.job_id,
        uploaderStatus: "running",
        uploaderTriggeredAt: new Date()
      }
    });
    await logTenantEvent({
      batchId: tenant.batchId,
      tenantId: tenant.id,
      eventType: "uploader_triggered",
      message: `email-uploader job ${data.job_id} started (${workers} workers, creds source=${cfg.source})`
    });
    return { ok: true, jobId: data.job_id };
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    await prisma.tenant.update({
      where: { id: tenant.id },
      data: { uploaderStatus: "failed" }
    });
    await logTenantEvent({
      batchId: tenant.batchId,
      tenantId: tenant.id,
      eventType: "uploader_trigger_failed",
      level: "error",
      message: `email-uploader trigger threw: ${msg}`
    });
    return { ok: false, error: msg };
  }
}
