/**
 * Phase 4.2 — first-attempt-success metrics endpoint.
 *
 * Returns an in-memory snapshot of every observed Graph operation,
 * keyed by op name. For each op:
 *
 *   {
 *     total: number,                    // calls observed since worker start
 *     ok: number,                       // calls that succeeded (any attempt)
 *     firstAttemptSuccessRate: number,  // 0..1
 *     attempts: { 1: 95, 2: 4, 3: 1 }, // histogram of which attempt worked
 *     errCodes: { Authorization_RequestDenied: 7 },
 *     latency_p50_ms: number,
 *     latency_p95_ms: number
 *   }
 *
 * Restart loses the data. That's fine — these metrics are a tuning aid,
 * not a long-term audit log. For persistent data, pipe `railway logs --json`
 * over the structured logCall lines (kind=call) into your own aggregator.
 *
 * NOTE: this endpoint runs in the web-app process. The worker has its own
 * process and its own metrics that this endpoint can't see. To inspect
 * worker metrics specifically, exec into the worker container or read
 * worker logs. A cross-process view (e.g. metrics persisted in Redis) is
 * future work.
 */
import { NextResponse } from "next/server";

import { snapshotMetrics } from "@/lib/observability";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  return NextResponse.json({
    capturedAt: new Date().toISOString(),
    process: "web",
    note: "Worker process has its own metrics not visible here.",
    ops: snapshotMetrics()
  });
}
