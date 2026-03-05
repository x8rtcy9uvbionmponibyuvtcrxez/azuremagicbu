import { NextResponse } from "next/server";

import { prisma } from "@/lib/prisma";
import { enqueueTenantProcessingJob } from "@/lib/queue";
import { pollDeviceAuthToken } from "@/lib/services/microsoft";
import { startTenantProcessorWorker } from "@/lib/workers/processor";

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
      status: true,
      tenants: {
        orderBy: { createdAt: "asc" },
        select: {
          id: true,
          tenantName: true,
          domain: true,
          status: true,
          authConfirmed: true,
          deviceCode: true,
          tenantId: true
        }
      }
    }
  });

  if (!batch) {
    return NextResponse.json({ error: "Batch not found" }, { status: 404 });
  }

  const processableTenants = batch.tenants.filter((tenant) => !["completed", "failed"].includes(tenant.status));
  if (processableTenants.length === 0) {
    return NextResponse.json({ started: true, count: 0 });
  }

  const validationResults = await Promise.all(
    processableTenants.map(async (tenant) => {
      try {
        if (tenant.authConfirmed && tenant.tenantId) {
          return { tenantId: tenant.id, ready: true as const, organizationId: tenant.tenantId };
        }

        if (!tenant.deviceCode) {
          return {
            tenantId: tenant.id,
            tenantName: tenant.tenantName,
            domain: tenant.domain,
            ready: false as const,
            error: "Device code missing. Generate all codes first."
          };
        }

        const verification = await pollDeviceAuthToken(tenant.id, tenant.deviceCode);
        if (!verification.verified) {
          return {
            tenantId: tenant.id,
            tenantName: tenant.tenantName,
            domain: tenant.domain,
            ready: false as const,
            error: "Authorization still pending"
          };
        }

        return {
          tenantId: tenant.id,
          ready: true as const,
          organizationId: verification.organizationId || tenant.tenantId
        };
      } catch (error) {
        return {
          tenantId: tenant.id,
          tenantName: tenant.tenantName,
          domain: tenant.domain,
          ready: false as const,
          error: error instanceof Error ? error.message : String(error)
        };
      }
    })
  );

  const notReady = validationResults.filter((result) => !result.ready);
  if (notReady.length > 0) {
    return NextResponse.json(
      {
        error: "Some tenants are not authorized yet. Finish device login and retry.",
        notReady
      },
      { status: 409 }
    );
  }

  const readyResults = validationResults.filter(
    (result): result is { tenantId: string; ready: true; organizationId: string | null } => result.ready
  );

  await Promise.all(
    readyResults.map((result) =>
      prisma.tenant.update({
        where: { id: result.tenantId },
        data: {
          authConfirmed: true,
          tenantId: result.organizationId || undefined,
          status: "queued",
          progress: 66,
          currentStep: "Authorization confirmed. Queued for processing...",
          errorMessage: null
        }
      })
    )
  );

  await prisma.batch.update({
    where: { id: batch.id },
    data: { status: "processing" }
  });

  startTenantProcessorWorker();

  const seed = Date.now();
  const staggerMs = 2500;

  await Promise.all(
    processableTenants.map((tenant, index) =>
      enqueueTenantProcessingJob(
        {
          tenantId: tenant.id,
          batchId: batch.id
        },
        {
          delayMs: index * staggerMs,
          jobId: `${batch.id}:${tenant.id}:start:${seed}:${index}`
        }
      )
    )
  );

  return NextResponse.json({ started: true, count: processableTenants.length });
}
