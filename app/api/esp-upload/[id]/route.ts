/**
 * Standalone ESP upload — status polling proxy.
 *
 * The /esp-upload UI polls this every 2 sec for live counters + log
 * lines. We hit the uploader's /api/status/{id}?detail=1 and translate
 * its response shape into the EspRun shape the UI was originally written
 * against (so app/esp-upload/page.tsx doesn't need any changes).
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

import { NextResponse } from "next/server";

const UPLOADER_URL = (process.env.EMAIL_UPLOADER_URL || "").trim().replace(/\/$/, "");

type UploaderStatusResponse = {
  job_id: string;
  platform: string;
  mode?: string;
  status: "running" | "paused" | "stopping" | "completed" | "failed" | "cancelled";
  total: number;
  processed: number;
  succeeded: number;
  failed: number;
  skipped: number;
  warnings: number;
  started_at: string | null;
  finished_at: string | null;
  logs: string[];
  config_safe?: { workspace?: string; mode?: string; email?: string } | null;
  account_status?: Record<string, { state: string; reason?: string; ts: string }>;
};

function mapStatus(status: UploaderStatusResponse["status"]):
  | "queued"
  | "running"
  | "completed"
  | "failed" {
  if (status === "completed") return "completed";
  if (status === "failed" || status === "cancelled") return "failed";
  return "running"; // running/paused/stopping all surface as "running"
}

function tailErrorMessage(data: UploaderStatusResponse): string | null {
  if (data.status !== "failed" && data.status !== "cancelled") return null;
  // Walk the log tail backwards looking for a fatal-ish line. Same
  // pattern as lib/workers/uploadWorker.ts — keeps the surfaced error
  // short and human-readable.
  const tail = (data.logs || []).slice(-30).reverse();
  for (const line of tail) {
    if (/fatal|error|failed|aborted/i.test(line)) {
      return line.slice(0, 500);
    }
  }
  return `status=${data.status}, ${data.failed}/${data.total} failed`;
}

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;

  if (!UPLOADER_URL) {
    return NextResponse.json(
      { error: "EMAIL_UPLOADER_URL is not configured" },
      { status: 503 }
    );
  }

  let res: Response;
  try {
    res = await fetch(`${UPLOADER_URL}/api/status/${id}?detail=1`, {
      cache: "no-store"
    });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Uploader unreachable" },
      { status: 502 }
    );
  }

  if (res.status === 404) {
    return NextResponse.json({ error: "Run not found" }, { status: 404 });
  }
  if (!res.ok) {
    const txt = await res.text().catch(() => "");
    return NextResponse.json(
      { error: txt.slice(0, 300) || `Uploader HTTP ${res.status}` },
      { status: res.status }
    );
  }

  const data: UploaderStatusResponse = await res.json();

  // Translate the uploader's shape into the EspRun shape the standalone
  // /esp-upload UI was originally written against. Keeping the front-end
  // contract stable means we don't need to touch app/esp-upload/page.tsx.
  const espStatus = mapStatus(data.status);
  const espType = data.platform === "smartlead_upload" ? "smartlead" : "instantly";
  const phase = espStatus === "running" ? "uploading" : "done";
  const exitCode = espStatus === "completed" ? 0 : espStatus === "failed" ? 1 : null;
  const failedCsvPath =
    espStatus !== "running" && (data.failed || 0) > 0
      ? `/api/esp-upload/${id}/download-failed`
      : null;

  const run = {
    id: data.job_id,
    esp: espType,
    status: espStatus,
    phase,
    createdAt: data.started_at || new Date().toISOString(),
    updatedAt: data.finished_at || new Date().toISOString(),
    apiKeyMasked: "****", // uploader doesn't echo the key; mask is fine
    logLines: data.logs || [],
    exitCode,
    errorMessage: tailErrorMessage(data),
    failedCsvPath,
    workspace: data.config_safe?.workspace,
    loginEmail: data.config_safe?.email
  };

  return NextResponse.json({ run });
}
