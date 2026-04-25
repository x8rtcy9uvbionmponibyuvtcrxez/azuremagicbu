/**
 * GET  /api/tenant/{id}/personas — list personas + photo state for a tenant
 * POST /api/tenant/{id}/personas — extract personas from Tenant.inboxNames
 *                                  (idempotent backfill; safe to call repeatedly)
 *
 * The extraction step runs automatically during provisioning Phase 4 once
 * mailbox creation finishes. This endpoint exists for retroactive backfill
 * on tenants that finished provisioning before the photo pipeline shipped,
 * and as a recovery path if extraction silently failed.
 */

import { NextResponse } from "next/server";

import { prisma } from "@/lib/prisma";
import { extractPersonas } from "@/lib/services/profilePhotos";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Params = { params: { id: string } };

export async function GET(_request: Request, { params }: Params) {
  const personas = await prisma.tenantPersona.findMany({
    where: { tenantId: params.id },
    orderBy: { createdAt: "asc" },
    select: {
      id: true,
      personaName: true,
      photoMime: true,
      photoSize: true,
      photoApplied: true,
      applyError: true,
      appliedAt: true,
      createdAt: true,
      updatedAt: true
    }
  });
  // Don't ship photoData to the JSON response — clients fetch the binary
  // via GET /api/personas/{id}/photo so it can be cached + streamed properly.
  // Surface a hasPhoto boolean instead.
  return NextResponse.json({
    personas: personas.map((p) => ({
      ...p,
      hasPhoto: p.photoSize !== null && p.photoSize > 0,
      appliedAt: p.appliedAt ? p.appliedAt.toISOString() : null,
      createdAt: p.createdAt.toISOString(),
      updatedAt: p.updatedAt.toISOString()
    }))
  });
}

export async function POST(_request: Request, { params }: Params) {
  try {
    const tenant = await prisma.tenant.findUnique({
      where: { id: params.id },
      select: { id: true }
    });
    if (!tenant) {
      return NextResponse.json({ error: "Tenant not found" }, { status: 404 });
    }
    const personas = await extractPersonas(params.id);
    return NextResponse.json({ ok: true, personas });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : String(error) },
      { status: 500 }
    );
  }
}
