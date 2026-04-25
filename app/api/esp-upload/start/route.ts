/**
 * Standalone ESP upload — proxies to the email-uploader service.
 *
 * This is the manual one-off upload page (UI at /esp-upload), separate from
 * the bulk-batch flow. Operator drops a CSV + creds, kicks off an upload
 * without going through Azure provisioning. Useful for cleanup runs and
 * for users who already have mailboxes provisioned elsewhere.
 *
 * Previously this route used a different env var (UPLOADER_SERVICE_URL)
 * and a different protocol (/jobs/smartlead, /jobs/instantly) that nobody
 * was on the other side of, plus a Python subprocess fallback that didn't
 * work because Dockerfile.web doesn't bundle Python or Chromium. Both
 * paths were dead code. This rewrite points the route at our actual
 * uploader (EMAIL_UPLOADER_URL → /api/start) and translates the form
 * fields between the two protocols.
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

import { NextResponse } from "next/server";

const UPLOADER_URL = (process.env.EMAIL_UPLOADER_URL || "").trim().replace(/\/$/, "");

export async function POST(request: Request) {
  if (!UPLOADER_URL) {
    return NextResponse.json(
      {
        error:
          "EMAIL_UPLOADER_URL is not configured on this service. Set it to the internal uploader URL (e.g. http://uploader.railway.internal:5050) and redeploy."
      },
      { status: 503 }
    );
  }

  try {
    const formData = await request.formData();
    const esp = formData.get("esp") as string;

    if (esp !== "smartlead" && esp !== "instantly") {
      return NextResponse.json(
        { error: "esp must be 'smartlead' or 'instantly'" },
        { status: 400 }
      );
    }

    const file = formData.get("file") as File | null;
    if (!file) {
      return NextResponse.json({ error: "CSV file is required" }, { status: 400 });
    }

    const apiKey = (formData.get("apiKey") as string) || "";
    if (!apiKey) {
      return NextResponse.json({ error: "API key is required" }, { status: 400 });
    }

    // Build the form payload our uploader expects (POST /api/start). The
    // field names differ from the legacy /jobs/* protocol — translate
    // here so the UI can stay protocol-agnostic.
    const body = new FormData();
    body.append("csv_file", file);
    body.append("api_key", apiKey);

    if (esp === "smartlead") {
      const loginUrl = (formData.get("loginUrl") as string) || "";
      if (!loginUrl) {
        return NextResponse.json(
          { error: "Microsoft OAuth Login URL is required for Smartlead" },
          { status: 400 }
        );
      }
      body.append("platform", "smartlead_upload");
      body.append("login_url", loginUrl);
    } else {
      const loginEmail = (formData.get("loginEmail") as string) || "";
      const loginPassword = (formData.get("loginPassword") as string) || "";
      const workspace = (formData.get("workspace") as string) || "";
      const apiVersion =
        (formData.get("apiVersion") as string) === "v2" ? "v2" : "v1";
      const v2ApiKey = (formData.get("v2ApiKey") as string) || "";

      if (!loginEmail || !loginPassword) {
        return NextResponse.json(
          { error: "Login email and password are required for Instantly" },
          { status: 400 }
        );
      }

      body.append("platform", "instantly");
      // Workspace blank = mode=single (skip the workspace switch step,
      // upload to whatever the login lands on as default workspace).
      body.append("mode", workspace ? "multi" : "single");
      body.append("api_version", apiVersion);
      body.append("v2_api_key", v2ApiKey);
      body.append("instantly_email", loginEmail);
      body.append("instantly_password", loginPassword);
      body.append("workspace", workspace);
      // workers comes from EMAIL_UPLOADER_DEFAULT_WORKERS on the uploader
      // side (Railway env var). The legacy UI exposed a 1-5 dropdown but
      // we hide it now — RAM ceiling on Hobby plan caps it at ~2 anyway.
    }

    const res = await fetch(`${UPLOADER_URL}/api/start`, { method: "POST", body });
    const text = await res.text();
    let data: { job_id?: string; status?: string; error?: string } = {};
    try {
      data = JSON.parse(text);
    } catch {
      /* non-JSON body — surface as raw error below */
    }

    if (!res.ok || !data.job_id) {
      return NextResponse.json(
        { error: data.error || text.slice(0, 300) || `Uploader HTTP ${res.status}` },
        { status: res.status >= 400 && res.status < 600 ? res.status : 502 }
      );
    }

    // The legacy frontend expects `runId`. Keep that contract.
    return NextResponse.json({ runId: data.job_id });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
