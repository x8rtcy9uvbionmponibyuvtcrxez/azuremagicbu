export const runtime = "nodejs";
export const dynamic = "force-dynamic";

import { NextResponse } from "next/server";
import { writeFile, mkdir } from "fs/promises";
import { join } from "path";
import { randomUUID } from "crypto";
import { tmpdir } from "os";
import { createEspRun, maskKey, type EspType } from "@/lib/esp-upload-store";
import { spawnSmartleadRun, spawnInstantlyRun } from "@/lib/esp-upload-spawn";

export async function POST(request: Request) {
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
      return NextResponse.json(
        { error: "CSV file is required" },
        { status: 400 }
      );
    }

    const apiKey = (formData.get("apiKey") as string) || "";
    if (!apiKey) {
      return NextResponse.json(
        { error: "API key is required" },
        { status: 400 }
      );
    }

    // Create temp working directory
    const workingDir = join(tmpdir(), `esp-upload-${randomUUID()}`);
    await mkdir(workingDir, { recursive: true });

    // Write CSV to disk
    const csvBuffer = Buffer.from(await file.arrayBuffer());
    const csvPath = join(workingDir, "accounts.csv");
    await writeFile(csvPath, csvBuffer);

    if (esp === "smartlead") {
      const loginUrl = (formData.get("loginUrl") as string) || "";
      if (!loginUrl) {
        return NextResponse.json(
          { error: "Microsoft OAuth Login URL is required for Smartlead" },
          { status: 400 }
        );
      }

      const run = createEspRun({
        esp: "smartlead",
        apiKeyMasked: maskKey(apiKey),
        csvPath,
        workingDir,
        loginUrl,
      });

      // Fire-and-forget
      spawnSmartleadRun({
        runId: run.id,
        apiKey,
        csvPath,
        loginUrl,
        workingDir,
      });

      return NextResponse.json({ runId: run.id });
    }

    // Instantly
    const loginEmail = (formData.get("loginEmail") as string) || "";
    const loginPassword = (formData.get("loginPassword") as string) || "";
    const workspace = (formData.get("workspace") as string) || "";
    const apiVersion =
      (formData.get("apiVersion") as string) === "v2" ? "v2" : "v1";
    const v2ApiKey = (formData.get("v2ApiKey") as string) || "";
    const numWorkers = Math.max(
      1,
      Math.min(5, parseInt(formData.get("numWorkers") as string) || 3)
    );

    if (!loginEmail || !loginPassword || !workspace) {
      return NextResponse.json(
        {
          error:
            "Login email, password, and workspace are required for Instantly",
        },
        { status: 400 }
      );
    }

    const run = createEspRun({
      esp: "instantly",
      apiKeyMasked: maskKey(apiKey),
      csvPath,
      workingDir,
      loginEmail,
      workspace,
      numWorkers,
      apiVersion: apiVersion as "v1" | "v2",
    });

    // Fire-and-forget
    spawnInstantlyRun({
      runId: run.id,
      apiKey,
      v2ApiKey,
      loginEmail,
      loginPassword,
      workspace,
      csvPath,
      apiVersion: apiVersion as "v1" | "v2",
      numWorkers,
      workingDir,
    });

    return NextResponse.json({ runId: run.id });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
