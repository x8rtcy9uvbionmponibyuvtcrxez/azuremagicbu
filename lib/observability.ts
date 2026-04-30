/**
 * Phase 4 — observability primitives.
 *
 * Two thin utilities, no infrastructure dependency. Logs go to console
 * as JSON; the operator greps `railway logs --json | jq` to query them.
 *
 * - logCall(...): structured per-Graph-call line. Replaces ad-hoc
 *   console.log strings in the service layer. Field shape is stable so
 *   downstream tools (jq scripts, Phase 4.2 metrics endpoint) can parse it.
 *
 * - withCallLogging(...): wrapper that times an async call, classifies
 *   the result (ok / error code), and emits one structured line. Drop-in
 *   replacement for `await graphRequest(...)` style call sites where we
 *   want telemetry without manually instrumenting each one.
 *
 * Bug 9.1 + 9.2 in BULLETPROOF_PLAN_DETAILED.md.
 */

export type CallLogEntry = {
  /** Operation name. Use a stable string so dashboards group cleanly. */
  op: string;
  /** Tenant the operation is scoped to, when applicable. */
  tenantId?: string;
  /** 1-indexed attempt count for retry-bearing call sites. */
  attempt?: number;
  /** Wall-clock ms the call took. Always present on terminal entries. */
  latency_ms?: number;
  /** True when the operation succeeded. False when it threw / errored. */
  ok: boolean;
  /** Stable error code from the upstream service (e.g. Graph "Authorization_RequestDenied"). */
  errCode?: string | null;
  /** Free-form. Avoid putting secrets here. */
  detail?: string;
};

/**
 * Emit one JSON line to stdout. The shape stays stable — anything that
 * grep/jq might depend on is on the top level, not nested.
 *
 * Tagged with a `kind: "call"` so other structured logs (job lifecycle,
 * worker boot, etc.) don't collide if added later.
 */
export function logCall(entry: CallLogEntry): void {
  // Single console.log so each line is one log row in Railway's UI.
  console.log(
    JSON.stringify({
      kind: "call",
      ts: new Date().toISOString(),
      ...entry
    })
  );
}

/**
 * Extract a stable error code from a thrown value. Microsoft Graph
 * returns `{ error: { code: "AuthorizationRequestDenied", message: "..." } }`
 * — the `code` field is committed as stable. `Authorization_RequestDenied`
 * (with underscore) is the older shape; both surface here.
 */
export function extractErrorCode(error: unknown): string | null {
  if (!error || typeof error !== "object") return null;
  const e = error as Record<string, unknown>;

  // Direct shape: { code: "..." }
  if (typeof e.code === "string") return e.code;

  // Wrapped Graph shape: { error: { code: "..." } }
  if (e.error && typeof e.error === "object") {
    const inner = e.error as Record<string, unknown>;
    if (typeof inner.code === "string") return inner.code;
  }

  // Fall back to scraping AADSTS error codes from the message — these
  // are stable identifiers Microsoft hands us back even when the rest
  // of the response is unstructured.
  if (typeof e.message === "string") {
    const m = e.message.match(/\bAADSTS\d{4,7}\b/);
    if (m) return m[0];
  }
  return null;
}

type CallLoggingOpts = {
  op: string;
  tenantId?: string;
  attempt?: number;
};

/**
 * Wrap an async call site with structured logging. One log line per
 * invocation, tagged with op + tenantId + attempt + latency + ok/errCode.
 *
 * Returns the wrapped function's value, or rethrows the same error so
 * existing handling stays correct.
 */
