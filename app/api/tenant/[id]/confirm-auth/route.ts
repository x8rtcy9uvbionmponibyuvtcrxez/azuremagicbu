import { NextResponse } from "next/server";
import { z } from "zod";

import { prisma } from "@/lib/prisma";
import { enqueueTenantProcessingJob } from "@/lib/queue";
import { pollDeviceAuthToken } from "@/lib/services/microsoft";

export const runtime = "nodejs";

const schema = z.object({
  confirmed: z.literal(true)
});

function tenantFromAdminEmail(adminEmail?: string | null): string | null {
  if (!adminEmail) return null;
  const atIndex = adminEmail.indexOf("@");
  if (atIndex < 0) return null;
  const domain = adminEmail.slice(atIndex + 1).trim().toLowerCase();
  return domain || null;
}

type Params = {
  params: {
    id: string;
  };
};

export async function POST(request: Request, { params }: Params) {
  try {
    const body = await request.json();
    schema.parse(body);

    const tenant = await prisma.tenant.findUnique({
      where: { id: params.id },
      select: {
        id: true,
        batchId: true,
        status: true,
        tenantId: true,
        adminEmail: true,
        authCode: true,
        deviceCode: true,
        authConfirmed: true
      }
    });

    if (!tenant) {
      return NextResponse.json({ error: "Tenant not found" }, { status: 404 });
    }

    if (tenant.authConfirmed) {
      await enqueueTenantProcessingJob({ tenantId: tenant.id, batchId: tenant.batchId });
      return NextResponse.json({ ok: true, tenantId: tenant.id, resumed: true });
    }

    if (!tenant.deviceCode) {
      // If we already have the org ID captured, treat auth as complete and continue.
      if (tenant.tenantId) {
        await prisma.tenant.update({
          where: { id: tenant.id },
          data: {
            authConfirmed: true,
            status: "mailboxes",
            currentStep: "Auth already verified. Continuing mailbox setup...",
            progress: 68
          }
        });
        await enqueueTenantProcessingJob({ tenantId: tenant.id, batchId: tenant.batchId });
        return NextResponse.json({
          ok: true,
          tenantId: tenant.id,
          resumed: true,
          bypassed: true,
          message: "Device code missing but tenant already authorized. Continuing mailbox setup."
        });
      }

      return NextResponse.json({ error: "No device code available for this tenant" }, { status: 400 });
    }

    const tenantDomain = tenantFromAdminEmail(tenant.adminEmail) || tenant.tenantId || process.env.GRAPH_TENANT_ID || "common";
    console.log("🔍 [Debug] Token exchange params:");
    console.log("- Has client_secret:", Boolean(process.env.GRAPH_CLIENT_SECRET));
    console.log("- Client ID:", process.env.GRAPH_CLIENT_ID || "(missing)");
    console.log("- Tenant domain:", tenantDomain);
    console.log("- Device code length:", tenant.deviceCode?.length ?? 0);
    console.log("- Param keys being sent:", ["grant_type", "client_id", "client_secret", "device_code"]);

    const verification = await pollDeviceAuthToken(tenant.id, tenant.deviceCode);

    if (!verification.verified) {
      return NextResponse.json(
        { error: "Authorization still pending. Complete device login and try again." },
        { status: 409 }
      );
    }

    await prisma.tenant.update({
      where: { id: tenant.id },
      data: {
        authConfirmed: true,
        tenantId: verification.organizationId || undefined,
        status: "mailboxes",
        currentStep: "Auth confirmed. Continuing mailbox setup...",
        progress: 68
      }
    });

    await enqueueTenantProcessingJob({ tenantId: tenant.id, batchId: tenant.batchId });

    return NextResponse.json({ ok: true, tenantId: tenant.id, resumed: true });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unable to confirm auth";
    const normalized = message.toLowerCase();
    const isExpiredDeviceCode =
      message.includes("AADSTS70008") ||
      normalized.includes("expired due to inactivity") ||
      normalized.includes("provided authorization code or refresh token has expired");

    if (isExpiredDeviceCode) {
      const tenant = await prisma.tenant.findUnique({
        where: { id: params.id },
        select: { id: true, batchId: true }
      });

      if (tenant) {
        await prisma.tenant.update({
          where: { id: tenant.id },
          data: {
            status: "tenant_prep",
            progress: 55,
            errorMessage: null,
            currentStep: "Device code expired. Generating a new authentication code...",
            authConfirmed: false,
            authCode: null,
            deviceCode: null,
            authCodeExpiry: null
          }
        });
        await enqueueTenantProcessingJob({ tenantId: tenant.id, batchId: tenant.batchId });
      }

      return NextResponse.json(
        {
          error: "Device code expired. A new code is being generated now. Refresh in a few seconds and use the new code."
        },
        { status: 409 }
      );
    }

    return NextResponse.json(
      { error: message },
      { status: 400 }
    );
  }
}
