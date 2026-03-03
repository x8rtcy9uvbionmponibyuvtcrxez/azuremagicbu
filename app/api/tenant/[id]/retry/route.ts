import { NextResponse } from "next/server";
import type { TenantStatus } from "@prisma/client";

import { prisma } from "@/lib/prisma";
import { enqueueTenantProcessingJob } from "@/lib/queue";
import { startTenantProcessorWorker } from "@/lib/workers/processor";

export const runtime = "nodejs";

type Params = {
  params: {
    id: string;
  };
};

export async function POST(_request: Request, { params }: Params) {
  try {
    const existing = await prisma.tenant.findUnique({
      where: { id: params.id },
      select: {
        id: true,
        batchId: true,
        zoneId: true,
        tenantId: true,
        authConfirmed: true,
        csvUrl: true
      }
    });

    if (!existing) {
      return NextResponse.json({ error: "Tenant not found" }, { status: 404 });
    }

    let restartStatus: TenantStatus = "queued";
    let progress = 0;
    let currentStep = "Retry requested from queue";

    if (existing.zoneId && !existing.tenantId) {
      restartStatus = "tenant_prep";
      progress = 50;
      currentStep = "Retry requested from tenant prep";
    } else if (existing.tenantId && !existing.authConfirmed) {
      restartStatus = "auth_pending";
      progress = 65;
      currentStep = "Retry requested for device auth";
    } else if (existing.tenantId && existing.authConfirmed && !existing.csvUrl) {
      restartStatus = "mailboxes";
      progress = 70;
      currentStep = "Retry requested from mailbox creation";
    } else if (existing.csvUrl) {
      return NextResponse.json({ ok: true, tenantId: existing.id, message: "Tenant already completed." });
    }

    const tenant = await prisma.tenant.update({
      where: { id: existing.id },
      data: {
        status: restartStatus,
        progress,
        errorMessage: null,
        currentStep,
        ...((restartStatus === "tenant_prep" || restartStatus === "auth_pending")
          ? { authConfirmed: false, authCode: null, authCodeExpiry: null }
          : {})
      }
    });

    await prisma.batch.update({
      where: { id: tenant.batchId },
      data: { status: "processing" }
    });

    startTenantProcessorWorker();
    await enqueueTenantProcessingJob({ tenantId: tenant.id, batchId: tenant.batchId });

    return NextResponse.json({ ok: true, tenantId: tenant.id, restartStatus });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Unable to retry tenant" },
      { status: 400 }
    );
  }
}
