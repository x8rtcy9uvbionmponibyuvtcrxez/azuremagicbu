import { NextResponse } from "next/server";
import { z } from "zod";

import { prisma } from "@/lib/prisma";

export const runtime = "nodejs";

const schema = z.object({
  confirmed: z.literal(true)
});

type Params = {
  params: {
    id: string;
  };
};

export async function POST(request: Request, { params }: Params) {
  try {
    const body = await request.json();
    schema.parse(body);

    const existing = await prisma.tenant.findUnique({
      where: { id: params.id },
      select: { id: true }
    });

    if (!existing) {
      return NextResponse.json({ error: "Tenant not found" }, { status: 404 });
    }

    const tenant = await prisma.tenant.update({
      where: { id: existing.id },
      data: {
        setupConfirmed: true
      }
    });

    return NextResponse.json({ ok: true, tenantId: tenant.id });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Unable to confirm setup" },
      { status: 400 }
    );
  }
}
