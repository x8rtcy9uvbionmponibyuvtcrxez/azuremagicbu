"use client";

import Link from "next/link";
import { FormEvent, useEffect, useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Alert, AlertDescription } from "@/components/ui/alert";

type EspType = "smartlead" | "instantly" | null;

type EspRun = {
  id: string;
  esp: "smartlead" | "instantly";
  status: "queued" | "running" | "completed" | "failed";
  phase: "uploading" | "configuring" | "done";
  createdAt: string;
  updatedAt: string;
  apiKeyMasked: string;
  logLines: string[];
  exitCode: number | null;
  errorMessage: string | null;
  failedCsvPath: string | null;
  loginUrl?: string;
  loginEmail?: string;
  workspace?: string;
  numWorkers?: number;
  apiVersion?: "v1" | "v2";
};

const statusColor: Record<string, string> = {
  queued: "bg-zinc-200 text-zinc-800",
  running: "bg-blue-100 text-blue-800",
  completed: "bg-emerald-100 text-emerald-800",
  failed: "bg-red-100 text-red-800",
};

const phaseLabel: Record<string, string> = {
  uploading: "Uploading accounts...",
  configuring: "Configuring warmup & limits...",
  done: "Done",
};

// Cloud mode no longer blocks ESP upload — the web app proxies to the uploader service.

