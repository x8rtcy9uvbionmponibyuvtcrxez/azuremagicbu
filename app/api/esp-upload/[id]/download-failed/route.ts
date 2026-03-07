export const runtime = "nodejs";
export const dynamic = "force-dynamic";

import { NextResponse } from "next/server";
import { readFile } from "fs/promises";
import { getEspRun } from "@/lib/esp-upload-store";

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
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
