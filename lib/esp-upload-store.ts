import { randomUUID } from "crypto";

export type EspType = "smartlead" | "instantly";
export type EspRunStatus = "queued" | "running" | "completed" | "failed";
export type EspRunPhase = "uploading" | "configuring" | "done";

export type EspRun = {
  id: string;
  esp: EspType;
  status: EspRunStatus;
  phase: EspRunPhase;
  createdAt: string;
  updatedAt: string;
  apiKeyMasked: string;
  csvPath: string;
  workingDir: string;
  logLines: string[];
  exitCode: number | null;
  errorMessage: string | null;
  failedCsvPath: string | null;
  // Smartlead-specific
  loginUrl?: string;
  // Instantly-specific
  loginEmail?: string;
  workspace?: string;
  numWorkers?: number;
  apiVersion?: "v1" | "v2";
};

const MAX_LOG_LINES = 1000;

const globalStore = globalThis as typeof globalThis & {
  espUploadRuns?: Map<string, EspRun>;
};

function getStore(): Map<string, EspRun> {
  if (!globalStore.espUploadRuns) {
    globalStore.espUploadRuns = new Map<string, EspRun>();
  }
  return globalStore.espUploadRuns;
}

function nowIso(): string {
  return new Date().toISOString();
}

const ANSI_REGEX = /\x1b\[[0-9;]*m/g;

export function maskKey(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length <= 8) return "***";
  return `${trimmed.slice(0, 4)}...${trimmed.slice(-4)}`;
}

export function createEspRun(input: {
  esp: EspType;
  apiKeyMasked: string;
  csvPath: string;
  workingDir: string;
  loginUrl?: string;
  loginEmail?: string;
  workspace?: string;
  numWorkers?: number;
  apiVersion?: "v1" | "v2";
}): EspRun {
  const run: EspRun = {
    id: randomUUID(),
    status: "queued",
    phase: "uploading",
    createdAt: nowIso(),
    updatedAt: nowIso(),
    apiKeyMasked: input.apiKeyMasked,
    csvPath: input.csvPath,
    workingDir: input.workingDir,
    logLines: [],
    exitCode: null,
    errorMessage: null,
    failedCsvPath: null,
    esp: input.esp,
    loginUrl: input.loginUrl,
    loginEmail: input.loginEmail,
    workspace: input.workspace,
    numWorkers: input.numWorkers,
    apiVersion: input.apiVersion,
  };
  getStore().set(run.id, run);
  return run;
}

export function getEspRun(id: string): EspRun | null {
  return getStore().get(id) || null;
}

export function listEspRuns(): EspRun[] {
  return Array.from(getStore().values()).sort(
    (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
  );
}

export function setEspRunStatus(id: string, status: EspRunStatus): void {
  const run = getEspRun(id);
  if (!run) return;
  run.status = status;
  run.updatedAt = nowIso();
}

export function setEspRunPhase(id: string, phase: EspRunPhase): void {
  const run = getEspRun(id);
  if (!run) return;
  run.phase = phase;
  run.updatedAt = nowIso();
}

export function appendEspRunLog(id: string, line: string): void {
  const run = getEspRun(id);
  if (!run) return;
  run.logLines.push(line.replace(ANSI_REGEX, ""));
  if (run.logLines.length > MAX_LOG_LINES) {
    run.logLines.splice(0, run.logLines.length - MAX_LOG_LINES);
  }
  run.updatedAt = nowIso();
}

export function completeEspRun(
  id: string,
  exitCode: number | null,
  failedCsvPath: string | null
): void {
  const run = getEspRun(id);
  if (!run) return;
  run.status = exitCode === 0 ? "completed" : "failed";
  run.exitCode = exitCode;
  run.failedCsvPath = failedCsvPath;
  run.phase = "done";
  run.updatedAt = nowIso();
}

export function failEspRun(id: string, errorMessage: string): void {
  const run = getEspRun(id);
  if (!run) return;
  run.status = "failed";
  run.errorMessage = errorMessage;
  run.phase = "done";
  run.updatedAt = nowIso();
}
