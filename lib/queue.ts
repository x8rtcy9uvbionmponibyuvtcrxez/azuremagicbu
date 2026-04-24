import { Queue, type ConnectionOptions, type JobsOptions } from "bullmq";

export const TENANT_PROCESSING_QUEUE = "tenant-processing";
export const TENANT_UPLOAD_QUEUE = "tenant-upload";

export type TenantProcessingJobData = {
  tenantId: string;
  batchId: string;
};

export type TenantUploadJobName = "start-upload" | "poll-upload";
export type TenantUploadJobData = {
  tenantId: string;
  batchId: string;
  // For poll jobs only — present once the uploader has acknowledged the run.
  uploaderJobId?: string;
};

const redisUrl = process.env.REDIS_URL || "redis://127.0.0.1:6379";

export const redisConnection: ConnectionOptions = {
  url: redisUrl,
  maxRetriesPerRequest: null,
  enableReadyCheck: false
};

const defaultJobOptions: JobsOptions = {
  attempts: 3,
  backoff: {
    type: "exponential",
    delay: 2000
  },
  removeOnComplete: 1000,
  removeOnFail: 1000
};

function normalizeJobId(jobId: string): string {
  // BullMQ reserves ":" as an internal separator and rejects custom ids containing it.
  return jobId.replace(/:/g, "__");
}

function buildRunJobId(baseJobId: string): string {
  return `${baseJobId}__run__${Date.now()}`;
}

const globalQueue = globalThis as unknown as {
  tenantProcessingQueue?: Queue<TenantProcessingJobData>;
};

export function getTenantQueue(): Queue<TenantProcessingJobData> {
  if (!globalQueue.tenantProcessingQueue) {
    globalQueue.tenantProcessingQueue = new Queue<TenantProcessingJobData>(TENANT_PROCESSING_QUEUE, {
      connection: redisConnection,
      defaultJobOptions
    });
    console.log("🔄 [Queue] Redis connected");
  }

  return globalQueue.tenantProcessingQueue;
}

export async function enqueueTenantProcessingJob(
  data: TenantProcessingJobData,
  options?: { delayMs?: number; jobId?: string }
) {
  const queue = getTenantQueue();
  const rawBaseJobId = options?.jobId || `${data.batchId}:${data.tenantId}`;
  const baseJobId = normalizeJobId(rawBaseJobId);
  const createJob = async (jobId: string) =>
    queue.add("process-tenant", data, {
      jobId,
      delay: options?.delayMs || 0
    });

  // Dedup by tenantId. Multiple enqueue paths (retry, reset, permission-propagation
  // auto-retry, domain-propagation auto-retry) used to pass unique timestamp-based
  // jobIds, which defeated BullMQ's jobId-based dedup and left stale queued jobs
  // accumulating across retries. Before adding the new job, drain any PENDING
  // (waiting/delayed/prioritized/paused) jobs for the same tenant+batch. Active
  // jobs are left alone — don't interrupt work that's already running.
  try {
    const pending = await queue.getJobs(["waiting", "delayed", "prioritized", "paused"], 0, 5000, true);
    let removed = 0;
    for (const job of pending) {
      if (job.data?.tenantId === data.tenantId && job.data?.batchId === data.batchId) {
        try {
          await job.remove();
          removed += 1;
        } catch {
          // Best-effort: BullMQ may have transitioned the job during removal.
        }
      }
    }
    if (removed > 0) {
      console.log(`🧹 [Queue] Cleaned ${removed} pending duplicate(s) for tenant ${data.tenantId}`);
    }
  } catch (error) {
    console.log(
      "⚠️ [Queue] Failed to dedup pending jobs:",
      error instanceof Error ? error.message : String(error)
    );
    // Don't block the enqueue if dedup fails — the worst case is a duplicate
    // (which idempotent operations handle fine), not a stuck tenant.
  }

  try {
    const job = await createJob(baseJobId);
    console.log("🔄 [Queue] Adding job:", job.id);
    return job;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message.toLowerCase().includes("job") && message.toLowerCase().includes("exists")) {
      const existing = await queue.getJob(baseJobId);
      if (existing) {
        const state = await existing.getState();
        if (state === "waiting" || state === "active" || state === "delayed" || state === "prioritized") {
          console.log("ℹ️ [Queue] Reusing in-flight job:", existing.id, state);
          return existing;
        }

        // Completed/failed/stuck terminal jobs must not block a retry.
        try {
          await existing.remove();
        } catch {
          // Ignore race if BullMQ already pruned this job.
        }

        const rerunId = buildRunJobId(baseJobId);
        const rerun = await createJob(rerunId);
        console.log("🔄 [Queue] Added rerun job:", rerun.id, "(replaced terminal job)");
        return rerun;
      }
    }
    throw error;
  }
}

