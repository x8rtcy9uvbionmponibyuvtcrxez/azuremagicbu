import { NextResponse } from "next/server";
import type { TenantStatus } from "@prisma/client";

import { prisma } from "@/lib/prisma";
import { enqueueTenantProcessingJob, getTenantQueue } from "@/lib/queue";
import { isLikelyTenantIdentifier, isSyntheticTestTenantId } from "@/lib/tenant-identifier";
import { logTenantEvent } from "@/lib/tenant-events";
import { startTenantProcessorWorker } from "@/lib/workers/processor";

export const runtime = "nodejs";

type Params = {
  params: {
    id: string;
  };
};

export async function POST(_request: Request, { params }: Params) {
  try {
    const existing = await prisma.tenant.findUnique({
      where: { id: params.id },
      select: {
        id: true,
        batchId: true,
        domain: true,
        zoneId: true,
        tenantId: true,
        status: true,
        authCode: true,
        deviceCode: true,
        authCodeExpiry: true,
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

    if (!existing) {
      return NextResponse.json({ error: "Tenant not found" }, { status: 404 });
    }

    startTenantProcessorWorker();
    const queue = getTenantQueue();
    const activeJobs = await queue.getJobs(["active"], 0, 2000, true);
    const queuedJobs = await queue.getJobs(["waiting", "delayed"], 0, -1, true);
    const isSameTenantJob = (job: { data: { tenantId: string; batchId: string } }) =>
      job.data.tenantId === existing.id && job.data.batchId === existing.batchId;

    const activeJob = activeJobs.find(isSameTenantJob);
    const tenantIdsInQueuedJobs = Array.from(new Set(queuedJobs.map((job) => job.data?.tenantId).filter(Boolean)));
    const queuedTenants =
      tenantIdsInQueuedJobs.length > 0
        ? await prisma.tenant.findMany({
            where: { id: { in: tenantIdsInQueuedJobs } },
            select: { id: true, domain: true }
          })
        : [];
    const queuedTenantDomainMap = new Map(queuedTenants.map((tenant) => [tenant.id, tenant.domain]));

    const duplicateQueuedJobs = queuedJobs.filter((job) => {
      if (isSameTenantJob(job)) return true;
      const jobTenantDomain = queuedTenantDomainMap.get(job.data?.tenantId);
      return Boolean(jobTenantDomain) && jobTenantDomain === existing.domain;
    });

    let removedQueuedRetries = 0;
    for (const job of duplicateQueuedJobs) {
      try {
        await job.remove();
        removedQueuedRetries += 1;
      } catch {
        // Best-effort cleanup: if a waiting job transitions state during removal, continue safely.
      }
    }

    let removedActiveJob = false;
    if (activeJob) {
      try {
        const removed = await queue.remove(String(activeJob.id));
        removedActiveJob = removed === 1;
      } catch {
        removedActiveJob = false;
      }
    }

    const shouldConnectSmartlead = Boolean(process.env.SMARTLEAD_API_KEY);
    const shouldConnectInstantly = Boolean(process.env.INSTANTLY_API_KEY);

    const phaseTwoComplete =
      existing.domainAdded && existing.domainVerified && existing.domainDefault && Boolean(existing.licensedUserId);
    const phaseThreeComplete =
      existing.sharedMailboxesCreated &&
      existing.passwordsSet &&
      existing.smtpAuthEnabled &&
      existing.delegationComplete &&
      existing.signInEnabled &&
      existing.cloudAppAdminAssigned;
    const phaseFourComplete =
      phaseThreeComplete &&
      existing.dkimConfigured &&
      (!shouldConnectSmartlead || existing.smartleadConnected) &&
      (!shouldConnectInstantly || existing.instantlyConnected);

    if (existing.status === "completed" || phaseFourComplete) {
      return NextResponse.json({ error: "Tenant already completed" }, { status: 400 });
    }

    let restartStatus: TenantStatus = "queued";
    let progress = 0;
    let currentStep: string | null = null;
    const tenantIdentifierInvalid =
      Boolean(existing.tenantId) &&
      (isSyntheticTestTenantId(existing.tenantId) || !isLikelyTenantIdentifier(existing.tenantId));

    if (tenantIdentifierInvalid) {
      restartStatus = "tenant_prep";
      progress = 55;
      currentStep = "Invalid/stale tenant ID detected. Regenerating authentication code.";
      console.log("⚠️ [Retry] Stale tenant identifier detected, forcing auth regeneration");
    } else if (!existing.zoneId && !existing.deviceCode && !existing.authConfirmed && !existing.tenantId) {
      restartStatus = "queued";
      progress = 0;
      currentStep = "Retry requested from Cloudflare setup";
      console.log("✅ [Retry] Cloudflare pending, restarting from queue");
    } else if (existing.authConfirmed && existing.tenantId) {
      if (!phaseTwoComplete) {
        if (!existing.domainAdded) {
          restartStatus = "domain_add";
          progress = 60;
          currentStep = "Retry requested from domain add";
        } else if (!existing.domainVerified || !existing.domainDefault) {
          restartStatus = "domain_verify";
          progress = existing.domainVerified ? 75 : 70;
          currentStep = existing.domainVerified
            ? "Retry requested from default domain setup"
            : "Retry requested from domain verification";
        } else {
          restartStatus = "licensed_user";
          progress = 80;
          currentStep = "Retry requested from licensed user setup";
        }
        console.log("✅ [Retry] Resuming Phase 2");
      } else if (!phaseThreeComplete) {
        if (!existing.sharedMailboxesCreated) {
          restartStatus = "mailboxes";
          progress = 60;
          currentStep = "Retry requested from shared mailbox creation";
        } else if (!existing.passwordsSet) {
          restartStatus = "mailboxes";
          progress = 75;
          currentStep = "Retry requested from mailbox password setup";
        } else if (!existing.smtpAuthEnabled) {
          restartStatus = "mailbox_config";
          progress = 80;
          currentStep = "Retry requested from SMTP auth setup";
        } else if (!existing.delegationComplete) {
          restartStatus = "mailbox_config";
          progress = 85;
          currentStep = "Retry requested from mailbox delegation";
        } else if (!existing.signInEnabled) {
          restartStatus = "mailbox_config";
          progress = 90;
          currentStep = "Retry requested from sign-in enablement";
        } else {
          restartStatus = "mailbox_config";
          progress = 95;
          currentStep = "Retry requested from Cloud App Admin assignment";
        }
        console.log("✅ [Retry] Resuming Phase 3");
      } else if (!existing.dkimConfigured) {
        restartStatus = "dkim_config";
        progress = 97;
        currentStep = "Retry requested from DKIM setup";
        console.log("✅ [Retry] Resuming DKIM setup");
      } else {
        restartStatus = "sequencer_connect";
        progress = 98;
        currentStep = "Retry requested from mailbox integration";
        console.log("✅ [Retry] Resuming sequencer integrations");
      }
    } else if (existing.deviceCode && !existing.authConfirmed) {
      const isExpired = existing.authCodeExpiry ? existing.authCodeExpiry.getTime() <= Date.now() : false;
      if (!isExpired) {
        restartStatus = "auth_pending";
        progress = 65;
        currentStep = "Waiting for device code confirmation";
        console.log("⚠️ [Retry] Device code exists, staying at auth_pending (code still valid)");

        await prisma.tenant.update({
          where: { id: existing.id },
          data: {
            status: restartStatus,
            progress,
            errorMessage: null,
            currentStep
          }
        });

        await logTenantEvent({
          batchId: existing.batchId,
          tenantId: existing.id,
          eventType: "retry_requested",
          level: "warn",
          message: "Retry requested while device code is still valid",
          details: { restartStatus, currentStep }
        });

        return NextResponse.json({
          ok: true,
          tenantId: existing.id,
          restartStatus,
          message: "Use existing device code. Click \"I've Entered the Code\" when ready."
        });
      }

      restartStatus = "tenant_prep";
      progress = 55;
      currentStep = "Device code expired. Regenerating authentication code.";
      console.log("🔄 [Retry] Device code expired, regenerating a fresh one");
    } else if (existing.tenantId && !existing.deviceCode) {
      if (!phaseTwoComplete) {
        restartStatus = "domain_add";
        progress = 60;
        currentStep = "Auth verified. Continuing domain setup...";
      } else if (!phaseThreeComplete) {
        restartStatus = "mailboxes";
        progress = 70;
        currentStep = "Auth verified. Continuing mailbox setup...";
      } else if (!existing.dkimConfigured) {
        restartStatus = "dkim_config";
        progress = 97;
        currentStep = "Auth verified. Continuing DKIM setup...";
      } else {
        restartStatus = "sequencer_connect";
        progress = 98;
        currentStep = "Auth verified. Continuing mailbox integration...";
      }
      console.log("✅ [Retry] Tenant already authorized, resuming at first incomplete phase");
    } else if (existing.zoneId && !existing.tenantId) {
      restartStatus = "tenant_prep";
      progress = 50;
      currentStep = "Retry requested from tenant prep";
      console.log("✅ [Retry] Cloudflare complete, restarting from Microsoft");
    } else {
      console.log("🔄 [Retry] Starting from beginning");
    }

    const tenant = await prisma.tenant.update({
      where: { id: existing.id },
      data: {
        status: restartStatus,
        progress,
        errorMessage: null,
        currentStep,
        ...(restartStatus === "tenant_prep"
          ? { authConfirmed: false, tenantId: null, authCode: null, deviceCode: null, authCodeExpiry: null }
          : {}),
        ...(restartStatus !== "tenant_prep"
          ? { authCode: null, deviceCode: null, authCodeExpiry: null }
          : {}),
        ...(existing.tenantId && restartStatus !== "tenant_prep" ? { authConfirmed: true } : {})
      }
    });

    await prisma.batch.update({
      where: { id: tenant.batchId },
      data: { status: "processing" }
    });

    await enqueueTenantProcessingJob({ tenantId: tenant.id, batchId: tenant.batchId });

    await logTenantEvent({
      batchId: tenant.batchId,
      tenantId: tenant.id,
      eventType: "retry_requested",
      level: "warn",
      message: `Retry requested. Resuming from ${restartStatus}`,
      details: {
        restartStatus,
        progress,
        currentStep,
        removedQueuedRetries,
        activeJobId: activeJob?.id || null,
        removedActiveJob
      }
    });

    return NextResponse.json({
      ok: true,
      tenantId: tenant.id,
      restartStatus,
      removedQueuedRetries,
      activeJobId: activeJob?.id || null,
      removedActiveJob
    });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Unable to retry tenant" },
      { status: 400 }
    );
  }
}
