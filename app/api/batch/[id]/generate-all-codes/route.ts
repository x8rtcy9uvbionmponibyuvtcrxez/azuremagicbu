import { NextResponse } from "next/server";

import { prisma } from "@/lib/prisma";
import { initiateDeviceAuth } from "@/lib/services/microsoft";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Params = {
  params: {
    id: string;
  };
};

export async function POST(_request: Request, { params }: Params) {
  const batch = await prisma.batch.findUnique({
    where: { id: params.id },
    select: {
      id: true,
      tenants: {
        orderBy: { createdAt: "asc" },
        select: {
          id: true,
          tenantName: true,
          domain: true,
          status: true,
          authCode: true,
          authCodeExpiry: true
        }
      }
    }
  });

  if (!batch) {
    return NextResponse.json({ error: "Batch not found" }, { status: 404 });
  }

  const now = Date.now();
  const tenantsForAuth = batch.tenants.filter((tenant) => !["completed", "failed"].includes(tenant.status));

  const generationResults = await Promise.allSettled(
    tenantsForAuth.map(async (tenant) => {
      const hasActiveCode =
        Boolean(tenant.authCode) &&
        Boolean(tenant.authCodeExpiry) &&
        (tenant.authCodeExpiry?.getTime() || 0) > now;

      if (!hasActiveCode) {
        await initiateDeviceAuth(tenant.id);
      }
    })
  );

  const failures = generationResults
    .map((result, index) => ({ result, tenant: tenantsForAuth[index] }))
    .filter((entry): entry is { result: PromiseRejectedResult; tenant: (typeof tenantsForAuth)[number] } => entry.result.status === "rejected")
    .map((entry) => ({
      tenantId: entry.tenant.id,
      tenantName: entry.tenant.tenantName,
      domain: entry.tenant.domain,
      error: entry.result.reason instanceof Error ? entry.result.reason.message : String(entry.result.reason)
    }));

  const refreshed = await prisma.tenant.findMany({
    where: { batchId: batch.id },
    orderBy: { createdAt: "asc" },
    select: {
      id: true,
      tenantName: true,
      domain: true,
      status: true,
      authCode: true,
      authCodeExpiry: true
    }
  });

  const codes = refreshed
    .filter((tenant) => tenant.authCode && tenant.status === "auth_pending")
    .map((tenant) => ({
      tenantId: tenant.id,
      tenantName: tenant.tenantName,
      domain: tenant.domain,
      code: tenant.authCode as string,
      expiry: tenant.authCodeExpiry ? tenant.authCodeExpiry.toISOString() : null
    }));

  return NextResponse.json({
    codes,
    generatedCount: codes.length,
    failedCount: failures.length,
    failures
  });
}
