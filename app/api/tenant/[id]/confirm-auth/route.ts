import { NextResponse } from "next/server";
import { z } from "zod";

import { prisma } from "@/lib/prisma";
import { enqueueTenantProcessingJob } from "@/lib/queue";
import { pollDeviceAuthToken } from "@/lib/services/microsoft";

export const runtime = "nodejs";

const schema = z.object({
  confirmed: z.literal(true)
});

type Params = {
  params: {
    id: string;
  };
};

export async function POST(request: Request, { params }: Params) {
  try {
    const body = await request.json();
    schema.parse(body);

    const tenant = await prisma.tenant.findUnique({
      where: { id: params.id },
      select: {
        id: true,
        batchId: true,
        status: true,
        authCode: true,
        authConfirmed: true
      }
    });

    if (!tenant) {
      return NextResponse.json({ error: "Tenant not found" }, { status: 404 });
    }

    if (tenant.authConfirmed) {
      await enqueueTenantProcessingJob({ tenantId: tenant.id, batchId: tenant.batchId });
      return NextResponse.json({ ok: true, tenantId: tenant.id, resumed: true });
    }

    if (!tenant.authCode) {
      return NextResponse.json({ error: "No device code available for this tenant" }, { status: 400 });
    }

    const verification = await pollDeviceAuthToken(tenant.id, tenant.authCode);

    if (!verification.verified) {
      return NextResponse.json(
        { error: "Authorization still pending. Complete device login and try again." },
        { status: 409 }
      );
    }

    await prisma.tenant.update({
      where: { id: tenant.id },
      data: {
        authConfirmed: true,
        tenantId: verification.organizationId || undefined,
        status: "mailboxes",
        currentStep: "Auth confirmed. Continuing mailbox setup...",
        progress: 68
      }
    });

    await enqueueTenantProcessingJob({ tenantId: tenant.id, batchId: tenant.batchId });

    return NextResponse.json({ ok: true, tenantId: tenant.id, resumed: true });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Unable to confirm auth" },
      { status: 400 }
    );
  }
}
