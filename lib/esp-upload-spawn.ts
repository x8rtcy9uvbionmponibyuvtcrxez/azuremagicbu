import { spawn, ChildProcess } from "child_process";
import { join } from "path";
import { readFileSync, writeFileSync, readdirSync } from "fs";
import {
  appendEspRunLog,
  setEspRunStatus,
  setEspRunPhase,
  completeEspRun,
  failEspRun,
} from "./esp-upload-store";

function getProjectRoot(): string {
  // In dev, process.cwd() is the project root
  return process.cwd();
}

function smartleadScriptDir(): string {
  return join(getProjectRoot(), "Uploaders ", "smartlead-uploader");
}

function instantlyScriptDir(): string {
  return join(getProjectRoot(), "Uploaders ", "instantly-uploader-multi-workspace");
}

function scanForFailedCsv(dir: string): string | null {
  try {
    const files = readdirSync(dir);
    const found = files.find(
      (f) => f.startsWith("failed_accounts") && f.endsWith(".csv")
    );
    return found ? join(dir, found) : null;
  } catch {
    return null;
  }
}

function attachStdio(
  child: ChildProcess,
  runId: string,
  prefix?: string
): void {
  const fmt = (line: string) => (prefix ? `${prefix} ${line}` : line);

  child.stdout?.on("data", (chunk: Buffer) => {
    const lines = chunk.toString("utf-8").split("\n");
    for (const line of lines) {
      if (line.trim()) appendEspRunLog(runId, fmt(line));
    }
  });

  child.stderr?.on("data", (chunk: Buffer) => {
    const lines = chunk.toString("utf-8").split("\n");
    for (const line of lines) {
      if (line.trim()) appendEspRunLog(runId, fmt(`[stderr] ${line}`));
    }
  });
}

// ---------------------------------------------------------------------------
// Smartlead
// ---------------------------------------------------------------------------

export function spawnSmartleadRun(input: {
  runId: string;
  apiKey: string;
  csvPath: string;
  loginUrl: string;
  workingDir: string;
}): void {
  const { runId, apiKey, csvPath, loginUrl, workingDir } = input;
  const scriptPath = join(smartleadScriptDir(), "sl-python.py");

  setEspRunStatus(runId, "running");
  setEspRunPhase(runId, "uploading");
  appendEspRunLog(runId, "--- Phase 1: Uploading accounts to Smartlead ---");

  const child = spawn("python3", [scriptPath, apiKey, csvPath, loginUrl], {
    cwd: workingDir,
    env: { ...process.env },
  });

  attachStdio(child, runId);

  child.on("error", (err) => {
    failEspRun(runId, `Failed to start sl-python.py: ${err.message}`);
  });

  child.on("close", (code) => {
    if (code !== 0) {
      const failedCsv = scanForFailedCsv(workingDir);
      completeEspRun(runId, code, failedCsv);
      return;
    }

    // Phase 2: configure warmup/sending limits
    appendEspRunLog(
      runId,
      "--- Phase 2: Configuring warmup and sending limits ---"
    );
    setEspRunPhase(runId, "configuring");

    const completeScript = join(smartleadScriptDir(), "sl-complete.py");
    const child2 = spawn("python3", [completeScript, apiKey, csvPath], {
      cwd: workingDir,
      env: { ...process.env },
    });

    attachStdio(child2, runId);

    child2.on("error", (err) => {
      appendEspRunLog(runId, `Warning: sl-complete.py failed to start: ${err.message}`);
      const failedCsv = scanForFailedCsv(workingDir);
      completeEspRun(runId, 1, failedCsv);
    });

    child2.on("close", (code2) => {
      const failedCsv = scanForFailedCsv(workingDir);
      completeEspRun(runId, code2, failedCsv);
    });
  });
}

// ---------------------------------------------------------------------------
// Instantly — CSV splitting
// ---------------------------------------------------------------------------

