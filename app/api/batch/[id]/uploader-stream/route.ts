/**
 * Bug 12.1 — cumulative uploader log + queue panel for the batch detail page.
 *
 * Aggregates uploader_log events across every tenant in the batch into a
 * single chronological feed, tagged per-tenant, plus a queue summary
 * (per-tenant uploaderStatus counts) for the small panel above the feed.
 *
 * Operator pain this addresses: today's UI shows uploader logs only
 * per-tenant. With 11+ tenants in a batch, the operator has to click
 * into each one to see what's happening. When (as in batch
 * cmokasf7a003bny1r3k6awkcf) every uploader run hits the same 401, that
 * pattern is invisible without aggregating across tenants.
 */
import { NextResponse } from "next/server";

import { prisma } from "@/lib/prisma";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Params = { params: { id: string } };

const MAX_LINES = 200; // enough for ~5 mins of activity across 5 parallel uploaders

export async function GET(_request: Request, { params }: Params) {
  try {
    const batch = await prisma.batch.findUnique({
      where: { id: params.id },
      select: {
        id: true,
        uploaderEsp: true,
        uploaderAutoTrigger: true,
        tenants: {
          select: {
            id: true,
            tenantName: true,
            uploaderStatus: true,
            uploaderTotal: true,
            uploaderSucceeded: true,
            uploaderFailed: true,
            uploaderQueuedAt: true,
            uploaderStartedAt: true,
            uploaderCompletedAt: true,
            uploaderLastLogAt: true
          }
        }
      }
    });

    if (!batch) {
      return NextResponse.json({ error: "Batch not found" }, { status: 404 });
    }

    // Queue panel: counts + per-tenant status. Skip tenants with status=null
    // (uploader never queued — happens when the batch's ESP wasn't set).
    const queueRows = batch.tenants
      .filter((t) => t.uploaderStatus !== null)
      .map((t) => ({
        tenantId: t.id,
        tenantName: t.tenantName,
        status: t.uploaderStatus,
        total: t.uploaderTotal,
        succeeded: t.uploaderSucceeded,
        failed: t.uploaderFailed,
        queuedAt: t.uploaderQueuedAt?.toISOString() || null,
        startedAt: t.uploaderStartedAt?.toISOString() || null,
        completedAt: t.uploaderCompletedAt?.toISOString() || null,
        lastLogAt: t.uploaderLastLogAt?.toISOString() || null
      }));

    const summary = {
      idle: queueRows.filter((r) => r.status === "idle").length,
      queued: queueRows.filter((r) => r.status === "queued").length,
      running: queueRows.filter((r) => r.status === "running").length,
      completed: queueRows.filter((r) => r.status === "completed").length,
      failed: queueRows.filter((r) => r.status === "failed").length
    };

    // Aggregated log feed: pull recent uploader_log events across the
    // whole batch's tenants, flatten the per-event "lines" arrays into
    // individual log lines tagged with tenantName, and return latest N.
    const tenantIdToName = new Map(batch.tenants.map((t) => [t.id, t.tenantName]));

    const events = await prisma.tenantEvent.findMany({
      where: {
        tenantId: { in: batch.tenants.map((t) => t.id) },
        eventType: "uploader_log"
      },
      orderBy: { createdAt: "desc" },
      take: 50, // each event has up to ~10 lines, so 50 events ≈ 500 lines
      select: { tenantId: true, createdAt: true, details: true }
    });

    type Line = { tenantId: string; tenantName: string; at: string; text: string };
    const lines: Line[] = [];

    for (const event of events) {
      // tenantId is nullable on TenantEvent for batch-level events. Skip
      // those — uploader_log is always tenant-scoped, but defend anyway.
      if (!event.tenantId) continue;
      const tenantId = event.tenantId;
      const tenantName = tenantIdToName.get(tenantId) || "?";
      const at = event.createdAt.toISOString();
      // details is a JSON string like {"lines":["[HH:MM:SS] foo",...],"totalSeen":N}
      let parsed: { lines?: unknown } = {};
      try {
        parsed = event.details ? JSON.parse(event.details) : {};
      } catch {
        // Malformed details — log a single placeholder line so the feed
        // still surfaces the event existed.
        lines.push({ tenantId, tenantName, at, text: "(unparseable uploader_log details)" });
        continue;
      }
      if (Array.isArray(parsed.lines)) {
        for (const raw of parsed.lines) {
          if (typeof raw !== "string" || raw.length === 0) continue;
          lines.push({ tenantId, tenantName, at, text: raw });
        }
      }
    }

    // Lines were collected newest-event-first. Reverse so the feed reads
    // chronologically (oldest at top, newest at bottom — matches log-tail
    // intuition). Cap to MAX_LINES to keep payload sane.
    lines.reverse();
    const trimmed = lines.slice(-MAX_LINES);

    return NextResponse.json({
      batchId: batch.id,
      uploaderEsp: batch.uploaderEsp,
      uploaderAutoTrigger: batch.uploaderAutoTrigger,
      summary,
      queue: queueRows,
      lines: trimmed,
      truncated: lines.length > MAX_LINES
    });
  } catch (error) {
    return NextResponse.json(
      {
        error: "Failed to load uploader stream.",
        details: error instanceof Error ? error.message : String(error)
      },
      { status: 500 }
    );
  }
}
