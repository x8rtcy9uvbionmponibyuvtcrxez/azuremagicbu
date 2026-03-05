"use client";

import Link from "next/link";
import { Fragment } from "react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { Download, RefreshCcw } from "lucide-react";

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { extractApiError, parseJsonResponse } from "@/lib/http-client";

type HistoryTenant = {
  id: string;
  tenantName: string;
  clientName: string;
  adminEmail: string;
  adminPassword: string;
  tenantId: string | null;
  domain: string;
  inboxNames: string[];
  status: string;
  progress: number;
  currentStep: string | null;
  inboxCount: number;
  forwardingUrl: string;
  csvUrl: string | null;
  createdAt: string;
  updatedAt: string;
  errorMessage: string | null;
};

type HistoryBatch = {
  id: string;
  status: string;
  totalCount: number;
  completedCount: number;
  createdAt: string;
  updatedAt: string;
  tenants: HistoryTenant[];
  totalInboxes: number;
  domains: string[];
};

const terminalTenantStatuses = new Set(["completed", "failed"]);

function formatDateTime(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? value
    : new Intl.DateTimeFormat(undefined, {
        year: "numeric",
        month: "short",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit"
      }).format(date);
}

function batchStatusClass(status: string): string {
  if (status === "completed") return "bg-emerald-100 text-emerald-900 border-emerald-200";
  if (status === "failed") return "bg-rose-100 text-rose-900 border-rose-200";
  return "bg-amber-100 text-amber-900 border-amber-200";
}

function tenantStatusClass(status: string): string {
  if (status === "completed") return "bg-emerald-100 text-emerald-900 border-emerald-200";
  if (status === "failed") return "bg-rose-100 text-rose-900 border-rose-200";
  if (status === "queued") return "bg-slate-100 text-slate-800 border-slate-200";
  if (status === "auth_pending") return "bg-amber-100 text-amber-900 border-amber-200";
  return "bg-blue-100 text-blue-900 border-blue-200";
}

function isBatchActive(batch: HistoryBatch): boolean {
  if (batch.status === "processing" || batch.status === "uploading") return true;
  return batch.tenants.some((tenant) => !terminalTenantStatuses.has(tenant.status));
}

