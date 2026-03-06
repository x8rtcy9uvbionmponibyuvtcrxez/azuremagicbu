"use client";

import { FormEvent, useEffect, useMemo, useState } from "react";

type DemoRun = {
  id: string;
  status: "queued" | "running" | "completed" | "failed";
  createdAt: string;
  updatedAt: string;
  apiKeyMasked: string;
  loginUrl: string;
  exitCode: number | null;
  errorMessage: string | null;
  failedCsvPath: string | null;
  logLines: string[];
};

export default function DemoUploaderPage() {
  const [apiKey, setApiKey] = useState("");
  const [loginUrl, setLoginUrl] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [runId, setRunId] = useState<string | null>(null);
  const [run, setRun] = useState<DemoRun | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const terminal = run?.status === "completed" || run?.status === "failed";

  async function fetchRun(id: string): Promise<void> {
    const response = await fetch(`/api/demo-uploader/${id}`, { cache: "no-store" });
    const payload = (await response.json()) as { error?: string; run?: DemoRun };
    if (!response.ok) {
      throw new Error(payload.error || "Failed to fetch run");
    }
    if (payload.run) {
      setRun(payload.run);
    }
  }

  useEffect(() => {
    if (!runId) return;
    let timer: ReturnType<typeof setInterval> | null = null;

    const tick = async () => {
      try {
        await fetchRun(runId);
      } catch (err) {
        setError(err instanceof Error ? err.message : "Failed to poll run");
      }
    };

    void tick();
    timer = setInterval(() => {
      void tick();
    }, 2000);

    return () => {
      if (timer) clearInterval(timer);
    };
  }, [runId]);

  const logText = useMemo(() => run?.logLines.join("\n") || "", [run?.logLines]);

  const onSubmit = async (event: FormEvent) => {
    event.preventDefault();
    if (!file) {
      setError("Select a CSV file.");
      return;
    }

    setBusy(true);
    setError(null);
    setRun(null);
    setRunId(null);

    try {
      const formData = new FormData();
      formData.append("apiKey", apiKey);
      formData.append("loginUrl", loginUrl);
      formData.append("file", file);

      const response = await fetch("/api/demo-uploader/start", {
        method: "POST",
        body: formData
      });

      const payload = (await response.json()) as { error?: string; runId?: string };
      if (!response.ok || !payload.runId) {
        throw new Error(payload.error || "Unable to start run.");
      }

      setRunId(payload.runId);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to start");
    } finally {
      setBusy(false);
    }
  };

  return (
    <main className="mx-auto max-w-5xl p-6 md:p-10">
      <h1 className="text-2xl font-semibold">Smartlead Selenium Demo Runner</h1>
      <p className="mt-2 text-sm text-muted-foreground">
        Upload a CSV, run the existing `sl-python.py` script, and watch live logs.
      </p>

      <form onSubmit={onSubmit} className="mt-6 grid gap-4 rounded-lg border p-4">
        <label className="grid gap-1">
          <span className="text-sm font-medium">Smartlead API Key</span>
          <input
            className="rounded border px-3 py-2 text-sm"
            type="password"
            value={apiKey}
            onChange={(event) => setApiKey(event.target.value)}
            placeholder="Enter API key"
            required
          />
        </label>

        <label className="grid gap-1">
          <span className="text-sm font-medium">Microsoft OAuth Login URL</span>
          <input
            className="rounded border px-3 py-2 text-sm"
            type="url"
            value={loginUrl}
            onChange={(event) => setLoginUrl(event.target.value)}
            placeholder="https://login.microsoftonline.com/..."
            required
          />
        </label>

        <label className="grid gap-1">
          <span className="text-sm font-medium">CSV File</span>
          <input
            className="rounded border px-3 py-2 text-sm"
            type="file"
            accept=".csv,text/csv"
            onChange={(event) => setFile(event.target.files?.[0] || null)}
            required
          />
        </label>

        <button className="rounded bg-black px-4 py-2 text-sm text-white disabled:opacity-50" disabled={busy} type="submit">
          {busy ? "Starting..." : "Start Demo Run"}
        </button>
      </form>

      {error ? <p className="mt-4 text-sm text-red-600">{error}</p> : null}

      {runId ? (
        <section className="mt-6 grid gap-4">
          <div className="rounded-lg border p-4">
            <p className="text-sm">
              <span className="font-medium">Run ID:</span> {runId}
            </p>
            <p className="text-sm">
              <span className="font-medium">Status:</span> {run?.status || "loading..."}
              {terminal ? " (terminal)" : ""}
            </p>
            {run && run.exitCode !== null ? (
              <p className="text-sm">
                <span className="font-medium">Exit Code:</span> {run.exitCode}
              </p>
            ) : null}
            {run?.failedCsvPath ? (
              <p className="text-sm">
                <span className="font-medium">Failed CSV:</span> {run.failedCsvPath}
              </p>
            ) : null}
          </div>

          <div className="rounded-lg border p-4">
            <p className="mb-2 text-sm font-medium">Live Logs</p>
            <textarea
              value={logText}
              readOnly
              className="h-[420px] w-full rounded border bg-zinc-950 p-3 font-mono text-xs text-zinc-100"
            />
          </div>
        </section>
      ) : null}
    </main>
  );
}
