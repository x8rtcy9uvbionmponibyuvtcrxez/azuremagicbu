import { NextResponse } from "next/server";

import { decryptSecret } from "@/lib/crypto";
import { prisma } from "@/lib/prisma";
import { parseInboxNamesValue } from "@/lib/utils";

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
            clientName: true,
            adminEmail: true,
            adminPassword: true,
            tenantId: true,
            domain: true,
            inboxNames: true,
            status: true,
            progress: true,
            currentStep: true,
            inboxCount: true,
            forwardingUrl: true,
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
      tenants: batch.tenants.map((tenant) => ({
        ...tenant,
        adminPassword: (() => {
          try {
            return decryptSecret(tenant.adminPassword);
          } catch {
            return tenant.adminPassword;
          }
        })(),
        inboxNames: parseInboxNamesValue(tenant.inboxNames)
      })),
      totalInboxes: batch.tenants.reduce((sum, tenant) => sum + (tenant.inboxCount || 99), 0),
      domains: batch.tenants.map((tenant) => tenant.domain).filter(Boolean)
    }));

    return NextResponse.json(history);
  } catch (error) {
    console.error("Failed to load history:", error);
    return NextResponse.json(
      {
        error: "Failed to load history.",
        details: error instanceof Error ? error.message : String(error)
      },
      { status: 500 }
    );
  }
}
