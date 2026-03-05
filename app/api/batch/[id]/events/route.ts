import { NextResponse } from "next/server";

import { prisma } from "@/lib/prisma";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Params = {
  params: {
    id: string;
  };
};

function parseDetails(value: string | null): unknown {
  if (!value) return null;
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

export async function GET(request: Request, { params }: Params) {
  try {
    const { searchParams } = new URL(request.url);
    const requestedLimit = Number.parseInt(searchParams.get("limit") || "250", 10);
    const limit = Number.isFinite(requestedLimit) ? Math.max(10, Math.min(1000, requestedLimit)) : 250;

    const events = await prisma.tenantEvent.findMany({
      where: { batchId: params.id },
      orderBy: { createdAt: "desc" },
      take: limit,
      include: {
        tenant: {
          select: {
            id: true,
            tenantName: true,
            clientName: true,
            domain: true,
            tenantId: true
          }
        }
      }
    });

    return NextResponse.json({
      events: events
        .reverse()
        .map((event) => ({
          id: event.id,
          batchId: event.batchId,
          tenantId: event.tenantId,
          level: event.level,
          eventType: event.eventType,
          message: event.message,
          details: parseDetails(event.details),
          createdAt: event.createdAt.toISOString(),
          tenant: event.tenant
        }))
    });
  } catch (error) {
    return NextResponse.json(
      {
        error: "Failed to load batch events.",
        details: error instanceof Error ? error.message : String(error)
      },
      { status: 500 }
    );
  }
}
