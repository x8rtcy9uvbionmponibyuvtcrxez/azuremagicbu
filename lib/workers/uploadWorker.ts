/**
 * Tenant upload worker — BullMQ consumer for the tenant-upload queue.
 *
 * Two job types, both in one worker (shared concurrency limit):
 *   • start-upload: POST to email-uploader /api/start, persist job_id,
 *     enqueue first poll. Retries on 429 (uploader busy) via exponential
 *     backoff up to 12 attempts.
 *   • poll-upload: GET /api/status/{id}?detail=1, mirror new log lines to
 *     TenantEvent, update tenant uploader counters, fire Slack on
 *     lifecycle transitions, enqueue next poll until terminal.
 *
 * Concurrency matches the uploader's MAX_CONCURRENT_JOBS cap (default 2)
 * so BullMQ doesn't over-queue against the downstream semaphore.
 */

import { Worker, type Job } from "bullmq";

import { prisma } from "@/lib/prisma";
import {
  TENANT_UPLOAD_QUEUE,
  enqueuePollUpload,
  redisConnection,
  type TenantUploadJobData,
  type TenantUploadJobName
} from "@/lib/queue";
import { logTenantEvent } from "@/lib/tenant-events";
import { triggerUploadForTenant, UPLOADER_URL } from "@/lib/services/emailUploader";
import { slackNotify } from "@/lib/services/slack";

const POLL_INTERVAL_MS = Math.max(
  5_000,
  Number(process.env.UPLOAD_POLL_INTERVAL_MS || 30_000)
);
const UPLOAD_WORKER_CONCURRENCY = Math.max(
  1,
  Number(process.env.UPLOAD_WORKER_CONCURRENCY || 2)
);

// ──────────────────────────────────────────────────────────────────────────
// start-upload handler
// ──────────────────────────────────────────────────────────────────────────

async function handleStartUpload(job: Job<TenantUploadJobData, unknown, TenantUploadJobName>) {
  const { tenantId, batchId } = job.data;

  await prisma.tenant.update({
    where: { id: tenantId },
    data: { uploaderStatus: "queued", uploaderQueuedAt: new Date() }
  }).catch(() => { /* tenant vanished — let handler finish gracefully */ });

  const result = await triggerUploadForTenant(tenantId);

  if (result.ok && "skipped" in result) {
    // Skipped by design (opt-in off, no ESP, already running). Reset to idle
    // if we bumped it to queued above.
    await prisma.tenant.update({
      where: { id: tenantId },
      data: { uploaderStatus: "idle" }
    }).catch(() => { /* ignore */ });
    return { skipped: true, reason: result.reason };
  }

  if (!result.ok) {
    if (result.retryable) {
      // Throw so BullMQ retries with exponential backoff. Do NOT set tenant
      // to 'failed' yet — it's just the uploader's semaphore pushing back.
      throw new Error(`retryable: ${result.error}`);
    }
    // Terminal failure — mark tenant + notify.
    await prisma.tenant.update({
      where: { id: tenantId },
      data: {
        uploaderStatus: "failed",
        uploaderErrorMessage: result.error,
        uploaderCompletedAt: new Date()
      }
    });
    const tenant = await prisma.tenant.findUnique({
      where: { id: tenantId },
      select: { tenantName: true, domain: true }
    });
    await slackNotify(
      `Upload failed to start for ${tenant?.tenantName || tenantId} (${tenant?.domain || ""}): ${result.error}`,
      "error"
    );
    return { ok: false, error: result.error };
  }

  // Success: persist the uploader's job_id, mark running, enqueue first poll.
  await prisma.tenant.update({
    where: { id: tenantId },
    data: {
      uploaderJobId: result.jobId,
      uploaderStatus: "running",
      uploaderStartedAt: new Date()
    }
  });

  const tenant = await prisma.tenant.findUnique({
    where: { id: tenantId },
    select: {
      tenantName: true,
      domain: true,
      inboxCount: true,
      batch: { select: { uploaderEsp: true } }
    }
  });

  await slackNotify(
    `Upload started: ${tenant?.tenantName} (${tenant?.domain}) → ${tenant?.batch.uploaderEsp}, ${tenant?.inboxCount} accounts`,
    "info"
  );

  await enqueuePollUpload(
    { tenantId, batchId, uploaderJobId: result.jobId },
    POLL_INTERVAL_MS
  );

  return { ok: true, jobId: result.jobId };
}

