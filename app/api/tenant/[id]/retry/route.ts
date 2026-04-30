import { NextResponse } from "next/server";
import type { TenantStatus } from "@prisma/client";

import { prisma } from "@/lib/prisma";
import { enqueueTenantProcessingJob, getTenantQueue } from "@/lib/queue";
import { isLikelyTenantIdentifier, isSyntheticTestTenantId } from "@/lib/tenant-identifier";
import { logTenantEvent } from "@/lib/tenant-events";

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
        errorMessage: true,
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

    // Detect a previous license-assignment failure so we rewind to the
    // licensed_user phase instead of blindly honouring the DB's
    // "licensedUserId is set, phase done" flag. Without this, retrying a
    // license-failed tenant jumps past license assignment, hits delegation,
    // and fails again with the same cryptic PowerShell error.
    const lowerErr = (existing.errorMessage || "").toLowerCase();
    const isLicenseError =
      Boolean(existing.licensedUserId) &&
      (lowerErr.includes("license could not be attached") ||
        lowerErr.includes("no license assigned") ||
        lowerErr.includes("has no assigned licenses") ||
        lowerErr.includes("exchange online license") ||
        (lowerErr.includes("no available") && lowerErr.includes("license")) ||
        // Graph eventual-consistency races: the user creation step succeeded
        // but the subsequent $filter lookup missed it. Both messages mean the
        // license phase didn't complete and we should re-run it from the top.
        lowerErr.includes("primary user") && lowerErr.includes("not found in tenant") ||
        lowerErr.includes("user exists but couldn't find id"));

    if (tenantIdentifierInvalid) {
      restartStatus = "tenant_prep";
      progress = 55;
      currentStep = "Invalid/stale tenant ID detected. Regenerating authentication code.";
      console.log("⚠️ [Retry] Stale tenant identifier detected, forcing auth regeneration");
    } else if (isLicenseError) {
      restartStatus = "licensed_user";
      progress = 80;
      currentStep = "Re-running licensed user + license assignment after previous failure...";
      console.log("🔄 [Retry] License-assignment failure detected, rewinding to licensed_user phase");
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
      restartStatus = "tenant_prep";
      progress = 55;
      currentStep = "Regenerating a fresh authentication code.";
      console.log("🔄 [Retry] Auth pending — always regenerating a fresh device code");
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

    // Only the "rewind to tenant_prep" path needs to wipe the auth code +
    // device code (they're tied to the auth session we're abandoning). For
    // every other restart phase we leave the existing authCode in place so
    // the device-auth UI row doesn't vanish in the few seconds between
    // "retry clicked" and "worker writes a new code". The new code, when
    // generated by the worker, atomically replaces the old one in a single
    // update — there's no value in pre-nulling it.
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
        ...(existing.tenantId && restartStatus !== "tenant_prep" ? { authConfirmed: true } : {}),
        // When retrying a license failure, wipe licensedUserId so the processor
        // actually re-runs the licensed_user phase. Without this, the processor's
        // phaseTwoComplete check (domainAdded && domainVerified && domainDefault &&
        // licensedUserId) would treat the phase as done and skip license allocation,
        // making the retry a no-op that falls straight into the same delegation failure.
        ...(isLicenseError ? { licensedUserId: null } : {})
      }
    });

    await prisma.batch.update({
      where: { id: tenant.batchId },
      data: { status: "processing" }
    });

    let enqueuedJob = await enqueueTenantProcessingJob({ tenantId: tenant.id, batchId: tenant.batchId });
    let enqueueState = await enqueuedJob.getState();
    const runnableStates = new Set(["waiting", "active", "delayed", "prioritized"]);
    if (!runnableStates.has(enqueueState)) {
      enqueuedJob = await enqueueTenantProcessingJob(
        { tenantId: tenant.id, batchId: tenant.batchId },
        { jobId: `${tenant.batchId}:${tenant.id}:retry:${Date.now()}` }
      );
      enqueueState = await enqueuedJob.getState();
    }

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
        removedActiveJob,
        enqueuedJobId: enqueuedJob.id,
        enqueueState
      }
    });

    return NextResponse.json({
      ok: true,
      tenantId: tenant.id,
      restartStatus,
      removedQueuedRetries,
      activeJobId: activeJob?.id || null,
      removedActiveJob,
      enqueuedJobId: enqueuedJob.id,
      enqueueState
    });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Unable to retry tenant" },
      { status: 400 }
    );
  }
}
