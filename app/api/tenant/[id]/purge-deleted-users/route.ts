/**
 * POST /api/tenant/{id}/purge-deleted-users
 *
 * When Azure AD's soft-delete recycle bin is blocking mailbox recreation
 * ("conflicting object" error from Graph), this endpoint hard-deletes the
 * matching users from the recycle bin to free their UPNs for reuse.
 *
 * Safety:
 *   - Only purges users whose UPN is in the DB's mailboxStatuses (i.e.,
 *     users we expected to exist for THIS tenant). Never touches unrelated
 *     soft-deleted users.
 *   - Read-before-write: refuses to run if the diagnostic shows no
 *     `deleted_users_blocking` warning.
 */

import { NextResponse } from "next/server";

import { prisma } from "@/lib/prisma";
import { diagnoseTenant } from "@/lib/services/diagnostics";
import { requestTenantGraphToken } from "@/lib/services/microsoft";
import { logTenantEvent } from "@/lib/tenant-events";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const GRAPH_BASE_URL = "https://graph.microsoft.com/v1.0";

type Params = {
  params: {
    id: string;
  };
};

async function graphDelete(token: string, path: string): Promise<void> {
  const response = await fetch(`${GRAPH_BASE_URL}${path}`, {
    method: "DELETE",
    headers: { Authorization: `Bearer ${token}` }
  });
  if (!response.ok && response.status !== 204 && response.status !== 404) {
    const text = await response.text();
    throw new Error(`Graph DELETE ${path} failed (${response.status}): ${text.slice(0, 200)}`);
  }
}

export async function POST(_request: Request, { params }: Params) {
  try {
    const tenant = await prisma.tenant.findUnique({
      where: { id: params.id },
      select: { id: true, batchId: true, tenantName: true, domain: true, tenantId: true }
    });

    if (!tenant) {
      return NextResponse.json({ error: "Tenant not found" }, { status: 404 });
    }

    if (!tenant.tenantId) {
      return NextResponse.json({ error: "Tenant has no Microsoft tenant ID." }, { status: 400 });
    }

    // Safety check: run diagnostic to confirm there's actually something to purge.
    const diagnostic = await diagnoseTenant(tenant.id);
    const blockingCheck = diagnostic.checks.find((c) => c.name === "deleted_users_blocking");

    if (!blockingCheck || blockingCheck.status !== "warn") {
      return NextResponse.json(
        {
          error:
            "No soft-deleted blocking users found. Either the drift isn't a soft-delete conflict, or the recycle bin couldn't be read. Check the diagnostic output.",
          diagnostic
        },
        { status: 409 }
      );
    }

    const blocking = (blockingCheck.data as { blocking?: Array<{ email: string; deletedId: string }> } | undefined)?.blocking || [];

    if (blocking.length === 0) {
      return NextResponse.json({ error: "No entries to purge.", diagnostic }, { status: 409 });
    }

    const token = await requestTenantGraphToken(tenant.tenantId);

    const purged: string[] = [];
    const failed: Array<{ email: string; error: string }> = [];

    for (const { email, deletedId } of blocking) {
      try {
        await graphDelete(token, `/directory/deletedItems/${deletedId}`);
        purged.push(email);
      } catch (error) {
        failed.push({ email, error: error instanceof Error ? error.message : String(error) });
      }
    }

    await logTenantEvent({
      batchId: tenant.batchId,
      tenantId: tenant.id,
      eventType: "deleted_users_purged",
      level: "warn",
      message: `Hard-deleted ${purged.length} soft-deleted users from Azure AD recycle bin to free UPNs for recreation.`,
      details: { purged, failed }
    });

    return NextResponse.json({
      ok: true,
      tenantId: tenant.id,
      purgedCount: purged.length,
      failedCount: failed.length,
      purged,
      failed,
      nextStep: "Call /api/tenant/{id}/reset-mailboxes to re-create the freed mailboxes."
    });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : String(error) },
      { status: 500 }
    );
  }
}