// ──────────────────────────────────────────────────────────────────────────
// poll-upload handler
// ──────────────────────────────────────────────────────────────────────────

type UploaderStatusResponse = {
  job_id: string;
  platform: string;
  mode?: string;
  status: "running" | "paused" | "stopping" | "completed" | "failed" | "cancelled";
  total: number;
  processed: number;
  succeeded: number;
  failed: number;
  skipped: number;
  warnings: number;
  started_at: string | null;
  finished_at: string | null;
  logs: string[];
  config_safe?: unknown;
  account_status?: Record<string, { state: string; reason?: string; ts: string }>;
};

function mapUploaderStatusToDb(status: UploaderStatusResponse["status"]):
  | "running"
  | "completed"
  | "failed" {
  if (status === "completed") return "completed";
  if (status === "failed" || status === "cancelled") return "failed";
  return "running"; // paused + stopping still count as in-flight
}

async function handlePollUpload(job: Job<TenantUploadJobData, unknown, TenantUploadJobName>) {
  const { tenantId, batchId, uploaderJobId } = job.data;
  if (!uploaderJobId) {
    throw new Error("poll-upload missing uploaderJobId in job data");
  }
  if (!UPLOADER_URL) {
    // Infrastructure gone sideways — bail and mark failed.
    await prisma.tenant.update({
      where: { id: tenantId },
      data: {
        uploaderStatus: "failed",
        uploaderErrorMessage: "EMAIL_UPLOADER_URL env var not set on worker",
        uploaderCompletedAt: new Date()
      }
    }).catch(() => { /* ignore */ });
    return { ok: false, error: "EMAIL_UPLOADER_URL not set" };
  }

  // Short-circuit if tenant already reached terminal state (e.g. retry replay).
  const current = await prisma.tenant.findUnique({
    where: { id: tenantId },
    select: { uploaderStatus: true, uploaderLastLogAt: true, tenantName: true, domain: true }
  });
  if (!current) return { ok: false, error: "tenant vanished" };
  if (current.uploaderStatus === "completed" || current.uploaderStatus === "failed") {
    return { ok: true, terminal: true };
  }

  let resp: Response;
  try {
    resp = await fetch(`${UPLOADER_URL}/api/status/${uploaderJobId}?detail=1`, {
      cache: "no-store"
    });
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    // Network blip — schedule another poll and bail without marking failed.
    await enqueuePollUpload({ tenantId, batchId, uploaderJobId }, POLL_INTERVAL_MS);
    return { ok: false, error: `uploader unreachable: ${msg}` };
  }

  if (resp.status === 404) {
    // Uploader restarted and lost in-memory state (Railway recycle). Mark
    // failed so a manual rerun can be triggered by the operator.
    await prisma.tenant.update({
      where: { id: tenantId },
      data: {
        uploaderStatus: "failed",
        uploaderErrorMessage: "uploader lost track of job (container recycle?)",
        uploaderCompletedAt: new Date()
      }
    });
    await logTenantEvent({
      batchId,
      tenantId,
      eventType: "uploader_job_lost",
      level: "error",
      message: `Uploader does not recognize job ${uploaderJobId} — likely container recycle`
    });
    await slackNotify(
      `Upload lost for ${current.tenantName}: uploader container may have restarted. Rerun manually.`,
      "error"
    );
    return { ok: false, error: "uploader 404" };
  }

  if (!resp.ok) {
    // Non-404 HTTP error — transient. Reschedule.
    await enqueuePollUpload({ tenantId, batchId, uploaderJobId }, POLL_INTERVAL_MS);
    return { ok: false, error: `uploader status HTTP ${resp.status}` };
  }

  const data: UploaderStatusResponse = await resp.json();
  const dbStatus = mapUploaderStatusToDb(data.status);

  // Mirror new log lines into TenantEvent. We stamp each batch of new lines
  // with the count we've already seen via uploaderLastLogAt as a "watermark":
  // the uploader's logs array is append-only (capped at 2000 entries), so we
  // just remember the last count we processed and forward anything beyond it.
  //
  // We store the count in a JSON details blob alongside one summary event
  // per poll, rather than one event per log line — keeps the TenantEvent
  // table from being flooded. The full log text is still searchable.
  const lastKnownCount = await getLastKnownLogCount(tenantId);
  if (data.logs.length > lastKnownCount) {
    const newLines = data.logs.slice(lastKnownCount);
    await logTenantEvent({
      batchId,
      tenantId,
      eventType: "uploader_log",
      message: `uploader: ${newLines.length} new log line(s)`,
      details: { lines: newLines, totalSeen: data.logs.length }
    });
    await prisma.tenant.update({
      where: { id: tenantId },
      data: { uploaderLastLogAt: new Date() }
    });
  }

  // Update tenant counters on every poll (cheap, idempotent).
  await prisma.tenant.update({
    where: { id: tenantId },
    data: {
      uploaderStatus: dbStatus,
      uploaderTotal: data.total,
      uploaderSucceeded: data.succeeded,
      uploaderFailed: data.failed,
      uploaderSkipped: data.skipped,
      uploaderWarnings: data.warnings,
      uploaderCompletedAt: dbStatus === "running" ? null : new Date(),
      uploaderErrorMessage:
        dbStatus === "failed" ? extractFailureReason(data) : null
    }
  });

  // Terminal — fire Slack + log summary event, don't reschedule.
  if (dbStatus !== "running") {
    await logTenantEvent({
      batchId,
      tenantId,
      eventType: dbStatus === "completed" ? "uploader_completed" : "uploader_failed",
      level: dbStatus === "failed" ? "error" : "info",
      message:
        dbStatus === "completed"
          ? `Upload completed: ${data.succeeded} ok, ${data.failed} failed, ${data.skipped} skipped`
          : `Upload ${data.status}: ${data.succeeded}/${data.total} ok, ${data.failed} failed`,
      details: {
        status: data.status,
        total: data.total,
        succeeded: data.succeeded,
        failed: data.failed,
        skipped: data.skipped,
        warnings: data.warnings
      }
    });
    const emoji = dbStatus === "completed" ? ":white_check_mark:" : ":x:";
    const outcomeLevel = dbStatus === "completed" ? "info" : "error";
    await slackNotify(
      `${emoji} Upload ${dbStatus} for ${current.tenantName} (${current.domain}): ` +
        `${data.succeeded}/${data.total} succeeded, ${data.failed} failed, ${data.skipped} skipped` +
        (data.warnings ? `, ${data.warnings} warnings` : ""),
      outcomeLevel
    );
    await maybeFinalizeBatchUpload(batchId);
    return { ok: true, terminal: true, status: dbStatus };
  }

  // Still running — schedule next poll.
  await enqueuePollUpload({ tenantId, batchId, uploaderJobId }, POLL_INTERVAL_MS);
  return { ok: true, terminal: false, status: dbStatus };
}

