/**
 * Standalone ESP upload — failed-accounts CSV download.
 *
 * Our uploader doesn't have a /failed-csv endpoint per job, but it does
 * return the per-account state map via /api/status/{id}?detail=1. We
 * filter for state="failed", correlate with the original CSV upload's
 * email + password rows (preserved in account_status's "row" if present
 * — though typically only email is exposed via account_status), and
 * synthesize a CSV that mirrors what the original /jobs/{id}/failed-csv
 * would have returned.
 *
 * Trade-off: account_status only exposes the email + state + reason.
 * Without password, the CSV we return is "list of email addresses that
 * failed" — useful for diagnostic / re-upload from a separate source,
 * but not directly resubmittable without joining back to a stored
 * password. For batch-flow uploads, the Retry Failed button on
 * /batch/[id] is the better path because it has the original CSV via
 * the persisted job state.
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

import { NextResponse } from "next/server";

const UPLOADER_URL = (process.env.EMAIL_UPLOADER_URL || "").trim().replace(/\/$/, "");

type AccountStatusEntry = {
  state: string;
  reason?: string;
  ts: string;
};

type UploaderStatusResponse = {
  job_id: string;
  status: string;
  account_status?: Record<string, AccountStatusEntry>;
};

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
    return NextResponse.json(
      { error: `Uploader HTTP ${res.status}` },
      { status: res.status }
    );
  }

  const data: UploaderStatusResponse = await res.json();
  const accountStatus = data.account_status || {};

  const failedRows: string[] = ["EmailAddress,Reason"];
  for (const [email, entry] of Object.entries(accountStatus)) {
    if (entry.state !== "failed") continue;
    // CSV-escape the reason (commas, quotes).
    const reason = (entry.reason || "").replace(/"/g, '""');
    failedRows.push(`${email},"${reason}"`);
  }

  if (failedRows.length === 1) {
    return NextResponse.json(
      { error: "No failed accounts in this run" },
      { status: 404 }
    );
  }

  return new Response(failedRows.join("\n") + "\n", {
    headers: {
      "Content-Type": "text/csv",
      "Content-Disposition": `attachment; filename="failed_accounts_${id}.csv"`
    }
  });
}
