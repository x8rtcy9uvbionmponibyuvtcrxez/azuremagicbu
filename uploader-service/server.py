"""
ESP Uploader Service — headless Chrome + Selenium on Railway.

Accepts upload jobs via HTTP, splits the CSV into N concurrent chunks,
and runs the Smartlead / Instantly Selenium scripts in parallel.
"""

import csv
import os
import subprocess
import threading
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Dict

import uvicorn
from fastapi import FastAPI, File, Form, HTTPException, UploadFile
from fastapi.responses import JSONResponse

# ---------------------------------------------------------------------------
# Config
# ---------------------------------------------------------------------------

SCRIPTS_DIR = Path(os.environ.get("SCRIPTS_DIR", "/app/scripts"))
WORK_DIR = Path(os.environ.get("WORK_DIR", "/tmp/uploads"))
WORK_DIR.mkdir(parents=True, exist_ok=True)

MAX_LOG_LINES = 2000
DEFAULT_WORKERS = int(os.environ.get("UPLOADER_WORKERS", "4"))
MAX_WORKERS = 8

app = FastAPI(title="ESP Uploader Service")

# ---------------------------------------------------------------------------
# In-memory job store
# ---------------------------------------------------------------------------


class UploadJob:
    def __init__(self, job_id: str, esp: str, num_workers: int):
        self.id = job_id
        self.esp = esp
        self.status = "queued"
        self.phase = "uploading"
        self.created_at = _now()
        self.updated_at = _now()
        self.log_lines: list[str] = []
        self.exit_code: int | None = None
        self.error_message: str | None = None
        self.num_workers = num_workers
        self.processes: list[subprocess.Popen] = []

    def log(self, line: str):
        self.log_lines.append(line)
        if len(self.log_lines) > MAX_LOG_LINES:
            self.log_lines = self.log_lines[-MAX_LOG_LINES:]
        self.updated_at = _now()

    def to_dict(self) -> dict:
        return {
            "id": self.id,
            "esp": self.esp,
            "status": self.status,
            "phase": self.phase,
            "createdAt": self.created_at,
            "updatedAt": self.updated_at,
            "logLines": self.log_lines[-500:],
            "exitCode": self.exit_code,
            "errorMessage": self.error_message,
            "numWorkers": self.num_workers,
        }


jobs: Dict[str, UploadJob] = {}


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


# ---------------------------------------------------------------------------
# CSV splitting
# ---------------------------------------------------------------------------