// ─────────────────────────────────────────────────────────────────────────
// Tenant upload queue — drives the email-uploader Phase 5 handoff.
// Separate from the main tenant-processing queue so uploader backpressure
// (429s, long-running 20-40min Selenium jobs) can't starve provisioning.
//
// ⚠️  GOTCHA for one-off scripts / ad-hoc enqueueing:
// BullMQ's defaultJobOptions are applied per-Queue-instance, NOT per-queue-
// name. A fresh `new Queue("tenant-upload", { connection })` without passing
// `defaultJobOptions` will hand back jobs with `attempts: 1` — meaning the
// very first 429 (expected under MAX_CONCURRENT_JOBS backpressure) marks the
// job permanently failed instead of backing off and retrying.
//
// This bit us on 2026-04-24 during the TN-003..006 manual kickoff: 2 of 4
// jobs landed on the uploader while the other 2 got 429'd, then died with
// attempts=1/1 because the one-off script instantiated a bare Queue.
//
// Always enqueue through `enqueueStartUpload` / `enqueuePollUpload` below,
// OR — if you MUST construct a Queue manually — pass `uploadJobOptions`
// explicitly as `defaultJobOptions`. Never trust the queue name alone to
// apply retry semantics.
// ─────────────────────────────────────────────────────────────────────────

const uploadJobOptions: JobsOptions = {
  // Allow generous retries for the start job specifically — 429s from the
  // uploader's MAX_CONCURRENT_JOBS cap are expected under parallel tenant
  // completion. Exponential backoff keeps us polite.
  attempts: 12,
  backoff: { type: "exponential", delay: 30_000 },
  removeOnComplete: 500,
  removeOnFail: 500
};

const globalUploadQueue = globalThis as unknown as {
  tenantUploadQueue?: Queue<TenantUploadJobData, unknown, TenantUploadJobName>;
};

export function getUploadQueue(): Queue<TenantUploadJobData, unknown, TenantUploadJobName> {
  if (!globalUploadQueue.tenantUploadQueue) {
    globalUploadQueue.tenantUploadQueue = new Queue<TenantUploadJobData, unknown, TenantUploadJobName>(
      TENANT_UPLOAD_QUEUE,
      {
        connection: redisConnection,
        defaultJobOptions: uploadJobOptions
      }
    );
    console.log("📦 [UploadQueue] Redis connected");
  }
  return globalUploadQueue.tenantUploadQueue;
}

export async function enqueueStartUpload(data: TenantUploadJobData): Promise<void> {
  const queue = getUploadQueue();
  const jobId = normalizeJobId(`start:${data.batchId}:${data.tenantId}`);

  // Drain stale duplicates for the same tenant before adding — mirrors the
  // dedup pattern in enqueueTenantProcessingJob. Safe even if nothing to remove.
  try {
    const pending = await queue.getJobs(["waiting", "delayed", "prioritized", "paused"], 0, 5000, true);
    for (const job of pending) {
      if (job.data?.tenantId === data.tenantId && job.name === "start-upload") {
        try { await job.remove(); } catch { /* race */ }
      }
    }
  } catch {
    /* dedup is best-effort — never block enqueue */
  }

  try {
    await queue.add("start-upload", data, { jobId });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message.toLowerCase().includes("exists")) {
      const existing = await queue.getJob(jobId);
      if (existing) {
        const state = await existing.getState();
        if (state === "waiting" || state === "active" || state === "delayed" || state === "prioritized") {
          return; // already in-flight, nothing to do
        }
        try { await existing.remove(); } catch { /* race */ }
        await queue.add("start-upload", data, { jobId: `${jobId}__rerun__${Date.now()}` });
        return;
      }
    }
    throw error;
  }
}

export async function enqueuePollUpload(
  data: TenantUploadJobData,
  delayMs = 15_000
): Promise<void> {
  const queue = getUploadQueue();
  // Polls are fire-and-forget — no dedup. Each scheduled poll runs once,
  // then decides whether to schedule the next one.
  await queue.add("poll-upload", data, {
    delay: delayMs,
    attempts: 3,
    backoff: { type: "fixed", delay: 5_000 }
  });
}