export async function withCallLogging<T>(
  opts: CallLoggingOpts,
  fn: () => Promise<T>
): Promise<T> {
  const started = Date.now();
  try {
    const value = await fn();
    logCall({
      op: opts.op,
      tenantId: opts.tenantId,
      attempt: opts.attempt,
      latency_ms: Date.now() - started,
      ok: true
    });
    recordMetric(opts.op, opts.attempt ?? 1, true, Date.now() - started, null);
    return value;
  } catch (error) {
    const errCode = extractErrorCode(error);
    logCall({
      op: opts.op,
      tenantId: opts.tenantId,
      attempt: opts.attempt,
      latency_ms: Date.now() - started,
      ok: false,
      errCode,
      detail: error instanceof Error ? error.message.slice(0, 200) : String(error).slice(0, 200)
    });
    recordMetric(opts.op, opts.attempt ?? 1, false, Date.now() - started, errCode);
    throw error;
  }
}

// ═════════════════════════════════════════════════════════════════════════
//  Phase 4.2 — first-attempt-success metrics
// ═════════════════════════════════════════════════════════════════════════
//
// In-memory rolling counter per op. Restart loses the data — that's fine,
// metrics inform tuning and aren't a permanent record. The /api/metrics
// endpoint reads from this. Operators can also pipe `railway logs --json |
// jq` over the structured logCall lines for offline analysis.

type OpStats = {
  total: number;
  ok: number;
  firstAttemptOk: number;
  attemptHistogram: Record<number, number>;
  errCodes: Record<string, number>;
  // Reservoir of recent latencies for p50/p95. Bounded to avoid memory drift.
  latencies: number[];
};

const RESERVOIR_SIZE = 500;
const stats = new Map<string, OpStats>();

function blankStats(): OpStats {
  return {
    total: 0,
    ok: 0,
    firstAttemptOk: 0,
    attemptHistogram: {},
    errCodes: {},
    latencies: []
  };
}

function recordMetric(
  op: string,
  attempt: number,
  ok: boolean,
  latencyMs: number,
  errCode: string | null
): void {
  let bucket = stats.get(op);
  if (!bucket) {
    bucket = blankStats();
    stats.set(op, bucket);
  }
  bucket.total += 1;
  if (ok) {
    bucket.ok += 1;
    if (attempt === 1) bucket.firstAttemptOk += 1;
  } else if (errCode) {
    bucket.errCodes[errCode] = (bucket.errCodes[errCode] || 0) + 1;
  }
  bucket.attemptHistogram[attempt] = (bucket.attemptHistogram[attempt] || 0) + 1;
  if (bucket.latencies.length < RESERVOIR_SIZE) {
    bucket.latencies.push(latencyMs);
  } else {
    // Replacement-sample: random index. Keeps the reservoir representative
    // of the full stream over a long-running worker process.
    const idx = Math.floor(Math.random() * bucket.latencies.length);
    bucket.latencies[idx] = latencyMs;
  }
}

function percentile(sortedAsc: number[], p: number): number {
  if (sortedAsc.length === 0) return 0;
  const idx = Math.min(sortedAsc.length - 1, Math.floor((sortedAsc.length - 1) * p));
  return sortedAsc[idx];
}

/**
 * Snapshot the current metrics. Caller (the /api/metrics route) serializes
 * the result. Sorts the latency reservoir for percentile reads.
 */
export function snapshotMetrics() {
  const out: Record<
    string,
    {
      total: number;
      ok: number;
      firstAttemptSuccessRate: number;
      attempts: Record<number, number>;
      errCodes: Record<string, number>;
      latency_p50_ms: number;
      latency_p95_ms: number;
    }
  > = {};
  for (const [op, bucket] of stats.entries()) {
    const sorted = [...bucket.latencies].sort((a, b) => a - b);
    out[op] = {
      total: bucket.total,
      ok: bucket.ok,
      firstAttemptSuccessRate: bucket.total > 0 ? bucket.firstAttemptOk / bucket.total : 0,
      attempts: { ...bucket.attemptHistogram },
      errCodes: { ...bucket.errCodes },
      latency_p50_ms: percentile(sorted, 0.5),
      latency_p95_ms: percentile(sorted, 0.95)
    };
  }
  return out;
}

/** Reset all in-memory metrics. Tests and operator-triggered resets only. */
export function resetMetrics(): void {
  stats.clear();
}
