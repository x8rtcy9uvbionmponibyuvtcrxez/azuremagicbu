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

  const loadTenant = () =>
    prisma.tenant.findUnique({
      where: { id: tenantId },
      select: {
        id: true,
        tenantName: true,
        status: true,
        zoneId: true,
        tenantId: true,
        authCode: true,
        authConfirmed: true,
        csvUrl: true
      }
    });

  let tenant = await loadTenant();

  if (!tenant) {
    throw new Error(`Tenant ${tenantId} not found`);
  }

  if (tenant.status === "completed" || tenant.status === "failed") {
    await updateBatchStatus(batchId);
    return { state: tenant.status };
  }

  if (!tenant.zoneId) {
    await setupCloudflare(tenant.id);
    console.log("✅ [Worker] Cloudflare complete");
    tenant = await loadTenant();
    if (!tenant || tenant.status === "failed") {
      await updateBatchStatus(batchId);
      return { state: "failed" };
    }
  } else {
    console.log(`✓ [Worker] Cloudflare already complete for ${tenant.tenantName}, skipping`);
  }

  if (!tenant.tenantId && !tenant.authCode && !tenant.authConfirmed) {
    await setupTenantPrep(tenant.id);
    console.log("✅ [Worker] Tenant prep complete");
    tenant = await loadTenant();
    if (!tenant || tenant.status === "failed") {
      await updateBatchStatus(batchId);
      return { state: "failed" };
    }
  } else {
    console.log(`✓ [Worker] Tenant prep already complete or auth started for ${tenant.tenantName}, skipping`);
  }

  if (!tenant.authConfirmed && !tenant.authCode) {
    await initiateDeviceAuth(tenant.id);
    console.log("✅ [Worker] Device auth initiated");
    tenant = await loadTenant();
    if (!tenant || tenant.status === "failed") {
      await updateBatchStatus(batchId);
      return { state: "failed" };
    }
  } else if (!tenant.authConfirmed) {
    console.log(`✓ [Worker] Waiting for auth confirmation for ${tenant.tenantName}`);
  }

  if (!tenant.authConfirmed) {
    await updateBatchStatus(batchId);
    return { state: "waiting_for_auth_confirmation" };
  }

  if (!tenant.csvUrl && tenant.status !== "completed") {
    await createMailboxes(tenant.id);
    console.log("✅ [Worker] Mailboxes complete");
  } else {
    console.log(`✓ [Worker] Mailboxes already complete for ${tenant.tenantName}, skipping`);
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
