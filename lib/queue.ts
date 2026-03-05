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
  const rawJobId = options?.jobId || `${data.batchId}:${data.tenantId}:${Date.now()}`;
  const jobId = normalizeJobId(rawJobId);
  const job = await queue.add("process-tenant", data, {
    jobId,
    delay: options?.delayMs || 0
  });
  console.log("🔄 [Queue] Adding job:", job.id);
  return job;
}
