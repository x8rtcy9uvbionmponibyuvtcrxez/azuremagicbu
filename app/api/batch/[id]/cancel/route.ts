import { NextResponse } from "next/server";

import { prisma } from "@/lib/prisma";
import { getTenantQueue } from "@/lib/queue";
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
        tenants: {
          select: { id: true, status: true }
        }
      }
    });

    if (!batch) {
      return NextResponse.json({ error: "Batch not found" }, { status: 404 });
    }

    const queue = getTenantQueue();
    const jobs = await queue.getJobs(["active", "waiting", "delayed", "paused", "prioritized"], 0, -1, true);
    let removedJobs = 0;
    for (const job of jobs) {
      if (job.data?.batchId === batch.id) {
        try {
          await job.remove();
          removedJobs += 1;
        } catch {
          // best-effort
        }
      }
    }

    const cancellable = batch.tenants.filter((t) => !["completed", "failed"].includes(t.status));

    if (cancellable.length > 0) {
      await prisma.tenant.updateMany({
        where: { id: { in: cancellable.map((t) => t.id) } },
        data: {
          status: "failed",
          errorMessage: "Run cancelled by user",
          currentStep: "Cancelled"
        }
      });

      await Promise.all(
        cancellable.map((t) =>
          logTenantEvent({
            batchId: batch.id,
            tenantId: t.id,
            eventType: "cancelled",
            level: "warn",
            message: "Tenant cancelled by user"
          })
        )
      );
    }

    await prisma.batch.update({
      where: { id: batch.id },
      data: { status: "failed" }
    });

    return NextResponse.json({
      ok: true,
      cancelledTenants: cancellable.length,
      removedJobs
    });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Cancel failed" },
      { status: 500 }
    );
  }
}
