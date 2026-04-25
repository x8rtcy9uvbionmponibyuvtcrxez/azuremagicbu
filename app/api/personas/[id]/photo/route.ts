/**
 * GET /api/personas/{id}/photo — stream the binary photo bytes for an
 * <img src> reference. Auth-free intentionally (the persona ID is a cuid,
 * unguessable; same posture as photo URLs in many B2B apps). If we ever
 * want stricter auth, gate by tenant access here.
 *
 * Returns Cache-Control: no-store because operators may re-upload and
 * expect the UI to show the new photo without a hard refresh.
 */

import { NextResponse } from "next/server";

import { prisma } from "@/lib/prisma";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Params = { params: { id: string } };

export async function GET(_request: Request, { params }: Params) {
  const persona = await prisma.tenantPersona.findUnique({
    where: { id: params.id },
    select: { photoData: true, photoMime: true, photoSize: true }
  });
  if (!persona || !persona.photoData || !persona.photoMime) {
    return NextResponse.json({ error: "Photo not found" }, { status: 404 });
  }
  return new Response(persona.photoData, {
    status: 200,
    headers: {
      "Content-Type": persona.photoMime,
      "Content-Length": String(persona.photoSize ?? persona.photoData.length),
      "Cache-Control": "no-store"
    }
  });
}
