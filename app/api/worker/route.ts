import { NextResponse } from "next/server";

import { getTenantQueue } from "@/lib/queue";
import { startTenantProcessorWorker } from "@/lib/workers/processor";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  startTenantProcessorWorker();
  const counts = await getTenantQueue().getJobCounts("waiting", "active", "completed", "failed", "delayed");

  return NextResponse.json({
    ok: true,
    worker: "tenant-processing",
    counts
  });
}

export async function POST() {
  return GET();
}