/**
 * Pull the count of already-mirrored log lines from the most recent
 * uploader_log event for this tenant. We use the details JSON as the
 * watermark — cheaper than a dedicated column, and self-healing if the
 * DB is ever reset (we just re-mirror what's in the uploader's buffer).
 */
async function getLastKnownLogCount(tenantId: string): Promise<number> {
  const last = await prisma.tenantEvent.findFirst({
    where: { tenantId, eventType: "uploader_log" },
    orderBy: { createdAt: "desc" },
    select: { details: true }
  });
  if (!last?.details) return 0;
  try {
    const parsed = JSON.parse(last.details);
    const count = Number(parsed.totalSeen);
    return Number.isFinite(count) ? count : 0;
  } catch {
    return 0;
  }
}

function extractFailureReason(status: UploaderStatusResponse): string {
  // Best-effort scan of the tail of the log for the last "fatal"/"error" line.
  const tail = status.logs.slice(-30).reverse();
  for (const line of tail) {
    if (/fatal|error|failed|aborted/i.test(line)) {
      return line.slice(0, 500);
    }
  }
  return `status=${status.status}, ${status.failed}/${status.total} failed`;
}

/**
 * When the last running upload for a batch terminates, post a batch-level
 * Slack summary. Runs after every terminal poll; short-circuits if any
 * uploads are still running for this batch.
 */
