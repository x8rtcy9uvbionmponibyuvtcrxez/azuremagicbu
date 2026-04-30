import { Worker, type Job } from "bullmq";
import type { BatchStatus } from "@prisma/client";

import { prisma } from "@/lib/prisma";
import {
  TENANT_PROCESSING_QUEUE,
  enqueueStartUpload,
  enqueueTenantProcessingJob,
  redisConnection,
  type TenantProcessingJobData
} from "@/lib/queue";
import { slackNotify } from "@/lib/services/slack";
import { isLikelyTenantIdentifier, isSyntheticTestTenantId } from "@/lib/tenant-identifier";
import { setupCloudflare } from "@/lib/services/cloudflare";
import {
  configureDkim,
  createMailboxes,
  initiateDeviceAuth,
  reconcileTenantFromMicrosoft,
  setupDomainAndUser,
  setupSharedMailboxes,
  setupTenantPrep,
  verifyPersonaDisplayNames
} from "@/lib/services/microsoft";
import { applyPhotosToTenant, extractPersonas } from "@/lib/services/profilePhotos";
import { connectMailboxesToSequencer } from "@/lib/services/sequencer";
import { logTenantEvent } from "@/lib/tenant-events";

const TERMINAL_BATCH_STATUSES: BatchStatus[] = ["completed", "failed"];
const DOMAIN_PROPAGATION_RETRY_DELAY_MS = Math.max(30_000, Number(process.env.DOMAIN_PROPAGATION_RETRY_DELAY_MS || 120_000));
const PRIVILEGE_PROPAGATION_BASE_DELAY_MS = Math.max(
  60_000,
  Number(process.env.PRIVILEGE_PROPAGATION_BASE_DELAY_MS || 318_000)
);
const PRIVILEGE_PROPAGATION_BUFFER_MULTIPLIER = Math.max(
  1,
  Number(process.env.PRIVILEGE_PROPAGATION_BUFFER_MULTIPLIER || 1.2)
);
const PRIVILEGE_PROPAGATION_RETRY_DELAY_MS = Math.round(
  PRIVILEGE_PROPAGATION_BASE_DELAY_MS * PRIVILEGE_PROPAGATION_BUFFER_MULTIPLIER
);

function isDomainPropagationError(message: string): boolean {
  const normalized = message.toLowerCase();
  return (
    normalized.includes("updates to unverified domains are not allowed") ||
    (normalized.includes("resource") &&
      normalized.includes("does not exist") &&
      normalized.includes("reference-property"))
  );
}

function isPermissionPropagationError(message: string): boolean {
  const normalized = message.toLowerCase();
  return (
    normalized.includes("insufficient privileges") ||
    normalized.includes("authorization_requestdenied") ||
    normalized.includes("access denied") ||
    normalized.includes("domain portion of the userprincipalname property is invalid")
  );
}

