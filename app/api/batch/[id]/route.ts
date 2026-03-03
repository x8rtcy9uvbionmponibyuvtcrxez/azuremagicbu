import { NextResponse } from "next/server";

import { prisma } from "@/lib/prisma";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Params = {
  params: {
    id: string;
  };
};

export async function GET(_request: Request, { params }: Params) {
  const batch = await prisma.batch.findUnique({
    where: { id: params.id },
    include: {
      tenants: {
        orderBy: { createdAt: "asc" },
        select: {
          id: true,
          tenantName: true,
          domain: true,
          status: true,
          progress: true,
          currentStep: true,
          authCode: true,
          authCodeExpiry: true,
          csvUrl: true,
          errorMessage: true,
          setupConfirmed: true
        }
      }
    }
  });

  if (!batch) {
    return NextResponse.json({ error: "Batch not found" }, { status: 404 });
  }

  const completedCount = batch.tenants.filter((tenant) => tenant.status === "completed").length;
  const hasActive = batch.tenants.some((tenant) =>
    ["queued", "cloudflare", "tenant_prep", "auth_pending", "mailboxes"].includes(tenant.status)
  );
  const hasFailed = batch.tenants.some((tenant) => tenant.status === "failed");

  let nextStatus = batch.status;
  if (completedCount === batch.totalCount && batch.totalCount > 0) {
    nextStatus = "completed";
  } else if (!hasActive && hasFailed) {
    nextStatus = "failed";
  } else if (batch.status === "uploading") {
    nextStatus = "processing";
  }

  const needsUpdate = completedCount !== batch.completedCount || nextStatus !== batch.status;

  const finalBatch = needsUpdate
    ? await prisma.batch.update({
        where: { id: batch.id },
        data: {
          completedCount,
          status: nextStatus
        }
      })
    : batch;

  return NextResponse.json({
    batch: {
      id: finalBatch.id,
      status: finalBatch.status,
      totalCount: finalBatch.totalCount,
      completedCount,
      createdAt: finalBatch.createdAt.toISOString()
    },
    tenants: batch.tenants.map((tenant) => ({
      ...tenant,
      authCodeExpiry: tenant.authCodeExpiry ? tenant.authCodeExpiry.toISOString() : null
    }))
  });
}
