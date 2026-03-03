"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";
import { CheckCircle2, CircleAlert, Clock3, Download, KeyRound, RefreshCcw, XCircle } from "lucide-react";

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Progress } from "@/components/ui/progress";

type BatchStatus = "uploading" | "processing" | "completed" | "failed";
type TenantStatus = "queued" | "cloudflare" | "tenant_prep" | "auth_pending" | "mailboxes" | "completed" | "failed";

type BatchPayload = {
  batch: {
    id: string;
    status: BatchStatus;
    totalCount: number;
    completedCount: number;
    createdAt: string;
  };
  tenants: Array<{
    id: string;
    tenantName: string;
    domain: string;
    status: TenantStatus;
    progress: number;
    currentStep: string | null;
    authCode: string | null;
    authCodeExpiry: string | null;
    csvUrl: string | null;
    errorMessage: string | null;
    setupConfirmed: boolean;
  }>;
};

type PageProps = {
  params: {
    id: string;
  };
};

function statusDisplay(status: TenantStatus): string {
  switch (status) {
    case "queued":
      return "Queued";
    case "cloudflare":
      return "Configuring Cloudflare";
    case "tenant_prep":
      return "Tenant Prep";
    case "auth_pending":
      return "Awaiting Auth";
    case "mailboxes":
      return "Creating Mailboxes";
    case "completed":
      return "Completed";
    case "failed":
      return "Failed";
    default:
      return status;
  }
}

function statusClasses(status: TenantStatus): string {
  switch (status) {
    case "queued":
      return "bg-slate-100 text-slate-800 border-slate-200";
    case "cloudflare":
    case "tenant_prep":
    case "mailboxes":
      return "bg-blue-100 text-blue-800 border-blue-200";
    case "auth_pending":
      return "bg-amber-100 text-amber-900 border-amber-200";
    case "completed":
      return "bg-emerald-100 text-emerald-900 border-emerald-200";
    case "failed":
      return "bg-rose-100 text-rose-900 border-rose-200";
    default:
      return "bg-slate-100 text-slate-800 border-slate-200";
  }
}

function formatEta(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds <= 0) return "0m";
  const mins = Math.floor(seconds / 60);
  const hrs = Math.floor(mins / 60);
  const remMins = mins % 60;
  if (hrs > 0) return `${hrs}h ${remMins}m`;
  return `${Math.max(1, mins)}m`;
}

