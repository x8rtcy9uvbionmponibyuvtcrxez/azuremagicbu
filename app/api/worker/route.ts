import { NextResponse } from "next/server";

import { getTenantQueue } from "@/lib/queue";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const counts = await getTenantQueue().getJobCounts("waiting", "active", "completed", "failed", "delayed");

    return NextResponse.json({
      ok: true,
      worker: "tenant-processing",
      counts
    });
  } catch (error) {
    return NextResponse.json(
      {
        ok: false,
        worker: "tenant-processing",
        error: error instanceof Error ? error.message : String(error)
      },
      { status: 500 }
    );
  }
}

export async function POST() {
  return GET();
}