async function maybeFinalizeBatchUpload(batchId: string) {
  const still = await prisma.tenant.count({
    where: {
      batchId,
      uploaderStatus: { in: ["queued", "running"] }
    }
  });
  if (still > 0) return;

  const tenants = await prisma.tenant.findMany({
    where: { batchId, uploaderStatus: { in: ["completed", "failed"] } },
    select: {
      tenantName: true,
      uploaderStatus: true,
      uploaderSucceeded: true,
      uploaderFailed: true,
      uploaderTotal: true
    }
  });
  if (tenants.length === 0) return;

  const totalOk = tenants.reduce((sum, t) => sum + (t.uploaderSucceeded || 0), 0);
  const totalFailed = tenants.reduce((sum, t) => sum + (t.uploaderFailed || 0), 0);
  const totalMailboxes = tenants.reduce((sum, t) => sum + (t.uploaderTotal || 0), 0);
  const failedTenants = tenants.filter((t) => t.uploaderStatus === "failed");

  const lines = [
    `Batch upload complete: ${tenants.length} tenants, ${totalOk}/${totalMailboxes} mailboxes uploaded, ${totalFailed} failed.`
  ];
  if (failedTenants.length > 0) {
    lines.push(`Failed tenants: ${failedTenants.map((t) => t.tenantName).join(", ")}`);
  }

  await logTenantEvent({
    batchId,
    eventType: "batch_upload_complete",
    level: failedTenants.length > 0 ? "warn" : "info",
    message: lines.join(" "),
    details: { totalOk, totalFailed, totalMailboxes, tenantCount: tenants.length }
  });
  await slackNotify(lines.join(" "), failedTenants.length > 0 ? "warn" : "info");
}

// ──────────────────────────────────────────────────────────────────────────
// Worker bootstrap
// ──────────────────────────────────────────────────────────────────────────

const globalUploadWorker = globalThis as unknown as {
  tenantUploadWorker?: Worker<TenantUploadJobData, unknown, TenantUploadJobName>;
};

export function startTenantUploadWorker() {
  if (globalUploadWorker.tenantUploadWorker) {
    return globalUploadWorker.tenantUploadWorker;
  }

  const worker = new Worker<TenantUploadJobData, unknown, TenantUploadJobName>(
    TENANT_UPLOAD_QUEUE,
    async (job) => {
      if (job.name === "start-upload") return handleStartUpload(job);
      if (job.name === "poll-upload") return handlePollUpload(job);
      throw new Error(`Unknown upload job: ${job.name}`);
    },
    {
      connection: redisConnection,
      concurrency: UPLOAD_WORKER_CONCURRENCY
    }
  );

  worker.on("failed", (job, error) => {
    const msg = error?.message || "unknown";
    console.error(`❌ [UploadWorker] Job ${job?.id} failed (attempt ${job?.attemptsMade}): ${msg}`);
  });
  worker.on("completed", (job, result) => {
    if (result && typeof result === "object" && "skipped" in result) return;
    console.log(`✅ [UploadWorker] Job ${job.id} (${job.name}) done`);
  });

  globalUploadWorker.tenantUploadWorker = worker;
  console.log(`📦 [UploadWorker] Started — concurrency=${UPLOAD_WORKER_CONCURRENCY} poll=${POLL_INTERVAL_MS}ms`);
  return worker;
}