export default function EspUploadPage() {
  const [selectedEsp, setSelectedEsp] = useState<EspType>(null);

  // Shared state
  const [runId, setRunId] = useState<string | null>(null);
  const [run, setRun] = useState<EspRun | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [file, setFile] = useState<File | null>(null);

  // Smartlead fields
  const [slApiKey, setSlApiKey] = useState("");
  const [slLoginUrl, setSlLoginUrl] = useState("");

  // Instantly fields
  const [instApiKey, setInstApiKey] = useState("");
  const [instV2ApiKey, setInstV2ApiKey] = useState("");
  const [instApiVersion, setInstApiVersion] = useState<"v1" | "v2">("v1");
  const [instEmail, setInstEmail] = useState("");
  const [instPassword, setInstPassword] = useState("");
  const [instWorkspace, setInstWorkspace] = useState("");
  const [instWorkers, setInstWorkers] = useState(3);

  const terminal = run?.status === "completed" || run?.status === "failed";

  // Poll for status
  useEffect(() => {
    if (!runId) return;
    const tick = async () => {
      try {
        const res = await fetch(`/api/esp-upload/${runId}`, { cache: "no-store" });
        const data = (await res.json()) as { run?: EspRun; error?: string };
        if (!res.ok) throw new Error(data.error || "Failed to fetch run");
        if (data.run) setRun(data.run);
      } catch (err) {
        setError(err instanceof Error ? err.message : "Polling failed");
      }
    };
    void tick();
    const timer = setInterval(() => void tick(), 2000);
    return () => clearInterval(timer);
  }, [runId]);

  const logText = useMemo(() => run?.logLines.join("\n") || "", [run?.logLines]);

  const onSubmit = async (event: FormEvent) => {
    event.preventDefault();
    if (!file || !selectedEsp) return;

    setBusy(true);
    setError(null);
    setRun(null);
    setRunId(null);

    try {
      const formData = new FormData();
      formData.append("esp", selectedEsp);
      formData.append("file", file);

      if (selectedEsp === "smartlead") {
        formData.append("apiKey", slApiKey);
        formData.append("loginUrl", slLoginUrl);
      } else {
        formData.append("apiKey", instApiKey);
        formData.append("v2ApiKey", instV2ApiKey);
        formData.append("apiVersion", instApiVersion);
        formData.append("loginEmail", instEmail);
        formData.append("loginPassword", instPassword);
        formData.append("workspace", instWorkspace);
        formData.append("numWorkers", String(instWorkers));
      }

      const res = await fetch("/api/esp-upload/start", {
        method: "POST",
        body: formData,
      });
      const data = (await res.json()) as { runId?: string; error?: string };
      if (!res.ok || !data.runId) {
        throw new Error(data.error || "Failed to start upload");
      }
      setRunId(data.runId);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to start");
    } finally {
      setBusy(false);
    }
  };

  const resetForm = () => {
    setRunId(null);
    setRun(null);
    setError(null);
    setFile(null);
    setBusy(false);
  };

  return (
    <main className="mx-auto max-w-5xl p-6 md:p-10">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-3xl font-semibold tracking-tight">Upload into ESP</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Upload email accounts into Smartlead or Instantly via OAuth automation.
          </p>
        </div>
        <Button asChild variant="outline">
          <Link href="/">Dashboard</Link>
        </Button>
      </div>

      {/* ESP Picker */}
      {!runId && (
        <div className="mt-6 grid gap-4 md:grid-cols-2">
          <Card
            className={`cursor-pointer transition-all ${selectedEsp === "smartlead" ? "ring-2 ring-blue-500" : "hover:border-blue-300"}`}
            onClick={() => setSelectedEsp("smartlead")}
          >
            <CardHeader>
              <CardTitle>Smartlead</CardTitle>
              <CardDescription>
                Add email accounts via Microsoft OAuth, then auto-configure warmup and sending limits.
              </CardDescription>
            </CardHeader>
          </Card>
          <Card
            className={`cursor-pointer transition-all ${selectedEsp === "instantly" ? "ring-2 ring-blue-500" : "hover:border-blue-300"}`}
            onClick={() => setSelectedEsp("instantly")}
          >
            <CardHeader>
              <CardTitle>Instantly</CardTitle>
              <CardDescription>
                Add email accounts via Microsoft OAuth with multi-worker parallel processing.
              </CardDescription>
            </CardHeader>
          </Card>
        </div>
      )}

      {/* Smartlead Form */}
      {selectedEsp === "smartlead" && !runId && (
        <form onSubmit={onSubmit} className="mt-6 grid gap-4 rounded-lg border p-4">
          <h2 className="text-lg font-medium">Smartlead Upload</h2>

          <label className="grid gap-1">
            <span className="text-sm font-medium">Smartlead API Key</span>
            <input
              className="rounded border px-3 py-2 text-sm"
              type="password"
              value={slApiKey}
              onChange={(e) => setSlApiKey(e.target.value)}
              placeholder="Enter API key"
              required
            />
          </label>

          <label className="grid gap-1">
            <span className="text-sm font-medium">Microsoft OAuth Login URL</span>
            <input
              className="rounded border px-3 py-2 text-sm"
              type="url"
              value={slLoginUrl}
              onChange={(e) => setSlLoginUrl(e.target.value)}
              placeholder="https://login.microsoftonline.com/..."
              required
            />
          </label>

          <label className="grid gap-1">
            <span className="text-sm font-medium">CSV File (EmailAddress, Password)</span>
            <input
              className="rounded border px-3 py-2 text-sm"
              type="file"
              accept=".csv,text/csv"
              onChange={(e) => setFile(e.target.files?.[0] || null)}
              required
            />
          </label>

          <Button type="submit" disabled={busy}>
            {busy ? "Starting..." : "Start Smartlead Upload"}
          </Button>
        </form>
      )}

      {/* Instantly Form */}
      {selectedEsp === "instantly" && !runId && (
        <form onSubmit={onSubmit} className="mt-6 grid gap-4 rounded-lg border p-4">
          <h2 className="text-lg font-medium">Instantly Upload</h2>

          <label className="grid gap-1">
            <span className="text-sm font-medium">API Version</span>
            <select
              className="rounded border px-3 py-2 text-sm"
              value={instApiVersion}
              onChange={(e) => setInstApiVersion(e.target.value === "v2" ? "v2" : "v1")}
            >
              <option value="v1">v1</option>
              <option value="v2">v2</option>
            </select>
          </label>

          <label className="grid gap-1">
            <span className="text-sm font-medium">Instantly API Key (v1)</span>
            <input
              className="rounded border px-3 py-2 text-sm"
              type="password"
              value={instApiKey}
              onChange={(e) => setInstApiKey(e.target.value)}
              required
            />
          </label>

          {instApiVersion === "v2" && (
            <label className="grid gap-1">
              <span className="text-sm font-medium">Instantly API Key (v2)</span>
              <input
                className="rounded border px-3 py-2 text-sm"
                type="password"
                value={instV2ApiKey}
                onChange={(e) => setInstV2ApiKey(e.target.value)}
                required
              />
            </label>
          )}

          <label className="grid gap-1">
            <span className="text-sm font-medium">Instantly Login Email</span>
            <input
              className="rounded border px-3 py-2 text-sm"
              type="email"
              value={instEmail}
              onChange={(e) => setInstEmail(e.target.value)}
              required
            />
          </label>

          <label className="grid gap-1">
            <span className="text-sm font-medium">Instantly Login Password</span>
            <input
              className="rounded border px-3 py-2 text-sm"
              type="password"
              value={instPassword}
              onChange={(e) => setInstPassword(e.target.value)}
              required
            />
          </label>

          <label className="grid gap-1">
            <span className="text-sm font-medium">Workspace Name</span>
            <input
              className="rounded border px-3 py-2 text-sm"
              type="text"
              value={instWorkspace}
              onChange={(e) => setInstWorkspace(e.target.value)}
              placeholder="Workspace name as shown in Instantly"
              required
            />
          </label>

          <label className="grid gap-1">
            <span className="text-sm font-medium">Number of Workers (1-5)</span>
            <select
              className="rounded border px-3 py-2 text-sm"
              value={instWorkers}
              onChange={(e) => setInstWorkers(parseInt(e.target.value))}
            >
              <option value={1}>1 worker</option>
              <option value={2}>2 workers</option>
              <option value={3}>3 workers (default)</option>
              <option value={4}>4 workers</option>
              <option value={5}>5 workers</option>
            </select>
          </label>

          <label className="grid gap-1">
            <span className="text-sm font-medium">CSV File (EmailAddress, Password)</span>
            <input
              className="rounded border px-3 py-2 text-sm"
              type="file"
              accept=".csv,text/csv"
              onChange={(e) => setFile(e.target.files?.[0] || null)}
              required
            />
          </label>

          <Button type="submit" disabled={busy}>
            {busy ? "Starting..." : "Start Instantly Upload"}
          </Button>
        </form>
      )}

      {/* Error */}
      {error && (
        <Alert variant="destructive" className="mt-4">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}

      {/* Run Status + Logs */}
      {runId && (
        <section className="mt-6 grid gap-4">
          <Card>
            <CardHeader className="pb-3">
              <div className="flex items-center justify-between">
                <CardTitle className="text-lg">
                  {run?.esp === "smartlead" ? "Smartlead" : "Instantly"} Upload Run
                </CardTitle>
                <Badge className={statusColor[run?.status || "queued"]}>
                  {run?.status || "queued"}
                </Badge>
              </div>
            </CardHeader>
            <CardContent className="grid gap-2 text-sm">
              <p>
                <span className="font-medium">Run ID:</span>{" "}
                <span className="font-mono text-xs">{runId}</span>
              </p>
              {run?.esp === "smartlead" && run.status === "running" && (
                <p>
                  <span className="font-medium">Phase:</span>{" "}
                  {phaseLabel[run.phase] || run.phase}
                </p>
              )}
              {run?.exitCode !== null && run?.exitCode !== undefined && (
                <p>
                  <span className="font-medium">Exit Code:</span> {run.exitCode}
                </p>
              )}
              {run?.errorMessage && (
                <p className="text-red-600">
                  <span className="font-medium">Error:</span> {run.errorMessage}
                </p>
              )}
              <div className="mt-2 flex gap-2">
                {run?.failedCsvPath && (
                  <Button asChild variant="outline" size="sm">
                    <a href={`/api/esp-upload/${runId}/download-failed`} download>
                      Download Failed Accounts
                    </a>
                  </Button>
                )}
                {terminal && (
                  <Button variant="outline" size="sm" onClick={resetForm}>
                    Start New Upload
                  </Button>
                )}
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-sm font-medium">Live Logs</CardTitle>
            </CardHeader>
            <CardContent>
              <textarea
                value={logText}
                readOnly
                className="h-[420px] w-full rounded border bg-zinc-950 p-3 font-mono text-xs text-zinc-100"
              />
            </CardContent>
          </Card>
        </section>
      )}
    </main>
  );
}
