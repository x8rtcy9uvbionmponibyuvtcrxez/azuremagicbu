/**
 * POST   /api/tenant/{id}/personas/{personaId}/photo — multipart upload of
 *        a JPG/PNG ≤4 MB. Bytes go into TenantPersona.photoData.
 *        Resets photoApplied/applyError so a re-upload triggers fresh apply.
 *
 * DELETE /api/tenant/{id}/personas/{personaId}/photo — clear the photo.
 *        Doesn't touch already-applied M365 user photos (those would need
 *        a separate Graph DELETE on /users/{id}/photo if we want to clear
 *        them; not implemented yet — operator can re-upload to overwrite).
 *
 * Both routes verify the persona belongs to the tenant before mutating.
 */

import { NextResponse } from "next/server";

import { prisma } from "@/lib/prisma";
import { setPersonaPhoto } from "@/lib/services/profilePhotos";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Params = { params: { id: string; personaId: string } };

async function loadOwnedPersona(tenantId: string, personaId: string) {
  const persona = await prisma.tenantPersona.findUnique({
    where: { id: personaId },
    select: { id: true, tenantId: true, personaName: true }
  });
  if (!persona) return { error: "Persona not found", status: 404 as const, persona: null };
  if (persona.tenantId !== tenantId) {
    return { error: "Persona does not belong to this tenant", status: 403 as const, persona: null };
  }
  return { error: null, status: 200 as const, persona };
}

export async function POST(request: Request, { params }: Params) {
  try {
    const owned = await loadOwnedPersona(params.id, params.personaId);
    if (owned.error) return NextResponse.json({ error: owned.error }, { status: owned.status });

    const form = await request.formData();
    const file = form.get("file") as File | null;
    if (!file) {
      return NextResponse.json({ error: "Missing 'file' in form data" }, { status: 400 });
    }
    const mime = file.type || "";
    const buf = Buffer.from(await file.arrayBuffer());

    const result = await setPersonaPhoto(params.personaId, buf, mime);
    if (!result.ok) {
      return NextResponse.json({ error: result.error }, { status: 400 });
    }
    return NextResponse.json({
      ok: true,
      personaId: params.personaId,
      personaName: owned.persona!.personaName,
      size: result.size,
      mime
    });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : String(error) },
      { status: 500 }
    );
  }
}

export async function DELETE(_request: Request, { params }: Params) {
  try {
    const owned = await loadOwnedPersona(params.id, params.personaId);
    if (owned.error) return NextResponse.json({ error: owned.error }, { status: owned.status });

    await prisma.tenantPersona.update({
      where: { id: params.personaId },
      data: {
        photoData: null,
        photoMime: null,
        photoSize: null,
        photoApplied: false,
        applyError: null,
        appliedAt: null
      }
    });
    return NextResponse.json({ ok: true });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : String(error) },
      { status: 500 }
    );
  }
}