function splitCsvForWorkers(
  csvPath: string,
  numWorkers: number,
  outputDir: string
): string[] {
  const raw = readFileSync(csvPath, "utf-8");
  const lines = raw.split("\n");
  const header = lines[0];
  const dataLines = lines.slice(1).filter((l) => l.trim());

  if (dataLines.length === 0) return [csvPath];

  const chunkSize = Math.ceil(dataLines.length / numWorkers);
  const paths: string[] = [];

  for (let i = 0; i < numWorkers; i++) {
    const chunk = dataLines.slice(i * chunkSize, (i + 1) * chunkSize);
    if (chunk.length === 0) break;
    const outPath = join(outputDir, `split_${i + 1}.csv`);
    writeFileSync(outPath, [header, ...chunk].join("\n"), "utf-8");
    paths.push(outPath);
  }

  return paths;
}

// ---------------------------------------------------------------------------
// Instantly
// ---------------------------------------------------------------------------

export function spawnInstantlyRun(input: {
  runId: string;
  apiKey: string;
  v2ApiKey: string;
  loginEmail: string;
  loginPassword: string;
  workspace: string;
  csvPath: string;
  apiVersion: "v1" | "v2";
  numWorkers: number;
  workingDir: string;
}): void {
  const {
    runId,
    apiKey,
    v2ApiKey,
    loginEmail,
    loginPassword,
    workspace,
    csvPath,
    apiVersion,
    numWorkers,
    workingDir,
  } = input;

  setEspRunStatus(runId, "running");
  setEspRunPhase(runId, "uploading");

  const scriptPath = join(instantlyScriptDir(), "upload.py");
  const effectiveWorkers = Math.max(1, Math.min(numWorkers, 5));

  // Split CSV if multi-worker
  let csvPaths: string[];
  if (effectiveWorkers > 1) {
    appendEspRunLog(
      runId,
      `Splitting CSV into ${effectiveWorkers} chunks for parallel processing...`
    );
    csvPaths = splitCsvForWorkers(csvPath, effectiveWorkers, workingDir);
    appendEspRunLog(runId, `Created ${csvPaths.length} chunks`);
  } else {
    csvPaths = [csvPath];
  }

  const totalWorkers = csvPaths.length;
  let finishedCount = 0;
  let anyFailed = false;

  for (let i = 0; i < totalWorkers; i++) {
    const workerId = String(i + 1);
    const workerCsv = csvPaths[i];
    const prefix = totalWorkers > 1 ? `[Worker ${workerId}]` : undefined;

    // upload.py <api_key> <email> <password> <workspace> <csv_file> <worker_id> <api_version> [existing_accounts_file] [v2_api_key]
    const args = [
      scriptPath,
      apiKey,
      loginEmail,
      loginPassword,
      workspace,
      workerCsv,
      workerId,
      apiVersion,
      "", // existing_accounts_file — not used here
    ];
    if (v2ApiKey) args.push(v2ApiKey);

    const child = spawn("python3", args, {
      cwd: instantlyScriptDir(), // upload.py imports from config.py in same dir
      env: { ...process.env },
    });

    attachStdio(child, runId, prefix);

    child.on("error", (err) => {
      appendEspRunLog(
        runId,
        `${prefix || ""} Failed to start upload.py: ${err.message}`
      );
      anyFailed = true;
      finishedCount++;
      if (finishedCount === totalWorkers) {
        const failedCsv = scanForFailedCsv(workingDir) || scanForFailedCsv(instantlyScriptDir());
        completeEspRun(runId, 1, failedCsv);
      }
    });

    child.on("close", (code) => {
      if (code !== 0) anyFailed = true;
      finishedCount++;

      if (finishedCount === totalWorkers) {
        // Scan both working dir and script dir for failed CSVs
        const failedCsv =
          scanForFailedCsv(workingDir) || scanForFailedCsv(instantlyScriptDir());
        completeEspRun(runId, anyFailed ? 1 : 0, failedCsv);
      }
    });
  }
}
