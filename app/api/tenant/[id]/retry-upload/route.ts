/**
 * Manual "Retry upload for this tenant" endpoint.
 *
 * Resets the tenant's uploader tracking fields and re-enqueues a
 * start-upload job. The uploader's existing_set check at job start will
 * fast-skip anything already in the ESP (usually ~95-99 of 99), so only
 * the genuinely-missing accounts get OAuth'd again. The end-of-job retry
 * pass (uploader-service/app.py) handles any accounts that fail OAuth on
 * the main loop.
 *
 * Powers the "Retry upload" button on the /batch/[id] page. Intended
 * for the post-batch cleanup case where uploaderFailed > 0 and we
 * want to take another shot at landing the missing mailboxes without
 * re-running Azure provisioning.
 */

import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { enqueueStartUpload } from "@/lib/queue";
import { logTenantEvent } from "@/lib/tenant-events";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Params = { params: { id: string } };

export async function POST(_request: Request, { params }: Params) {
  const tenantId = params.id;

  try {
    const tenant = await prisma.tenant.findUnique({
      where: { id: tenantId },
      select: {
        id: true,
        batchId: true,
        tenantName: true,
        uploaderStatus: true,
        batch: { select: { uploaderAutoTrigger: true, uploaderEsp: true } }
      }
    });

    if (!tenant) {
      return NextResponse.json({ error: "Tenant not found" }, { status: 404 });
    }

    // The batch must have an ESP configured — otherwise there's nothing
    // meaningful to retry against. Operator should've filled in Step 3
    // at batch creation; if not, they need to do it then.
    if (!tenant.batch.uploaderAutoTrigger || !tenant.batch.uploaderEsp) {
      return NextResponse.json(
        {
          error:
            "This batch has no ESP configured (Step 3 was left as 'None' or empty). Cannot retry upload — resubmit the batch with ESP details."
        },
        { status: 422 }
      );
    }

    // Don't stomp on an in-flight upload.
    if (
      tenant.uploaderStatus === "queued" ||
      tenant.uploaderStatus === "running"
    ) {
      return NextResponse.json(
        {
          error: `Upload is currently ${tenant.uploaderStatus}. Wait for it to reach a terminal state before retrying.`
        },
        { status: 409 }
      );
    }

    // Reset tenant uploader state so triggerUploadForTenant's idempotency
    // gate doesn't short-circuit us (it treats non-idle, non-failed as
    // "already in progress, skip").
    await prisma.tenant.update({
      where: { id: tenant.id },
      data: {
        uploaderStatus: "idle",
        uploaderJobId: null,
        uploaderErrorMessage: null,
        uploaderStartedAt: null,
        uploaderCompletedAt: null,
        // Keep uploaderTotal/Succeeded/Failed/Skipped from the prior run
        // as visible history; they'll get overwritten by the new run's
        // poll updates. If we cleared them the UI would briefly show
        // "0 of 0" which is confusing.
      }
    });

    await enqueueStartUpload({ tenantId: tenant.id, batchId: tenant.batchId });

    await logTenantEvent({
      batchId: tenant.batchId,
      tenantId: tenant.id,
      eventType: "uploader_retry_enqueued",
      message: `Manual retry enqueued (existing_set will skip already-landed accounts)`
    });

    return NextResponse.json({ ok: true });
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    return NextResponse.json(
      { error: "Failed to enqueue retry", details: msg },
      { status: 500 }
    );
  }
}
