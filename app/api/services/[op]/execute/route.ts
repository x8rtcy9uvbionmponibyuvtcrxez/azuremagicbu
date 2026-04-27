/**
 * POST /api/services/{op}/execute — actually run the operation. Persists
 * a ServiceOperation row up-front, executes the per-row work, then writes
 * the results array + final status to the same row.
 *
 * Body: { tenantId: string, csv: string, options?: object }
 *
 * Notes:
 *   - Synchronous execution. For 50 rows × ~30 sec/row (re-OAuth) this
 *     can run for 25+ min. The Next.js fetch from the wizard UI keeps
 *     the connection open. If the user closes the tab, the operation
 *     KEEPS RUNNING server-side and the ServiceOperation row records
 *     the outcome — the wizard can show "in progress" if the user
 *     comes back via the operation list view (future enhancement).
 *   - Progress streaming via SSE is a future enhancement; v1 does not
 *     stream. Wizard shows a spinner with "this may take several minutes".
 *   - Tenant context (Instantly creds, Smartlead creds) is loaded from
 *     the tenant's Batch row inside userOps. No need to pass them here.
 */

import { NextResponse } from "next/server";

import { prisma } from "@/lib/prisma";
import {
  parseRenameCsv,
  parseRemoveCsv,
  parseSwapCsv,
  removeUsers,
  renameUsers,
  swapUsers,
} from "@/lib/services/userOps";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Params = { params: { op: string } };

export async function POST(request: Request, { params }: Params) {
  const op = params.op;
  if (op !== "rename" && op !== "remove" && op !== "swap") {
    return NextResponse.json({ error: `Unknown op: ${op}` }, { status: 400 });
  }

  let body: { tenantId?: string; csv?: string; options?: Record<string, unknown> };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Body must be JSON" }, { status: 400 });
  }
  if (!body.tenantId) return NextResponse.json({ error: "tenantId required" }, { status: 400 });
  if (!body.csv) return NextResponse.json({ error: "csv required" }, { status: 400 });

  const tenantExists = await prisma.tenant.findUnique({
    where: { id: body.tenantId },
    select: { id: true },
  });
  if (!tenantExists) return NextResponse.json({ error: "Tenant not found" }, { status: 404 });

  // Pre-parse to count rows
  let rowCount = 0;
  if (op === "rename") rowCount = parseRenameCsv(body.csv).length;
  else if (op === "remove") rowCount = parseRemoveCsv(body.csv).length;
  else rowCount = parseSwapCsv(body.csv).length;

  if (rowCount === 0) {
    return NextResponse.json({ error: "No valid rows in CSV" }, { status: 400 });
  }

  // Persist the operation row up front so we have an audit trail even
  // if the caller disconnects.
  const opRow = await prisma.serviceOperation.create({
    data: {
      tenantId: body.tenantId,
      opType: op,
      status: "running",
      csvData: body.csv,
      csvRowCount: rowCount,
      options: body.options ? JSON.stringify(body.options) : null,
      startedAt: new Date(),
    },
  });

  let results;
  try {
    if (op === "rename") {
      results = await renameUsers(body.tenantId, parseRenameCsv(body.csv), body.options || {});
    } else if (op === "remove") {
      results = await removeUsers(body.tenantId, parseRemoveCsv(body.csv), body.options || {});
    } else {
      results = await swapUsers(body.tenantId, parseSwapCsv(body.csv), body.options || {});
    }
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    await prisma.serviceOperation.update({
      where: { id: opRow.id },
      data: {
        status: "failed",
        errorMessage: msg.slice(0, 1000),
        finishedAt: new Date(),
      },
    });
    return NextResponse.json({ error: msg, opId: opRow.id }, { status: 500 });
  }

  const succeeded = results.filter((r) => r.state === "succeeded").length;
  const failed = results.filter((r) => r.state === "failed").length;
  const partial = results.filter((r) => r.state === "partial").length;
  const skipped = results.filter((r) => r.state === "skipped").length;

  await prisma.serviceOperation.update({
    where: { id: opRow.id },
    data: {
      status: failed === 0 ? "completed" : (succeeded === 0 ? "failed" : "completed"),
      results: JSON.stringify(results),
      succeeded,
      // We treat partial as failed for the purpose of this counter so the
      // surface flag in the UI catches them — operator can retry partials.
      failed: failed + partial,
      skipped,
      finishedAt: new Date(),
    },
  });

  return NextResponse.json({
    op,
    opId: opRow.id,
    summary: {
      total: results.length,
      succeeded,
      failed,
      partial,
      skipped,
    },
    results,
  });
}
