import { NextResponse } from "next/server";
import { parse } from "csv-parse/sync";
import { z } from "zod";
import type { UploaderEsp } from "@prisma/client";

import { encryptSecret, ensureEncryptionKey } from "@/lib/crypto";
import { prisma } from "@/lib/prisma";
import { logTenantEvent } from "@/lib/tenant-events";
import { mapTenantCsvRow } from "@/lib/validation";
import type { ParsedTenantRecord } from "@/lib/validation";
import { serializeInboxNames } from "@/lib/utils";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const fileFieldName = "file";

type UploaderConfig = {
  esp: UploaderEsp | null;
  autoTrigger: boolean;
  workers: number;
  instantlyEmail: string | null;
  instantlyPassword: string | null;
  instantlyV1Key: string | null;
  instantlyV2Key: string | null;
  instantlyWorkspace: string | null;
  instantlyApiVersion: "v1" | "v2";
  smartleadApiKey: string | null;
  smartleadLoginUrl: string | null;
};

function parseUploaderConfig(formData: FormData): { cfg: UploaderConfig; error?: string } {
  const enabled = formData.get("uploader_enabled") === "1";
  const cfg: UploaderConfig = {
    esp: null,
    autoTrigger: false,
    workers: 2,
    instantlyEmail: null,
    instantlyPassword: null,
    instantlyV1Key: null,
    instantlyV2Key: null,
    instantlyWorkspace: null,
    instantlyApiVersion: "v1",
    smartleadApiKey: null,
    smartleadLoginUrl: null
  };

  if (!enabled) {
    return { cfg };
  }

  const espRaw = (formData.get("uploader_esp") as string | null)?.trim() || "";
  if (espRaw !== "instantly" && espRaw !== "smartlead") {
    return { cfg, error: "uploader_esp must be 'instantly' or 'smartlead' when uploader_enabled=1" };
  }
  cfg.esp = espRaw;
  cfg.autoTrigger = true;

  const workersRaw = Number(formData.get("uploader_workers") || "2");
  cfg.workers = Math.max(1, Math.min(5, Number.isFinite(workersRaw) ? Math.round(workersRaw) : 2));

  if (cfg.esp === "instantly") {
    cfg.instantlyEmail = (formData.get("instantly_email") as string | null)?.trim() || null;
    cfg.instantlyPassword = (formData.get("instantly_password") as string | null)?.trim() || null;
    cfg.instantlyV1Key = (formData.get("instantly_v1_key") as string | null)?.trim() || null;
    cfg.instantlyV2Key = (formData.get("instantly_v2_key") as string | null)?.trim() || null;
    cfg.instantlyWorkspace = (formData.get("instantly_workspace") as string | null)?.trim() || null;
    const apiVersion = (formData.get("instantly_api_version") as string | null)?.trim() || "v1";
    cfg.instantlyApiVersion = apiVersion === "v2" ? "v2" : "v1";

    if (!cfg.instantlyEmail || !cfg.instantlyPassword) {
      return { cfg, error: "Instantly email + password are required when uploader_esp=instantly" };
    }
    if (!cfg.instantlyV1Key && !cfg.instantlyV2Key) {
      return { cfg, error: "At least one Instantly API key (v1 or v2) is required" };
    }
    if (cfg.instantlyApiVersion === "v2" && !cfg.instantlyV2Key) {
      return { cfg, error: "instantly_api_version=v2 requires instantly_v2_key" };
    }
  } else {
    cfg.smartleadApiKey = (formData.get("smartlead_api_key") as string | null)?.trim() || null;
    cfg.smartleadLoginUrl = (formData.get("smartlead_login_url") as string | null)?.trim() || null;
    if (!cfg.smartleadApiKey) {
      return { cfg, error: "Smartlead API key is required when uploader_esp=smartlead" };
    }
    if (!cfg.smartleadLoginUrl) {
      return { cfg, error: "Smartlead Microsoft OAuth login URL is required when uploader_esp=smartlead" };
    }
  }

  return { cfg };
}

