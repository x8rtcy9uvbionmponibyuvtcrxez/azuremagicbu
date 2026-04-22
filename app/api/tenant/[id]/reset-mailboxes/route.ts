/**
 * POST /api/tenant/{id}/reset-mailboxes
 *
 * Recover from "ghost mailbox" state: the worker marked the mailbox-phase
 * as done in the DB (mailboxStatuses + sharedMailboxesCreated=true, etc.),
 * but Microsoft actually doesn't have those mailboxes. Plain /retry can't
 * recover this because the processor trusts the DB flags and skips the
 * mailbox-creation phase.
 *
 * This endpoint:
 *   1. Runs the diagnostic to verify mailbox drift actually exists in
 *      Microsoft vs the DB (refuses to run if mailboxes DO exist).
 *   2. Wipes mailboxStatuses + resets all downstream mailbox-phase flags.
 *   3. Enqueues the tenant for re-processing, starting at the mailboxes
 *      phase.
 *
 * Safe: read diagnostic before write. Never wipes state unless Graph
 * confirms the mailboxes genuinely aren't there.
 */

import { NextResponse } from "next/server";

import { prisma } from "@/lib/prisma";
import { enqueueTenantProcessingJob } from "@/lib/queue";
import { diagnoseTenant } from "@/lib/services/diagnostics";
import { logTenantEvent } from "@/lib/tenant-events";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Params = {
  params: {
    id: string;
  };
};

export async function POST(_request: Request, { params }: Params) {
  try {
    const tenant = await prisma.tenant.findUnique({
      where: { id: params.id },
      select: { id: true, batchId: true, tenantName: true, domain: true }
    });

    if (!tenant) {
      return NextResponse.json({ error: "Tenant not found" }, { status: 404 });
    }

    // Safety check: confirm the mailboxes are actually missing in Microsoft
    // before wiping any DB state. Don't trust user intent alone — trust Graph.
    let diagnostic;
    try {
      diagnostic = await diagnoseTenant(tenant.id);
    } catch (error) {
      return NextResponse.json(
        {
          error:
            "Could not run diagnostic to confirm mailbox drift — refusing to wipe DB state without verification. " +
            (error instanceof Error ? error.message : String(error))
        },
        { status: 500 }
      );
    }

    const driftCheck = diagnostic.checks.find((c) => c.name === "mailbox_drift");

    if (!driftCheck) {
      return NextResponse.json(
        { error: "Diagnostic didn't include a mailbox_drift check. Aborting.", diagnostic },
        { status: 500 }
      );
    }

    if (driftCheck.status === "pass") {
      return NextResponse.json(
        {
          error:
            "No mailbox drift detected — mailboxes the DB thinks were created are actually present in Microsoft. Use /retry instead.",
          diagnostic
        },
        { status: 409 }
      );
    }

    if (driftCheck.status === "skip") {
      return NextResponse.json(
        {
          error:
            "DB has no recorded mailboxes (nothing to reset). Use /retry to run the mailboxes phase from scratch.",
          diagnostic
        },
        { status: 409 }
      );
    }

    // driftCheck.status is "warn" or "fail" — there IS drift. Proceed with reset.

    const missingCount =
      (driftCheck.data as { missingInGraph?: unknown[] } | undefined)?.missingInGraph?.length ?? 0;
    const totalInDb = (driftCheck.data as { totalInDb?: number } | undefined)?.totalInDb ?? 0;

    await prisma.tenant.update({
      where: { id: tenant.id },
      data: {
        mailboxStatuses: null,
        sharedMailboxesCreated: false,
        passwordsSet: false,
        smtpAuthEnabled: false,
        delegationComplete: false,
        signInEnabled: false,
        cloudAppAdminAssigned: false,
        status: "mailboxes",
        progress: 60,
        errorMessage: null,
        currentStep: `Mailbox state reset (was ${totalInDb - missingCount}/${totalInDb} actually present in Microsoft). Re-creating shared mailboxes...`
      }
    });

    await logTenantEvent({
      batchId: tenant.batchId,
      tenantId: tenant.id,
      eventType: "mailboxes_reset",
      level: "warn",
      message: `Mailbox state reset: DB thought ${totalInDb} mailboxes existed, Graph found ${totalInDb - missingCount}. Re-queueing for mailbox recreation.`,
      details: { missingCount, totalInDb }
    });

    const enqueued = await enqueueTenantProcessingJob(
      { tenantId: tenant.id, batchId: tenant.batchId },
      { jobId: `${tenant.batchId}:${tenant.id}:reset-mailboxes:${Date.now()}` }
    );

    return NextResponse.json({
      ok: true,
      tenantId: tenant.id,
      missingCount,
      totalInDb,
      jobId: enqueued.id,
      message: `Reset ${totalInDb} mailbox records; re-creating ${totalInDb} mailboxes from scratch.`
    });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : String(error) },
      { status: 500 }
    );
  }
}
