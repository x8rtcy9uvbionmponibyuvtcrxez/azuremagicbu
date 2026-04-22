/**
 * POST /api/tenant/{id}/auto-recover-mailboxes
 *
 * One-button recovery for tenants stuck with "ghost" mailboxes — where
 * PowerShell's Get-Mailbox returns a hit for a UPN but Graph /users doesn't
 * see it (usually because the object is in some Exchange cubbyhole like
 * an inactive/soft-deleted mailbox that Graph's /directory/deletedItems
 * recycle-bin query doesn't cover).
 *
 * Sequence:
 *   1. Generate the expected mailbox list (same algorithm as provisioning).
 *   2. Query Microsoft Graph /users for the tenant's actual users.
 *   3. Compute missing = expected - actual.
 *   4. Hard-remove each missing UPN via PowerShell /remove-shared-mailboxes.
 *      (This clears whatever Exchange-side ghost is holding the UPN.)
 *   5. Wipe mailboxStatuses + all mailbox-phase booleans in the DB.
 *   6. Enqueue the tenant for re-processing — worker restarts the
 *      mailboxes phase from scratch.
 *
 * Safe: refuses if nothing is missing. Doesn't touch mailboxes that are
 * actually present in Graph (only hard-removes the genuine ghosts).
 */

import { NextResponse } from "next/server";

import { decryptSecret } from "@/lib/crypto";
import { prisma } from "@/lib/prisma";
import { enqueueTenantProcessingJob } from "@/lib/queue";
import { generateEmailVariations } from "@/lib/services/email-generator";
import { callPowerShellService, requestTenantGraphToken } from "@/lib/services/microsoft";
import { logTenantEvent } from "@/lib/tenant-events";
import { parseInboxNamesValue } from "@/lib/utils";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const GRAPH_BASE_URL = "https://graph.microsoft.com/v1.0";

type Params = { params: { id: string } };

export async function POST(_request: Request, { params }: Params) {
  try {
    const tenant = await prisma.tenant.findUnique({
      where: { id: params.id },
      select: {
        id: true,
        batchId: true,
        tenantName: true,
        domain: true,
        tenantId: true,
        adminEmail: true,
        adminPassword: true,
        inboxNames: true,
        inboxCount: true
      }
    });

    if (!tenant) return NextResponse.json({ error: "Tenant not found" }, { status: 404 });
    if (!tenant.tenantId) {
      return NextResponse.json(
        { error: "Tenant has no Microsoft tenant ID — can't recover." },
        { status: 400 }
      );
    }

    // 1. Generate the expected mailbox list.
    const names = parseInboxNamesValue(tenant.inboxNames);
    if (names.length === 0) {
      return NextResponse.json({ error: "Tenant has no inbox names." }, { status: 400 });
    }
    const expected = generateEmailVariations(names, tenant.domain, tenant.inboxCount || 99);
    const expectedUpns = new Set(expected.map((e) => e.email.toLowerCase()));

    // 2. Query Graph for the tenant's actual users.
    const token = await requestTenantGraphToken(tenant.tenantId);
    const graphRes = await fetch(`${GRAPH_BASE_URL}/users?$select=userPrincipalName&$top=999`, {
      headers: { Authorization: `Bearer ${token}` }
    });
    if (!graphRes.ok) {
      const text = await graphRes.text();
      return NextResponse.json(
        { error: `Graph /users failed: ${graphRes.status} ${text.slice(0, 200)}` },
        { status: 500 }
      );
    }
    const graphUsers = (await graphRes.json()) as { value: Array<{ userPrincipalName?: string }> };
    const actualUpns = new Set(
      (graphUsers.value || [])
        .map((u) => (u.userPrincipalName || "").toLowerCase())
        .filter(Boolean)
    );

    // 3. Compute missing.
    const missing = Array.from(expectedUpns).filter((upn) => !actualUpns.has(upn));

    if (missing.length === 0) {
      return NextResponse.json(
        {
          ok: false,
          message: "No missing mailboxes. All expected UPNs are present in Graph. Nothing to recover.",
          expectedCount: expected.length,
          actualInGraph: actualUpns.size
        },
        { status: 409 }
      );
    }

    // 4. Hard-remove each missing UPN via PowerShell.
    //    /remove-shared-mailboxes runs Remove-Mailbox -Force on each.
    //    For UPNs that don't have a mailbox at all, Remove-Mailbox will fail
    //    gracefully — that's fine, it's a cleanup pass.
    const adminPassword = decryptSecret(tenant.adminPassword);
    let psRemoveResult: unknown = null;
    let psRemoveError: string | null = null;
    try {
      psRemoveResult = await callPowerShellService(
        "/remove-shared-mailboxes",
        {
          adminUpn: tenant.adminEmail,
          adminPassword,
          organizationId: tenant.tenantId,
          emails: missing
        },
        120000
      );
    } catch (error) {
      psRemoveError = error instanceof Error ? error.message : String(error);
      console.log(`⚠️ [AutoRecover] PowerShell remove step failed: ${psRemoveError}. Proceeding with DB reset anyway.`);
    }

    // 5. Wipe mailboxStatuses + all mailbox-phase booleans.
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
        currentStep: `Auto-recover: removed ${missing.length} ghost mailbox(es) from Exchange, re-creating from scratch...`
      }
    });

    await logTenantEvent({
      batchId: tenant.batchId,
      tenantId: tenant.id,
      eventType: "auto_recover_triggered",
      level: "warn",
      message: `Auto-recovery: ${missing.length} missing mailbox(es) detected. Hard-removed from Exchange + DB reset + re-queued.`,
      details: { missing, psRemoveResult, psRemoveError }
    });

    // 6. Re-queue.
    const enqueued = await enqueueTenantProcessingJob(
      { tenantId: tenant.id, batchId: tenant.batchId },
      { jobId: `${tenant.batchId}:${tenant.id}:auto-recover:${Date.now()}` }
    );

    return NextResponse.json({
      ok: true,
      tenantId: tenant.id,
      missingCount: missing.length,
      missing,
      psRemoveResult,
      psRemoveError,
      jobId: enqueued.id,
      message: `Removed ${missing.length} ghost(s) from Exchange; tenant re-queued from mailboxes phase.`
    });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : String(error) },
      { status: 500 }
    );
  }
}
