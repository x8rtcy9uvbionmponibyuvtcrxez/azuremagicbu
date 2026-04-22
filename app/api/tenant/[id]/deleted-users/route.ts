/**
 * GET /api/tenant/{id}/deleted-users
 *
 * Read-only dump of everything in the tenant's Azure AD deleted-users recycle
 * bin. Useful for diagnosing "conflicting object" creation errors that don't
 * surface via the main diagnostic's drift-based check.
 */

import { NextResponse } from "next/server";

import { prisma } from "@/lib/prisma";
import { requestTenantGraphToken } from "@/lib/services/microsoft";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const GRAPH_BASE_URL = "https://graph.microsoft.com/v1.0";

type Params = { params: { id: string } };

export async function GET(_request: Request, { params }: Params) {
  try {
    const tenant = await prisma.tenant.findUnique({
      where: { id: params.id },
      select: { id: true, domain: true, tenantId: true }
    });
    if (!tenant) return NextResponse.json({ error: "Tenant not found" }, { status: 404 });
    if (!tenant.tenantId) return NextResponse.json({ error: "No Microsoft tenant ID" }, { status: 400 });

    const token = await requestTenantGraphToken(tenant.tenantId);

    const response = await fetch(
      `${GRAPH_BASE_URL}/directory/deletedItems/microsoft.graph.user?$select=id,userPrincipalName,deletedDateTime&$top=999`,
      { headers: { Authorization: `Bearer ${token}` } }
    );
    const text = await response.text();
    const payload = text ? JSON.parse(text) : {};
    if (!response.ok) {
      return NextResponse.json(
        { error: payload.error?.message || `Graph ${response.status}` },
        { status: response.status }
      );
    }

    const users = (payload.value || []) as Array<{ id: string; userPrincipalName?: string; deletedDateTime?: string }>;
    return NextResponse.json({
      tenantId: tenant.tenantId,
      domain: tenant.domain,
      count: users.length,
      users: users.map((u) => ({ id: u.id, upn: u.userPrincipalName, deletedAt: u.deletedDateTime }))
    });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : String(error) },
      { status: 500 }
    );
  }
}
