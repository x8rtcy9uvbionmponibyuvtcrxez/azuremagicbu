/**
 * POST /api/tenant/{id}/grant-primary-global-admin
 *
 * Idempotently grants the Global Administrator directory role to the
 * tenant's primary licensed user (licensedUserUpn / licensedUserId).
 *
 * Why: the primary user is the identity that signs into Instantly/Smartlead
 * OAuth. If they hold Global Admin, their own sign-in covers the tenant-wide
 * consent prompt — no "Need admin approval" detour via admin@<tenant>.onmicrosoft.com.
 *
 * Never assign Global Admin to the 98 shared mailboxes. Blast radius.
 *
 * As of the provisioning-side rollup of this grant into `createLicensedUser`,
 * this endpoint is mostly useful for retroactive fixes on tenants provisioned
 * before the rollup, or to recover from a transient grant failure during
 * tenant prep. It delegates to the shared `grantGlobalAdmin` helper.
 */

import { NextResponse } from "next/server";

import { prisma } from "@/lib/prisma";
import { grantGlobalAdmin, requestTenantGraphToken } from "@/lib/services/microsoft";
import { logTenantEvent } from "@/lib/tenant-events";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Params = { params: { id: string } };

export async function POST(_request: Request, { params }: Params) {
  try {
    const tenant = await prisma.tenant.findUnique({
      where: { id: params.id },
      select: {
        id: true,
        batchId: true,
        tenantName: true,
        tenantId: true,
        licensedUserId: true,
        licensedUserUpn: true
      }
    });

    if (!tenant) {
      return NextResponse.json({ error: "Tenant not found" }, { status: 404 });
    }
    if (!tenant.tenantId) {
      return NextResponse.json(
        { error: "Tenant has no Microsoft tenant ID — provisioning incomplete." },
        { status: 400 }
      );
    }
    if (!tenant.licensedUserId) {
      return NextResponse.json(
        { error: "Tenant has no licensed user ID — complete licensed user setup first." },
        { status: 400 }
      );
    }

    const token = await requestTenantGraphToken(tenant.tenantId);
    const result = await grantGlobalAdmin(token, {
      kind: "user",
      id: tenant.licensedUserId
    });

    if (!result.ok) {
      return NextResponse.json(
        { error: result.error || "Unknown error granting Global Admin" },
        { status: 500 }
      );
    }

    await logTenantEvent({
      batchId: tenant.batchId,
      tenantId: tenant.id,
      eventType: "primary_global_admin_granted",
      message: result.alreadyAssigned
        ? `Primary user ${tenant.licensedUserUpn} already had Global Administrator`
        : `Granted Global Administrator to primary user ${tenant.licensedUserUpn}`,
      details: {
        licensedUserId: tenant.licensedUserId,
        licensedUserUpn: tenant.licensedUserUpn,
        roleId: result.roleId
      }
    });

    return NextResponse.json({
      ok: true,
      tenantId: tenant.id,
      tenantName: tenant.tenantName,
      licensedUserId: tenant.licensedUserId,
      licensedUserUpn: tenant.licensedUserUpn,
      roleId: result.roleId,
      alreadyAssigned: result.alreadyAssigned ?? false
    });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : String(error) },
      { status: 500 }
    );
  }
}
