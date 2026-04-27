/**
 * GET /api/services/tenants — list of tenants the operator can run a
 * service against. Powers the "Pick tenant" dropdown on the Services
 * wizard. Filters to tenants that have a Microsoft tenantId AND a
 * licensedUserUpn (i.e. provisioning got far enough that we can actually
 * call Graph against them).
 */

import { NextResponse } from "next/server";

import { prisma } from "@/lib/prisma";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const tenants = await prisma.tenant.findMany({
    where: { tenantId: { not: null }, licensedUserUpn: { not: null } },
    orderBy: { createdAt: "desc" },
    select: {
      id: true,
      tenantName: true,
      domain: true,
      status: true,
      licensedUserUpn: true,
      createdAt: true,
      batch: { select: { id: true, uploaderEsp: true } },
    },
  });
  return NextResponse.json({
    tenants: tenants.map((t) => ({
      ...t,
      createdAt: t.createdAt.toISOString(),
    })),
  });
}
