import JSZip from "jszip";
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
    const batch = await prisma.batch.findUnique({
      where: { id: params.id },
      include: {
        tenants: {
          select: {
            id: true,
            tenantName: true,
            clientName: true,
            domain: true,
            inboxCount: true,
            inboxNames: true,
            csvUrl: true
          },
          orderBy: { createdAt: "asc" }
        }
      }
    });

    if (!batch) {
      return NextResponse.json({ error: "Batch not found" }, { status: 404 });
    }

    const zip = new JSZip();

    for (const tenant of batch.tenants) {
      const filename = tenantCsvFilename(tenant.tenantName, tenant.clientName, tenant.domain);
      try {
        const csv = await getTenantCsvContent(tenant);
        zip.file(filename, csv);
      } catch (error) {
        zip.file(
          `${filename.replace(/\.csv$/i, "")}.error.txt`,
          error instanceof Error ? error.message : "Unable to generate CSV"
        );
      }
    }

    const zipBuffer = await zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" });

    return new Response(zipBuffer, {
      status: 200,
      headers: {
        "Content-Type": "application/zip",
        "Content-Disposition": `attachment; filename=\"batch-${batch.id}-csvs.zip\"`
      }
    });
  } catch (error) {
    return NextResponse.json(
      {
        error: "Failed to prepare batch download.",
        details: error instanceof Error ? error.message : String(error)
      },
      { status: 500 }
    );
  }
}
