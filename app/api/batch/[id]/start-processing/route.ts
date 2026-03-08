import { NextResponse } from "next/server";

import { prisma } from "@/lib/prisma";
import { enqueueTenantProcessingJob } from "@/lib/queue";
import { pollDeviceAuthToken } from "@/lib/services/microsoft";
import { isLikelyTenantIdentifier, isSyntheticTestTenantId } from "@/lib/tenant-identifier";
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
            if (isSyntheticTestTenantId(tenant.tenantId) || !isLikelyTenantIdentifier(tenant.tenantId)) {
              return {
                tenantId: tenant.id,
                tenantName: tenant.tenantName,
                domain: tenant.domain,
                ready: false as const,
                error: "Invalid tenant identifier from a prior test/auth run. Retry tenant to regenerate authorization."
              };
            }
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
      await Promise.all(
        notReady.map((item) =>
          logTenantEvent({
            batchId: batch.id,
            tenantId: item.tenantId,
            eventType: "processing_blocked",
            level: "warn",
            message: "Cannot start processing: tenant is not authorized yet",
            details: {
              tenantName: item.tenantName,
              domain: item.domain,
              error: item.error
            }
          })
        )
      );
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

    await Promise.all(
      readyResults.map((result) =>
        logTenantEvent({
          batchId: batch.id,
          tenantId: result.tenantId,
          eventType: "processing_started",
          message: "Authorization confirmed. Tenant queued for worker processing",
          details: { organizationId: result.organizationId }
        })
      )
    );

    // Only enqueue the FIRST tenant with a 6-minute permission propagation delay.
    // When it completes, the worker will enqueue the next queued tenant in the batch.
    const PERMISSION_PROPAGATION_DELAY_MS = Math.round(
      Math.max(60_000, Number(process.env.PRIVILEGE_PROPAGATION_BASE_DELAY_MS || 318_000)) *
      Math.max(1, Number(process.env.PRIVILEGE_PROPAGATION_BUFFER_MULTIPLIER || 1.2))
    );

    const firstTenant = processableTenants[0];
    const seed = Date.now();

    const waitMinutes = Math.round(PERMISSION_PROPAGATION_DELAY_MS / 60_000);

    await prisma.tenant.update({
      where: { id: firstTenant.id },
      data: {
        currentStep: `Waiting ${waitMinutes}m for Microsoft permission propagation...`
      }
    });

    await enqueueTenantProcessingJob(
      { tenantId: firstTenant.id, batchId: batch.id },
      {
        delayMs: PERMISSION_PROPAGATION_DELAY_MS,
        jobId: `${batch.id}:${firstTenant.id}:start:${seed}:0`
      }
    );

    // Mark remaining tenants as waiting — they'll be chained by the worker after the previous one completes
    for (let i = 1; i < processableTenants.length; i++) {
      await prisma.tenant.update({
        where: { id: processableTenants[i].id },
        data: {
          currentStep: `Queued — will start after tenant ${i} of ${processableTenants.length} completes`
        }
      });
    }

    await prisma.batch.update({
      where: { id: batch.id },
      data: { status: "processing" }
    });

    return NextResponse.json({ started: true, count: processableTenants.length });
  } catch (error) {
    return NextResponse.json(
      {
        error: "Failed to start processing.",
        details: error instanceof Error ? error.message : String(error)
      },
      { status: 500 }
    );
  }
}