export default function HistoryPage() {
  const [history, setHistory] = useState<HistoryBatch[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});

  const loadHistory = useCallback(async () => {
    try {
      const response = await fetch("/api/history", { cache: "no-store" });
      const payload = await parseJsonResponse<HistoryBatch[] & { error?: string; message?: string; details?: unknown }>(
        response
      );
      if (!response.ok) {
        throw new Error(extractApiError(payload, "Failed to load history"));
      }
      setHistory(Array.isArray(payload) ? payload : []);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load history");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadHistory();
  }, [loadHistory]);

  const hasActiveBatch = useMemo(() => history.some((batch) => isBatchActive(batch)), [history]);

  useEffect(() => {
    if (!hasActiveBatch) return;
    const timer = setInterval(() => {
      void loadHistory();
    }, 30000);
    return () => clearInterval(timer);
  }, [hasActiveBatch, loadHistory]);

  const stats = useMemo(() => {
    const totalBatches = history.length;
    const totalTenants = history.reduce((sum, batch) => sum + batch.tenants.length, 0);
    const totalInboxes = history.reduce((sum, batch) => sum + batch.totalInboxes, 0);
    const completedTenants = history.reduce(
      (sum, batch) => sum + batch.tenants.filter((tenant) => tenant.status === "completed").length,
      0
    );
    const successRate = totalTenants === 0 ? 0 : Math.round((completedTenants / totalTenants) * 100);

    return {
      totalBatches,
      totalTenants,
      totalInboxes,
      successRate
    };
  }, [history]);

  return (
    <main className="mx-auto min-h-screen w-full max-w-7xl p-6 md:p-10">
      <div className="mb-6 flex items-start justify-between gap-3">
        <div>
          <h1 className="text-3xl font-semibold tracking-tight">Batch History</h1>
          <p className="text-sm text-muted-foreground">
            All batches and tenant outcomes. Auto-refreshes every 30s while processing is active.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Button variant="outline" onClick={() => void loadHistory()}>
            <RefreshCcw className="mr-2 h-4 w-4" />
            Refresh
          </Button>
          <Button asChild variant="outline">
            <Link href="/">Back to Dashboard</Link>
          </Button>
        </div>
      </div>

      {error ? (
        <Alert variant="destructive" className="mb-6">
          <AlertTitle>Unable to load history</AlertTitle>
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      ) : null}

      <div className="mb-6 grid gap-4 md:grid-cols-2 xl:grid-cols-4">
        <Card>
          <CardHeader className="pb-2">
            <CardDescription>Total Batches</CardDescription>
            <CardTitle className="text-2xl">{stats.totalBatches}</CardTitle>
          </CardHeader>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardDescription>Total Tenants Processed</CardDescription>
            <CardTitle className="text-2xl">{stats.totalTenants}</CardTitle>
          </CardHeader>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardDescription>Total Inboxes Created</CardDescription>
            <CardTitle className="text-2xl">{stats.totalInboxes}</CardTitle>
          </CardHeader>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardDescription>Success Rate</CardDescription>
            <CardTitle className="text-2xl">{stats.successRate}%</CardTitle>
          </CardHeader>
        </Card>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>All Batches</CardTitle>
          <CardDescription>
            Columns: Date, Domains, Status, Tenants (completed/total), Total Inboxes, Actions.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {loading ? (
            <p className="text-sm text-muted-foreground">Loading history...</p>
          ) : history.length === 0 ? (
            <p className="text-sm text-muted-foreground">No batches found yet.</p>
          ) : (
            <div className="overflow-x-auto rounded-lg border">
              <table className="min-w-full text-sm">
                <thead className="bg-muted/60 text-left">
                  <tr>
                    <th className="px-3 py-2">Date</th>
                    <th className="px-3 py-2">Domains</th>
                    <th className="px-3 py-2">Status</th>
                    <th className="px-3 py-2">Tenants</th>
                    <th className="px-3 py-2">Total Inboxes</th>
                    <th className="px-3 py-2">Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {history.map((batch) => {
                    const completedTenants = batch.tenants.filter((tenant) => tenant.status === "completed").length;
                    const domainsLabel = batch.domains.length === 0 ? "-" : batch.domains.join(", ");
                    const isExpanded = Boolean(expanded[batch.id]);

                    return (
                      <Fragment key={batch.id}>
                        <tr key={batch.id} className="border-t align-top">
                          <td className="px-3 py-2">{formatDateTime(batch.createdAt)}</td>
                          <td className="max-w-md px-3 py-2">
                            <span className="line-clamp-2" title={domainsLabel}>
                              {domainsLabel}
                            </span>
                          </td>
                          <td className="px-3 py-2">
                            <Badge className={batchStatusClass(batch.status)}>{batch.status}</Badge>
                          </td>
                          <td className="px-3 py-2">
                            {completedTenants}/{batch.tenants.length || batch.totalCount}
                          </td>
                          <td className="px-3 py-2">{batch.totalInboxes}</td>
                          <td className="px-3 py-2">
                            <div className="flex flex-wrap items-center gap-2">
                              <Button asChild size="sm" variant="outline">
                                <Link href={`/batch/${batch.id}`}>View Batch</Link>
                              </Button>
                              <Button
                                type="button"
                                size="sm"
                                variant="ghost"
                                onClick={() =>
                                  setExpanded((prev) => ({
                                    ...prev,
                                    [batch.id]: !prev[batch.id]
                                  }))
                                }
                              >
                                {isExpanded ? "Hide Details" : "Show Details"}
                              </Button>
                            </div>
                          </td>
                        </tr>
                        {isExpanded ? (
                          <tr className="border-t bg-muted/20">
                            <td className="px-3 py-3" colSpan={6}>
                              <div className="overflow-x-auto rounded-md border bg-background">
                                <table className="min-w-full text-xs md:text-sm">
                                  <thead className="bg-muted/50 text-left">
                                    <tr>
                                      <th className="px-3 py-2">Tenant</th>
                                      <th className="px-3 py-2">Domain</th>
                                      <th className="px-3 py-2">Submitted Input</th>
                                      <th className="px-3 py-2">Status</th>
                                      <th className="px-3 py-2">Progress</th>
                                      <th className="px-3 py-2">Current Step</th>
                                      <th className="px-3 py-2">Error</th>
                                      <th className="px-3 py-2">Actions</th>
                                    </tr>
                                  </thead>
                                  <tbody>
                                    {batch.tenants.map((tenant) => (
                                      <tr key={tenant.id} className="border-t align-top">
                                        <td className="px-3 py-2">
                                          <div className="font-medium">{tenant.tenantName}</div>
                                          <div className="text-[11px] text-muted-foreground">
                                            Updated {formatDateTime(tenant.updatedAt)}
                                          </div>
                                        </td>
                                        <td className="px-3 py-2">{tenant.domain || "-"}</td>
                                        <td className="max-w-lg px-3 py-2 text-[11px] text-muted-foreground">
                                          <div>
                                            <span className="font-medium text-foreground">Client:</span>{" "}
                                            <span>{tenant.clientName || "—"}</span>
                                          </div>
                                          <div>
                                            <span className="font-medium text-foreground">Admin:</span>{" "}
                                            <span>{tenant.adminEmail || "—"}</span>
                                          </div>
                                          <div>
                                            <span className="font-medium text-foreground">Password:</span>{" "}
                                            <code className="rounded bg-muted px-1 py-0.5 text-[10px] text-foreground">
                                              {tenant.adminPassword || "—"}
                                            </code>
                                          </div>
                                          <div>
                                            <span className="font-medium text-foreground">Tenant ID:</span>{" "}
                                            <span>{tenant.tenantId || "—"}</span>
                                          </div>
                                          <div>
                                            <span className="font-medium text-foreground">Forwarding URL:</span>{" "}
                                            {tenant.forwardingUrl ? (
                                              <a
                                                className="text-blue-700 underline underline-offset-2"
                                                href={tenant.forwardingUrl}
                                                rel="noreferrer"
                                                target="_blank"
                                              >
                                                {tenant.forwardingUrl}
                                              </a>
                                            ) : (
                                              "—"
                                            )}
                                          </div>
                                          <div>
                                            <span className="font-medium text-foreground">Inbox Count:</span>{" "}
                                            <span>{tenant.inboxCount}</span>
                                          </div>
                                          <div>
                                            <span className="font-medium text-foreground">Inbox Names:</span>{" "}
                                            <span>{tenant.inboxNames.length ? tenant.inboxNames.join(", ") : "—"}</span>
                                          </div>
                                        </td>
                                        <td className="px-3 py-2">
                                          <Badge className={tenantStatusClass(tenant.status)}>{tenant.status}</Badge>
                                        </td>
                                        <td className="px-3 py-2">{tenant.progress}%</td>
                                        <td className="max-w-sm px-3 py-2 text-muted-foreground">
                                          {tenant.currentStep || "—"}
                                        </td>
                                        <td className="max-w-sm px-3 py-2 text-rose-700">
                                          {tenant.errorMessage || "—"}
                                        </td>
                                        <td className="px-3 py-2">
                                          {tenant.status === "completed" ? (
                                            <Button asChild size="sm" variant="outline">
                                              <a href={`/api/tenant/${tenant.id}/csv`}>
                                                <Download className="mr-1 h-3 w-3" />
                                                Download CSV
                                              </a>
                                            </Button>
                                          ) : (
                                            <span className="text-muted-foreground">—</span>
                                          )}
                                        </td>
                                      </tr>
                                    ))}
                                  </tbody>
                                </table>
                              </div>
                            </td>
                          </tr>
                        ) : null}
                      </Fragment>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>
    </main>
  );
}
