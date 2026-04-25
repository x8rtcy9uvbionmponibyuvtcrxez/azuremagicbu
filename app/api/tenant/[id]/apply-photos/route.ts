/**
 * POST /api/tenant/{id}/apply-photos — fire the photo-application worker
 * synchronously (the operation is bounded — at most ~99 mailboxes × one
 * Graph PUT each, plus the displayName lookup). Returns a per-mailbox
 * outcome map plus rolled-up counts.
 *
 * Pre-conditions:
 *   - Tenant has tenantId (M365 tenant exists)
 *   - At least one mailbox in mailboxStatuses
 *   - At least one persona with a photo uploaded (we don't fail if some
 *     personas have no photo — those mailboxes get skipped with a warning)
 *
 * Auto-trigger from worker Phase 4.5 calls applyPhotosToTenant() directly.
 * This endpoint is for manual retry + the UI button.
 */

import { NextResponse } from "next/server";

import { prisma } from "@/lib/prisma";
import { applyPhotosToTenant } from "@/lib/services/profilePhotos";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Params = { params: { id: string } };

export async function POST(_request: Request, { params }: Params) {
  try {
    const tenant = await prisma.tenant.findUnique({
      where: { id: params.id },
      select: { id: true, tenantId: true, mailboxStatuses: true }
    });
    if (!tenant) {
      return NextResponse.json({ error: "Tenant not found" }, { status: 404 });
    }
    if (!tenant.tenantId) {
      return NextResponse.json(
        { error: "Tenant has no Microsoft tenant ID — provisioning incomplete." },
        { status: 400 }
      );
    }

    const personasWithPhoto = await prisma.tenantPersona.count({
      where: { tenantId: params.id, photoSize: { gt: 0 } }
    });
    if (personasWithPhoto === 0) {
      return NextResponse.json(
        { error: "No personas have a photo uploaded yet. Upload at least one before applying." },
        { status: 400 }
      );
    }

    const result = await applyPhotosToTenant(params.id);
    return NextResponse.json({
      ok: true,
      tenantId: params.id,
      ...result
    });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : String(error) },
      { status: 500 }
    );
  }
}
