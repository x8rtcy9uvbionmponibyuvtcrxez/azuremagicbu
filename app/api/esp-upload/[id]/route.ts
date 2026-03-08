export const runtime = "nodejs";
export const dynamic = "force-dynamic";

import { NextResponse } from "next/server";
import { getEspRun } from "@/lib/esp-upload-store";

const UPLOADER_URL = process.env.UPLOADER_SERVICE_URL || "";

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;

  // ── Cloud mode: proxy to uploader micro-service ──────────
  if (UPLOADER_URL) {
    try {
      const res = await fetch(`${UPLOADER_URL}/jobs/${id}`, {
        cache: "no-store",
      });
      const data = await res.json();

      if (!res.ok) {
        return NextResponse.json(
          { error: data.detail || data.error || "Uploader service error" },
          { status: res.status }
        );
      }

      // Map uploader response shape → frontend EspRun shape
      const run = {
        id: data.jobId,
        esp: data.esp,
        status: data.status,
        phase: data.phase || "uploading",
        createdAt: data.createdAt || new Date().toISOString(),
        updatedAt: data.updatedAt || new Date().toISOString(),
        apiKeyMasked: data.apiKeyMasked || "****",
        logLines: data.logs || [],
        exitCode: data.exitCode ?? null,
        errorMessage: data.errorMessage || null,
        failedCsvPath: data.failedCsvPath || null,
      };

      return NextResponse.json({ run });
    } catch (err) {
      return NextResponse.json(
        { error: err instanceof Error ? err.message : "Uploader service unreachable" },
        { status: 502 }
      );
    }
  }

  // ── Local mode: read from in-memory store ────────────────
  const run = getEspRun(id);

  if (!run) {
    return NextResponse.json({ error: "Run not found" }, { status: 404 });
  }

  return NextResponse.json({ run });
}
