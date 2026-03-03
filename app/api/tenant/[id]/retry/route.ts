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
        status: true,
        authCode: true,
        deviceCode: true,
        authCodeExpiry: true,
        authConfirmed: true,
        csvUrl: true
      }
    });

    if (!existing) {
      return NextResponse.json({ error: "Tenant not found" }, { status: 404 });
    }

    if (existing.csvUrl) {
      return NextResponse.json({ error: "Tenant already completed" }, { status: 400 });
    }

    let restartStatus: TenantStatus = "queued";
    let progress = 0;
    let currentStep: string | null = null;

    if (existing.authConfirmed && existing.tenantId) {
      restartStatus = "mailboxes";
      progress = 70;
      currentStep = "Retry requested from mailbox creation";
      console.log("✅ [Retry] Auth confirmed, restarting from mailboxes");
    } else if (existing.deviceCode && !existing.authConfirmed) {
      const isExpired = existing.authCodeExpiry ? existing.authCodeExpiry.getTime() <= Date.now() : false;
      if (!isExpired) {
        restartStatus = "auth_pending";
        progress = 65;
        currentStep = "Waiting for device code confirmation";
        console.log("⚠️ [Retry] Device code exists, staying at auth_pending (code still valid)");

        await prisma.tenant.update({
          where: { id: existing.id },
          data: {
            status: restartStatus,
            progress,
            errorMessage: null,
            currentStep
          }
        });

        return NextResponse.json({
          ok: true,
          tenantId: existing.id,
          restartStatus,
          message: "Use existing device code. Click \"I've Entered the Code\" when ready."
        });
      }

      restartStatus = "tenant_prep";
      progress = 55;
      currentStep = "Device code expired. Regenerating authentication code.";
      console.log("🔄 [Retry] Device code expired, regenerating a fresh one");
    } else if (existing.tenantId && !existing.deviceCode) {
      restartStatus = "mailboxes";
      progress = 70;
      currentStep = "Auth already verified. Continuing mailbox setup...";
      console.log("✅ [Retry] Tenant already authorized, bypassing device auth and restarting from mailboxes");
    } else if (existing.zoneId && !existing.tenantId) {
      restartStatus = "tenant_prep";
      progress = 50;
      currentStep = "Retry requested from tenant prep";
      console.log("✅ [Retry] Cloudflare complete, restarting from Microsoft");
    } else {
      console.log("🔄 [Retry] Starting from beginning");
    }

    const tenant = await prisma.tenant.update({
      where: { id: existing.id },
      data: {
        status: restartStatus,
        progress,
        errorMessage: null,
        currentStep,
        ...(restartStatus === "tenant_prep"
          ? { authConfirmed: false, authCode: null, deviceCode: null, authCodeExpiry: null }
          : {}),
        ...(restartStatus === "mailboxes" && existing.tenantId
          ? { authConfirmed: true, authCode: null, deviceCode: null, authCodeExpiry: null }
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
