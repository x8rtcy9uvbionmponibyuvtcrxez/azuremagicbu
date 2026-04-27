/**
 * /services/{op} — wizard for rename, remove, swap. Five-step flow:
 *   1. Pick tenant (dropdown of provisioned tenants)
 *   2. Upload CSV (per-op columns; download template)
 *   3. Preview table (validate against M365 — no writes)
 *   4. Confirmation summary (totals + skip-ESP checkboxes)
 *   5. Execute (POST to /execute, render results)
 *
 * One file handles all 3 ops; the differences (CSV columns, preview
 * column headers, confirmation copy) are in tiny per-op config blocks.
 */

"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { ArrowLeft, AlertTriangle, CheckCircle2, Loader2 } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

type Tenant = {
  id: string;
  tenantName: string;
  domain: string;
  status: string;
  licensedUserUpn: string | null;
};

type PreviewRow = {
  email: string;
  new_display_name?: string;
  new_email?: string;
  resolvable: boolean;
  currentDisplayName?: string;
  warnings: string[];
};

type PreviewResponse = {
  op: string;
  tenant: { id: string; tenantName: string; domain: string };
  rows: PreviewRow[];
  summary: { total: number; resolvable: number; missing: number; warnings_total: number };
};

type ResultRow = {
  email: string;
  state: "succeeded" | "failed" | "skipped" | "partial";
  steps: Array<{ name: string; ok: boolean; detail?: string }>;
  message?: string;
};

const OP_CONFIG: Record<string, {
  title: string;
  csvHeader: string;
  csvSample: string;
  previewCols: string[];
  description: string;
  destructive: boolean;
}> = {
  rename: {
    title: "Rename Users",
    csvHeader: "email,new_display_name",
    csvSample: "harrison.franke@usecharlotteb2b.com,Harrison Franke\nharry.franke@usecharlotteb2b.com,Harry Franke",
    previewCols: ["email", "current name", "new name", "warnings"],
    description: "Change display name in M365, delete + re-OAuth in Instantly so cold-email recipients see the new name.",
    destructive: true,
  },
  remove: {
    title: "Remove Users",
    csvHeader: "email",
    csvSample: "harrison.franke@usecharlotteb2b.com\nharry.franke@usecharlotteb2b.com",
    previewCols: ["email", "current name", "warnings"],
    description: "Delete the listed users from M365 (frees license), Instantly, and Smartlead.",
    destructive: true,
  },
  swap: {
    title: "Swap Users",
    csvHeader: "old_email,new_email,new_display_name",
    csvSample: "harrison.franke@usecharlotteb2b.com,h.franke@usecharlotteb2b.com,Harrison Franke",
    previewCols: ["old email", "new email", "new name", "warnings"],
    description: "Delete user A, create user B with same display name, OAuth B into ESPs.",
    destructive: true,
  },
};

