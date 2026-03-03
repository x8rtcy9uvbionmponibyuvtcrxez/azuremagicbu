import { NextResponse } from "next/server";

import { prisma } from "@/lib/prisma";
import { enqueueTenantProcessingJob } from "@/lib/queue";

export const runtime = "nodejs";

type Params = {
  params: {
    id: string;
  };
};

export async function POST(_request: Request, { params }: Params) {
  try {
    const tenant = await prisma.tenant.update({
      where: { id: params.id },
      data: {
        status: "queued",
        progress: 0,
        errorMessage: null,
        currentStep: "Retry requested",
        authConfirmed: false,
        authCode: null,
        authCodeExpiry: null
      }
    });

    await prisma.batch.update({
      where: { id: tenant.batchId },
      data: { status: "processing" }
    });

    await enqueueTenantProcessingJob({ tenantId: tenant.id, batchId: tenant.batchId });

    return NextResponse.json({ ok: true, tenantId: tenant.id });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Unable to retry tenant" },
      { status: 400 }
    );
  }
}
