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

function getUploaderConfig() {
  const url = (process.env.EMAIL_UPLOADER_URL || "").trim();
  const email = (process.env.INSTANTLY_EMAIL || "").trim();
  const password = (process.env.INSTANTLY_PASSWORD || "").trim();
  const v1Key = (process.env.INSTANTLY_V1_KEY || "").trim();
  const v2Key = (process.env.INSTANTLY_V2_KEY || "").trim();
  const workspace = (process.env.INSTANTLY_WORKSPACE || "").trim();
  const workers = Number(process.env.EMAIL_UPLOADER_WORKERS || "2");
  return { url, email, password, v1Key, v2Key, workspace, workers };
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
  const cfg = getUploaderConfig();
  if (!cfg.url) {
    return { ok: true, skipped: true, error: "EMAIL_UPLOADER_URL not set" };
  }
  if (!cfg.email || !cfg.password || (!cfg.v1Key && !cfg.v2Key)) {
    return {
      ok: false,
      error: "email-uploader env incomplete — need INSTANTLY_EMAIL, INSTANTLY_PASSWORD, INSTANTLY_V1_KEY or INSTANTLY_V2_KEY"
    };
  }

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
      uploaderStatus: true
    }
  });
  if (!tenant) return { ok: false, error: "Tenant not found" };

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
      message: `email-uploader job ${data.job_id} started (${workers} workers)`
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
