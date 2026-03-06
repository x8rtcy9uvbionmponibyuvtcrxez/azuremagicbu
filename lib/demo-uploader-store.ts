import { randomUUID } from "crypto";

export type DemoRunStatus = "queued" | "running" | "completed" | "failed";

export type DemoRun = {
  id: string;
  status: DemoRunStatus;
  createdAt: string;
  updatedAt: string;
  apiKeyMasked: string;
  loginUrl: string;
  csvPath: string;
  workingDir: string;
  logLines: string[];
  exitCode: number | null;
  errorMessage: string | null;
  failedCsvPath: string | null;
};

const MAX_LOG_LINES = 800;

const globalStore = globalThis as typeof globalThis & {
  demoUploaderRuns?: Map<string, DemoRun>;
};

function getStore(): Map<string, DemoRun> {
  if (!globalStore.demoUploaderRuns) {
    globalStore.demoUploaderRuns = new Map<string, DemoRun>();
  }
  return globalStore.demoUploaderRuns;
}

function nowIso(): string {
  return new Date().toISOString();
}

export function maskApiKey(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length <= 8) return "***";
  return `${trimmed.slice(0, 4)}...${trimmed.slice(-4)}`;
}

export function createDemoRun(input: {
  apiKeyMasked: string;
  loginUrl: string;
  csvPath: string;
  workingDir: string;
}): DemoRun {
  const run: DemoRun = {
    id: randomUUID(),
    status: "queued",
    createdAt: nowIso(),
    updatedAt: nowIso(),
    apiKeyMasked: input.apiKeyMasked,
    loginUrl: input.loginUrl,
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

export function getDemoRun(id: string): DemoRun | null {
  return getStore().get(id) || null;
}

export function listDemoRuns(): DemoRun[] {
  return Array.from(getStore().values()).sort(
    (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
  );
}

export function setDemoRunStatus(id: string, status: DemoRunStatus): void {
  const run = getDemoRun(id);
  if (!run) return;
  run.status = status;
  run.updatedAt = nowIso();
}

export function appendDemoRunLog(id: string, line: string): void {
  const run = getDemoRun(id);
  if (!run) return;
  run.logLines.push(line);
  if (run.logLines.length > MAX_LOG_LINES) {
    run.logLines.splice(0, run.logLines.length - MAX_LOG_LINES);
  }
  run.updatedAt = nowIso();
}

export function completeDemoRun(id: string, exitCode: number | null, failedCsvPath: string | null): void {
  const run = getDemoRun(id);
  if (!run) return;
  run.status = exitCode === 0 ? "completed" : "failed";
  run.exitCode = exitCode;
  run.failedCsvPath = failedCsvPath;
  run.updatedAt = nowIso();
}

export function failDemoRun(id: string, errorMessage: string): void {
  const run = getDemoRun(id);
  if (!run) return;
  run.status = "failed";
  run.errorMessage = errorMessage;
  run.updatedAt = nowIso();
}
