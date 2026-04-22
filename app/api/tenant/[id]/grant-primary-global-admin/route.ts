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
 * Sequence:
 *   1. Load tenant + verify licensedUserId is set.
 *   2. Acquire app-only Graph token for the tenant (our SP has Global Admin,
 *      granted during completeTenantPrep, so this works).
 *   3. Find the "Global Administrator" directoryRole — activate from template
 *      if not yet present in this tenant.
 *   4. POST /directoryRoles/{id}/members/$ref with the primary user URL.
 *      Treat "already exists" as success.
 *   5. Return result.
 */

import { NextResponse } from "next/server";

import { prisma } from "@/lib/prisma";
import { requestTenantGraphToken } from "@/lib/services/microsoft";
import { logTenantEvent } from "@/lib/tenant-events";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const GRAPH_BASE_URL = "https://graph.microsoft.com/v1.0";

type Params = { params: { id: string } };

async function graph<T>(token: string, path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${GRAPH_BASE_URL}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      ...(init?.headers || {})
    }
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Graph ${init?.method || "GET"} ${path} failed: ${res.status} ${text.slice(0, 400)}`);
  }
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

async function ensureGlobalAdminRoleActivated(token: string): Promise<string> {
  const roles = await graph<{ value: Array<{ id: string; displayName: string }> }>(
    token,
    "/directoryRoles"
  );
  const existing = roles.value?.find((r) => r.displayName === "Global Administrator");
  if (existing) return existing.id;

  const templates = await graph<{ value: Array<{ id: string; displayName: string }> }>(
    token,
    "/directoryRoleTemplates"
  );
  const template = templates.value?.find((t) => t.displayName === "Global Administrator");
  if (!template) {
    throw new Error("Global Administrator template not found in tenant");
  }
  const activated = await graph<{ id: string }>(token, "/directoryRoles", {
    method: "POST",
    body: JSON.stringify({ roleTemplateId: template.id })
  });
  return activated.id;
}

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
    const roleId = await ensureGlobalAdminRoleActivated(token);

    let alreadyAssigned = false;
    try {
      await graph<Record<string, unknown>>(
        token,
        `/directoryRoles/${roleId}/members/$ref`,
        {
          method: "POST",
          body: JSON.stringify({
            "@odata.id": `${GRAPH_BASE_URL}/users/${tenant.licensedUserId}`
          })
        }
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const normalized = message.toLowerCase();
      if (
        normalized.includes("already exist") ||
        normalized.includes("added already") ||
        normalized.includes("one or more added object references already exist")
      ) {
        alreadyAssigned = true;
      } else {
        throw error;
      }
    }

    await logTenantEvent({
      batchId: tenant.batchId,
      tenantId: tenant.id,
      eventType: "primary_global_admin_granted",
      message: alreadyAssigned
        ? `Primary user ${tenant.licensedUserUpn} already had Global Administrator`
        : `Granted Global Administrator to primary user ${tenant.licensedUserUpn}`,
      details: { licensedUserId: tenant.licensedUserId, licensedUserUpn: tenant.licensedUserUpn, roleId }
    });

    return NextResponse.json({
      ok: true,
      tenantId: tenant.id,
      tenantName: tenant.tenantName,
      licensedUserId: tenant.licensedUserId,
      licensedUserUpn: tenant.licensedUserUpn,
      roleId,
      alreadyAssigned
    });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : String(error) },
      { status: 500 }
    );
  }
}
