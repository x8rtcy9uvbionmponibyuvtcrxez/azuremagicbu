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
import { configureDkim, initiateDeviceAuth, setupDomainAndUser, setupSharedMailboxes, setupTenantPrep } from "@/lib/services/microsoft";
import { connectMailboxesToSequencer } from "@/lib/services/sequencer";

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
        deviceCode: true,
        authConfirmed: true,
        csvUrl: true,
        domainAdded: true,
        domainVerified: true,
        domainDefault: true,
        licensedUserId: true,
        sharedMailboxesCreated: true,
        passwordsSet: true,
        smtpAuthEnabled: true,
        delegationComplete: true,
        signInEnabled: true,
        cloudAppAdminAssigned: true,
        dkimConfigured: true,
        smartleadConnected: true,
        instantlyConnected: true
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
    console.log(`✅ [Worker] Cloudflare already complete for ${tenant.tenantName}, skipping`);
  }

  if (!tenant.tenantId && !tenant.deviceCode && !tenant.authConfirmed) {
    await setupTenantPrep(tenant.id);
    console.log("✅ [Worker] Tenant prep complete");
    tenant = await loadTenant();
    if (!tenant || tenant.status === "failed") {
      await updateBatchStatus(batchId);
      return { state: "failed" };
    }
  } else {
    console.log(`✅ [Worker] Tenant prep already complete for ${tenant.tenantName}, skipping`);
  }

  if (tenant.authConfirmed) {
    console.log(`✅ [Worker] Auth already confirmed for ${tenant.tenantName}, skipping device auth`);
  } else if (tenant.deviceCode) {
    console.log(`⚠️ [Worker] Device code already exists for ${tenant.tenantName}, waiting for confirmation`);
  } else {
    console.log(`🔄 [Worker] Generating new device code for ${tenant.tenantName}`);
    await initiateDeviceAuth(tenant.id);
    console.log("✅ [Worker] Device auth initiated");
    tenant = await loadTenant();
    if (!tenant || tenant.status === "failed") {
      await updateBatchStatus(batchId);
      return { state: "failed" };
    }
  }

  if (!tenant.authConfirmed) {
    console.log(`⚠️ [Worker] Waiting for auth confirmation for ${tenant.tenantName}`);
    await updateBatchStatus(batchId);
    return { state: "waiting_for_auth_confirmation" };
  }

  const phaseTwoComplete =
    tenant.domainAdded && tenant.domainVerified && tenant.domainDefault && Boolean(tenant.licensedUserId);

  if (!phaseTwoComplete) {
    await setupDomainAndUser(tenant.id);
    console.log("✅ [Worker] Domain setup + licensed user complete");
    tenant = await loadTenant();
    if (!tenant || tenant.status === "failed") {
      await updateBatchStatus(batchId);
      return { state: "failed" };
    }
  } else {
    console.log(`✓ [Worker] Domain setup already complete for ${tenant.tenantName}, skipping`);
  }

  const phaseThreeComplete =
    tenant.sharedMailboxesCreated &&
    tenant.passwordsSet &&
    tenant.smtpAuthEnabled &&
    tenant.delegationComplete &&
    tenant.signInEnabled &&
    tenant.cloudAppAdminAssigned;

  if (!phaseThreeComplete && tenant.status !== "completed") {
    await setupSharedMailboxes(tenant.id);
    console.log("✅ [Worker] Shared mailbox pipeline complete");
    tenant = await loadTenant();
    if (!tenant || tenant.status === "failed") {
      await updateBatchStatus(batchId);
      return { state: "failed" };
    }
  } else {
    console.log(`✓ [Worker] Shared mailbox pipeline already complete for ${tenant.tenantName}, skipping`);
  }

  if (!tenant.dkimConfigured) {
    await configureDkim(tenant.id);
    console.log("✅ [Worker] DKIM configured");
    tenant = await loadTenant();
    if (!tenant || tenant.status === "failed") {
      await updateBatchStatus(batchId);
      return { state: "failed" };
    }
  } else {
    console.log(`✓ [Worker] DKIM already configured for ${tenant.tenantName}, skipping`);
  }

  const shouldConnectSmartlead = Boolean(process.env.SMARTLEAD_API_KEY);
  const shouldConnectInstantly = Boolean(process.env.INSTANTLY_API_KEY);

  if (shouldConnectSmartlead && !tenant.smartleadConnected) {
    await connectMailboxesToSequencer(tenant.id, "smartlead");
    console.log("✅ [Worker] Smartlead integration complete");
    tenant = await loadTenant();
  } else if (shouldConnectSmartlead) {
    console.log(`✓ [Worker] Smartlead already connected for ${tenant.tenantName}, skipping`);
  } else {
    console.log("ℹ️ [Worker] SMARTLEAD_API_KEY not set, skipping Smartlead integration");
  }

  if (shouldConnectInstantly && !tenant.instantlyConnected) {
    await connectMailboxesToSequencer(tenant.id, "instantly");
    console.log("✅ [Worker] Instantly integration complete");
    tenant = await loadTenant();
  } else if (shouldConnectInstantly) {
    console.log(`✓ [Worker] Instantly already connected for ${tenant.tenantName}, skipping`);
  } else {
    console.log("ℹ️ [Worker] INSTANTLY_API_KEY not set, skipping Instantly integration");
  }

  if (!tenant || tenant.status === "failed") {
    await updateBatchStatus(batchId);
    return { state: "failed" };
  }

  const phaseFourComplete =
    tenant.dkimConfigured &&
    (!shouldConnectSmartlead || tenant.smartleadConnected) &&
    (!shouldConnectInstantly || tenant.instantlyConnected);

  if (phaseFourComplete && tenant.status !== "completed") {
    await prisma.tenant.update({
      where: { id: tenant.id },
      data: {
        status: "completed",
        currentStep: "All mailboxes configured and connected",
        progress: 100
      }
    });
    console.log("✅ [Worker] Phase 4 complete");
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