export default function ServiceWizardPage() {
  const params = useParams();
  const router = useRouter();
  const op = (params.op as string) || "";
  const cfg = OP_CONFIG[op];

  const [tenants, setTenants] = useState<Tenant[]>([]);
  const [tenantId, setTenantId] = useState<string>("");
  const [csvText, setCsvText] = useState<string>("");
  const [csvFileName, setCsvFileName] = useState<string>("");
  const [previewBusy, setPreviewBusy] = useState(false);
  const [preview, setPreview] = useState<PreviewResponse | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);

  const [skipInstantly, setSkipInstantly] = useState(false);
  const [skipSmartlead, setSkipSmartlead] = useState(false);
  const [skipM365, setSkipM365] = useState(false);
  const [dryRun, setDryRun] = useState(false);

  const [executeBusy, setExecuteBusy] = useState(false);
  const [executeError, setExecuteError] = useState<string | null>(null);
  const [results, setResults] = useState<ResultRow[] | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    void fetch("/api/services/tenants")
      .then((r) => r.json())
      .then((d) => setTenants(d.tenants || []));
  }, []);

  if (!cfg) {
    return (
      <div className="container mx-auto max-w-3xl p-8">
        <p className="text-rose-700">Unknown op: {op}</p>
        <Link href="/services" className="mt-4 inline-block text-sm underline">← Back to services</Link>
      </div>
    );
  }

  const step = !tenantId ? 1 : !csvText ? 2 : !preview ? 3 : !results ? 4 : 5;

  async function loadFile(file: File) {
    const txt = await file.text();
    setCsvText(txt);
    setCsvFileName(file.name);
    setPreview(null);
    setResults(null);
  }

  async function runPreview() {
    setPreviewBusy(true);
    setPreviewError(null);
    setPreview(null);
    try {
      const resp = await fetch(`/api/services/${op}/preview`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ tenantId, csv: csvText }),
      });
      const data = await resp.json();
      if (!resp.ok) {
        setPreviewError(data.error || `HTTP ${resp.status}`);
      } else {
        setPreview(data);
      }
    } catch (e) {
      setPreviewError(e instanceof Error ? e.message : String(e));
    } finally {
      setPreviewBusy(false);
    }
  }

  async function runExecute() {
    setExecuteBusy(true);
    setExecuteError(null);
    try {
      const options: Record<string, boolean> = { dryRun };
      if (skipInstantly) options.skipInstantly = true;
      if (skipSmartlead) options.skipSmartlead = true;
      if (op === "remove" && skipM365) options.skipM365 = true;
      const resp = await fetch(`/api/services/${op}/execute`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ tenantId, csv: csvText, options }),
      });
      const data = await resp.json();
      if (!resp.ok) {
        setExecuteError(data.error || `HTTP ${resp.status}`);
      } else {
        setResults(data.results);
      }
    } catch (e) {
      setExecuteError(e instanceof Error ? e.message : String(e));
    } finally {
      setExecuteBusy(false);
    }
  }

  function downloadTemplate() {
    const blob = new Blob([cfg.csvHeader + "\n" + cfg.csvSample], { type: "text/csv" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${op}-template.csv`;
    a.click();
    URL.revokeObjectURL(url);
  }

  return (
    <div className="container mx-auto max-w-4xl px-4 py-8">
      <div className="mb-6">
        <Link href="/services" className="inline-flex items-center text-sm text-muted-foreground hover:text-foreground">
          <ArrowLeft className="mr-1 h-4 w-4" /> Back to services
        </Link>
        <h1 className="mt-2 text-3xl font-bold">{cfg.title}</h1>
        <p className="mt-1 text-muted-foreground">{cfg.description}</p>
      </div>

      {/* Step indicator */}
      <div className="mb-6 flex items-center gap-2 text-xs">
        {[1, 2, 3, 4, 5].map((n) => (
          <Badge key={n} variant={step === n ? "default" : step > n ? "outline" : "outline"}
                 className={step > n ? "bg-emerald-100 text-emerald-900 border-emerald-200" : ""}>
            {step > n ? "✓ " : ""}Step {n}
          </Badge>
        ))}
      </div>

      {/* STEP 1: tenant */}
      <Card className="mb-4">
        <CardHeader>
          <CardTitle className="text-base">1. Pick tenant</CardTitle>
        </CardHeader>
        <CardContent>
          <select
            className="w-full rounded border px-3 py-2 text-sm"
            value={tenantId}
            onChange={(e) => { setTenantId(e.target.value); setPreview(null); setResults(null); }}
          >
            <option value="">— select tenant —</option>
            {tenants.map((t) => (
              <option key={t.id} value={t.id}>
                {t.tenantName} • {t.domain} • {t.status}
              </option>
            ))}
          </select>
        </CardContent>
      </Card>

      {/* STEP 2: CSV */}
      {tenantId ? (
        <Card className="mb-4">
          <CardHeader>
            <CardTitle className="text-base">2. CSV</CardTitle>
          </CardHeader>
          <CardContent>
            <p className="mb-2 text-sm text-muted-foreground">
              Required columns: <code className="rounded bg-muted px-1 py-0.5 text-xs">{cfg.csvHeader}</code>
            </p>
            <div className="flex flex-wrap gap-2">
              <Button size="sm" variant="outline" onClick={() => fileInputRef.current?.click()}>
                {csvFileName ? `Replace (${csvFileName})` : "Upload CSV"}
              </Button>
              <Button size="sm" variant="ghost" onClick={downloadTemplate}>
                Download template
              </Button>
              <input
                ref={fileInputRef}
                type="file"
                accept=".csv,text/csv"
                className="hidden"
                onChange={(e) => {
                  const f = e.target.files?.[0];
                  if (f) void loadFile(f);
                  e.currentTarget.value = "";
                }}
              />
            </div>
          </CardContent>
        </Card>
      ) : null}

      {/* STEP 3: preview */}
      {tenantId && csvText ? (
        <Card className="mb-4">
          <CardHeader>
            <CardTitle className="text-base">3. Preview</CardTitle>
          </CardHeader>
          <CardContent>
            {!preview ? (
              <Button size="sm" onClick={() => void runPreview()} disabled={previewBusy}>
                {previewBusy ? <><Loader2 className="mr-2 h-4 w-4 animate-spin" />Validating…</> : "Run preview"}
              </Button>
            ) : (
              <PreviewTable preview={preview} cfg={cfg} />
            )}
            {previewError ? (
              <p className="mt-3 rounded border border-rose-200 bg-rose-50 px-3 py-2 text-sm text-rose-800">
                {previewError}
              </p>
            ) : null}
          </CardContent>
        </Card>
      ) : null}

      {/* STEP 4: confirmation + execute */}
      {preview && !results ? (
        <Card className="mb-4 border-amber-300 bg-amber-50/40">
          <CardHeader>
            <CardTitle className="text-base flex items-center gap-2">
              <AlertTriangle className="h-4 w-4 text-amber-700" />
              4. Confirm and execute
            </CardTitle>
          </CardHeader>
          <CardContent>
            <p className="mb-3 text-sm">
              About to run <b>{op}</b> on <b>{preview.summary.resolvable}</b> resolvable user(s).
              {preview.summary.missing > 0 ? (
                <span className="text-rose-700"> {preview.summary.missing} won&apos;t resolve and will be skipped.</span>
              ) : null}
              {preview.summary.warnings_total > 0 ? (
                <span className="text-amber-700"> {preview.summary.warnings_total} warning(s) above.</span>
              ) : null}
            </p>

            <div className="mb-3 space-y-1 text-sm">
              <label className="flex items-center gap-2">
                <input type="checkbox" checked={dryRun} onChange={(e) => setDryRun(e.target.checked)} />
                <span>Dry run — simulate, don&apos;t make changes</span>
              </label>
              {(op === "rename" || op === "swap" || op === "remove") ? (
                <label className="flex items-center gap-2">
                  <input type="checkbox" checked={skipInstantly} onChange={(e) => setSkipInstantly(e.target.checked)} />
                  <span>Skip Instantly side</span>
                </label>
              ) : null}
              {(op === "rename" || op === "swap" || op === "remove") ? (
                <label className="flex items-center gap-2">
                  <input type="checkbox" checked={skipSmartlead} onChange={(e) => setSkipSmartlead(e.target.checked)} />
                  <span>Skip Smartlead side</span>
                </label>
              ) : null}
              {op === "remove" ? (
                <label className="flex items-center gap-2">
                  <input type="checkbox" checked={skipM365} onChange={(e) => setSkipM365(e.target.checked)} />
                  <span>Skip M365 delete (only remove from ESPs)</span>
                </label>
              ) : null}
            </div>

            <Button onClick={() => void runExecute()} disabled={executeBusy} variant={cfg.destructive ? "destructive" : "default"}>
              {executeBusy ? (
                <><Loader2 className="mr-2 h-4 w-4 animate-spin" />Running… (may take several minutes)</>
              ) : (
                dryRun ? "Run dry-run" : `Execute ${op}`
              )}
            </Button>
            {executeError ? (
              <p className="mt-3 rounded border border-rose-200 bg-rose-50 px-3 py-2 text-sm text-rose-800">
                {executeError}
              </p>
            ) : null}
          </CardContent>
        </Card>
      ) : null}

      {/* STEP 5: results */}
      {results ? (
        <Card>
          <CardHeader>
            <CardTitle className="text-base flex items-center gap-2">
              <CheckCircle2 className="h-4 w-4 text-emerald-700" />
              5. Results
            </CardTitle>
          </CardHeader>
          <CardContent>
            <p className="mb-3 text-sm">
              <b>{results.filter((r) => r.state === "succeeded").length}</b> succeeded,{" "}
              <b className="text-rose-700">{results.filter((r) => r.state === "failed").length}</b> failed,{" "}
              <b className="text-amber-700">{results.filter((r) => r.state === "partial").length}</b> partial,{" "}
              <b className="text-muted-foreground">{results.filter((r) => r.state === "skipped").length}</b> skipped
            </p>
            <div className="max-h-[600px] overflow-y-auto">
              <table className="w-full text-xs">
                <thead className="sticky top-0 bg-card">
                  <tr className="border-b text-left">
                    <th className="px-2 py-2">email</th>
                    <th className="px-2 py-2">state</th>
                    <th className="px-2 py-2">steps</th>
                  </tr>
                </thead>
                <tbody>
                  {results.map((r, i) => (
                    <tr key={i} className="border-b align-top">
                      <td className="px-2 py-2 font-mono">{r.email}</td>
                      <td className="px-2 py-2">
                        <Badge className={
                          r.state === "succeeded" ? "bg-emerald-100 text-emerald-900 border-emerald-200" :
                          r.state === "failed" ? "bg-rose-100 text-rose-900 border-rose-200" :
                          r.state === "partial" ? "bg-amber-100 text-amber-900 border-amber-200" :
                          "bg-muted text-muted-foreground border-muted"
                        }>{r.state}</Badge>
                      </td>
                      <td className="px-2 py-2">
                        <ul className="space-y-0.5">
                          {r.steps.map((s, j) => (
                            <li key={j} className="flex gap-2">
                              <span>{s.ok ? "✓" : "✗"}</span>
                              <span>{s.name}</span>
                              {s.detail ? <span className="text-muted-foreground">— {s.detail}</span> : null}
                            </li>
                          ))}
                        </ul>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="mt-4 flex gap-2">
              <Button size="sm" variant="outline" onClick={() => router.push("/services")}>
                Back to services
              </Button>
              <Button size="sm" variant="ghost" onClick={() => { setResults(null); setPreview(null); setCsvText(""); setCsvFileName(""); }}>
                Run another batch
              </Button>
            </div>
          </CardContent>
        </Card>
      ) : null}
    </div>
  );
}

function PreviewTable({ preview, cfg }: { preview: PreviewResponse; cfg: typeof OP_CONFIG[string] }) {
  return (
    <>
      <p className="mb-2 text-sm">
        {preview.summary.total} row(s) parsed • {preview.summary.resolvable} resolvable •{" "}
        {preview.summary.missing > 0 ? <span className="text-rose-700">{preview.summary.missing} missing</span> : "0 missing"}
        {preview.summary.warnings_total > 0 ? <span className="text-amber-700"> • {preview.summary.warnings_total} warning(s)</span> : null}
      </p>
      <div className="max-h-96 overflow-y-auto rounded border">
        <table className="w-full text-xs">
          <thead className="sticky top-0 bg-muted/50">
            <tr className="text-left">
              {cfg.previewCols.map((c) => <th key={c} className="px-2 py-2">{c}</th>)}
            </tr>
          </thead>
          <tbody>
            {preview.rows.map((r, i) => (
              <tr key={i} className="border-t align-top">
                {cfg.previewCols.map((c) => (
                  <td key={c} className="px-2 py-2 font-mono">
                    {c === "email" || c === "old email" ? r.email :
                     c === "new email" ? (r.new_email || "") :
                     c === "current name" ? (r.currentDisplayName || (r.resolvable ? "" : <span className="text-rose-700">user not found</span>)) :
                     c === "new name" ? (r.new_display_name || "") :
                     c === "warnings" ? (
                       r.warnings.length === 0 ? <span className="text-muted-foreground">—</span> :
                       <span className="text-amber-700">{r.warnings.join("; ")}</span>
                     ) : ""}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}
