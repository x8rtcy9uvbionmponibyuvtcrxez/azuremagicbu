import { Queue, type ConnectionOptions, type JobsOptions } from "bullmq";

export const TENANT_PROCESSING_QUEUE = "tenant-processing";

export type TenantProcessingJobData = {
  tenantId: string;
  batchId: string;
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
