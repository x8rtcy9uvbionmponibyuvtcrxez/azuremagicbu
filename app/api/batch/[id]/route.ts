import { NextResponse } from "next/server";

import { decryptSecret } from "@/lib/crypto";
import { prisma } from "@/lib/prisma";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

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
          orderBy: { createdAt: "asc" },
          select: {
            id: true,
            tenantName: true,
            clientName: true,
            domain: true,
            adminEmail: true,
            adminPassword: true,
            status: true,
            progress: true,
            currentStep: true,
            authCode: true,
            authCodeExpiry: true,
            authConfirmed: true,
            csvUrl: true,
            errorMessage: true,
            setupConfirmed: true,
            createdAt: true,
            updatedAt: true,
            // Per-step completion flags — surfaced so the UI can render a
            // checklist of what's done vs in-flight instead of a useless
            // "Processing in progress." spinner.
            domainAdded: true,
            domainVerified: true,
            domainDefault: true,
            licensedUserId: true,
            sharedMailboxesCreated: true,
            passwordsSet: true,
            smtpAuthEnabled: true,
            delegationComplete: true,
            signInEnabled: true,
            cloudAppAdminAssigned: true,
            dkimConfigured: true,
            smartleadConnected: true,
            instantlyConnected: true,
            // Uploader tracking
            uploaderJobId: true,
            uploaderStatus: true,
            uploaderQueuedAt: true,
            uploaderStartedAt: true,
            uploaderCompletedAt: true,
            uploaderTotal: true,
            uploaderSucceeded: true,
            uploaderFailed: true,
            uploaderSkipped: true,
            uploaderWarnings: true,
            uploaderErrorMessage: true,
            uploaderLastLogAt: true
          }
        }
      }
    });

    if (!batch) {
      return NextResponse.json({ error: "Batch not found" }, { status: 404 });
    }

    const completedCount = batch.tenants.filter((tenant) => tenant.status === "completed").length;
    const hasActive = batch.tenants.some((tenant) => !["completed", "failed"].includes(tenant.status));
    const hasFailed = batch.tenants.some((tenant) => tenant.status === "failed");

    let nextStatus = batch.status;
    if (completedCount === batch.totalCount && batch.totalCount > 0) {
      nextStatus = "completed";
    } else if (!hasActive && hasFailed) {
      nextStatus = "failed";
    }

    const needsUpdate = completedCount !== batch.completedCount || nextStatus !== batch.status;

    const finalBatch = needsUpdate
      ? await prisma.batch.update({
          where: { id: batch.id },
          data: {
            completedCount,
            status: nextStatus
          }
        })
      : batch;

    return NextResponse.json({
      batch: {
        id: finalBatch.id,
        status: finalBatch.status,
        totalCount: finalBatch.totalCount,
        completedCount,
        createdAt: finalBatch.createdAt.toISOString(),
        uploaderEsp: finalBatch.uploaderEsp,
        uploaderAutoTrigger: finalBatch.uploaderAutoTrigger
      },
      tenants: batch.tenants.map((tenant) => {
        let adminPasswordPlain = "";
        try {
          adminPasswordPlain = tenant.adminPassword ? decryptSecret(tenant.adminPassword) : "";
        } catch {
          adminPasswordPlain = "";
        }
        return {
          ...tenant,
          adminPassword: adminPasswordPlain,
          authCodeExpiry: tenant.authCodeExpiry ? tenant.authCodeExpiry.toISOString() : null,
          createdAt: tenant.createdAt.toISOString(),
          updatedAt: tenant.updatedAt.toISOString(),
          uploaderQueuedAt: tenant.uploaderQueuedAt ? tenant.uploaderQueuedAt.toISOString() : null,
          uploaderStartedAt: tenant.uploaderStartedAt ? tenant.uploaderStartedAt.toISOString() : null,
          uploaderCompletedAt: tenant.uploaderCompletedAt ? tenant.uploaderCompletedAt.toISOString() : null,
          uploaderLastLogAt: tenant.uploaderLastLogAt ? tenant.uploaderLastLogAt.toISOString() : null
        };
      })
    });
  } catch (error) {
    return NextResponse.json(
      {
        error: "Failed to load batch.",
        details: error instanceof Error ? error.message : String(error)
      },
      { status: 500 }
    );
  }
}