function formatDuration(ms: number): string {
  const totalSeconds = Math.max(1, Math.round(ms / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes === 0) return `${seconds}s`;
  if (seconds === 0) return `${minutes}m`;
  return `${minutes}m ${seconds}s`;
}

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

// Sequential chaining removed — all tenants are enqueued at batch start.
// Workers pick them up in parallel based on WORKER_CONCURRENCY and replica count.

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
        domain: true,
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

  // Phase 1 Day 4 — reconcile DB flags against Microsoft state at the top
  // of every worker invocation (when USE_POLL_HELPERS is on). The
  // existing phase-completion checks below all read those flags; once
  // they reflect Microsoft truth, drift can't accumulate across phase
  // boundaries. No-op when the flag is off.
  let reconcileChanges: Record<string, unknown> | null = null;
  let reconcileError: string | null = null;
  try {
    const reconcile = await reconcileTenantFromMicrosoft(tenant.id);
    if (reconcile.reconciled && Object.keys(reconcile.changes).length > 0) {
      reconcileChanges = reconcile.changes as Record<string, unknown>;
    }
  } catch (error) {
    // Reconcile is a safety check, never a gate. Log and continue with
    // the flags we have — the worker's own Graph calls will surface any
    // real Microsoft problems.
    reconcileError = error instanceof Error ? error.message : String(error);
  }
  if (reconcileChanges) {
    console.log(
      `🔄 [Worker] (USE_POLL_HELPERS) Reconciled DB → MS state for ${tenant.tenantName}: ${JSON.stringify(reconcileChanges)}`
    );
    await logTenantEvent({
      batchId,
      tenantId: tenant.id,
      eventType: "phase_warning",
      level: "info",
      message: "Reconciled DB flags from Microsoft state",
      details: reconcileChanges
    });
    // Reload the tenant so the rest of the function sees the corrected
    // flags. Without this we'd still branch on the stale snapshot.
    const reloaded = await loadTenant();
    if (!reloaded) {
      throw new Error(`Tenant ${tenantId} disappeared after reconcile`);
    }
    tenant = reloaded;
  } else if (reconcileError) {
    console.log(
      `⚠️ [Worker] Reconcile from Microsoft failed for ${tenant.tenantName}: ${reconcileError} — continuing with DB flags as-is`
    );
  }

  await logTenantEvent({
    batchId,
    tenantId: tenant.id,
    eventType: "worker_started",
    message: "Worker picked up tenant for processing",
    details: { status: tenant.status }
  });

  if (!tenant.zoneId) {
    await logTenantEvent({
      batchId,
      tenantId: tenant.id,
      eventType: "phase_start",
      message: "Starting Cloudflare setup"
    });
    await setupCloudflare(tenant.id);
    console.log("✅ [Worker] Cloudflare complete");
    await logTenantEvent({
      batchId,
      tenantId: tenant.id,
      eventType: "phase_complete",
      message: "Cloudflare setup completed"
    });
    tenant = await loadTenant();
    if (!tenant || tenant.status === "failed") {
      await updateBatchStatus(batchId);
      return { state: "failed" };
    }
  } else {
    console.log(`✅ [Worker] Cloudflare already complete for ${tenant.tenantName}, skipping`);
  }

  if (!tenant.tenantId && !tenant.deviceCode && !tenant.authConfirmed) {
    await logTenantEvent({
      batchId,
      tenantId: tenant.id,
      eventType: "phase_start",
      message: "Starting tenant prep and device auth bootstrap"
    });
    await setupTenantPrep(tenant.id);
    console.log("✅ [Worker] Tenant prep complete");
    await logTenantEvent({
      batchId,
      tenantId: tenant.id,
      eventType: "phase_complete",
      message: "Tenant prep completed"
    });
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
    await logTenantEvent({
      batchId,
      tenantId: tenant.id,
      eventType: "auth_code_generating",
      message: "Generating new Microsoft device code"
    });
    await initiateDeviceAuth(tenant.id);
    console.log("✅ [Worker] Device auth initiated");
    await logTenantEvent({
      batchId,
      tenantId: tenant.id,
      eventType: "auth_code_generated",
      message: "Device code generated. Waiting for user authorization."
    });
    tenant = await loadTenant();
    if (!tenant || tenant.status === "failed") {
      await updateBatchStatus(batchId);
      return { state: "failed" };
    }
  }

  if (!tenant.authConfirmed) {
    console.log(`⚠️ [Worker] Waiting for auth confirmation for ${tenant.tenantName}`);
    await logTenantEvent({
      batchId,
      tenantId: tenant.id,
      eventType: "auth_pending",
      level: "warn",
      message: "Waiting for device code confirmation"
    });
    await updateBatchStatus(batchId);
    return { state: "waiting_for_auth_confirmation" };
  }

  if (tenant.tenantId && (isSyntheticTestTenantId(tenant.tenantId) || !isLikelyTenantIdentifier(tenant.tenantId))) {
    console.log(`⚠️ [Worker] Invalid tenant identifier '${tenant.tenantId}' detected for ${tenant.tenantName}. Resetting auth flow.`);
    await prisma.tenant.update({
      where: { id: tenant.id },
      data: {
        authConfirmed: false,
        tenantId: null,
        authCode: null,
        deviceCode: null,
        authCodeExpiry: null,
        status: "tenant_prep",
        progress: 55,
        errorMessage: null,
        currentStep: "Stale tenant identifier detected. Regenerating authentication code..."
      }
    });

    await logTenantEvent({
      batchId,
      tenantId: tenant.id,
      eventType: "auth_reset",
      level: "warn",
      message: "Stale tenant identifier detected. Resetting auth flow."
    });

    await initiateDeviceAuth(tenant.id);
    await updateBatchStatus(batchId);
    return { state: "waiting_for_auth_confirmation" };
  }

  if (process.env.TEST_MODE === "true") {
    console.log(`🧪 [Worker] TEST_MODE active, using synthetic mailbox flow for ${tenant.tenantName}`);
    await logTenantEvent({
      batchId,
      tenantId: tenant.id,
      eventType: "test_mode_path",
      message: "Running synthetic mailbox flow in TEST_MODE"
    });
    await createMailboxes(tenant.id);
    await updateBatchStatus(batchId);
    const finalTenant = await prisma.tenant.findUnique({
      where: { id: tenantId },
      select: { status: true }
    });
    return { state: finalTenant?.status || "unknown" };
  }

  const phaseTwoComplete =
    tenant.domainAdded && tenant.domainVerified && tenant.domainDefault && Boolean(tenant.licensedUserId);

  if (!phaseTwoComplete) {
    try {
      await logTenantEvent({
        batchId,
        tenantId: tenant.id,
        eventType: "phase_start",
        message: "Starting domain setup + licensed user provisioning"
      });
      await setupDomainAndUser(tenant.id);
      console.log("✅ [Worker] Domain setup + licensed user complete");
      await logTenantEvent({
        batchId,
        tenantId: tenant.id,
        eventType: "phase_complete",
        message: "Domain setup + licensed user provisioning completed"
      });
      tenant = await loadTenant();
      if (!tenant || tenant.status === "failed") {
        await updateBatchStatus(batchId);
        return { state: "failed" };
      }
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      if (!tenant) {
        throw error;
      }
      if (isDomainPropagationError(message)) {
        if (!tenant) {
          throw error;
        }
        const retryAfterMinutes = Math.max(1, Math.round(DOMAIN_PROPAGATION_RETRY_DELAY_MS / 60000));
        const resumeStatus = tenant.domainAdded ? "domain_verify" : "domain_add";
        await prisma.tenant.update({
          where: { id: tenant.id },
          data: {
            status: resumeStatus,
            progress: tenant.domainAdded ? 74 : 62,
            errorMessage: null,
            currentStep: `Domain propagation delay detected. Auto-retrying in ${retryAfterMinutes} minute${retryAfterMinutes === 1 ? "" : "s"}...`
          }
        });
        await logTenantEvent({
          batchId,
          tenantId: tenant.id,
          eventType: "phase_warning",
          level: "warn",
          message: "Domain propagation delay detected; scheduled automatic retry",
          details: { error: message, retryAfterMs: DOMAIN_PROPAGATION_RETRY_DELAY_MS, resumeStatus }
        });
        await enqueueTenantProcessingJob(
          { tenantId: tenant.id, batchId },
          {
            delayMs: DOMAIN_PROPAGATION_RETRY_DELAY_MS,
            jobId: `${batchId}:${tenant.id}:domain-propagation-retry:${Date.now()}`
          }
        );
        await updateBatchStatus(batchId);
        return { state: "waiting_for_domain_propagation" };
      }

      if (isPermissionPropagationError(message)) {
        const waitLabel = formatDuration(PRIVILEGE_PROPAGATION_RETRY_DELAY_MS);
        const resumeStatus = tenant.domainAdded ? "domain_verify" : "domain_add";
        await prisma.tenant.update({
          where: { id: tenant.id },
          data: {
            status: resumeStatus,
            progress: tenant.domainAdded ? 74 : 62,
            errorMessage: null,
            currentStep: `Permission propagation in Microsoft. Auto-retrying in ${waitLabel}...`
          }
        });
        await logTenantEvent({
          batchId,
          tenantId: tenant.id,
          eventType: "phase_warning",
          level: "warn",
          message: "Permission propagation delay detected; scheduled automatic retry",
          details: {
            error: message,
            retryAfterMs: PRIVILEGE_PROPAGATION_RETRY_DELAY_MS,
            resumeStatus,
            measuredBaselineMs: PRIVILEGE_PROPAGATION_BASE_DELAY_MS,
            bufferMultiplier: PRIVILEGE_PROPAGATION_BUFFER_MULTIPLIER
          }
        });
        await enqueueTenantProcessingJob(
          { tenantId: tenant.id, batchId },
          {
            delayMs: PRIVILEGE_PROPAGATION_RETRY_DELAY_MS,
            jobId: `${batchId}:${tenant.id}:permission-propagation-retry:${Date.now()}`
          }
        );
        await updateBatchStatus(batchId);
        return { state: "waiting_for_permission_propagation" };
      }

      await logTenantEvent({
        batchId,
        tenantId: tenant?.id,
        eventType: "phase_failed",
        level: "error",
        message: "Domain setup + licensed user provisioning failed",
        details: { error: message }
      });
      throw error;
    }
  } else {
    console.log(`✓ [Worker] Domain setup already complete for ${tenant.tenantName}, skipping`);
  }

  if (tenant.dkimConfigured && tenant.status !== "completed") {
    await prisma.tenant.update({
      where: { id: tenant.id },
      data: {
        status: "completed",
        currentStep: "DKIM configured. Tenant completed.",
        progress: 100
      }
    });
    await logTenantEvent({
      batchId,
      tenantId: tenant.id,
      eventType: "tenant_completed",
      message: "Tenant completed successfully after DKIM"
    });
    await updateBatchStatus(batchId);
    return { state: "completed" };
  }

  const phaseThreeComplete =
    tenant.sharedMailboxesCreated &&
    tenant.passwordsSet &&
    tenant.smtpAuthEnabled &&
    tenant.delegationComplete &&
    tenant.signInEnabled &&
    tenant.cloudAppAdminAssigned;

  if (!phaseThreeComplete && tenant.status !== "completed") {
    try {
      await logTenantEvent({
        batchId,
        tenantId: tenant.id,
        eventType: "phase_start",
        message: "Starting shared mailbox pipeline"
      });
      await setupSharedMailboxes(tenant.id);
    } catch (error: any) {
      console.error("❌ [Worker] Phase 3 failed:", error.message);
      console.error("❌ [Worker] Stack:", error.stack);
      await logTenantEvent({
        batchId,
        tenantId: tenant.id,
        eventType: "phase_failed",
        level: "error",
        message: "Shared mailbox pipeline failed",
        details: { error: error instanceof Error ? error.message : String(error) }
      });
      throw error;
    }
    console.log("✅ [Worker] Shared mailbox pipeline complete");
    await logTenantEvent({
      batchId,
      tenantId: tenant.id,
      eventType: "phase_complete",
      message: "Shared mailbox pipeline completed"
    });
    tenant = await loadTenant();
    if (!tenant || tenant.status === "failed") {
      await updateBatchStatus(batchId);
      return { state: "failed" };
    }
  } else {
    console.log(`✓ [Worker] Shared mailbox pipeline already complete for ${tenant.tenantName}, skipping`);
  }

  if (!tenant.dkimConfigured) {
    await logTenantEvent({
      batchId,
      tenantId: tenant.id,
      eventType: "phase_start",
      message: "Starting DKIM setup"
    });
    const dkimResult = await configureDkim(tenant.id);
    if (dkimResult.verificationDeferred) {
      console.log("⚠️ [Worker] DKIM enable deferred due to propagation. Continuing pipeline.");
      await logTenantEvent({
        batchId,
        tenantId: tenant.id,
        eventType: "phase_warning",
        level: "warn",
        message: "DKIM propagation pending; tenant continued without blocking",
        details: { reason: dkimResult.reason || "Propagation pending" }
      });
    } else {
      console.log("✅ [Worker] DKIM configured");
    }
    await logTenantEvent({
      batchId,
      tenantId: tenant.id,
      eventType: "phase_complete",
      message: "DKIM setup completed"
    });
    tenant = await loadTenant();
    if (!tenant || tenant.status === "failed") {
      await updateBatchStatus(batchId);
      return { state: "failed" };
    }
  } else {
    console.log(`✓ [Worker] DKIM already configured for ${tenant.tenantName}, skipping`);
  }

  const smartleadKey = (process.env.SMARTLEAD_API_KEY || "").trim();
  const instantlyKey = (process.env.INSTANTLY_API_KEY || "").trim();
  const shouldConnectSmartlead = smartleadKey.length > 0 && smartleadKey !== "none";
  const shouldConnectInstantly = instantlyKey.length > 0 && instantlyKey !== "none";

  if (!tenant) {
    await updateBatchStatus(batchId);
    return { state: "failed" };
  }

  if (shouldConnectSmartlead && !tenant.smartleadConnected) {
    await logTenantEvent({
      batchId,
      tenantId: tenant.id,
      eventType: "phase_start",
      message: "Starting Smartlead mailbox connection"
    });
    await connectMailboxesToSequencer(tenant.id, "smartlead");
    console.log("✅ [Worker] Smartlead integration complete");
    await logTenantEvent({
      batchId,
      tenantId: tenant.id,
      eventType: "phase_complete",
      message: "Smartlead mailbox connection completed"
    });
    tenant = await loadTenant();
  } else if (shouldConnectSmartlead) {
    console.log(`✓ [Worker] Smartlead already connected for ${tenant.tenantName}, skipping`);
  } else {
    console.log("ℹ️ [Worker] SMARTLEAD_API_KEY not set, skipping Smartlead integration");
  }

  if (!tenant) {
    await updateBatchStatus(batchId);
    return { state: "failed" };
  }

  if (shouldConnectInstantly && !tenant.instantlyConnected) {
    await logTenantEvent({
      batchId,
      tenantId: tenant.id,
      eventType: "phase_start",
      message: "Starting Instantly mailbox connection"
    });
    await connectMailboxesToSequencer(tenant.id, "instantly");
    console.log("✅ [Worker] Instantly integration complete");
    await logTenantEvent({
      batchId,
      tenantId: tenant.id,
      eventType: "phase_complete",
      message: "Instantly mailbox connection completed"
    });
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

  // Completion gate: once DKIM is configured and optional integrations are
  // either connected or intentionally skipped (no API key), mark tenant done.
  const phaseFourComplete =
    tenant.dkimConfigured &&
    (!shouldConnectSmartlead || tenant.smartleadConnected) &&
    (!shouldConnectInstantly || tenant.instantlyConnected);

  if (phaseFourComplete && tenant.status !== "completed") {
    // Bug 12.6: verify, end-of-flow, that every persona's display name
    // actually matches in Microsoft. Non-blocking — mismatches surface
    // as a phase_warning so the operator can spot them, but the tenant
    // still completes. If the verification call itself errors, log and
    // proceed; this is a safety check, not a gate.
    try {
      const dnCheck = await verifyPersonaDisplayNames(tenant.id);
      if (dnCheck.mismatched.length > 0) {
        console.log(
          `⚠️ [Worker] ${tenant.tenantName}: ${dnCheck.mismatched.length}/${dnCheck.total} persona display names did not match Microsoft state`
        );
        await logTenantEvent({
          batchId,
          tenantId: tenant.id,
          eventType: "phase_warning",
          level: "warn",
          message: `Display name verification: ${dnCheck.mismatched.length} of ${dnCheck.total} did not match expected`,
          details: {
            total: dnCheck.total,
            matched: dnCheck.matched,
            // Cap to first 10 so the event stays readable in tools.
            mismatched: dnCheck.mismatched.slice(0, 10),
            mismatchedCount: dnCheck.mismatched.length
          }
        });
      } else if (dnCheck.total > 0) {
        console.log(
          `✓ [Worker] ${tenant.tenantName}: all ${dnCheck.total} persona display names verified`
        );
      } else if (dnCheck.reason) {
        console.log(`ℹ️ [Worker] ${tenant.tenantName}: display-name verification skipped — ${dnCheck.reason}`);
      }
    } catch (error) {
      // Verification failure is non-fatal — log and continue. The pipeline
      // already passed every other completion gate; refusing to mark the
      // tenant complete because the verification call hit a transient 5xx
      // would do more harm than good.
      console.log(
        `⚠️ [Worker] Display name verification failed for ${tenant.tenantName}:`,
        error instanceof Error ? error.message : String(error)
      );
    }

    await prisma.tenant.update({
      where: { id: tenant.id },
      data: {
        status: "completed",
        currentStep: "All mailboxes configured and connected",
        progress: 100
      }
    });
    console.log("✅ [Worker] Phase 4 complete");
    await logTenantEvent({
      batchId,
      tenantId: tenant.id,
      eventType: "tenant_completed",
      message: "Tenant completed successfully"
    });

    // Slack: tenant provisioned. Separate from uploader start so the user
    // sees provisioning-vs-upload as distinct lifecycle moments.
    void slackNotify(
      `Tenant provisioned: ${tenant.tenantName} (${tenant.domain})`,
      "info"
    );

    // Phase 4.5: profile photos. Idempotent re-extraction of personas (catches
    // any inboxNames edits since batch submission), then auto-apply if EVERY
    // persona has a photo uploaded. Partial sets fall through to manual apply
    // via POST /api/tenant/{id}/apply-photos. Failures are logged but never
    // block the ESP-upload handoff — photos are best-effort polish, not a
    // gate on getting accounts into Instantly/Smartlead.
    try {
      const personas = await extractPersonas(tenant.id);
      if (personas.length > 0 && personas.every((p) => p.hasPhoto)) {
        const result = await applyPhotosToTenant(tenant.id);
        await logTenantEvent({
          batchId,
          tenantId: tenant.id,
          eventType: "profile_photos_applied",
          message: `Profile photos applied: ${result.applied}/${result.applied + result.failed + result.skipped} mailboxes (failed=${result.failed}, skipped=${result.skipped})`,
          details: {
            applied: result.applied,
            failed: result.failed,
            skipped: result.skipped
          }
        });
        if (result.applied > 0) {
          void slackNotify(
            `Profile photos applied: ${tenant.tenantName} — ${result.applied} mailboxes`,
            result.failed > 0 ? "warn" : "info"
          );
        }
      } else if (personas.length > 0) {
        const missing = personas.filter((p) => !p.hasPhoto).map((p) => p.personaName);
        await logTenantEvent({
          batchId,
          tenantId: tenant.id,
          eventType: "profile_photos_skipped",
          message: `Auto-apply skipped — ${missing.length}/${personas.length} persona(s) have no photo: ${missing.join(", ")}. Operator can upload + click "Apply Photos" later.`
        });
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await logTenantEvent({
        batchId,
        tenantId: tenant.id,
        eventType: "profile_photos_failed",
        level: "error",
        message: `Profile photo apply failed: ${message}`
      });
    }

    // Phase 5: if the batch opted in to auto-upload, hand off to the
    // tenant-upload queue. The upload worker owns all retry/backoff/polling —
    // we just enqueue and move on.
    const batchCfg = await prisma.batch.findUnique({
      where: { id: batchId },
      select: { uploaderAutoTrigger: true, uploaderEsp: true }
    });
    if (batchCfg?.uploaderAutoTrigger && batchCfg.uploaderEsp) {
      try {
        await enqueueStartUpload({ tenantId: tenant.id, batchId });
        await logTenantEvent({
          batchId,
          tenantId: tenant.id,
          eventType: "uploader_enqueued",
          message: `Upload enqueued (${batchCfg.uploaderEsp})`
        });
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        await logTenantEvent({
          batchId,
          tenantId: tenant.id,
          eventType: "uploader_enqueue_failed",
          level: "error",
          message: `Failed to enqueue upload: ${msg}`
        });
      }
    }
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
      await logTenantEvent({
        batchId: job.data.batchId,
        tenantId: job.data.tenantId,
        eventType: "worker_failed",
        level: "error",
        message: "Worker job failed after retries",
        details: { error: message }
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
          console.error("❌ [Worker] Error:", error instanceof Error ? error.message : String(error));
          if (error instanceof Error && error.stack) {
            console.error("❌ [Worker] Stack:", error.stack);
          }
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
        concurrency: Math.max(1, Number(process.env.WORKER_CONCURRENCY || 1))
      }
    );

    attachWorkerEvents(globalWorker.tenantProcessorWorker);
  }

  return globalWorker.tenantProcessorWorker;
}