export default function BatchPage({ params }: PageProps) {
  const [data, setData] = useState<BatchPayload | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [actionBusy, setActionBusy] = useState<Record<string, boolean>>({});

  const fetchBatch = useCallback(async () => {
    try {
      const response = await fetch(`/api/batch/${params.id}`, { cache: "no-store" });
      const payload = (await response.json()) as BatchPayload & { error?: string };

      if (!response.ok) {
        throw new Error(payload.error || "Failed to load batch");
      }

      setData(payload);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unknown error");
    } finally {
      setLoading(false);
    }
  }, [params.id]);

  useEffect(() => {
    void fetchBatch();
  }, [fetchBatch]);

  const isTerminal = data?.batch.status === "completed" || data?.batch.status === "failed";

  useEffect(() => {
    if (!data || isTerminal) return;

    const timer = setInterval(() => {
      void fetchBatch();
    }, 2000);

    return () => clearInterval(timer);
  }, [data, fetchBatch, isTerminal]);

  const counts = useMemo(() => {
    if (!data) return { completed: 0, failed: 0, inProgress: 0 };
    const completed = data.tenants.filter((tenant) => tenant.status === "completed").length;
    const failed = data.tenants.filter((tenant) => tenant.status === "failed").length;
    const inProgress = data.tenants.filter((tenant) => ["cloudflare", "tenant_prep", "mailboxes"].includes(tenant.status)).length;
    return { completed, failed, inProgress };
  }, [data]);

  const overallPercent = useMemo(() => {
    if (!data || data.batch.totalCount === 0) return 0;
    return Math.round((data.batch.completedCount / data.batch.totalCount) * 100);
  }, [data]);

  const etaLabel = useMemo(() => {
    if (!data) return "Calculating...";
    if (data.batch.completedCount === 0) return "Calculating...";

    const elapsedSec = (Date.now() - new Date(data.batch.createdAt).getTime()) / 1000;
    const avgPerTenant = elapsedSec / data.batch.completedCount;
    const remaining = Math.max(0, data.batch.totalCount - data.batch.completedCount);
    return formatEta(avgPerTenant * remaining);
  }, [data]);

  const callTenantAction = async (tenantId: string, endpoint: string, body?: Record<string, boolean>) => {
    const key = `${tenantId}:${endpoint}`;
    setActionBusy((prev) => ({ ...prev, [key]: true }));

    try {
      const response = await fetch(`/api/tenant/${tenantId}/${endpoint}`, {
        method: "POST",
        headers: body ? { "Content-Type": "application/json" } : undefined,
        body: body ? JSON.stringify(body) : undefined
      });

      const payload = (await response.json()) as { error?: string };
      if (!response.ok) {
        throw new Error(payload.error || "Action failed");
      }

      await fetchBatch();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Action failed");
    } finally {
      setActionBusy((prev) => ({ ...prev, [key]: false }));
    }
  };

  if (loading) {
    return (
      <main className="mx-auto min-h-screen w-full max-w-6xl p-6 md:p-10">
        <Card>
          <CardContent className="p-10 text-sm text-muted-foreground">Loading batch...</CardContent>
        </Card>
      </main>
    );
  }

  if (!data) {
    return (
      <main className="mx-auto min-h-screen w-full max-w-6xl p-6 md:p-10">
        <Alert variant="destructive">
          <AlertTitle>Unable to load batch</AlertTitle>
          <AlertDescription>{error || "No response from server"}</AlertDescription>
        </Alert>
      </main>
    );
  }

  return (
    <main className="mx-auto min-h-screen w-full max-w-6xl p-6 md:p-10">
      <div className="mb-6 flex items-start justify-between gap-3">
        <div>
          <h1 className="text-3xl font-semibold tracking-tight">Batch {data.batch.id}</h1>
          <p className="text-sm text-muted-foreground">Auto-refresh every 2 seconds until batch reaches completed or failed.</p>
        </div>
        <div className="flex items-center gap-2">
          <Button variant="outline" onClick={() => void fetchBatch()}>
            <RefreshCcw className="mr-2 h-4 w-4" />
            Refresh
          </Button>
          <Button asChild variant="outline">
            <Link href="/">Back</Link>
          </Button>
        </div>
      </div>

      {error ? (
        <Alert variant="destructive" className="mb-6">
          <AlertTitle>Last action error</AlertTitle>
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      ) : null}

      <Card className="mb-6">
        <CardHeader>
          <CardTitle>Overall Progress</CardTitle>
          <CardDescription>Status: {data.batch.status}</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <Progress value={overallPercent} />
          <div className="flex flex-wrap items-center gap-2">
            <Badge className="bg-emerald-100 text-emerald-900 border-emerald-200">Completed: {counts.completed}</Badge>
            <Badge className="bg-blue-100 text-blue-900 border-blue-200">In Progress: {counts.inProgress}</Badge>
            <Badge className="bg-rose-100 text-rose-900 border-rose-200">Failed: {counts.failed}</Badge>
          </div>
          <div className="text-sm text-muted-foreground">
            {data.batch.completedCount} / {data.batch.totalCount} complete ({overallPercent}%) • ETA: {etaLabel}
          </div>
          {data.batch.status === "completed" ? (
            <Button asChild>
              <a href={`/api/batch/${data.batch.id}/download`}>
                <Download className="mr-2 h-4 w-4" />
                Download All CSVs
              </a>
            </Button>
          ) : null}
        </CardContent>
      </Card>

      <div className="grid gap-4">
        {data.tenants.map((tenant) => {
          const isBusy = (endpoint: string) => actionBusy[`${tenant.id}:${endpoint}`];

          return (
            <Card key={tenant.id}>
              <CardHeader>
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div>
                    <CardTitle className="text-xl">{tenant.domain}</CardTitle>
                    <CardDescription>
                      {tenant.tenantName} • {statusDisplay(tenant.status)}
                    </CardDescription>
                  </div>
                  <Badge className={statusClasses(tenant.status)}>{statusDisplay(tenant.status)}</Badge>
                </div>
              </CardHeader>
              <CardContent className="space-y-4">
                <div className="space-y-2">
                  <Progress value={tenant.progress} />
                  <p className="text-sm text-muted-foreground">
                    Progress: {tenant.progress}% • Step: {tenant.currentStep || "Waiting for next action"}
                  </p>
                </div>

                {tenant.status === "auth_pending" ? (
                  <div className="rounded-lg border border-amber-200 bg-amber-50 p-4">
                    <div className="mb-2 flex items-center gap-2 text-amber-900">
                      <KeyRound className="h-4 w-4" />
                      <span className="text-sm font-medium">Action Required</span>
                    </div>
                    <p className="text-sm text-amber-900">Go to Microsoft device login and enter this code:</p>
                    <p className="mt-2 text-2xl font-semibold tracking-[0.15em] text-amber-950">{tenant.authCode || "CODE_PENDING"}</p>
                    <a className="mt-2 inline-block text-sm underline" href="https://microsoft.com/devicelogin" target="_blank" rel="noreferrer">
                      Open microsoft.com/devicelogin
                    </a>
                    <div className="mt-3">
                      <Button
                        onClick={() => void callTenantAction(tenant.id, "confirm-auth", { confirmed: true })}
                        disabled={Boolean(isBusy("confirm-auth"))}
                      >
                        I&apos;ve Entered the Code
                      </Button>
                    </div>
                  </div>
                ) : null}

                {tenant.status === "completed" ? (
                  <div className="rounded-lg border border-emerald-200 bg-emerald-50 p-4">
                    <div className="mb-3 flex items-center gap-2 text-emerald-900">
                      <CheckCircle2 className="h-5 w-5" />
                      <span className="text-sm font-medium">Tenant setup complete</span>
                    </div>
                    <div className="flex flex-wrap items-center gap-3">
                      <Button asChild variant="outline">
                        <a href={`/api/tenant/${tenant.id}/csv`}>
                          <Download className="mr-2 h-4 w-4" />
                          Download CSV
                        </a>
                      </Button>
                      <label className="flex items-center gap-2 text-sm">
                        <input
                          type="checkbox"
                          checked={tenant.setupConfirmed}
                          onChange={(event) => {
                            if (event.target.checked) {
                              void callTenantAction(tenant.id, "confirm-complete", { confirmed: true });
                            }
                          }}
                        />
                        Confirm Setup Complete
                      </label>
                    </div>
                  </div>
                ) : null}

                {tenant.status === "failed" ? (
                  <div className="rounded-lg border border-rose-200 bg-rose-50 p-4">
                    <div className="mb-2 flex items-center gap-2 text-rose-900">
                      <XCircle className="h-5 w-5" />
                      <span className="text-sm font-medium">Tenant failed</span>
                    </div>
                    <p className="text-sm text-rose-900">{tenant.errorMessage || "No error message provided."}</p>
                    <div className="mt-3">
                      <Button
                        variant="outline"
                        onClick={() => void callTenantAction(tenant.id, "retry")}
                        disabled={Boolean(isBusy("retry"))}
                      >
                        Retry
                      </Button>
                    </div>
                  </div>
                ) : null}

                {tenant.status === "queued" ? (
                  <div className="flex items-center gap-2 rounded-lg border border-slate-200 bg-slate-50 p-3 text-sm text-slate-700">
                    <Clock3 className="h-4 w-4" />
                    Waiting in queue.
                  </div>
                ) : null}

                {["cloudflare", "tenant_prep", "mailboxes"].includes(tenant.status) ? (
                  <div className="flex items-center gap-2 rounded-lg border border-blue-200 bg-blue-50 p-3 text-sm text-blue-900">
                    <CircleAlert className="h-4 w-4" />
                    Processing in progress.
                  </div>
                ) : null}
              </CardContent>
            </Card>
          );
        })}
      </div>
    </main>
  );
}
