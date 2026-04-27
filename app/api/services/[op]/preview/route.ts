/**
 * POST /api/services/{op}/preview — parse + validate a CSV without making
 * any changes. Returns a per-row preview the wizard renders into a
 * confirmation table. {op} is one of "rename" | "remove" | "swap".
 *
 * Body: { tenantId: string, csv: string, options?: object }
 *
 * Response shape:
 *   {
 *     op,
 *     tenant: { id, tenantName, domain, ... },
 *     rows: Array<{
 *       email: string,
 *       new_display_name?: string,    // rename + swap
 *       new_email?: string,           // swap only
 *       resolvable: boolean,           // user found in M365
 *       displayName?: string,          // current displayName from M365
 *       userId?: string,
 *       warnings: string[],
 *     }>,
 *     summary: { total, resolvable, missing, warnings_total }
 *   }
 *
 * No write side-effects. Safe to call repeatedly.
 */

import { NextResponse } from "next/server";

import { prisma } from "@/lib/prisma";
import { graphRequest, requestTenantGraphToken } from "@/lib/services/microsoft";
import {
  parseRenameCsv,
  parseRemoveCsv,
  parseSwapCsv,
} from "@/lib/services/userOps";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Params = { params: { op: string } };

export async function POST(request: Request, { params }: Params) {
  const op = params.op;
  if (op !== "rename" && op !== "remove" && op !== "swap") {
    return NextResponse.json({ error: `Unknown op: ${op}` }, { status: 400 });
  }

  let body: { tenantId?: string; csv?: string };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Body must be JSON" }, { status: 400 });
  }

  if (!body.tenantId) return NextResponse.json({ error: "tenantId required" }, { status: 400 });
  if (!body.csv) return NextResponse.json({ error: "csv required" }, { status: 400 });

  const tenant = await prisma.tenant.findUnique({
    where: { id: body.tenantId },
    select: { id: true, tenantName: true, domain: true, tenantId: true, licensedUserUpn: true },
  });
  if (!tenant) return NextResponse.json({ error: "Tenant not found" }, { status: 404 });
  if (!tenant.tenantId) {
    return NextResponse.json({ error: "Tenant has no Microsoft tenantId" }, { status: 400 });
  }

  // Parse CSV per op
  const renameRows = op === "rename" ? parseRenameCsv(body.csv) : [];
  const removeRows = op === "remove" ? parseRemoveCsv(body.csv) : [];
  const swapRows = op === "swap" ? parseSwapCsv(body.csv) : [];
  const emails =
    op === "rename" ? renameRows.map((r) => r.email)
    : op === "remove" ? removeRows.map((r) => r.email)
    : swapRows.map((r) => r.oldEmail);

  if (emails.length === 0) {
    return NextResponse.json({ error: "No valid rows in CSV — check column headers" }, { status: 400 });
  }

  // Resolve each email against M365 to flag missing users + show current displayName
  const token = await requestTenantGraphToken(tenant.tenantId);
  const resolutions: Record<string, { id?: string; displayName?: string; warnings: string[] }> = {};
  for (const email of emails) {
    const warnings: string[] = [];
    try {
      const u = await graphRequest<{ id: string; displayName: string }>(
        token,
        `/users/${encodeURIComponent(email)}?$select=id,displayName`
      );
      resolutions[email] = { id: u.id, displayName: u.displayName, warnings };
    } catch {
      warnings.push("user not found in M365");
      resolutions[email] = { warnings };
    }
  }

  // Build per-row preview structures + warnings specific to op
  let rows: Array<Record<string, unknown>> = [];
  if (op === "rename") {
    rows = renameRows.map((r) => {
      const info = resolutions[r.email];
      const warnings = [...info.warnings];
      if (info.displayName === r.newDisplayName) warnings.push("new display name == current; rename is a no-op");
      return {
        email: r.email,
        new_display_name: r.newDisplayName,
        resolvable: !!info.id,
        userId: info.id,
        currentDisplayName: info.displayName,
        warnings,
      };
    });
  } else if (op === "remove") {
    rows = removeRows.map((r) => {
      const info = resolutions[r.email];
      return {
        email: r.email,
        resolvable: !!info.id,
        userId: info.id,
        currentDisplayName: info.displayName,
        warnings: info.warnings,
      };
    });
  } else {
    // swap
    rows = swapRows.map((r) => {
      const info = resolutions[r.oldEmail];
      const warnings = [...info.warnings];
      const newDomain = (r.newEmail.split("@")[1] || "").toLowerCase();
      if (newDomain !== tenant.domain.toLowerCase()) {
        warnings.push(`new email domain ${newDomain} doesn't match tenant ${tenant.domain}`);
      }
      return {
        email: r.oldEmail,
        new_email: r.newEmail,
        new_display_name: r.newDisplayName,
        resolvable: !!info.id,
        userId: info.id,
        currentDisplayName: info.displayName,
        warnings,
      };
    });
  }

  const summary = {
    total: rows.length,
    resolvable: rows.filter((r) => r.resolvable).length,
    missing: rows.filter((r) => !r.resolvable).length,
    warnings_total: rows.reduce((sum, r) => sum + ((r.warnings as string[]).length || 0), 0),
  };

  return NextResponse.json({
    op,
    tenant: {
      id: tenant.id,
      tenantName: tenant.tenantName,
      domain: tenant.domain,
      tenantId: tenant.tenantId,
      licensedUserUpn: tenant.licensedUserUpn,
    },
    rows,
    summary,
  });
}
