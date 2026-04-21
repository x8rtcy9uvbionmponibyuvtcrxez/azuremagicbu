"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";
import { CheckCircle2, CircleAlert, Clock3, Copy, Download, ExternalLink, RefreshCcw, XCircle } from "lucide-react";

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Progress } from "@/components/ui/progress";
import { extractApiError, parseJsonResponse } from "@/lib/http-client";

type BatchStatus = "uploading" | "processing" | "completed" | "failed";
type TenantStatus =
  | "queued"
  | "cloudflare"
  | "tenant_prep"
  | "auth_pending"
  | "domain_add"
  | "domain_verify"
  | "licensed_user"
  | "mailboxes"
  | "mailbox_config"
  | "dkim_config"
  | "sequencer_connect"
  | "completed"
  | "failed";

const processingStatuses = new Set<TenantStatus>([
  "cloudflare",
  "tenant_prep",
  "domain_add",
  "domain_verify",
  "licensed_user",
  "mailboxes",
  "mailbox_config",
  "dkim_config",
  "sequencer_connect"
]);

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
    clientName: string;
    domain: string;
    adminEmail: string;
    adminPassword: string;
    status: TenantStatus;
    progress: number;
    currentStep: string | null;
    authCode: string | null;
    authCodeExpiry: string | null;
    authConfirmed: boolean;
    csvUrl: string | null;
    errorMessage: string | null;
    setupConfirmed: boolean;
    createdAt: string;
    updatedAt: string;
  }>;
};

type PageProps = {
  params: {
    id: string;
  };
};

type BatchEvent = {
  id: string;
  batchId: string;
  tenantId: string | null;
  level: string;
  eventType: string;
  message: string;
  details: unknown;
  createdAt: string;
  tenant: {
    id: string;
    tenantName: string;
    clientName: string;
    domain: string;
    tenantId: string | null;
  } | null;
};

type EventFilterKey =
  | "all"
  | "errors"
  | "retries"
  | "auth"
  | "domain"
  | "mailboxes"
  | "dkim"
  | "integration"
  | "worker"
  | "submission"
  | "other";

type EventPhaseTag = "auth" | "domain" | "mailboxes" | "dkim" | "integration" | "retry" | "submission" | "worker" | "error" | "other";
type AutoRetryWaitState = {
  startedAtMs: number;
  totalMs: number;
  reason: string;
  bufferMultiplier: number | null;
};

const eventFilterOptions: Array<{ key: EventFilterKey; label: string }> = [
  { key: "all", label: "All" },
  { key: "errors", label: "Errors" },
  { key: "retries", label: "Retries" },
  { key: "auth", label: "Auth" },
  { key: "domain", label: "Domain" },
  { key: "mailboxes", label: "Mailboxes" },
  { key: "dkim", label: "DKIM" },
  { key: "integration", label: "Integration" },
  { key: "worker", label: "Worker" },
  { key: "submission", label: "Submission" },
  { key: "other", label: "Other" }
];

