import { NextResponse } from "next/server";
import { z } from "zod";

import { prisma } from "@/lib/prisma";
import { enqueueTenantProcessingJob } from "@/lib/queue";
import { isAppConsentedInTenant, pollDeviceAuthToken } from "@/lib/services/microsoft";
import { logTenantEvent } from "@/lib/tenant-events";

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

    const tenant = await prisma.tenant.findUnique({
      where: { id: params.id },
      select: {
        id: true,
        batchId: true,
        status: true,
        tenantId: true,
        authCode: true,
        deviceCode: true,
        authConfirmed: true
      }
    });

    if (!tenant) {
      return NextResponse.json({ error: "Tenant not found" }, { status: 404 });
    }

    if (tenant.authConfirmed) {
      // Without this status flip the UI keeps showing "auth_pending" with
      // the old "Enter code" instruction even though consent is done. The
      // worker will progress past auth based on authConfirmed=true, but
      // the operator-visible state stays a lie until the next phase
      // boundary writes a fresh currentStep. Update here so the UI
      // immediately reflects "we're past auth, continuing setup."
      if (tenant.status === "auth_pending") {
        await prisma.tenant.update({
          where: { id: tenant.id },
          data: {
            status: "mailboxes",
            progress: 68,
            currentStep: "Auth confirmed. Continuing mailbox setup...",
            authCode: null,
            deviceCode: null,
            authCodeExpiry: null
          }
        });
      }
      await enqueueTenantProcessingJob({ tenantId: tenant.id, batchId: tenant.batchId });
      await logTenantEvent({
        batchId: tenant.batchId,
        tenantId: tenant.id,
        eventType: "auth_confirmed",
        message: "Auth already confirmed. Resuming processing."
      });
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
        await logTenantEvent({
          batchId: tenant.batchId,
          tenantId: tenant.id,
          eventType: "auth_bypassed",
          level: "warn",
          message: "Device code missing but tenant already authorized. Resumed mailbox setup."
        });
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

    const verification = await pollDeviceAuthToken(tenant.id, tenant.deviceCode);

    if (!verification.verified) {
      await logTenantEvent({
        batchId: tenant.batchId,
        tenantId: tenant.id,
        eventType: "auth_pending",
        level: "warn",
        message: "Authorization still pending; waiting for device login."
      });
      return NextResponse.json(
        { error: "Authorization still pending. Complete device login and try again." },
        { status: 409 }
      );
    }

    // Bug 12.5: don't trust the device-auth response by itself. Microsoft
    // returned a token, but we want a real Graph call to confirm we can
    // actually read from this tenant before flipping status to "mailboxes."
    // If consent didn't actually propagate (rare but seen), the worker
    // would otherwise advance and fail mysteriously two phases later.
    if (verification.organizationId) {
      const consent = await isAppConsentedInTenant(verification.organizationId);
      if (!consent.exists) {
        await prisma.tenant.update({
          where: { id: tenant.id },
          data: {
            errorMessage: `Device code accepted but Graph verification failed: ${consent.reason || "service principal not visible"}. Wait ~30s and click again — Microsoft consent propagation can take time.`,
            currentStep: "Verifying Microsoft Graph access..."
          }
        });
        await logTenantEvent({
          batchId: tenant.batchId,
          tenantId: tenant.id,
          eventType: "auth_verification_failed",
          level: "warn",
          message: "Device code confirmed but Graph verification failed.",
          details: { organizationId: verification.organizationId, reason: consent.reason || null }
        });
        return NextResponse.json(
          {
            error: `Device code accepted but Graph verification failed: ${consent.reason || "service principal not visible"}. Wait ~30s and try again.`
          },
          { status: 409 }
        );
      }
    }

    await prisma.tenant.update({
      where: { id: tenant.id },
      data: {
        authConfirmed: true,
        tenantId: verification.organizationId || undefined,
        status: "mailboxes",
        currentStep: "Auth confirmed and Graph access verified. Continuing mailbox setup...",
        progress: 68,
        errorMessage: null
      }
    });

    await enqueueTenantProcessingJob({ tenantId: tenant.id, batchId: tenant.batchId });
    await logTenantEvent({
      batchId: tenant.batchId,
      tenantId: tenant.id,
      eventType: "auth_confirmed",
      message: "Device code confirmed and Graph access verified. Tenant queued for processing.",
      details: { organizationId: verification.organizationId || null }
    });

    return NextResponse.json({ ok: true, tenantId: tenant.id, resumed: true, verified: true });
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
        await logTenantEvent({
          batchId: tenant.batchId,
          tenantId: tenant.id,
          eventType: "auth_code_expired",
          level: "warn",
          message: "Device code expired. Triggered fresh auth code generation."
        });
      }

      return NextResponse.json(
        {
          error: "Device code expired. A new code is being generated now. Refresh in a few seconds and use the new code."
        },
        { status: 409 }
      );
    }

    // AADSTS650051: "service principal name is already present for the
    // tenant". Microsoft is saying our app is already consented in this
    // tenant — i.e. consent already happened on a previous run. We don't
    // need a fresh device-code consent. Verify the SP is reachable via
    // client_credentials and, if so, advance the tenant.
    const isSpAlreadyPresent =
      message.includes("AADSTS650051") ||
      normalized.includes("service principal name is already present");

    if (isSpAlreadyPresent) {
      const tenant = await prisma.tenant.findUnique({
        where: { id: params.id },
        select: { id: true, batchId: true, tenantId: true }
      });

      if (tenant?.tenantId) {
        const consent = await isAppConsentedInTenant(tenant.tenantId);
        if (consent.exists) {
          await prisma.tenant.update({
            where: { id: tenant.id },
            data: {
              authConfirmed: true,
              status: "mailboxes",
              progress: 68,
              currentStep: "Auth already confirmed (SP exists in tenant). Continuing setup...",
              authCode: null,
              deviceCode: null,
              authCodeExpiry: null,
              errorMessage: null
            }
          });
          await enqueueTenantProcessingJob({ tenantId: tenant.id, batchId: tenant.batchId });
          await logTenantEvent({
            batchId: tenant.batchId,
            tenantId: tenant.id,
            eventType: "auth_bypassed",
            level: "warn",
            message: "Service principal already present in tenant; skipping device-code re-consent."
          });
          return NextResponse.json({
            ok: true,
            tenantId: tenant.id,
            resumed: true,
            bypassed: true,
            message: "App already consented in tenant; resumed setup."
          });
        }
      }
    }

    return NextResponse.json(
      { error: message },
      { status: 400 }
    );
  }
}
