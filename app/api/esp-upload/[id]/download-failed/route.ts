export const runtime = "nodejs";
export const dynamic = "force-dynamic";

import { NextResponse } from "next/server";
import { readFile } from "fs/promises";
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
      const res = await fetch(`${UPLOADER_URL}/jobs/${id}/failed-csv`, {
        cache: "no-store",
      });

      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        return NextResponse.json(
          { error: data.detail || data.error || "No failed CSV available" },
          { status: res.status }
        );
      }

      const content = await res.text();
      return new Response(content, {
        headers: {
          "Content-Type": "text/csv",
          "Content-Disposition": `attachment; filename="failed_accounts.csv"`,
        },
      });
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

  if (!run.failedCsvPath) {
    return NextResponse.json(
      { error: "No failed accounts CSV available" },
      { status: 404 }
    );
  }

  try {
    const content = await readFile(run.failedCsvPath, "utf-8");
    return new Response(content, {
      headers: {
        "Content-Type": "text/csv",
        "Content-Disposition": `attachment; filename="failed_accounts.csv"`,
      },
    });
  } catch {
    return NextResponse.json(
      { error: "Failed CSV file not found on disk" },
      { status: 404 }
    );
  }
}
