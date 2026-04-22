/**
 * GET /api/tenant/{id}/inspect-recipient?upn=user@domain
 *
 * Asks Exchange directly what it thinks a UPN is. Calls the PowerShell
 * service's /inspect-recipient endpoint which runs Get-Recipient,
 * Get-Mailbox (with -IncludeInactiveMailbox), and Get-User in one session.
 *
 * Useful when Graph /users doesn't see a UPN but PowerShell clearly does —
 * tells us if it's a MailUser, an inactive mailbox tombstone, a contact, etc.
 */

import { NextResponse } from "next/server";

import { decryptSecret } from "@/lib/crypto";
import { prisma } from "@/lib/prisma";
import { callPowerShellService } from "@/lib/services/microsoft";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Params = { params: { id: string } };

export async function GET(request: Request, { params }: Params) {
  const url = new URL(request.url);
  const upn = url.searchParams.get("upn");
  if (!upn) {
    return NextResponse.json({ error: "upn query parameter required" }, { status: 400 });
  }

  try {
    const tenant = await prisma.tenant.findUnique({
      where: { id: params.id },
      select: {
        id: true,
        tenantId: true,
        adminEmail: true,
        adminPassword: true
      }
    });
    if (!tenant) return NextResponse.json({ error: "Tenant not found" }, { status: 404 });
    if (!tenant.tenantId) return NextResponse.json({ error: "No Microsoft tenant ID" }, { status: 400 });

    const adminPassword = decryptSecret(tenant.adminPassword);
    const result = await callPowerShellService(
      "/inspect-recipient",
      {
        adminUpn: tenant.adminEmail,
        adminPassword,
        organizationId: tenant.tenantId,
        upn
      },
      60000
    );

    return NextResponse.json(result);
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : String(error) },
      { status: 500 }
    );
  }
}