export async function POST(request: Request) {
  let formData: FormData;
  try {
    formData = await request.formData();
  } catch (error) {
    return NextResponse.json(
      {
        error: "Invalid request payload.",
        details: error instanceof Error ? error.message : String(error)
      },
      { status: 400 }
    );
  }
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

  const { cfg: uploaderCfg, error: uploaderError } = parseUploaderConfig(formData);
  if (uploaderError) {
    return NextResponse.json(
      { error: "Uploader config invalid.", details: uploaderError },
      { status: 422 }
    );
  }

  try {
    const batch = await prisma.batch.create({
      data: {
        status: "uploading",
        totalCount: parsedTenants.length,
        completedCount: 0,
        uploaderEsp: uploaderCfg.esp,
        uploaderAutoTrigger: uploaderCfg.autoTrigger,
        uploaderWorkers: uploaderCfg.workers,
        instantlyEmail: uploaderCfg.instantlyEmail,
        instantlyPassword: uploaderCfg.instantlyPassword
          ? encryptSecret(uploaderCfg.instantlyPassword)
          : null,
        instantlyV1Key: uploaderCfg.instantlyV1Key
          ? encryptSecret(uploaderCfg.instantlyV1Key)
          : null,
        instantlyV2Key: uploaderCfg.instantlyV2Key
          ? encryptSecret(uploaderCfg.instantlyV2Key)
          : null,
        instantlyWorkspace: uploaderCfg.instantlyWorkspace,
        instantlyApiVersion: uploaderCfg.instantlyApiVersion,
        smartleadApiKey: uploaderCfg.smartleadApiKey
          ? encryptSecret(uploaderCfg.smartleadApiKey)
          : null,
        smartleadLoginUrl: uploaderCfg.smartleadLoginUrl,
        tenants: {
          create: parsedTenants.map((tenant) => ({
            tenantName: tenant.tenantName,
            clientName: tenant.clientName,
            adminEmail: tenant.adminEmail.toLowerCase(),
            adminPassword: encryptSecret(tenant.adminPassword),
            encryptionVersion: 1,
            domain: tenant.domain,
            inboxNames: serializeInboxNames(tenant.inboxNames),
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
            clientName: true,
            status: true
          }
        }
      }
    });

    await Promise.all(
      batch.tenants.map((tenant) =>
        logTenantEvent({
          batchId: batch.id,
          tenantId: tenant.id,
          eventType: "csv_submitted",
          message: `CSV row accepted for ${tenant.tenantName}`,
          details: {
            tenantName: tenant.tenantName,
            clientName: tenant.clientName,
            domain: parsedTenants.find((item) => item.tenantName === tenant.tenantName)?.domain || null
          }
        })
      )
    );

    // Batch-level event: record whether auto-upload is wired for this batch.
    await logTenantEvent({
      batchId: batch.id,
      eventType: "batch_submitted",
      message: uploaderCfg.autoTrigger
        ? `Batch of ${parsedTenants.length} tenant(s) submitted — auto-upload to ${uploaderCfg.esp} enabled`
        : `Batch of ${parsedTenants.length} tenant(s) submitted — no auto-upload configured`,
      details: {
        tenantCount: parsedTenants.length,
        uploaderEsp: uploaderCfg.esp,
        uploaderAutoTrigger: uploaderCfg.autoTrigger,
        uploaderWorkers: uploaderCfg.workers
      }
    });

    // Slack — fire-and-forget. Never block the response on Slack.
    void (async () => {
      try {
        const { slackNotify } = await import("@/lib/services/slack");
        if (uploaderCfg.autoTrigger) {
          await slackNotify(
            `Batch submitted: ${parsedTenants.length} tenants, auto-upload to ${uploaderCfg.esp} (${uploaderCfg.workers} workers)`,
            "info"
          );
        } else {
          await slackNotify(
            `Batch submitted: ${parsedTenants.length} tenants (no auto-upload)`,
            "info"
          );
        }
      } catch (error) {
        console.error("[batches] slack notify failed:", error);
      }
    })();

    return NextResponse.json(
      {
        batch: {
          id: batch.id,
          status: batch.status,
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
