import { randomUUID } from "crypto";

export type DemoInstantlyRunStatus = "queued" | "running" | "completed" | "failed";

export type DemoInstantlyRun = {
  id: string;
  status: DemoInstantlyRunStatus;
  createdAt: string;
  updatedAt: string;
  apiKeyMasked: string;
  loginEmail: string;
  workspace: string;
  apiVersion: "v1" | "v2";
  csvPath: string;
  workingDir: string;
  logLines: string[];
  exitCode: number | null;
  errorMessage: string | null;
  failedCsvPath: string | null;
};

const MAX_LOG_LINES = 1000;

const globalStore = globalThis as typeof globalThis & {
  demoInstantlyRuns?: Map<string, DemoInstantlyRun>;
};

function getStore(): Map<string, DemoInstantlyRun> {
  if (!globalStore.demoInstantlyRuns) {
    globalStore.demoInstantlyRuns = new Map<string, DemoInstantlyRun>();
  }
  return globalStore.demoInstantlyRuns;
}

function nowIso(): string {
  return new Date().toISOString();
}

export function maskKey(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length <= 8) return "***";
  return `${trimmed.slice(0, 4)}...${trimmed.slice(-4)}`;
}

export function createDemoInstantlyRun(input: {
  apiKeyMasked: string;
  loginEmail: string;
  workspace: string;
  apiVersion: "v1" | "v2";
  csvPath: string;
  workingDir: string;
}): DemoInstantlyRun {
  const run: DemoInstantlyRun = {
    id: randomUUID(),
    status: "queued",
    createdAt: nowIso(),
    updatedAt: nowIso(),
    apiKeyMasked: input.apiKeyMasked,
    loginEmail: input.loginEmail,
    workspace: input.workspace,
    apiVersion: input.apiVersion,
    csvPath: input.csvPath,
    workingDir: input.workingDir,
    logLines: [],
    exitCode: null,
    errorMessage: null,
    failedCsvPath: null
  };
  getStore().set(run.id, run);
  return run;
}

export function getDemoInstantlyRun(id: string): DemoInstantlyRun | null {
  return getStore().get(id) || null;
}

export function listDemoInstantlyRuns(): DemoInstantlyRun[] {
  return Array.from(getStore().values()).sort(
    (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
  );
}

export function setDemoInstantlyRunStatus(id: string, status: DemoInstantlyRunStatus): void {
  const run = getDemoInstantlyRun(id);
  if (!run) return;
  run.status = status;
  run.updatedAt = nowIso();
}

export function appendDemoInstantlyRunLog(id: string, line: string): void {
  const run = getDemoInstantlyRun(id);
  if (!run) return;
  run.logLines.push(line);
  if (run.logLines.length > MAX_LOG_LINES) {
    run.logLines.splice(0, run.logLines.length - MAX_LOG_LINES);
  }
  run.updatedAt = nowIso();
}

export function completeDemoInstantlyRun(id: string, exitCode: number | null, failedCsvPath: string | null): void {
  const run = getDemoInstantlyRun(id);
  if (!run) return;
  run.status = exitCode === 0 ? "completed" : "failed";
  run.exitCode = exitCode;
  run.failedCsvPath = failedCsvPath;
  run.updatedAt = nowIso();
}

export function failDemoInstantlyRun(id: string, errorMessage: string): void {
  const run = getDemoInstantlyRun(id);
  if (!run) return;
  run.status = "failed";
  run.errorMessage = errorMessage;
  run.updatedAt = nowIso();
}
