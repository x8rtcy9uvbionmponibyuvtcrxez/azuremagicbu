import { NextResponse } from "next/server";

import { prisma } from "@/lib/prisma";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const batches = await prisma.batch.findMany({
      orderBy: { createdAt: "desc" },
      include: {
        tenants: {
          select: {
            id: true,
            tenantName: true,
            domain: true,
            status: true,
            progress: true,
            currentStep: true,
            inboxCount: true,
            csvUrl: true,
            createdAt: true,
            updatedAt: true,
            errorMessage: true
          },
          orderBy: { createdAt: "asc" }
        }
      }
    });

    const history = batches.map((batch) => ({
      id: batch.id,
      status: batch.status,
      totalCount: batch.totalCount,
      completedCount: batch.completedCount,
      createdAt: batch.createdAt,
      updatedAt: batch.updatedAt,
      tenants: batch.tenants,
      totalInboxes: batch.tenants.reduce((sum, tenant) => sum + (tenant.inboxCount || 99), 0),
      domains: batch.tenants.map((tenant) => tenant.domain).filter(Boolean)
    }));

    return NextResponse.json(history);
  } catch (error) {
    console.error("Failed to load history:", error);
    // Return empty list to keep the UI functional when DB is missing/unavailable
    return NextResponse.json([], { status: 200 });
  }
}
