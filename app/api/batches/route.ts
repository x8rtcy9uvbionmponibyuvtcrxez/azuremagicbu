import { NextResponse } from "next/server";
import { parse } from "csv-parse/sync";
import { z } from "zod";

import { encryptSecret, ensureEncryptionKey } from "@/lib/crypto";
import { prisma } from "@/lib/prisma";
import { enqueueTenantProcessingJob } from "@/lib/queue";
import { mapTenantCsvRow } from "@/lib/validation";
import { startTenantProcessorWorker } from "@/lib/workers/processor";
import type { ParsedTenantRecord } from "@/lib/validation";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const fileFieldName = "file";

export async function POST(request: Request) {
  const formData = await request.formData();
  const candidate = formData.get(fileFieldName);

  if (!(candidate instanceof File)) {
    return NextResponse.json(
      { error: `A CSV file must be provided in the '${fileFieldName}' form field.` },
      { status: 400 }
    );
  }

  const fileBuffer = Buffer.from(await candidate.arrayBuffer());
  const csvPayload = fileBuffer.toString("utf8").trim();

  if (!csvPayload) {
    return NextResponse.json({ error: "Uploaded CSV is empty." }, { status: 400 });
  }

  let rawRows: Record<string, string>[] = [];

  try {
    rawRows = parse(csvPayload, {
      columns: true,
      skip_empty_lines: true,
      trim: true
    });
  } catch (error) {
    return NextResponse.json(
      { error: "Unable to parse CSV.", details: error instanceof Error ? error.message : String(error) },
      { status: 400 }
    );
  }

  if (rawRows.length === 0) {
    return NextResponse.json({ error: "CSV does not include any data rows." }, { status: 400 });
  }

  const parsedTenants: ParsedTenantRecord[] = [];
  const validationErrors: Array<{ row: number; message: string }> = [];

  rawRows.forEach((row, index) => {
    try {
      parsedTenants.push(mapTenantCsvRow(row));
    } catch (error) {
      if (error instanceof z.ZodError) {
        validationErrors.push({ row: index + 2, message: error.issues.map((err) => err.message).join("; ") });
      } else if (error instanceof Error) {
        validationErrors.push({ row: index + 2, message: error.message });
      } else {
        validationErrors.push({ row: index + 2, message: "Unknown validation error" });
      }
    }
  });

  if (validationErrors.length > 0) {
    return NextResponse.json(
      {
        error: "CSV validation failed.",
        details: validationErrors
      },
      { status: 422 }
    );
  }

  const tenantNameSet = new Set<string>();
  const domainSet = new Set<string>();

  for (const tenant of parsedTenants) {
    if (tenantNameSet.has(tenant.tenantName)) {
      return NextResponse.json(
        {
          error: "CSV validation failed.",
          details: [{ row: 0, message: `Duplicate tenant_name detected: ${tenant.tenantName}` }]
        },
        { status: 422 }
      );
    }
    tenantNameSet.add(tenant.tenantName);

    if (domainSet.has(tenant.domain)) {
      return NextResponse.json(
        {
          error: "CSV validation failed.",
          details: [{ row: 0, message: `Duplicate domain detected: ${tenant.domain}` }]
        },
        { status: 422 }
      );
    }
    domainSet.add(tenant.domain);
  }

  try {
    ensureEncryptionKey();
  } catch (error) {
    return NextResponse.json(
      {
        error: "Server misconfiguration.",
        details: error instanceof Error ? error.message : String(error)
      },
      { status: 500 }
    );
  }

  try {
    const batch = await prisma.batch.create({
      data: {
        status: "uploading",
        totalCount: parsedTenants.length,
        completedCount: 0,
        tenants: {
          create: parsedTenants.map((tenant) => ({
            tenantName: tenant.tenantName,
            adminEmail: tenant.adminEmail.toLowerCase(),
            adminPassword: encryptSecret(tenant.adminPassword),
            encryptionVersion: 1,
            domain: tenant.domain,
            inboxNames: tenant.inboxNames,
            inboxCount: tenant.inboxCount,
            forwardingUrl: tenant.forwardingUrl,
            status: "queued"
          }))
        }
      },
      include: {
        tenants: {
          select: {
            id: true,
            tenantName: true,
            status: true
          }
        }
      }
    });

    startTenantProcessorWorker();
    console.log("🔄 [API] Worker started for batch:", batch.id);

    await Promise.all(
      batch.tenants.map((tenant) =>
        enqueueTenantProcessingJob({
          tenantId: tenant.id,
          batchId: batch.id
        })
      )
    );

    await prisma.batch.update({
      where: { id: batch.id },
      data: { status: "processing" }
    });

    return NextResponse.json(
      {
        batch: {
          id: batch.id,
          status: "processing",
          totalCount: batch.totalCount,
          completedCount: batch.completedCount,
          createdAt: batch.createdAt,
          tenants: batch.tenants
        }
      },
      { status: 201 }
    );
  } catch (error) {
    return NextResponse.json(
      {
        error: "Failed to persist batch.",
        details: error instanceof Error ? error.message : String(error)
      },
      { status: 500 }
    );
  }
}