function readNumericDetail(details: unknown, key: string): number | null {
  if (!details || typeof details !== "object") return null;
  const value = (details as Record<string, unknown>)[key];
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

function extractRetryAfterMs(details: unknown): number | null {
  const value = readNumericDetail(details, "retryAfterMs");
  if (!value || value <= 0) return null;
  return value;
}

function extractBufferMultiplier(details: unknown): number | null {
  const value = readNumericDetail(details, "bufferMultiplier");
  if (!value || value < 1) return null;
  return value;
}

function formatDurationMs(ms: number): string {
  const safeMs = Math.max(0, Math.round(ms));
  const totalSeconds = Math.ceil(safeMs / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}m ${seconds.toString().padStart(2, "0")}s`;
}

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
    case "domain_add":
      return "Adding Domain";
    case "domain_verify":
      return "Verifying Domain";
    case "licensed_user":
      return "Creating Licensed User";
    case "mailbox_config":
      return "Configuring Mailboxes";
    case "dkim_config":
      return "Configuring DKIM";
    case "sequencer_connect":
      return "Connecting Sequencer";
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
    case "domain_add":
    case "domain_verify":
    case "licensed_user":
    case "mailboxes":
    case "mailbox_config":
    case "dkim_config":
    case "sequencer_connect":
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

function formatCountdown(expiry: string | null): string {
  if (!expiry) return "No expiry";
  const remaining = new Date(expiry).getTime() - Date.now();
  if (!Number.isFinite(remaining) || remaining <= 0) return "Expired";
  const totalSeconds = Math.floor(remaining / 1000);
  const mins = Math.floor(totalSeconds / 60);
  const secs = totalSeconds % 60;
  return `${mins}m ${secs.toString().padStart(2, "0")}s`;
}

function parseStepCounter(step: string | null): { current: number; total: number } | null {
  if (!step) return null;
  const match = step.match(/(\d+)\s*\/\s*(\d+)/);
  if (!match) return null;

  const current = Number.parseInt(match[1], 10);
  const total = Number.parseInt(match[2], 10);
  if (!Number.isFinite(current) || !Number.isFinite(total) || total <= 0) return null;

  return {
    current: Math.max(0, Math.min(current, total)),
    total
  };
}

function formatTimestamp(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit"
  }).format(date);
}

function formatEventTime(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat(undefined, {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false
  }).format(date);
}

function CopyButton({ value, label, mask = false }: { value: string; label?: string; mask?: boolean }) {
  const [copied, setCopied] = useState(false);
  const display = mask ? "••••••••" : value || "—";
  const disabled = !value;

  const onClick = async () => {
    if (!value) return;
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      setTimeout(() => setCopied(false), 1200);
    } catch {
      // no-op; browser may block clipboard without user gesture
    }
  };

  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className="group inline-flex items-center gap-1.5 rounded px-1.5 py-0.5 font-mono text-xs hover:bg-slate-100 disabled:opacity-50"
      title={copied ? "Copied" : label ? `Copy ${label}` : "Copy"}
    >
      <span className={mask ? "tracking-widest" : "truncate max-w-[220px]"}>{display}</span>
      {copied ? (
        <span className="text-emerald-600">Copied</span>
      ) : (
        <Copy className="h-3 w-3 text-slate-400 group-hover:text-slate-700" />
      )}
    </button>
  );
}

function levelBadgeClass(level: string): string {
  if (level === "error") return "bg-rose-100 text-rose-900 border-rose-200";
  if (level === "warn") return "bg-amber-100 text-amber-900 border-amber-200";
  return "bg-blue-100 text-blue-900 border-blue-200";
}

function summarizeDetails(details: unknown): string {
  if (!details) return "";
  if (typeof details === "string") return details;
  try {
    return JSON.stringify(details);
  } catch {
    return String(details);
  }
}

function inferEventTags(event: BatchEvent): EventPhaseTag[] {
  const tags = new Set<EventPhaseTag>();
  const text = `${event.eventType} ${event.message}`.toLowerCase();

  if (event.level === "error" || text.includes("failed") || text.includes("error")) {
    tags.add("error");
  }
  if (event.eventType === "retry_requested") {
    tags.add("retry");
  }
  if (event.eventType === "csv_submitted") {
    tags.add("submission");
  }
  if (event.eventType.startsWith("auth_") || event.eventType === "processing_blocked") {
    tags.add("auth");
  }
  if (text.includes("domain")) {
    tags.add("domain");
  }
  if (text.includes("mailbox")) {
    tags.add("mailboxes");
  }
  if (text.includes("dkim")) {
    tags.add("dkim");
  }
  if (text.includes("smartlead") || text.includes("instantly") || text.includes("integration") || text.includes("sequencer")) {
    tags.add("integration");
  }
  if (
    event.eventType === "worker_started" ||
    event.eventType === "worker_failed" ||
    event.eventType === "phase_start" ||
    event.eventType === "phase_complete" ||
    event.eventType === "phase_failed" ||
    event.eventType === "tenant_completed" ||
    event.eventType === "test_mode_path"
  ) {
    tags.add("worker");
  }

  if (tags.size === 0) {
    tags.add("other");
  }

  return Array.from(tags);
}

function tagBadgeClass(tag: EventPhaseTag): string {
  switch (tag) {
    case "error":
      return "bg-rose-100 text-rose-900 border-rose-200";
    case "retry":
      return "bg-amber-100 text-amber-900 border-amber-200";
    case "auth":
      return "bg-sky-100 text-sky-900 border-sky-200";
    case "domain":
      return "bg-indigo-100 text-indigo-900 border-indigo-200";
    case "mailboxes":
      return "bg-violet-100 text-violet-900 border-violet-200";
    case "dkim":
      return "bg-cyan-100 text-cyan-900 border-cyan-200";
    case "integration":
      return "bg-emerald-100 text-emerald-900 border-emerald-200";
    case "worker":
      return "bg-slate-100 text-slate-900 border-slate-200";
    case "submission":
      return "bg-lime-100 text-lime-900 border-lime-200";
    default:
      return "bg-zinc-100 text-zinc-900 border-zinc-200";
  }
}

function tagLabel(tag: EventPhaseTag): string {
  switch (tag) {
    case "dkim":
      return "DKIM";
    default:
      return tag.charAt(0).toUpperCase() + tag.slice(1);
  }
}

export default function BatchPage({ params }: PageProps) {
  const [data, setData] = useState<BatchPayload | null>(null);
  const [events, setEvents] = useState<BatchEvent[]>([]);
  const [nowMs, setNowMs] = useState(() => Date.now());
  const [selectedEventFilter, setSelectedEventFilter] = useState<EventFilterKey>("all");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [eventsError, setEventsError] = useState<string | null>(null);
  const [actionBusy, setActionBusy] = useState<Record<string, boolean>>({});
  const [retryStatusByTenant, setRetryStatusByTenant] = useState<Record<string, string>>({});
  const [batchActionBusy, setBatchActionBusy] = useState<Record<string, boolean>>({});

  const fetchBatch = useCallback(async () => {
    try {
      const response = await fetch(`/api/batch/${params.id}`, { cache: "no-store" });
      const payload = await parseJsonResponse<BatchPayload & { error?: string; message?: string }>(response);

      if (!response.ok) {
        throw new Error(extractApiError(payload, "Failed to load batch"));
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

  const fetchEvents = useCallback(async () => {
    try {
      const response = await fetch(`/api/batch/${params.id}/events?limit=400`, { cache: "no-store" });
      const payload = await parseJsonResponse<{ events?: BatchEvent[]; error?: string; message?: string }>(response);
      if (!response.ok) {
        throw new Error(extractApiError(payload, "Failed to load activity log"));
      }
      setEvents(Array.isArray(payload.events) ? payload.events : []);
      setEventsError(null);
    } catch (err) {
      setEventsError(err instanceof Error ? err.message : "Failed to load activity log");
    }
  }, [params.id]);

  useEffect(() => {
    void fetchEvents();
  }, [fetchEvents]);

  useEffect(() => {
    const timer = setInterval(() => {
      setNowMs(Date.now());
    }, 1000);
    return () => clearInterval(timer);
  }, []);

  const isTerminal = data?.batch.status === "completed" || data?.batch.status === "failed";

  useEffect(() => {
    if (!data || isTerminal) return;

    const timer = setInterval(() => {
      void fetchBatch();
      void fetchEvents();
    }, 2000);

    return () => clearInterval(timer);
  }, [data, fetchBatch, fetchEvents, isTerminal]);

  const counts = useMemo(() => {
    if (!data) return { completed: 0, failed: 0, inProgress: 0, queued: 0, remaining: 0 };
    const completed = data.tenants.filter((tenant) => tenant.status === "completed").length;
    const failed = data.tenants.filter((tenant) => tenant.status === "failed").length;
    const inProgress = data.tenants.filter((tenant) => processingStatuses.has(tenant.status)).length;
    const queued = data.tenants.filter((tenant) => tenant.status === "queued").length;
    const remaining = data.tenants.filter((tenant) => !["completed", "failed"].includes(tenant.status)).length;
    return { completed, failed, inProgress, queued, remaining };
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

  const fixedEtaLabel = useMemo(() => formatEta(counts.remaining * 20 * 60), [counts.remaining]);

  const authGridTenants = useMemo(() => {
    if (!data) return [];
    return data.tenants.filter((tenant) => tenant.status === "auth_pending" || Boolean(tenant.authCode));
  }, [data]);

  const showAuthGrid = useMemo(() => {
    if (!data) return false;
    if (data.batch.status === "completed" || data.batch.status === "failed") return false;
    // Keep the grid visible whenever any tenant still needs (or has) an auth code —
    // even after batch.status flips to "processing" from per-tenant retries.
    return authGridTenants.length > 0 || data.tenants.some((t) => !["completed", "failed"].includes(t.status) && !t.authConfirmed);
  }, [data, authGridTenants]);

  const queuedPositions = useMemo(() => {
    if (!data) return new Map<string, number>();
    const map = new Map<string, number>();
    let position = 1;
    data.tenants
      .filter((tenant) => tenant.status === "queued")
      .forEach((tenant) => {
        map.set(tenant.id, position);
        position += 1;
      });
    return map;
  }, [data]);

  const currentTenant = useMemo(() => {
    if (!data) return null;
    return data.tenants.find((tenant) => processingStatuses.has(tenant.status)) || null;
  }, [data]);

  const isSingleTenant = data?.batch.totalCount === 1 && (data?.tenants.length ?? 0) <= 1;
  const singleTenant = isSingleTenant ? data?.tenants[0] ?? null : null;

  const taggedEvents = useMemo(() => events.map((event) => ({ event, tags: inferEventTags(event) })), [events]);

  const autoRetryWaitByTenant = useMemo(() => {
    const waits = new Map<string, AutoRetryWaitState>();
    const resolvedTenants = new Set<string>();

    for (let index = events.length - 1; index >= 0; index -= 1) {
      const event = events[index];
      if (!event.tenantId) continue;
      if (resolvedTenants.has(event.tenantId)) continue;

      if (
        event.eventType === "worker_started" ||
        event.eventType === "retry_requested" ||
        event.eventType === "phase_start" ||
        event.eventType === "phase_complete" ||
        event.eventType === "phase_failed" ||
        event.eventType === "tenant_completed"
      ) {
        resolvedTenants.add(event.tenantId);
        continue;
      }

      if (event.eventType !== "phase_warning") continue;

      const retryAfterMs = extractRetryAfterMs(event.details);
      if (!retryAfterMs) continue;

      const startedAtMs = new Date(event.createdAt).getTime();
      if (!Number.isFinite(startedAtMs)) continue;

      waits.set(event.tenantId, {
        startedAtMs,
        totalMs: retryAfterMs,
        reason: event.message,
        bufferMultiplier: extractBufferMultiplier(event.details)
      });
      resolvedTenants.add(event.tenantId);
    }

    return waits;
  }, [events]);

  const eventFilterCounts = useMemo(() => {
    const counts: Record<EventFilterKey, number> = {
      all: taggedEvents.length,
      errors: 0,
      retries: 0,
      auth: 0,
      domain: 0,
      mailboxes: 0,
      dkim: 0,
      integration: 0,
      worker: 0,
      submission: 0,
      other: 0
    };

    for (const item of taggedEvents) {
      if (item.tags.includes("error")) counts.errors += 1;
      if (item.tags.includes("retry")) counts.retries += 1;
      if (item.tags.includes("auth")) counts.auth += 1;
      if (item.tags.includes("domain")) counts.domain += 1;
      if (item.tags.includes("mailboxes")) counts.mailboxes += 1;
      if (item.tags.includes("dkim")) counts.dkim += 1;
      if (item.tags.includes("integration")) counts.integration += 1;
      if (item.tags.includes("worker")) counts.worker += 1;
      if (item.tags.includes("submission")) counts.submission += 1;
      if (item.tags.includes("other")) counts.other += 1;
    }

    return counts;
  }, [taggedEvents]);

  const filteredEvents = useMemo(() => {
    const matches = (tags: EventPhaseTag[]) => {
      switch (selectedEventFilter) {
        case "all":
          return true;
        case "errors":
          return tags.includes("error");
        case "retries":
          return tags.includes("retry");
        case "auth":
          return tags.includes("auth");
        case "domain":
          return tags.includes("domain");
        case "mailboxes":
          return tags.includes("mailboxes");
        case "dkim":
          return tags.includes("dkim");
        case "integration":
          return tags.includes("integration");
        case "worker":
          return tags.includes("worker");
        case "submission":
          return tags.includes("submission");
        case "other":
          return tags.includes("other");
        default:
          return true;
      }
    };

    return taggedEvents
      .filter((item) => matches(item.tags))
      .slice()
      .reverse();
  }, [selectedEventFilter, taggedEvents]);

  const callTenantAction = async (tenantId: string, endpoint: string, body?: Record<string, boolean>) => {
    const key = `${tenantId}:${endpoint}`;
    setActionBusy((prev) => ({ ...prev, [key]: true }));

    try {
      const response = await fetch(`/api/tenant/${tenantId}/${endpoint}`, {
        method: "POST",
        headers: body ? { "Content-Type": "application/json" } : undefined,
        body: body ? JSON.stringify(body) : undefined
      });

      const payload = await parseJsonResponse<{ error?: string; message?: string; details?: unknown; restartStatus?: string }>(
        response
      );
      if (!response.ok) {
        throw new Error(extractApiError(payload, "Action failed"));
      }

      if (endpoint === "retry" && payload.restartStatus) {
        setRetryStatusByTenant((prev) => ({ ...prev, [tenantId]: payload.restartStatus as string }));
      }

      await fetchBatch();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Action failed");
    } finally {
      setActionBusy((prev) => ({ ...prev, [key]: false }));
    }
  };

  const callBatchAction = async (endpoint: "generate-all-codes" | "start-processing" | "cancel") => {
    setBatchActionBusy((prev) => ({ ...prev, [endpoint]: true }));
    try {
      const response = await fetch(`/api/batch/${params.id}/${endpoint}`, {
        method: "POST"
      });
      const payload = await parseJsonResponse<{
        error?: string;
        message?: string;
        details?: unknown;
        notReady?: Array<{ tenantName?: string; error?: string }>;
      }>(response);
      if (!response.ok) {
        const baseMessage = extractApiError(payload, "Batch action failed");
        const notReadyMessage =
          payload.notReady && payload.notReady.length > 0
            ? ` (${payload.notReady.map((item) => `${item.tenantName || "tenant"}: ${item.error || "pending"}`).join(" | ")})`
            : "";
        throw new Error(baseMessage + notReadyMessage);
      }
      await fetchBatch();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Batch action failed");
    } finally {
      setBatchActionBusy((prev) => ({ ...prev, [endpoint]: false }));
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
          <h1 className="text-3xl font-semibold tracking-tight">
            {isSingleTenant ? `Tenant Setup ${singleTenant?.domain ? `for ${singleTenant.domain}` : ""}`.trim() : `Batch ${data.batch.id}`}
          </h1>
          <p className="text-sm text-muted-foreground">
            {isSingleTenant
              ? "Auto-refresh every 2 seconds while setup is in progress."
              : "Auto-refresh every 2 seconds until batch reaches completed or failed."}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Button
            variant="outline"
            onClick={async () => {
              await Promise.all([fetchBatch(), fetchEvents()]);
            }}
          >
            <RefreshCcw className="mr-2 h-4 w-4" />
            Refresh
          </Button>
          {data.batch.status !== "completed" && data.batch.status !== "failed" ? (
            <Button
              variant="outline"
              className="border-rose-300 text-rose-700 hover:bg-rose-50"
              disabled={Boolean(batchActionBusy["cancel"])}
              onClick={() => {
                if (window.confirm("Cancel this run? All pending tenants will be marked failed.")) {
                  void callBatchAction("cancel");
                }
              }}
            >
              {batchActionBusy["cancel"] ? "Cancelling..." : "Cancel Run"}
            </Button>
          ) : null}
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

      {showAuthGrid ? (
        <Card className="mb-6">
          <CardHeader>
            <CardTitle>Device Authorization</CardTitle>
            <CardDescription>
              For each tenant: open the device login link, sign in with the admin credentials, enter the code, then click
              &ldquo;I&apos;ve Entered the Code&rdquo;. Each tenant processes independently.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="flex flex-wrap items-center gap-2">
              <Button
                onClick={() => void callBatchAction("generate-all-codes")}
                disabled={Boolean(batchActionBusy["generate-all-codes"])}
              >
                {batchActionBusy["generate-all-codes"] ? "Generating..." : isSingleTenant ? "Generate Code" : "Generate All Codes"}
              </Button>
              <a
                className="inline-flex items-center gap-1.5 text-sm font-medium text-blue-700 underline hover:text-blue-900"
                href="https://microsoft.com/devicelogin"
                target="_blank"
                rel="noreferrer"
              >
                Open microsoft.com/devicelogin <ExternalLink className="h-3.5 w-3.5" />
              </a>
            </div>

            {authGridTenants.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                No codes yet. Click {isSingleTenant ? "Generate Code" : "Generate All Codes"} to start.
              </p>
            ) : (
              <div className="overflow-x-auto rounded-md border">
                <table className="w-full text-sm">
                  <thead className="bg-slate-50 text-left text-xs uppercase tracking-wide text-slate-600">
                    <tr>
                      <th className="px-3 py-2">Tenant</th>
                      <th className="px-3 py-2">Code</th>
                      <th className="px-3 py-2">Admin email</th>
                      <th className="px-3 py-2">Password</th>
                      <th className="px-3 py-2">Expires</th>
                      <th className="px-3 py-2 text-right">Action</th>
                    </tr>
                  </thead>
                  <tbody>
                    {authGridTenants.map((tenant) => {
                      const isBusy = Boolean(actionBusy[`${tenant.id}:confirm-auth`]);
                      const isRetrying = Boolean(actionBusy[`${tenant.id}:retry`]);
                      const done = tenant.status !== "auth_pending";
                      return (
                        <tr key={tenant.id} className="border-t align-middle">
                          <td className="px-3 py-2">
                            <div className="font-medium">{tenant.domain}</div>
                            <div className="text-xs text-muted-foreground">
                              {tenant.clientName} • {tenant.tenantName}
                            </div>
                          </td>
                          <td className="px-3 py-2">
                            <CopyButton value={tenant.adminEmail} label="admin email" />
                          </td>
                          <td className="px-3 py-2">
                            <CopyButton value={tenant.adminPassword} label="password" mask />
                          </td>
                          <td className="px-3 py-2">
                            {tenant.authCode ? (
                              <CopyButton value={tenant.authCode} label="code" />
                            ) : (
                              <span className="text-xs text-muted-foreground">pending…</span>
                            )}
                          </td>
                          <td className="px-3 py-2 text-xs text-muted-foreground">
                            {formatCountdown(tenant.authCodeExpiry)}
                          </td>
                          <td className="px-3 py-2 text-right">
                            {done ? (
                              <Badge className={statusClasses(tenant.status)}>{statusDisplay(tenant.status)}</Badge>
                            ) : (
                              <div className="flex items-center justify-end gap-2">
                                <Button
                                  size="sm"
                                  variant="ghost"
                                  onClick={() => void callTenantAction(tenant.id, "retry")}
                                  disabled={isRetrying}
                                  title="Regenerate a fresh code"
                                >
                                  {isRetrying ? "…" : "New code"}
                                </Button>
                                <Button
                                  size="sm"
                                  onClick={() => void callTenantAction(tenant.id, "confirm-auth", { confirmed: true })}
                                  disabled={isBusy || !tenant.authCode}
                                >
                                  {isBusy ? "Checking…" : "I've Entered the Code"}
                                </Button>
                              </div>
                            )}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </CardContent>
        </Card>
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
            <Badge className="bg-slate-100 text-slate-900 border-slate-200">Queued: {counts.queued}</Badge>
            <Badge className="bg-rose-100 text-rose-900 border-rose-200">Failed: {counts.failed}</Badge>
          </div>
          <div className="text-sm text-muted-foreground">
            {data.batch.completedCount} / {data.batch.totalCount} complete ({overallPercent}%) • ETA: {etaLabel}
          </div>
          <div className="text-sm text-muted-foreground">ETA (20m/tenant): {fixedEtaLabel}</div>
          <div className="text-sm text-muted-foreground">
            Current tenant: {currentTenant ? `${currentTenant.tenantName} (${currentTenant.domain})` : "Waiting for queue"}
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

      <Card className="mb-6">
        <CardHeader>
          <CardTitle>Activity Log</CardTitle>
          <CardDescription>
            Timeline of submissions, auth, processing, retries, and errors for this {isSingleTenant ? "tenant" : "batch"}.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {eventsError ? <p className="text-sm text-rose-700">{eventsError}</p> : null}
          {events.length === 0 ? (
            <p className="text-sm text-muted-foreground">No activity events yet.</p>
          ) : (
            <div className="space-y-3">
              <div className="flex flex-wrap items-center gap-2">
                {eventFilterOptions.map((option) => {
                  const active = selectedEventFilter === option.key;
                  const count = eventFilterCounts[option.key];
                  return (
                    <Button
                      key={option.key}
                      size="sm"
                      variant={active ? "default" : "outline"}
                      className={active ? "" : "h-7 px-2 text-xs"}
                      onClick={() => setSelectedEventFilter(option.key)}
                    >
                      {option.label} ({count})
                    </Button>
                  );
                })}
              </div>

              <div className="max-h-96 overflow-auto rounded-lg border">
              <table className="min-w-full text-xs md:text-sm">
                <thead className="bg-muted/50 text-left">
                  <tr>
                    <th className="w-20 px-3 py-2">Time</th>
                    <th className="w-16 px-3 py-2">Level</th>
                    <th className="px-3 py-2">Tenant</th>
                    <th className="px-3 py-2">Event</th>
                  </tr>
                </thead>
                <tbody>
                  {filteredEvents.map(({ event }) => (
                    <tr key={event.id} className="border-t align-top">
                      <td className="whitespace-nowrap px-3 py-2 font-mono text-xs text-muted-foreground">{formatEventTime(event.createdAt)}</td>
                      <td className="px-3 py-2">
                        <Badge className={levelBadgeClass(event.level)}>{event.level}</Badge>
                      </td>
                      <td className="whitespace-nowrap px-3 py-2">
                        {event.tenant ? `${event.tenant.tenantName} • ${event.tenant.domain}` : "Batch"}
                      </td>
                      <td className="px-3 py-2">{event.message}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            </div>
          )}
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
                      {tenant.clientName} • {tenant.tenantName} • {statusDisplay(tenant.status)}
                    </CardDescription>
                  </div>
                  <Badge className={statusClasses(tenant.status)}>{statusDisplay(tenant.status)}</Badge>
                </div>
              </CardHeader>
              <CardContent className="space-y-4">
                <div className="space-y-2">
                  {(() => {
                    const stepLabel =
                      tenant.status === "auth_pending"
                        ? "Waiting for device code confirmation"
                        : tenant.currentStep || "Waiting for next action";
                    const stepCounter = parseStepCounter(stepLabel);
                    const waitState = autoRetryWaitByTenant.get(tenant.id) || null;
                    const waitDeadlineMs = waitState ? waitState.startedAtMs + waitState.totalMs : 0;
                    const waitRemainingMs = waitState ? Math.max(0, waitDeadlineMs - nowMs) : 0;
                    const waitElapsedMs = waitState ? Math.min(waitState.totalMs, Math.max(0, nowMs - waitState.startedAtMs)) : 0;
                    const waitProgress = waitState && waitState.totalMs > 0 ? Math.round((waitElapsedMs / waitState.totalMs) * 100) : 0;
                    const autoRetryBufferPct = waitState?.bufferMultiplier ? Math.round((waitState.bufferMultiplier - 1) * 100) : 0;
                    const isAutoRetryStep = stepLabel.toLowerCase().includes("auto-retrying");
                    const showAutoRetryTimer = Boolean(waitState && isAutoRetryStep);
                    return (
                      <>
                  <Progress value={tenant.progress} />
                  <div className="flex items-baseline gap-2 text-sm">
                    <span className="font-medium">{statusDisplay(tenant.status)}</span>
                    <span className="text-xs text-muted-foreground">({tenant.progress}%)</span>
                  </div>
                  <p className="text-xs text-muted-foreground">{stepLabel}</p>
                        {showAutoRetryTimer ? (
                          <div className="space-y-1 rounded-md border border-amber-200 bg-amber-50 p-2">
                            <div className="flex items-center justify-between text-xs text-amber-900">
                              <span>
                                Waiting for auto-retry
                                {autoRetryBufferPct > 0 ? ` (+${autoRetryBufferPct}% safety buffer)` : ""}
                              </span>
                              <span>{waitRemainingMs > 0 ? `${formatDurationMs(waitRemainingMs)} remaining` : "Retrying now..."}</span>
                            </div>
                            <Progress value={waitProgress} className="h-1.5" />
                            <p className="text-[11px] text-amber-800">{waitState?.reason}</p>
                          </div>
                        ) : null}
                        {stepCounter ? (
                          <div className="space-y-1">
                            <div className="flex items-center justify-between text-xs text-muted-foreground">
                              <span>Sub-step progress</span>
                              <span>
                                {stepCounter.current}/{stepCounter.total}
                              </span>
                            </div>
                            <Progress value={Math.round((stepCounter.current / stepCounter.total) * 100)} className="h-1.5" />
                          </div>
                        ) : null}
                      </>
                    );
                  })()}
                  {retryStatusByTenant[tenant.id] ? (
                    <Badge variant="outline">Retry from: {retryStatusByTenant[tenant.id]}</Badge>
                  ) : null}
                  {tenant.status === "queued" ? (
                    <Badge variant="outline">Queue position: #{queuedPositions.get(tenant.id) || 1}</Badge>
                  ) : null}
                  {processingStatuses.has(tenant.status) ? (
                    <Badge className="bg-blue-100 text-blue-900 border-blue-200">Currently processing</Badge>
                  ) : null}
                </div>

                {tenant.status === "auth_pending" ? (
                  <div className="rounded-lg border border-amber-200 bg-amber-50 px-4 py-2 text-sm text-amber-900">
                    Awaiting device authorization — use the table at the top of the page.
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
                  </div>
                ) : null}

                <div className="mt-3">
                  <Button
                    variant="outline"
                    onClick={() => void callTenantAction(tenant.id, "retry")}
                    disabled={Boolean(isBusy("retry"))}
                  >
                    Retry
                  </Button>
                </div>

                {tenant.status !== "failed" && tenant.status !== "completed" ? (
                  <div className="mt-3">
                    <p className="text-xs text-muted-foreground">Retry is always available if the flow gets stuck.</p>
                  </div>
                ) : null}

                {tenant.status === "queued" ? (
                  <div className="flex items-center gap-2 rounded-lg border border-slate-200 bg-slate-50 p-3 text-sm text-slate-700">
                    <Clock3 className="h-4 w-4" />
                    Waiting in queue.
                  </div>
                ) : null}

                {processingStatuses.has(tenant.status) ? (
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