def split_csv(csv_path: str, num_chunks: int, output_dir: str) -> list[str]:
    """Split a CSV into *num_chunks* smaller files, preserving the header."""
    with open(csv_path, "r", newline="") as f:
        reader = csv.DictReader(f)
        fieldnames = reader.fieldnames
        rows = list(reader)

    if not rows or not fieldnames:
        return [csv_path]

    chunk_size = max(1, len(rows) // num_chunks)
    paths: list[str] = []

    for i in range(num_chunks):
        start = i * chunk_size
        chunk_rows = rows[start:] if i == num_chunks - 1 else rows[start : start + chunk_size]
        if not chunk_rows:
            break

        out = os.path.join(output_dir, f"chunk_{i + 1}.csv")
        with open(out, "w", newline="") as f:
            writer = csv.DictWriter(f, fieldnames=fieldnames)
            writer.writeheader()
            writer.writerows(chunk_rows)
        paths.append(out)

    return paths


def _count_data_rows(csv_path: str) -> int:
    with open(csv_path) as f:
        return max(0, sum(1 for _ in f) - 1)


# ---------------------------------------------------------------------------
# Subprocess helpers
# ---------------------------------------------------------------------------


def _monitor(proc: subprocess.Popen, job: UploadJob, prefix: str = ""):
    """Stream stdout/stderr into the job log."""
    if proc.stdout:
        for raw_line in iter(proc.stdout.readline, ""):
            line = raw_line.rstrip("\n\r")
            if line:
                job.log(f"{prefix}{line}")
        proc.stdout.close()

    if proc.stderr:
        for raw_line in iter(proc.stderr.readline, ""):
            line = raw_line.rstrip("\n\r")
            if line:
                job.log(f"{prefix}[stderr] {line}")
        proc.stderr.close()


# ---------------------------------------------------------------------------
# Smartlead runner
# ---------------------------------------------------------------------------


def _run_smartlead(
    job: UploadJob,
    api_key: str,
    csv_path: str,
    login_url: str,
    work_dir: str,
    num_workers: int,
):
    try:
        job.status = "running"
        job.phase = "uploading"
        job.log(f"--- Phase 1: Uploading accounts to Smartlead ({num_workers} workers) ---")

        script = str(SCRIPTS_DIR / "smartlead" / "sl-python.py")
        chunks = split_csv(csv_path, num_workers, work_dir)
        job.log(f"Split CSV into {len(chunks)} chunks")

        threads_and_procs = []
        for i, chunk in enumerate(chunks):
            pfx = f"[W{i + 1}] " if len(chunks) > 1 else ""
            job.log(f"{pfx}Starting — {_count_data_rows(chunk)} accounts")

            proc = subprocess.Popen(
                ["python3", script, api_key, chunk, login_url],
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                text=True,
                cwd=work_dir,
            )
            job.processes.append(proc)
            t = threading.Thread(target=_monitor, args=(proc, job, pfx), daemon=True)
            t.start()
            threads_and_procs.append((t, proc))

        for t, proc in threads_and_procs:
            proc.wait()
            t.join(timeout=10)

        any_failed = any(p.returncode != 0 for _, p in threads_and_procs)

        # Phase 2 — configure warmup / sending limits
        if not any_failed:
            job.phase = "configuring"
            job.log("--- Phase 2: Configuring warmup and sending limits ---")

            complete_script = str(SCRIPTS_DIR / "smartlead" / "sl-complete.py")
            proc2 = subprocess.Popen(
                ["python3", complete_script, api_key, csv_path],
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                text=True,
                cwd=work_dir,
            )
            mt = threading.Thread(target=_monitor, args=(proc2, job), daemon=True)
            mt.start()
            proc2.wait()
            mt.join(timeout=10)
            if proc2.returncode != 0:
                any_failed = True

        job.exit_code = 1 if any_failed else 0
        job.status = "failed" if any_failed else "completed"
        job.phase = "done"
        job.log(f"Upload {'failed' if any_failed else 'completed successfully'}")

    except Exception as e:
        job.status = "failed"
        job.error_message = str(e)
        job.phase = "done"
        job.log(f"Fatal error: {e}")


# ---------------------------------------------------------------------------
# Instantly runner
# ---------------------------------------------------------------------------


def _run_instantly(
    job: UploadJob,
    api_key: str,
    v2_api_key: str,
    login_email: str,
    login_password: str,
    workspace: str,
    csv_path: str,
    api_version: str,
    num_workers: int,
    work_dir: str,
):
    try:
        job.status = "running"
        job.phase = "uploading"
        job.log(f"--- Uploading accounts to Instantly ({num_workers} workers) ---")

        script = str(SCRIPTS_DIR / "instantly" / "upload.py")
        chunks = split_csv(csv_path, num_workers, work_dir)
        job.log(f"Split CSV into {len(chunks)} chunks")

        threads_and_procs = []
        for i, chunk in enumerate(chunks):
            wid = str(i + 1)
            pfx = f"[W{wid}] " if len(chunks) > 1 else ""
            job.log(f"{pfx}Starting — {_count_data_rows(chunk)} accounts")

            args = [
                "python3",
                script,
                api_key,
                login_email,
                login_password,
                workspace,
                chunk,
                wid,
                api_version,
                "",  # existing_accounts_file placeholder
            ]
            if v2_api_key:
                args.append(v2_api_key)

            proc = subprocess.Popen(
                args,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                text=True,
                cwd=str(SCRIPTS_DIR / "instantly"),
            )
            job.processes.append(proc)
            t = threading.Thread(target=_monitor, args=(proc, job, pfx), daemon=True)
            t.start()
            threads_and_procs.append((t, proc))

        for t, proc in threads_and_procs:
            proc.wait()
            t.join(timeout=10)

        any_failed = any(p.returncode != 0 for _, p in threads_and_procs)

        job.exit_code = 1 if any_failed else 0
        job.status = "failed" if any_failed else "completed"
        job.phase = "done"
        job.log(f"Upload {'failed' if any_failed else 'completed successfully'}")

    except Exception as e:
        job.status = "failed"
        job.error_message = str(e)
        job.phase = "done"
        job.log(f"Fatal error: {e}")


# ---------------------------------------------------------------------------
# HTTP endpoints
# ---------------------------------------------------------------------------


@app.get("/health")
async def health():
    return {"status": "ok", "service": "uploader", "activeJobs": sum(1 for j in jobs.values() if j.status == "running")}


@app.post("/jobs/smartlead")
async def start_smartlead(
    file: UploadFile = File(...),
    apiKey: str = Form(...),
    loginUrl: str = Form(...),
    numWorkers: int = Form(DEFAULT_WORKERS),
):
    job_id = str(uuid.uuid4())
    wd = str(WORK_DIR / job_id)
    os.makedirs(wd, exist_ok=True)

    csv_path = os.path.join(wd, "accounts.csv")
    content = await file.read()
    with open(csv_path, "wb") as f:
        f.write(content)

    n = max(1, min(numWorkers, MAX_WORKERS))
    job = UploadJob(job_id, "smartlead", n)
    jobs[job_id] = job

    threading.Thread(
        target=_run_smartlead,
        args=(job, apiKey, csv_path, loginUrl, wd, n),
        daemon=True,
    ).start()

    return {"jobId": job_id}


@app.post("/jobs/instantly")
async def start_instantly(
    file: UploadFile = File(...),
    apiKey: str = Form(...),
    loginEmail: str = Form(...),
    loginPassword: str = Form(...),
    workspace: str = Form(...),
    apiVersion: str = Form("v1"),
    v2ApiKey: str = Form(""),
    numWorkers: int = Form(DEFAULT_WORKERS),
):
    job_id = str(uuid.uuid4())
    wd = str(WORK_DIR / job_id)
    os.makedirs(wd, exist_ok=True)

    csv_path = os.path.join(wd, "accounts.csv")
    content = await file.read()
    with open(csv_path, "wb") as f:
        f.write(content)

    n = max(1, min(numWorkers, MAX_WORKERS))
    job = UploadJob(job_id, "instantly", n)
    jobs[job_id] = job

    threading.Thread(
        target=_run_instantly,
        args=(job, apiKey, v2ApiKey, loginEmail, loginPassword, workspace, csv_path, apiVersion, n, wd),
        daemon=True,
    ).start()

    return {"jobId": job_id}


@app.get("/jobs/{job_id}")
async def get_job(job_id: str):
    job = jobs.get(job_id)
    if not job:
        raise HTTPException(status_code=404, detail="Job not found")

    d = job.to_dict()
    return {
        "jobId": d["id"],
        "esp": d["esp"],
        "status": d["status"],
        "phase": d["phase"],
        "createdAt": d["createdAt"],
        "updatedAt": d["updatedAt"],
        "apiKeyMasked": "****",
        "logs": d["logLines"],
        "exitCode": d["exitCode"],
        "errorMessage": d["errorMessage"],
        "failedCsvPath": d.get("failedCsvPath"),
    }


@app.get("/jobs/{job_id}/failed-csv")
async def get_failed_csv(job_id: str):
    job = jobs.get(job_id)
    if not job:
        raise HTTPException(status_code=404, detail="Job not found")

    # Look for failed_accounts.csv in the job's working directory
    wd = WORK_DIR / job_id
    failed_path = wd / "failed_accounts.csv"

    if not failed_path.exists():
        raise HTTPException(status_code=404, detail="No failed CSV available")

    from fastapi.responses import FileResponse

    return FileResponse(
        path=str(failed_path),
        media_type="text/csv",
        filename="failed_accounts.csv",
    )


# ---------------------------------------------------------------------------
# Entrypoint
# ---------------------------------------------------------------------------

if __name__ == "__main__":
    port = int(os.environ.get("PORT", "3098"))
    print(f"🚀 Uploader service starting on port {port}")
    uvicorn.run(app, host="0.0.0.0", port=port)
