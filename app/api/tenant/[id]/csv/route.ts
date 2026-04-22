import { NextResponse } from "next/server";

import { prisma } from "@/lib/prisma";
import { getTenantCsvContent, tenantCsvFilename } from "@/lib/tenant-csv";

export const runtime = "nodejs";

type Params = {
  params: {
    id: string;
  };
};

export async function GET(_request: Request, { params }: Params) {
  try {
    const tenant = await prisma.tenant.findUnique({
      where: { id: params.id },
      select: {
        id: true,
        tenantName: true,
        clientName: true,
        domain: true,
        inboxCount: true,
        inboxNames: true,
        csvUrl: true,
        licensedUserUpn: true,
        adminPassword: true,
        mailboxStatuses: true
      }
    });

    if (!tenant) {
      return NextResponse.json({ error: "Tenant not found" }, { status: 404 });
    }

    const csv = await getTenantCsvContent(tenant);
    const filename = tenantCsvFilename(tenant.tenantName, tenant.clientName, tenant.domain);

    return new Response(csv, {
      status: 200,
      headers: {
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": `attachment; filename=\"${filename}\"`
      }
    });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Unable to prepare tenant CSV" },
      { status: 500 }
    );
  }
}
