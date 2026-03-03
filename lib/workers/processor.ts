import { Worker, type Job } from "bullmq";
import type { BatchStatus } from "@prisma/client";

import { prisma } from "@/lib/prisma";
import {
  TENANT_PROCESSING_QUEUE,
  enqueueTenantProcessingJob,
  redisConnection,
  type TenantProcessingJobData
} from "@/lib/queue";
import { setupCloudflare } from "@/lib/services/cloudflare";
import { createMailboxes, initiateDeviceAuth, setupTenantPrep } from "@/lib/services/microsoft";

const TERMINAL_BATCH_STATUSES: BatchStatus[] = ["completed", "failed"];

async function updateBatchStatus(batchId: string) {
  const tenants = await prisma.tenant.findMany({
    where: { batchId },
    select: { status: true }
  });

  const total = tenants.length;
  const completedCount = tenants.filter((tenant) => tenant.status === "completed").length;
  const hasFailed = tenants.some((tenant) => tenant.status === "failed");
  const hasActive = tenants.some((tenant) => !["completed", "failed"].includes(tenant.status));

  let status: BatchStatus = "processing";
  if (total > 0 && completedCount === total) {
    status = "completed";
  } else if (hasFailed && !hasActive) {
    status = "failed";
  }

  await prisma.batch.update({
    where: { id: batchId },
    data: {
      completedCount,
      status
    }
  });
}

async function processTenant(job: Job<TenantProcessingJobData>): Promise<{ state: string }> {
  const { tenantId, batchId } = job.data;
  console.log("🔄 [Worker] Processing tenant:", tenantId);

  const batch = await prisma.batch.findUnique({
    where: { id: batchId },
    select: { status: true }
  });

  if (!batch) {
    throw new Error(`Batch ${batchId} not found`);
  }

  if (TERMINAL_BATCH_STATUSES.includes(batch.status)) {
    return { state: "batch-terminal" };
  }

  let tenant = await prisma.tenant.findUnique({
    where: { id: tenantId },
    select: {
      id: true,
      status: true,
      authConfirmed: true
    }
  });

  if (!tenant) {
    throw new Error(`Tenant ${tenantId} not found`);
  }

  if (tenant.status === "completed" || tenant.status === "failed") {
    await updateBatchStatus(batchId);
    return { state: tenant.status };
  }

  if (tenant.status === "queued") {
    await setupCloudflare(tenant.id);
    console.log("✅ [Worker] Cloudflare complete");
    tenant = await prisma.tenant.findUnique({
      where: { id: tenant.id },
      select: { id: true, status: true, authConfirmed: true }
    });
    if (!tenant || tenant.status === "failed") {
      await updateBatchStatus(batchId);
      return { state: "failed" };
    }
  }

  if (tenant.status === "cloudflare") {
    await setupTenantPrep(tenant.id);
    console.log("✅ [Worker] Tenant prep complete");
    tenant = await prisma.tenant.findUnique({
      where: { id: tenant.id },
      select: { id: true, status: true, authConfirmed: true }
    });
    if (!tenant || tenant.status === "failed") {
      await updateBatchStatus(batchId);
      return { state: "failed" };
    }
  }

  if (tenant.status === "tenant_prep") {
    await initiateDeviceAuth(tenant.id);
    console.log("✅ [Worker] Device auth initiated");
    tenant = await prisma.tenant.findUnique({
      where: { id: tenant.id },
      select: { id: true, status: true, authConfirmed: true }
    });
    if (!tenant || tenant.status === "failed") {
      await updateBatchStatus(batchId);
      return { state: "failed" };
    }
  }

  if (tenant.status === "auth_pending" && !tenant.authConfirmed) {
    await updateBatchStatus(batchId);
    return { state: "waiting_for_auth_confirmation" };
  }

  if ((tenant.status === "auth_pending" && tenant.authConfirmed) || tenant.status === "mailboxes") {
    await createMailboxes(tenant.id);
    console.log("✅ [Worker] Mailboxes complete");
  }

  await updateBatchStatus(batchId);

  const finalTenant = await prisma.tenant.findUnique({
    where: { id: tenantId },
    select: { status: true }
  });

  return { state: finalTenant?.status || "unknown" };
}

const globalWorker = globalThis as unknown as {
  tenantProcessorWorker?: Worker<TenantProcessingJobData>;
};

function attachWorkerEvents(worker: Worker<TenantProcessingJobData>) {
  worker.on("completed", async (job, result) => {
    if (!job) return;

    if (result?.state === "waiting_for_auth_confirmation") {
      const tenant = await prisma.tenant.findUnique({
        where: { id: job.data.tenantId },
        select: { authConfirmed: true, status: true }
      });

      if (tenant?.authConfirmed && tenant.status === "auth_pending") {
        await enqueueTenantProcessingJob(job.data);
      }
    }
  });

  worker.on("failed", async (job, error) => {
    if (!job) return;

    const message = error?.message || "Worker job failed";

    if (job.attemptsMade >= (job.opts.attempts || 1)) {
      await prisma.tenant.update({
        where: { id: job.data.tenantId },
        data: {
          status: "failed",
          errorMessage: message,
          currentStep: "Failed after retries"
        }
      });
      await updateBatchStatus(job.data.batchId);
    }
  });
}

export function startTenantProcessorWorker() {
  if (!globalWorker.tenantProcessorWorker) {
    globalWorker.tenantProcessorWorker = new Worker<TenantProcessingJobData>(
      TENANT_PROCESSING_QUEUE,
      async (job) => {
        try {
          return await processTenant(job);
        } catch (error) {
          console.log("❌ [Worker] Error:", error instanceof Error ? error.message : String(error));
          const message = error instanceof Error ? error.message : "Unknown processing error";
          await prisma.tenant.update({
            where: { id: job.data.tenantId },
            data: {
              status: "failed",
              errorMessage: message,
              currentStep: "Worker error"
            }
          });
          await updateBatchStatus(job.data.batchId);
          throw error;
        }
      },
      {
        connection: redisConnection,
        concurrency: 3
      }
    );

    attachWorkerEvents(globalWorker.tenantProcessorWorker);
  }

  return globalWorker.tenantProcessorWorker;
}
