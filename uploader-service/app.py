#!/usr/bin/env python3
"""
Unified Uploader App — Flask backend
Built from clean reference files (Uploaders 2).

Supports:
  • Instantly  — Single Workspace + Multi Workspace (Microsoft OAuth via Selenium)
  • Smartlead  — Upload Accounts (headless Chrome OAuth) + Warmup/Sending Config (API)

Features: SQLite history, pause/stop, live progress & logs
"""

import os
import csv
import json
import uuid
import time
import sqlite3
import threading
from datetime import datetime
from flask import Flask, request, jsonify, render_template
import requests as http_req

from selenium import webdriver
from selenium.common.exceptions import TimeoutException
from selenium.webdriver.support.ui import WebDriverWait
from selenium.webdriver.support import expected_conditions as EC
from selenium.webdriver.common.by import By

# Optional seleniumwire — only needed when running through an authenticated
# residential proxy (cloud deploy). For local Mac runs this import is absent
# and we fall back to regular selenium.webdriver.Chrome below.
try:
    from seleniumwire import webdriver as _wire_webdriver
    _HAS_SELENIUM_WIRE = True
except ImportError:
    _wire_webdriver = None
    _HAS_SELENIUM_WIRE = False


_proxy_session_local = threading.local()


def set_proxy_session(session_id):
    """Pin this thread to a sticky proxy IP by attaching a session ID that gets
    appended to the proxy password. Call once per worker thread at startup;
    each worker should use a unique ID so it gets its own sticky IP."""
    _proxy_session_local.session_id = session_id


def _proxy_config():
    """Read PROXY_URL / PROXY_USER / PROXY_PASS env vars. Returns a dict ready
    for seleniumwire_options['proxy'], or None if no proxy configured.

    IPRoyal convention: sticky sessions are controlled by appending
    `_session-<id>_lifetime-<minutes>m` to the password. We do that here
    per-thread when a session ID has been set via set_proxy_session()."""
    url = os.environ.get("PROXY_URL", "").strip()
    user = os.environ.get("PROXY_USER", "").strip()
    pw = os.environ.get("PROXY_PASS", "").strip()
    if not url:
        return None
    session_id = getattr(_proxy_session_local, "session_id", None)
    if session_id and pw and "_session-" not in pw:
        pw = f"{pw}_session-{session_id}_lifetime-30m"
    auth = f"{user}:{pw}@" if (user and pw) else ""
    full = f"http://{auth}{url}"
    return {"http": full, "https": full, "no_proxy": "localhost,127.0.0.1"}


def _build_proxy_auth_extension_dir(host, port, user, pw):
    """Generate a Chrome extension that handles HTTP proxy auth via
    chrome.webRequest.onAuthRequired. Chromium's native --proxy-server flag
    doesn't accept user:pass inline (hits ERR_PROXY_AUTH_UNSUPPORTED), and
    selenium-wire's MITM proxy is flaky in headless Chromium. This extension
    approach is the battle-tested pattern that works reliably in --headless=new.

    Returns a directory path to load via --load-extension=<dir>. Each driver
    gets its own dir so sticky session IDs (embedded in the password) don't
    collide across workers."""
    import tempfile as _tempfile
    import json as _json
    ext_dir = _tempfile.mkdtemp(prefix="proxy_ext_")
    manifest = {
        "manifest_version": 2,
        "name": "Proxy Auth Helper",
        "version": "1.0",
        "permissions": [
            "proxy", "tabs", "unlimitedStorage", "storage",
            "<all_urls>", "webRequest", "webRequestBlocking",
        ],
        "background": {"scripts": ["bg.js"]},
        "minimum_chrome_version": "22.0.0",
    }
    bg_js = (
        'var config = {'
        '  mode: "fixed_servers",'
        '  rules: {'
        f'    singleProxy: {{ scheme: "http", host: "{host}", port: parseInt("{port}") }},'
        '    bypassList: ["localhost","127.0.0.1"]'
        '  }'
        '};'
        'chrome.proxy.settings.set({value: config, scope: "regular"}, function() {});'
        'chrome.webRequest.onAuthRequired.addListener('
        f'  function(details) {{ return {{ authCredentials: {{username: "{user}", password: "{pw}"}} }}; }},'
        '  {urls: ["<all_urls>"]},'
        '  ["blocking"]'
        ');'
    )
    with open(os.path.join(ext_dir, "manifest.json"), "w") as f:
        f.write(_json.dumps(manifest))
    with open(os.path.join(ext_dir, "bg.js"), "w") as f:
        f.write(bg_js)
    return ext_dir


def _build_chrome(opts):
    """Create a Chrome driver. If PROXY_URL is set, inject a proxy-auth Chrome
    extension for the IPRoyal/whatever residential proxy. Extension-based auth
    works in both headed and headless=new modes. Local runs with no PROXY_URL
    fall through to vanilla Chrome."""
    url = os.environ.get("PROXY_URL", "").strip()
    user = os.environ.get("PROXY_USER", "").strip()
    pw = os.environ.get("PROXY_PASS", "").strip()
    if not url or not user or not pw:
        return webdriver.Chrome(options=opts)

    # Append sticky session suffix to password if a thread-local session is set
    session_id = getattr(_proxy_session_local, "session_id", None)
    if session_id and "_session-" not in pw:
        pw = f"{pw}_session-{session_id}_lifetime-30m"

    # Parse host:port
    if ":" in url:
        host, port = url.split(":", 1)
    else:
        host, port = url, "80"

    ext_dir = _build_proxy_auth_extension_dir(host, port, user, pw)
    opts.add_argument(f"--load-extension={ext_dir}")
    # --disable-extensions-except keeps only our proxy extension active
    opts.add_argument(f"--disable-extensions-except={ext_dir}")
    return webdriver.Chrome(options=opts)


def _apply_cloud_opts(opts):
    """Apply container-friendly flags when HEADLESS=1 (set in Dockerfile).
    Local runs leave this off so you can watch Chrome do its thing."""
    if os.environ.get("HEADLESS", "").strip() == "1":
        opts.add_argument("--headless=new")
        opts.add_argument("--window-size=1920,1080")

# ── App Setup ─────────────────────────────────────────────────────
app = Flask(__name__)
BASE_DIR = os.path.dirname(os.path.abspath(__file__))
# DATA_DIR can point at a Railway-mounted volume (e.g. /app/data) so
# history.db + uploaded CSVs persist across container restarts. When unset
# (local Mac), we use the repo directory as before.
DATA_DIR = os.environ.get("DATA_DIR", BASE_DIR)
os.makedirs(DATA_DIR, exist_ok=True)
DB_PATH = os.path.join(DATA_DIR, "history.db")
UPLOAD_DIR = os.path.join(DATA_DIR, "uploads")
os.makedirs(UPLOAD_DIR, exist_ok=True)

MAX_RETRIES_INSTANTLY = 3
MAX_RETRIES_SMARTLEAD = 4

# Scale-hardening knobs (all env-var overridable for fine-tuning):
#   RECYCLE_AFTER_N  — quit & respawn each worker's Chrome after N accounts.
#                      Prevents the Chromium memory-leak death spiral that
#                      was causing TN-001 to crawl past account 75.
#   MAX_CONCURRENT_JOBS — semaphore cap on simultaneous jobs. Prevents
#                         OS thread exhaustion from 5+ parallel uploads.
RECYCLE_AFTER_N = max(1, int(os.environ.get("RECYCLE_AFTER_N", "20")))
MAX_CONCURRENT_JOBS = max(1, int(os.environ.get("MAX_CONCURRENT_JOBS", "2")))

jobs = {}   # job_id → JobState
_startup_time = time.time()
_job_slots = threading.Semaphore(MAX_CONCURRENT_JOBS)
_IS_GUNICORN = "gunicorn" in os.environ.get("SERVER_SOFTWARE", "").lower() or __name__ != "__main__"


# ═══════════════════════════════════════════════════════════════════
#  DATABASE
# ═══════════════════════════════════════════════════════════════════

def init_db():
    with sqlite3.connect(DB_PATH) as conn:
        conn.execute("""
            CREATE TABLE IF NOT EXISTS job_history (
                id TEXT PRIMARY KEY,
                platform TEXT,
                mode TEXT,
                status TEXT,
                total INTEGER DEFAULT 0,
                processed INTEGER DEFAULT 0,
                succeeded INTEGER DEFAULT 0,
                failed INTEGER DEFAULT 0,
                skipped INTEGER DEFAULT 0,
                config TEXT,
                started_at TEXT,
                finished_at TEXT
            )
        """)
        # Resumable state for in-flight jobs. Written continuously by
        # JobState mutators (mark_success/failure/skipped/warning/finish).
        # On uploader restart we read non-terminal rows from here, re-build
        # JobState in memory, and re-spawn worker threads — they use the
        # per-account account_status map to skip work already done.
        #
        # Design rationale: Railway Hobby containers recycle (OOM or platform
        # maintenance) and Railway redeploys on every main push unless the
        # service is path-scoped. Without this table, ANY restart orphans
        # in-flight jobs and the operator sees "failed with 0/99" even
        # though ~60 accounts actually landed. This table is what makes the
        # uploader durable across restarts.
        conn.execute("""
            CREATE TABLE IF NOT EXISTS active_jobs (
                id TEXT PRIMARY KEY,
                platform TEXT,
                mode TEXT,
                status TEXT,
                total INTEGER DEFAULT 0,
                processed INTEGER DEFAULT 0,
                succeeded INTEGER DEFAULT 0,
                failed INTEGER DEFAULT 0,
                skipped INTEGER DEFAULT 0,
                warnings INTEGER DEFAULT 0,
                csv_path TEXT,
                config_json TEXT,
                config_safe_json TEXT,
                account_status_json TEXT,
                failed_accounts_json TEXT,
                logs_json TEXT,
                started_at TEXT,
                finished_at TEXT,
                updated_at TEXT
            )
        """)
        conn.commit()


def save_job(job):
    # Save the FULL config (includes api keys + password) + csv_path so the
    # UI can offer a one-click "rerun" of a previous job with all settings
    # restored. This is a local-only single-user app — credentials at rest
    # in a file in the user's home dir are acceptable; they're the same
    # secrets the user typed into the form.
    full = dict(job.config or {})
    full["_csv_path"] = job.csv_path
    full["_safe"] = job.config_safe  # keep the display-safe view alongside
    with sqlite3.connect(DB_PATH) as conn:
        conn.execute("""
            INSERT OR REPLACE INTO job_history
            (id,platform,mode,status,total,processed,succeeded,failed,skipped,config,started_at,finished_at)
            VALUES (?,?,?,?,?,?,?,?,?,?,?,?)
        """, (
            job.job_id, job.platform, job.mode, job.status,
            job.total, job.processed, job.succeeded, job.failed, job.skipped,
            json.dumps(full), job.started_at, job.finished_at,
        ))
        conn.commit()


def persist_job(job):
    """Upsert the full JobState snapshot to active_jobs so we can resume on
    uploader restart. Called on every counter/status mutation — SQLite is
    local (on the mounted Railway volume) and we cap concurrent jobs at 2, so
    the write volume is trivial (a few hundred writes per 99-account run)."""
    try:
        with job._lock:
            # Snapshot under the lock so we don't tear on concurrent mutation
            # from another worker thread, then release before hitting SQLite.
            payload = (
                job.job_id,
                job.platform,
                job.mode,
                job.status,
                job.total,
                job.processed,
                job.succeeded,
                job.failed,
                job.skipped,
                job.warnings,
                job.csv_path,
                json.dumps(job.config or {}),
                json.dumps(job.config_safe or {}),
                json.dumps(job.account_status or {}),
                json.dumps(job.failed_accounts or []),
                # Cap log retention — we only need recent context for the
                # UI on resume, and huge log blobs bloat the DB. 500 lines
                # ≈ last ~3 min of upload activity.
                json.dumps((job.logs or [])[-500:]),
                job.started_at,
                job.finished_at,
                datetime.now().isoformat(),
            )
        with sqlite3.connect(DB_PATH) as conn:
            conn.execute("""
                INSERT OR REPLACE INTO active_jobs (
                    id, platform, mode, status, total, processed, succeeded, failed, skipped, warnings,
                    csv_path, config_json, config_safe_json, account_status_json, failed_accounts_json,
                    logs_json, started_at, finished_at, updated_at
                ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
            """, payload)
            conn.commit()
    except Exception as e:
        # Persistence must NEVER crash the job. If SQLite has a bad day we
        # just skip this snapshot; next state change tries again. The
        # worst case is a slightly stale resume on restart.
        print(f"[persist_job] non-fatal: {e}", flush=True)


def clear_active_job(job_id):
    """Remove an active_jobs row on terminal transition. Keeps the table
    small and ensures a restart doesn't try to resume a completed job."""
    try:
        with sqlite3.connect(DB_PATH) as conn:
            conn.execute("DELETE FROM active_jobs WHERE id = ?", (job_id,))
            conn.commit()
    except Exception as e:
        print(f"[clear_active_job] non-fatal: {e}", flush=True)


def load_history():
    with sqlite3.connect(DB_PATH) as conn:
        conn.row_factory = sqlite3.Row
        rows = conn.execute(
            "SELECT * FROM job_history ORDER BY started_at DESC LIMIT 100"
        ).fetchall()
    return [dict(r) for r in rows]


# ═══════════════════════════════════════════════════════════════════
#  JOB STATE
# ═══════════════════════════════════════════════════════════════════

class JobState:
    def __init__(self, job_id, platform, mode, total, csv_path, config, config_safe):
        self.job_id = job_id
        self.platform = platform
        self.mode = mode
        self.total = total
        self.processed = 0
        self.succeeded = 0
        self.failed = 0
        self.skipped = 0
        self.warnings = 0  # non-fatal anomalies (workspace switch fallback, etc.)
        self.status = "running"
        self.logs = []
        self.csv_path = csv_path
        self.config = config
        self.config_safe = config_safe
        self.failed_accounts = []
        # Per-account status map: email → {state, reason?, ts}
        # state ∈ {pending, processing, succeeded, failed, skipped, warned}
        # Powers the UI detail drawer + post-run reporting.
        self.account_status = {}
        self.started_at = datetime.now().isoformat()
        self.finished_at = None
        self._pause = threading.Event()
        self._pause.set()
        self._stop = False
        self._lock = threading.Lock()
        self._active_drivers = set()  # force-quit all on stop (one per worker)
        # Monotonically increasing log sequence, used by SSE stream clients to
        # tell "already-sent" from "new" log lines.
        self._log_seq = 0
        self._log_seq_by_line = {}

    def log(self, msg):
        ts = datetime.now().strftime("%H:%M:%S")
        entry = f"[{ts}] {msg}"
        with self._lock:
            self.logs.append(entry)
            if len(self.logs) > 2000:
                self.logs = self.logs[-1500:]
        print(entry, flush=True)

    def pause(self):
        self.status = "paused"
        self._pause.clear()
        self.log("⏸  Job paused")
        persist_job(self)

    def resume(self):
        self.status = "running"
        self._pause.set()
        self.log("▶  Job resumed")
        persist_job(self)

    def request_stop(self):
        self._stop = True
        self.status = "stopping"
        self._pause.set()
        with self._lock:
            drivers = list(self._active_drivers)
        self.log(f"⏹  Stop requested — killing {len(drivers)} active browser(s)…")
        for d in drivers:
            try:
                d.quit()
            except Exception:
                pass
        persist_job(self)

    def wait_if_paused(self):
        self._pause.wait()
        return not self._stop

    @property
    def should_stop(self):
        return self._stop

    def register_driver(self, driver):
        if driver is None:
            return
        with self._lock:
            self._active_drivers.add(driver)

    def unregister_driver(self, driver):
        if driver is None:
            return
        with self._lock:
            self._active_drivers.discard(driver)

    def mark_success(self):
        with self._lock:
            self.succeeded += 1
            self.processed += 1
        persist_job(self)

    def mark_failure(self, row=None):
        with self._lock:
            self.failed += 1
            self.processed += 1
            if row is not None:
                self.failed_accounts.append(row)
        persist_job(self)

    def mark_skipped(self):
        with self._lock:
            self.skipped += 1
            self.processed += 1
        persist_job(self)

    def mark_warning(self, reason):
        """Non-fatal anomaly (e.g., workspace switch needed fallback). Increments
        job.warnings and logs. Shown in UI separately from 'failed'."""
        with self._lock:
            self.warnings += 1
        self.log(f"⚠ Warning: {reason}")
        persist_job(self)

    def set_account_status(self, email, state, reason=None):
        """Per-account status map for the UI detail drawer. state ∈
        {pending, processing, succeeded, failed, skipped, warned}."""
        if not email:
            return
        with self._lock:
            self.account_status[email.lower()] = {
                "state": state,
                "reason": reason,
                "ts": datetime.now().isoformat(),
            }
        # Persist AFTER releasing the lock — persist_job takes the lock again
        # internally for the snapshot. Without this, we'd miss account_status
        # updates in the resume state (and thus re-process accounts on
        # restart because the worker loop's account_status skip check would
        # see an empty map).
        persist_job(self)

    def finish(self, status="completed"):
        self.status = status
        self.finished_at = datetime.now().isoformat()
        self.log(f"Job finished — {status}")
        save_job(self)
        # Terminal — job is now in job_history; stop carrying it in
        # active_jobs so restarts don't try to resume a finished job.
        clear_active_job(self.job_id)
        # Fire a Slack webhook if configured. Notifies on any non-trivial
        # outcome: failed / cancelled / completed-with-failures / warnings.
        # Silent no-op if SLACK_WEBHOOK_URL isn't set, so local runs are
        # unaffected.
        try:
            notify_slack_job_finished(self)
        except Exception:
            pass  # never let notification issues hurt the job

    def to_dict(self, include_full_logs=False, include_account_status=False):
        with self._lock:
            d = {
                "job_id": self.job_id,
                "platform": self.platform,
                "mode": self.mode,
                "status": self.status,
                "total": self.total,
                "processed": self.processed,
                "succeeded": self.succeeded,
                "failed": self.failed,
                "skipped": self.skipped,
                "warnings": self.warnings,
                "started_at": self.started_at,
                "finished_at": self.finished_at,
                "logs": list(self.logs) if include_full_logs else list(self.logs[-300:]),
                "config_safe": self.config_safe,
            }
            if include_account_status:
                d["account_status"] = dict(self.account_status)
        return d


def notify_slack_job_finished(job):
    """Post a summary of a finished (or cancelled / failed) job to Slack if
    SLACK_WEBHOOK_URL is set. Uses Slack's incoming-webhook format. Silent
    no-op when the env var is missing or the post fails. Filters out the
    trivial case (clean completion with all-succeeded) to avoid noise —
    only pings when there's a failure, warning, or cancellation."""
    url = os.environ.get("SLACK_WEBHOOK_URL", "").strip()
    if not url:
        return
    # Only notify on cases the user actually wants to know about.
    interesting = (
        job.status != "completed"       # cancelled / failed / etc.
        or (job.failed or 0) > 0         # any failures
        or (job.warnings or 0) > 0       # any warnings (workspace switch fallbacks, etc.)
    )
    if not interesting:
        return
    emoji = {
        "completed": ":white_check_mark:",
        "cancelled": ":no_entry:",
        "failed": ":x:",
    }.get(job.status, ":warning:")
    text = (
        f"{emoji} *Email Uploader — {job.platform}/{job.mode}* finished: `{job.status}`\n"
        f"> {job.succeeded} succeeded · {job.failed} failed · "
        f"{job.skipped} skipped · {job.warnings} warnings · {job.total} total\n"
        f"> job id: `{job.job_id}`"
    )
    try:
        http_req.post(url, json={"text": text}, timeout=10)
    except Exception as e:
        # Logged to stdout (Railway picks it up) but not to job.log to avoid
        # leaking the webhook URL into the job's user-visible log buffer.
        print(f"[slack] notify failed: {e}", flush=True)


def cancelable_sleep(seconds, job):
    """time.sleep(seconds) but wake up immediately on stop, and pause-aware.
    Returns False if caller should abort (stop requested), True otherwise.
    200ms polling granularity is fast enough for perceived responsiveness
    without burning CPU."""
    if job is None:
        time.sleep(seconds)
        return True
    end = time.time() + seconds
    while time.time() < end:
        if job.should_stop:
            return False
        if not job.wait_if_paused():
            return False
        time.sleep(min(0.2, max(0.0, end - time.time())))
    return True


# ═══════════════════════════════════════════════════════════════════
#  INSTANTLY — API HELPERS
# ═══════════════════════════════════════════════════════════════════

def inst_fetch_existing_v1(api_key, log):
    """V1 API — skip/limit pagination."""
    url = "https://api.instantly.ai/api/v1/account/list"
    emails = []
    skip = 0
    try:
        while True:
            r = http_req.get(url, params={"api_key": api_key, "limit": 100, "skip": skip}, timeout=30)
            if r.status_code != 200:
                log(f"V1 fetch error: {r.status_code}")
                break
            data = r.json()
            accts = data.get("accounts", data) if isinstance(data, dict) else data
            if not accts:
                break
            emails.extend(a.get("email", "") for a in accts if a.get("email"))
            if len(accts) < 100:
                break
            skip += 100
    except Exception as e:
        log(f"V1 fetch exception: {e}")
    log(f"V1: {len(emails)} existing accounts")
    return emails


def inst_fetch_existing_v2(api_key, log):
    """V2 API — cursor pagination with Bearer token."""
    url = "https://api.instantly.ai/api/v2/accounts"
    hdrs = {"Authorization": f"Bearer {api_key}", "Content-Type": "application/json"}
    emails = []
    cursor = None
    try:
        while True:
            p = {"limit": 100}
            if cursor:
                p["starting_after"] = cursor
            r = http_req.get(url, headers=hdrs, params=p, timeout=30)
            if r.status_code != 200:
                log(f"V2 fetch error: {r.status_code}")
                break
            data = r.json()
            items = data.get("items", [])
            if not items:
                break
            emails.extend(a.get("email", "") for a in items if a.get("email"))
            nsa = data.get("next_starting_after")
            if nsa and nsa != cursor:
                cursor = nsa
            else:
                break
            if len(items) < 100:
                break
    except Exception as e:
        log(f"V2 fetch exception: {e}")
    log(f"V2: {len(emails)} existing accounts")
    return emails


def inst_check_v1(api_key, email, log):
    """Verify a specific account is visible to the v1 API key.

    Paginates through /api/v1/account/list (100 per page, up to 5000 accounts
    = 50 pages). Early-exits the moment we find the target email.

    HISTORICAL NOTE: earlier version hardcoded limit=10 which silently missed
    newly-added accounts in workspaces with >10 existing accounts. Caused
    every post-OAuth check to return False in large workspaces, which made
    inst_add_account retry up to 3 times per account — burning ~2 min per
    account (Instantly dedupes by email so duplicates do not land, but it
    wastes enormous time + looks like everything is failing).
    """
    try:
        skip = 0
        while True:
            r = http_req.get(
                "https://api.instantly.ai/api/v1/account/list",
                params={"api_key": api_key, "limit": 100, "skip": skip},
                timeout=30,
            )
            if r.status_code != 200:
                log(f"V1 check HTTP {r.status_code}")
                return False
            data = r.json()
            accts = data.get("accounts", data) if isinstance(data, dict) else data
            if not accts:
                return False
            if any(a.get("email", "").lower() == email.lower() for a in accts):
                return True
            if len(accts) < 100:
                return False
            skip += 100
            # Safety cap. Shouldn't matter for normal customers, but keeps a
            # runaway pagination loop from DoS'ing the Instantly API.
            if skip >= 5000:
                log(f"V1 check: hit 5000-account pagination cap while searching for {email}")
                return False
    except Exception as e:
        log(f"V1 check error: {e}")
    return False


def inst_check_v2(api_key, email, log):
    """Verify a specific account via Instantly's direct-lookup endpoint.

    Primary path: GET /api/v2/accounts/{email} — O(1), no pagination needed.
    Falls back to a paginated /api/v2/accounts scan if the direct lookup
    returns a non-2xx, non-404 status (so a transient 5xx doesn't silently
    claim the account is missing).
    """
    hdrs = {"Authorization": f"Bearer {api_key}", "Content-Type": "application/json"}
    try:
        r = http_req.get(
            f"https://api.instantly.ai/api/v2/accounts/{email}",
            headers=hdrs,
            timeout=15,
        )
        if r.status_code == 200:
            return True
        if r.status_code == 404:
            return False
        # 5xx / 429 / 401 — fall through to paginated list rather than
        # silently declaring a not-found.
        log(f"V2 direct-lookup HTTP {r.status_code}, falling back to list")
    except Exception as e:
        log(f"V2 direct-lookup error (fallback to list): {e}")

    cursor = None
    try:
        # Safety cap: 50 pages × 100 = 5000 accounts (matches v1 fix).
        for _ in range(50):
            p = {"limit": 100}
            if cursor:
                p["starting_after"] = cursor
            r = http_req.get(
                "https://api.instantly.ai/api/v2/accounts",
                headers=hdrs,
                params=p,
                timeout=30,
            )
            if r.status_code != 200:
                break
            data = r.json()
            items = data.get("items", [])
            if any(a.get("email", "").lower() == email.lower() for a in items):
                return True
            nsa = data.get("next_starting_after")
            if not nsa or nsa == cursor or len(items) < 100:
                break
            cursor = nsa
    except Exception as e:
        log(f"V2 list fallback error: {e}")
    return False


# ═══════════════════════════════════════════════════════════════════
#  INSTANTLY — SELENIUM  (exact flows from upload.py)
# ═══════════════════════════════════════════════════════════════════

def make_inst_driver():
    """Chrome with incognito + anti-detection — matches original setup_driver().
    Uses residential proxy + headless when env vars are set (cloud deploy);
    otherwise plain visible Chrome (local Mac behavior unchanged)."""
    opts = webdriver.ChromeOptions()
    opts.add_argument("--incognito")
    opts.add_argument("--no-sandbox")
    opts.add_argument("--disable-dev-shm-usage")
    opts.add_argument("--disable-gpu")
    opts.add_argument("--disable-popup-blocking")
    opts.add_argument("--disable-blink-features=AutomationControlled")
    opts.add_experimental_option("excludeSwitches", ["enable-automation"])
    opts.add_experimental_option("useAutomationExtension", False)
    _apply_cloud_opts(opts)
    driver = _build_chrome(opts)
    driver.execute_script("Object.defineProperty(navigator, 'webdriver', {get: () => undefined})")
    try:
        driver.maximize_window()
    except Exception:
        pass  # headless containers sometimes throw on maximize
    return driver


def _wait_click(driver, by, value, timeout=10, retries=2, js=True, log=None):
    """Find + click an element, tolerating the headless Chromium NoneType bug
    where EC.element_to_be_clickable can raise AttributeError on transitioning
    pages. Uses presence_of_element_located (no is_displayed internal call),
    then JS-clicks by default. Returns True on success, False on timeout.
    Retries on NoneType / stale errors with a short backoff."""
    last_err = None
    for attempt in range(retries + 1):
        try:
            el = WebDriverWait(driver, timeout).until(
                EC.presence_of_element_located((by, value))
            )
            if js:
                driver.execute_script("arguments[0].click();", el)
            else:
                el.click()
            return True
        except TimeoutException:
            return False
        except Exception as e:
            last_err = e
            msg = str(e).lower()
            if "nonetype" in msg or "is_displayed" in msg or "stale" in msg:
                if attempt < retries:
                    time.sleep(0.5)
                    continue
            if log:
                log(f"_wait_click({value}) final error: {e}")
            return False
    return False


def _wait_type(driver, by, value, text, timeout=10, retries=2):
    """Find + type text into an input, tolerant of the headless Chromium
    "NoneType has no attribute is_displayed" race that shows up under load.

    Behavior, in order:
      1. Wait for presence, clear, send_keys (standard Selenium path)
      2. On NoneType/stale errors, retry up to `retries` times with a
         short sleep — catches most transient failures
      3. If send_keys keeps failing, fall back to the JS path: set the
         element's .value directly and dispatch input/change events so
         Angular/React state listeners see the change. Many Instantly /
         Microsoft login pages wire their bindings to these events
         rather than to raw send_keys keydown events, so JS often
         succeeds where send_keys can't.
      4. If EVERYTHING fails, log diagnostic context (element tag/class,
         page URL) so we can post-mortem without a screenshot endpoint.
         Returns False so the caller's own retry loop can fire.

    Returns True on success, False on terminal failure.
    """
    last_exc = None
    for attempt in range(retries + 1):
        try:
            el = WebDriverWait(driver, timeout).until(
                EC.presence_of_element_located((by, value))
            )
            try:
                el.clear()
            except Exception:
                pass
            el.send_keys(text)
            return True
        except TimeoutException:
            # Element never appeared — no point retrying or JS-fallback.
            return False
        except Exception as e:
            last_exc = e
            msg = str(e).lower()
            if "nonetype" in msg or "is_displayed" in msg or "stale" in msg:
                if attempt < retries:
                    time.sleep(0.5)
                    continue
            # Fall through to JS fallback rather than return False directly.
            break

    # JS fallback — works around the send_keys race when the element is in
    # the DOM but Selenium's is_displayed internal check segfaults on it.
    try:
        el = WebDriverWait(driver, 3).until(
            EC.presence_of_element_located((by, value))
        )
        # Set value + fire the events frameworks listen to. Without the
        # events, the input validator / submit button won't wake up.
        driver.execute_script(
            """
            const el = arguments[0];
            const val = arguments[1];
            const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
            setter.call(el, val);
            el.dispatchEvent(new Event('input', { bubbles: true }));
            el.dispatchEvent(new Event('change', { bubbles: true }));
            """,
            el,
            text,
        )
        return True
    except Exception as js_exc:
        # Final failure — emit enough context to post-mortem why this
        # specific page+element combination is wedging. Without this, we
        # only see "could not type email" with no clue what was on screen.
        try:
            tag = driver.execute_script(
                "const el = document.evaluate(arguments[0], document, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null).singleNodeValue; return el ? (el.tagName + '.' + (el.className || '')).slice(0,120) : '<no-element>';",
                value,
            ) if by == By.XPATH else "<non-xpath-selector>"
        except Exception:
            tag = "<diag-failed>"
        try:
            url = driver.current_url
        except Exception:
            url = "<no-url>"
        print(
            f"[_wait_type] hard-fail selector={value!r} url={url!r} "
            f"element={tag!r} send_keys_err={str(last_exc)[:160]!r} "
            f"js_err={str(js_exc)[:160]!r}",
            flush=True,
        )
        return False


def inst_dismiss_overlays(driver, log=None):
    """Instantly embeds Featurebase's changelog-popup widget which shows a
    full-page overlay <div class="fb-changelog-popup-overlay"> that
    intercepts ALL clicks. It can re-appear at any point during a session
    (new announcements trigger it). Call this before every click target
    interaction to keep it out of the way. Best-effort — never throws."""
    try:
        result = driver.execute_script("""
            var removed = 0;
            // Kill Featurebase changelog popup overlays
            document.querySelectorAll('.fb-changelog-popup-overlay, [data-featurebase-widget]').forEach(function(el) {
                try { el.remove(); removed += 1; } catch (e) {}
            });
            // Generic: any fixed full-screen overlay with high z-index we can cull
            document.querySelectorAll('iframe[src*="featurebase"], iframe[src*="changelog"]').forEach(function(el) {
                try { el.remove(); removed += 1; } catch (e) {}
            });
            return removed;
        """)
        if result and log:
            log(f"Dismissed {result} overlay element(s)")
    except Exception as e:
        if log:
            log(f"Overlay dismiss non-fatal: {e}")


def inst_login(driver, email, password, log, job=None):
    """Login: email + password on SAME page, ONE submit, wait for URL."""
    if job is not None and job.should_stop:
        return False
    try:
        driver.get("https://app.instantly.ai/app/accounts")
        if not cancelable_sleep(2, job):
            return False

        email_field = WebDriverWait(driver, 10).until(
            EC.visibility_of_element_located((By.XPATH, "//input[@placeholder='Email']"))
        )
        email_field.clear()
        email_field.send_keys(email)

        if job is not None and job.should_stop:
            return False

        pw_field = WebDriverWait(driver, 10).until(
            EC.visibility_of_element_located((By.XPATH, "//input[@placeholder='Password']"))
        )
        pw_field.clear()
        pw_field.send_keys(password)

        WebDriverWait(driver, 10).until(
            EC.element_to_be_clickable((By.XPATH, "//button[@type='submit']"))
        ).click()

        WebDriverWait(driver, 15).until(
            lambda d: "https://app.instantly.ai/app/accounts" in d.current_url
        )
        log("Instantly login successful")
        # Small wait then dismiss any Featurebase changelog popup that auto-
        # loads after sign-in and would otherwise intercept every click.
        if not cancelable_sleep(2, job):
            return False
        inst_dismiss_overlays(driver, log)
        return True
    except Exception as e:
        if job is not None and job.should_stop:
            return False
        log(f"Instantly login failed: {e}")
        return False


def inst_switch_workspace(driver, target, log):
    """Switch workspace via MUI dropdown — matches original switch_workspace().
    Phase 1 fix: dismiss the Featurebase changelog overlay BEFORE searching
    for the workspace button. The overlay intercepts DOM visibility in headless
    mode and was causing "Could not find workspace button" false-negatives
    even though the button was present in the DOM."""
    if not target:
        return True
    try:
        # Clear any Featurebase / changelog overlay that's blocking the DOM.
        # Was being called after the search timed out; moved to the top.
        inst_dismiss_overlays(driver, log)
        time.sleep(5)
        ws_btn = None
        btn_sels = [
            "//button[contains(@class,'MuiButton-root') and contains(@class,'MuiButton-outlined')]//div[contains(@class,'MuiGrid-item')]",
            "//button[contains(@class,'MuiButton-root')]//div[contains(@class,'MuiGrid-item')][1]",
            "//div[@class='AppTopbar__ContentContainer-sc-7gcyed-0 kqmvQN']//button[contains(@class,'MuiButton-root')]",
            "//*[@id='mainAppBar']//button[contains(@class,'MuiButton-root')]",
            "/html/body/div[1]/div[2]/div[1]/div[1]/div/div/button[2]",
            "//button[contains(@class,'cursorPointer') and contains(@class,'MuiButton')]",
        ]
        for sel in btn_sels:
            try:
                ws_btn = WebDriverWait(driver, 5).until(EC.element_to_be_clickable((By.XPATH, sel)))
                break
            except TimeoutException:
                continue
        if not ws_btn:
            log("Could not find workspace button")
            return False

        cur = ""
        try:
            el = ws_btn.find_element(By.XPATH, ".//div[contains(@class,'MuiGrid-item')][1]")
            cur = el.text.strip()
        except Exception:
            cur = ws_btn.text.strip()
        if cur.endswith("..."):
            cur = cur[:-3]

        if cur.lower() == target.lower() or \
           target.lower().startswith(cur.lower()) or \
           cur.lower().startswith(target.lower()):
            log(f"Already in workspace: {cur}")
            return True

        log(f"Switching workspace: {cur} → {target}")
        driver.execute_script("arguments[0].click();", ws_btn)
        time.sleep(3)

        dd_sels = [
            f"//div[contains(@class,'MuiPaper-root')]//li[contains(text(),'{target}')]",
            f"//div[contains(@class,'MuiMenu-paper')]//li[contains(text(),'{target}')]",
            f"//ul[contains(@class,'MuiMenu-list')]//li[contains(text(),'{target}')]",
            f"//li[contains(@class,'MuiMenuItem-root') and contains(text(),'{target}')]",
            f"//li[@role='menuitem' and contains(text(),'{target}')]",
        ]
        opt = None
        for sel in dd_sels:
            try:
                opt = WebDriverWait(driver, 3).until(EC.element_to_be_clickable((By.XPATH, sel)))
                break
            except TimeoutException:
                continue
        if not opt:
            log(f"Workspace '{target}' not found in dropdown")
            return False

        driver.execute_script("arguments[0].click();", opt)
        time.sleep(5)
        # Phase 2: verify we're actually on the target workspace by re-reading
        # the button text. If it doesn't match, the click silently missed and
        # future accounts would land in whichever workspace Chrome opened with.
        try:
            ws_btn2 = None
            for sel in btn_sels:
                try:
                    ws_btn2 = WebDriverWait(driver, 3).until(
                        EC.presence_of_element_located((By.XPATH, sel))
                    )
                    break
                except TimeoutException:
                    continue
            if ws_btn2 is not None:
                actual = (ws_btn2.text or "").strip().rstrip(".")
                if target.lower() not in actual.lower() and actual.lower() not in target.lower():
                    log(f"FATAL: workspace verify mismatch — wanted '{target}', page shows '{actual}'")
                    return False
                log(f"✓ Verified workspace: {actual}")
        except Exception as e:
            log(f"⚠ Workspace verify skipped (non-fatal): {e}")
        log(f"Switched to workspace: {target}")
        return True
    except Exception as e:
        log(f"Workspace switch error: {e}")
        return False


def inst_oauth(driver, email, password, log, job=None):
    """Complete Microsoft OAuth — matches original complete_oauth_flow().
    Uses NoneType-tolerant _wait_type / _wait_click helpers since headless
    Chromium can sporadically raise AttributeError from EC.element_to_be_clickable
    during page transitions. Single wrapper `try/except` left for last-resort
    catch; all individual steps have their own retry logic."""
    if job is not None and job.should_stop:
        return False
    try:
        # Email + submit (required)
        if not _wait_type(driver, By.NAME, "loginfmt", email, timeout=10, retries=3):
            log(f"OAuth: could not type email for {email}")
            return False
        if not cancelable_sleep(1, job):
            return False
        if not _wait_click(driver, By.CSS_SELECTOR, 'input[type="submit"]', timeout=10, retries=3, log=log):
            log("OAuth: could not click submit after email")
            return False
        if not cancelable_sleep(2, job):
            return False

        # Password + submit (required)
        if not _wait_type(driver, By.NAME, "passwd", password, timeout=10, retries=3):
            log(f"OAuth: could not type password for {email}")
            return False
        if not cancelable_sleep(1, job):
            return False
        if not _wait_click(driver, By.CSS_SELECTOR, 'input[type="submit"]', timeout=10, retries=3, log=log):
            log("OAuth: could not click submit after password")
            return False
        if not cancelable_sleep(3, job):
            return False

        # Stay signed in? (optional screen)
        if _wait_click(driver, By.ID, "KmsiCheckboxField", timeout=3, retries=1):
            _wait_click(driver, By.ID, "idBtn_Back", timeout=3, retries=1)
            if not cancelable_sleep(2, job):
                return False

        # Ask me later (optional MFA-setup nag)
        if _wait_click(driver, By.ID, "btnAskLater", timeout=3, retries=1):
            if not cancelable_sleep(2, job):
                return False

        # Accept permissions (optional — only on first consent for an app)
        if _wait_click(driver, By.XPATH, "//input[@value='Accept']", timeout=3, retries=1):
            if not cancelable_sleep(2, job):
                return False

        # Switch back to main window — force-switch ALWAYS, even when Instantly
        # auto-closes the OAuth popup (which it does after successful consent).
        # Without this force-switch, `driver` stays pointed at the now-dead popup
        # handle and the next account's driver.get() throws "no such window".
        try:
            wins = driver.window_handles
            if wins:
                if len(wins) > 1:
                    for h in wins[1:]:
                        try:
                            driver.switch_to.window(h)
                            driver.close()
                        except Exception:
                            pass
                driver.switch_to.window(driver.window_handles[0])
        except Exception as e:
            log(f"Window cleanup skipped: {e}")
        if not cancelable_sleep(3, job):
            return False
        log("OAuth flow completed")
        return True
    except Exception as e:
        if job is not None and job.should_stop:
            return False
        log(f"OAuth error: {e}")
        return False


def inst_add_account(driver, api_key, inst_email, inst_pass, workspace,
                     email, password, log, api_version="v1", job=None):
    """Add New → Microsoft → SMTP enabled → OAuth popup → verify API.
    Returns (driver, success). Creates fresh driver on retry.
    Honors job.should_stop — returns (driver, False) immediately when set,
    without starting a new retry, new driver, or new login."""
    retries = MAX_RETRIES_INSTANTLY
    for attempt in range(retries):
        if job is not None and job.should_stop:
            log("⏹ Stop requested — aborting retry loop")
            return driver, False
        if attempt > 0:
            old_driver = driver
            try:
                old_driver.quit()
            except Exception:
                pass
            if job is not None:
                job.unregister_driver(old_driver)
            if not cancelable_sleep(5, job):
                log("⏹ Stop requested — skipping retry")
                return driver, False
            log(f"Retry {attempt+1}/{retries} — fresh browser")
            driver = make_inst_driver()
            if job is not None:
                job.register_driver(driver)
            if not inst_login(driver, inst_email, inst_pass, log, job=job):
                continue
            if job is not None and job.should_stop:
                return driver, False
            if workspace:
                inst_switch_workspace(driver, workspace, log)
        try:
            # Defensive: make sure driver is on a live window before navigating.
            # Instantly sometimes closes the OAuth popup before we switched
            # away from it, leaving driver pointed at a dead handle.
            try:
                if driver.window_handles:
                    driver.switch_to.window(driver.window_handles[0])
            except Exception:
                pass
            driver.get("https://app.instantly.ai/app/accounts")
            if not cancelable_sleep(3, job):
                return driver, False
            inst_dismiss_overlays(driver, log)

            # Add New
            add_new_btn = WebDriverWait(driver, 10).until(
                EC.presence_of_element_located((By.XPATH, "//button[.//span[text()='Add New']]"))
            )
            inst_dismiss_overlays(driver, log)
            driver.execute_script("arguments[0].click();", add_new_btn)
            if not cancelable_sleep(2, job):
                return driver, False

            # Microsoft
            ms_opt = WebDriverWait(driver, 10).until(
                EC.presence_of_element_located((By.XPATH, '//p[text()="Microsoft"]'))
            )
            inst_dismiss_overlays(driver, log)
            driver.execute_script("arguments[0].click();", ms_opt)
            if not cancelable_sleep(2, job):
                return driver, False

            # SMTP has been enabled
            smtp_btn = WebDriverWait(driver, 10).until(
                EC.presence_of_element_located((By.XPATH, "//button[contains(text(),'SMTP has been enabled')]"))
            )
            inst_dismiss_overlays(driver, log)
            driver.execute_script("arguments[0].click();", smtp_btn)
            if not cancelable_sleep(3, job):
                return driver, False

            # Switch to OAuth popup
            wins = driver.window_handles
            if len(wins) > 1:
                driver.switch_to.window(wins[1])
                if inst_oauth(driver, email, password, log, job=job):
                    time.sleep(5)
                    check = inst_check_v2 if api_version == "v2" else inst_check_v1
                    tries = 3 if api_version == "v2" else 1
                    for vi in range(tries):
                        if vi > 0:
                            time.sleep(10 * vi)
                        if check(api_key, email, log):
                            log(f"✓ {email} verified in Instantly")
                            return driver, True
                    log(f"OAuth done but {email} not found in API")
                else:
                    log(f"OAuth failed for {email}")
            else:
                log("No OAuth popup opened")
        except TimeoutException as e:
            log(f"Timeout adding {email} (attempt {attempt+1}): {e}")
        except Exception as e:
            log(f"Error adding {email} (attempt {attempt+1}): {e}")

        try:
            driver.switch_to.window(driver.window_handles[0])
        except Exception:
            pass

    log(f"✗ FAILED: {email} after {retries} attempts")
    return driver, False


# ═══════════════════════════════════════════════════════════════════
#  INSTANTLY — JOB RUNNER
# ═══════════════════════════════════════════════════════════════════

def run_instantly_job(job):
    cfg = job.config
    api_key = cfg["api_key"]
    api_ver = cfg.get("api_version", "v1")
    inst_email = cfg["instantly_email"]
    inst_pass = cfg["instantly_password"]
    workspace = cfg.get("workspace", "")
    v2_key = cfg.get("v2_api_key", "")
    verify_key = v2_key if api_ver == "v2" and v2_key else api_key
    workers = max(1, min(5, int(cfg.get("workers", 1) or 1)))

    try:
        # 1) Fetch existing
        job.log("Fetching existing accounts…")
        if api_ver == "v2":
            existing = inst_fetch_existing_v2(verify_key, job.log)
        else:
            existing = inst_fetch_existing_v1(api_key, job.log)
        existing_set = {e.lower() for e in existing}

        # 2) Read CSV
        accounts = []
        with open(job.csv_path, newline="") as f:
            rdr = csv.DictReader(f)
            for row in rdr:
                em = (row.get("EmailAddress") or row.get("Email") or row.get("email") or "").strip()
                pw = (row.get("Password") or row.get("password") or "").strip()
                if em and pw:
                    accounts.append({"email": em, "password": pw, "row": row})

        job.total = len(accounts)
        job.log(f"CSV loaded: {job.total} accounts • {workers} parallel worker(s)")
        save_job(job)

        # 3) Split accounts round-robin across N workers so each chunk has
        #    similar size even if some accounts take longer than others.
        chunks = [[] for _ in range(workers)]
        for i, acct in enumerate(accounts):
            chunks[i % workers].append(acct)

        def worker_loop(worker_id, my_accounts):
            if not my_accounts:
                return
            prefix = f"[W{worker_id+1}] "

            def fresh_session_id():
                """Rotates the IPRoyal sticky proxy session — called on spawn +
                every driver recycle so each ~20-account chunk gets its own
                residential IP (velocity hygiene + avoids 30-min TTL expiry)."""
                return f"w{worker_id+1}-{uuid.uuid4().hex[:8]}"

            def spawn_and_prep():
                """Spawn a fresh driver, login to Instantly, switch workspace.
                Returns driver on success, None on failure (worker aborts)."""
                set_proxy_session(fresh_session_id())
                try:
                    d = make_inst_driver()
                except Exception as e:
                    job.log(prefix + f"FATAL: driver launch failed: {e}")
                    return None
                job.register_driver(d)
                if not inst_login(d, inst_email, inst_pass, job.log, job=job):
                    if not job.should_stop:
                        job.log(prefix + "login failed, worker aborting")
                    try: d.quit()
                    except Exception: pass
                    job.unregister_driver(d)
                    return None
                if job.should_stop:
                    return None
                if workspace:
                    if not inst_switch_workspace(d, workspace, job.log):
                        # Fail loud: don't upload to wrong workspace. Abort this worker
                        # cleanly — other workers continue unaffected.
                        job.mark_warning(f"worker {worker_id+1} aborted: workspace switch to '{workspace}' failed")
                        job.log(prefix + "FATAL: workspace switch failed, aborting worker")
                        try: d.quit()
                        except Exception: pass
                        job.unregister_driver(d)
                        return None
                return d

            driver = spawn_and_prep()
            if driver is None:
                return
            accounts_this_driver = 0

            try:
                for acct in my_accounts:
                    if job.should_stop:
                        break
                    if not job.wait_if_paused():
                        break

                    email = acct["email"]
                    pw = acct["password"]

                    # Resume-safety: if this job was reloaded from active_jobs
                    # and we already recorded a terminal state for this email,
                    # skip it LOCALLY without incrementing any counters (we
                    # already counted it in the prior run). Without this
                    # check, a restart-resume would re-see the account in
                    # existing_set (we uploaded it last time) and mark_skipped,
                    # double-counting it into total > job.total.
                    prior_state = (job.account_status.get(email.lower()) or {}).get("state")
                    if prior_state in ("succeeded", "failed", "skipped"):
                        continue

                    if email.lower() in existing_set:
                        job.mark_skipped()
                        job.set_account_status(email, "skipped", "already in Instantly")
                        job.log(prefix + f"Skipped (exists): {email}")
                        save_job(job)
                        continue

                    # Driver recycling: every RECYCLE_AFTER_N real OAuth
                    # attempts, tear down the driver and respawn fresh. Kills
                    # the Chromium memory-leak death spiral at ~75+ accounts
                    # and rotates the IPRoyal sticky session for velocity hygiene.
                    if accounts_this_driver >= RECYCLE_AFTER_N:
                        job.log(prefix + f"♻ Recycling driver after {accounts_this_driver} accounts…")
                        try: driver.quit()
                        except Exception: pass
                        job.unregister_driver(driver)
                        driver = spawn_and_prep()
                        if driver is None:
                            return
                        accounts_this_driver = 0

                    job.set_account_status(email, "processing")
                    job.log(prefix + f"Processing {email} ({job.processed+1}/{job.total})")
                    try:
                        new_driver, ok = inst_add_account(
                            driver, verify_key, inst_email, inst_pass, workspace,
                            email, pw, job.log, api_ver, job=job,
                        )
                        if new_driver is not driver:
                            job.unregister_driver(driver)
                            driver = new_driver
                            job.register_driver(driver)
                        if job.should_stop:
                            break
                        if ok:
                            job.mark_success()
                            job.set_account_status(email, "succeeded")
                        else:
                            job.mark_failure(acct["row"])
                            job.set_account_status(email, "failed", "OAuth/verify failed after retries")
                    except Exception as e:
                        if job.should_stop:
                            break
                        job.mark_failure(acct["row"])
                        job.set_account_status(email, "failed", str(e)[:200])
                        job.log(prefix + f"Error: {e}")

                    accounts_this_driver += 1
                    save_job(job)
                    if not cancelable_sleep(1, job):
                        break
            finally:
                if driver is not None:
                    job.unregister_driver(driver)
                    try:
                        driver.quit()
                    except Exception:
                        pass

        threads = [
            threading.Thread(target=worker_loop, args=(i, chunks[i]), daemon=True)
            for i in range(workers)
        ]
        for t in threads:
            t.start()
        for t in threads:
            t.join()

        # Reconcile counter with reality: some accounts that we marked as
        # "failed" may have actually landed in Instantly but weren't verified
        # within our 30s post-OAuth check window. Re-query the existing set
        # from the API and flip any confirmed-present accounts to success.
        if job.failed > 0 and not job.should_stop:
            job.log(f"Reconciling {job.failed} unverified account(s) against Instantly API…")
            try:
                if api_ver == "v2":
                    current_existing = inst_fetch_existing_v2(verify_key, job.log)
                else:
                    current_existing = inst_fetch_existing_v1(api_key, job.log)
                current_set = {e.lower() for e in current_existing}
                with job._lock:
                    reconciled, still_failed = [], []
                    for row in job.failed_accounts:
                        em = (
                            row.get("EmailAddress") or row.get("Email") or row.get("email") or ""
                        ).strip().lower()
                        if em and em in current_set:
                            reconciled.append(row)
                        else:
                            still_failed.append(row)
                    if reconciled:
                        job.succeeded += len(reconciled)
                        job.failed -= len(reconciled)
                        job.failed_accounts = still_failed
                        # Reflect the reconciliation in account_status too,
                        # so a retry pass below doesn't try to re-OAuth them.
                        for row in reconciled:
                            em = (
                                row.get("EmailAddress") or row.get("Email") or row.get("email") or ""
                            ).strip()
                            if em:
                                job.set_account_status(em, "succeeded", "reconciled post-OAuth")
                if reconciled:
                    job.log(
                        f"✓ Reconciled {len(reconciled)} account(s) that landed after the verify window"
                    )
            except Exception as e:
                job.log(f"Reconcile non-fatal: {e}")

        # Retry pass: anything still in failed_accounts is genuinely missing
        # from Instantly per the just-fetched existing set. Most of these
        # are transient OAuth races (the headless Chromium "_wait_type"
        # NoneType issue) that recover on a clean browser. Run them through
        # inst_add_account once more with a fresh driver; the function has
        # its own 3-attempt internal retry, and a final reconcile catches
        # any that land but verify late.
        if job.failed_accounts and not job.should_stop:
            retry_count = len(job.failed_accounts)
            job.log(f"♻ Retry pass on {retry_count} still-missing account(s) with fresh browser")

            # Snapshot + reset so the retry pass's own mark_success/failure
            # calls land with a clean slate. We accumulate retry outcomes
            # into job.succeeded / job.failed normally.
            with job._lock:
                retry_rows = list(job.failed_accounts)
                job.failed_accounts = []
                job.failed -= retry_count  # we'll re-increment below for any that fail again

            # Single-driver retry — gentler than the parallel main pass and
            # avoids spawning a second IPRoyal session right after the
            # previous pool of drivers shut down.
            set_proxy_session(f"retry-{uuid.uuid4().hex[:8]}")
            retry_driver = None
            try:
                retry_driver = make_inst_driver()
                job.register_driver(retry_driver)
                if not inst_login(retry_driver, inst_email, inst_pass, job.log, job=job):
                    job.log("Retry pass: login failed — bailing out, accounts stay marked failed")
                    with job._lock:
                        # Restore failures since we couldn't actually retry.
                        job.failed_accounts = retry_rows
                        job.failed += len(retry_rows)
                    raise RuntimeError("retry-login-failed")
                if not job.should_stop and workspace:
                    inst_switch_workspace(retry_driver, workspace, job.log)

                for idx, row in enumerate(retry_rows):
                    if job.should_stop:
                        # Push back any row whose retry didn't complete to a
                        # terminal account_status (current + everything after).
                        # Anything before idx that succeeded/failed already
                        # moved counters appropriately and won't be touched.
                        with job._lock:
                            for r in retry_rows[idx:]:
                                em = (r.get("EmailAddress") or r.get("Email") or r.get("email") or "").strip()
                                if not em:
                                    continue
                                state = (job.account_status.get(em.lower()) or {}).get("state")
                                if state not in ("succeeded", "failed", "skipped"):
                                    job.failed_accounts.append(r)
                                    job.failed += 1
                        break

                    email = (row.get("EmailAddress") or row.get("Email") or row.get("email") or "").strip()
                    pw = (row.get("Password") or row.get("password") or "").strip()
                    if not email or not pw:
                        # Malformed row — keep as failed.
                        with job._lock:
                            job.failed_accounts.append(row)
                            job.failed += 1
                        continue

                    job.set_account_status(email, "processing", "retry pass")
                    job.log(f"♻ Retry: {email}")
                    try:
                        new_driver, ok = inst_add_account(
                            retry_driver, verify_key, inst_email, inst_pass, workspace,
                            email, pw, job.log, api_ver, job=job,
                        )
                        if new_driver is not retry_driver:
                            job.unregister_driver(retry_driver)
                            retry_driver = new_driver
                            job.register_driver(retry_driver)
                        if ok:
                            job.mark_success()
                            job.set_account_status(email, "succeeded", "succeeded on retry pass")
                            job.log(f"✓ Retry succeeded: {email}")
                        else:
                            with job._lock:
                                job.failed_accounts.append(row)
                                job.failed += 1
                            job.set_account_status(email, "failed", "still failed after retry pass")
                    except Exception as e:
                        with job._lock:
                            job.failed_accounts.append(row)
                            job.failed += 1
                        job.set_account_status(email, "failed", f"retry exception: {str(e)[:160]}")
                        job.log(f"Retry error for {email}: {e}")
            except Exception as e:
                # Setup failure (driver launch, login). Already restored
                # failed_accounts above on login failure; for other paths
                # the per-account loop handles its own bookkeeping.
                job.log(f"Retry pass setup failed: {e}")
            finally:
                if retry_driver is not None:
                    job.unregister_driver(retry_driver)
                    try:
                        retry_driver.quit()
                    except Exception:
                        pass

            # Final reconcile after retry — catches any retry that succeeded
            # OAuth-side but missed its own verify window.
            if job.failed_accounts and not job.should_stop:
                try:
                    if api_ver == "v2":
                        current_existing = inst_fetch_existing_v2(verify_key, job.log)
                    else:
                        current_existing = inst_fetch_existing_v1(api_key, job.log)
                    current_set = {e.lower() for e in current_existing}
                    with job._lock:
                        late_recon, still_failed = [], []
                        for row in job.failed_accounts:
                            em = (
                                row.get("EmailAddress") or row.get("Email") or row.get("email") or ""
                            ).strip().lower()
                            if em and em in current_set:
                                late_recon.append(row)
                            else:
                                still_failed.append(row)
                        if late_recon:
                            job.succeeded += len(late_recon)
                            job.failed -= len(late_recon)
                            job.failed_accounts = still_failed
                    if late_recon:
                        job.log(f"✓ Post-retry reconcile: {len(late_recon)} more landed")
                except Exception as e:
                    job.log(f"Post-retry reconcile non-fatal: {e}")

            job.log(
                f"♻ Retry pass complete — {job.succeeded} succeeded, "
                f"{job.failed} still failed, {job.skipped} skipped of {job.total}"
            )

        # Finish disposition logic — the historical default of always calling
        # finish("completed") unless .should_stop masked catastrophic outcomes
        # like "every worker aborted on workspace-switch failure so we did
        # zero work but technically reached the end of the function". That
        # looked like a green run to the azure poller. Flag it as failed if
        # the job had accounts to process but processed none.
        if job.should_stop:
            job.finish("cancelled")
        elif job.total > 0 and job.processed == 0:
            job.log(
                "⚠ Job ran end-to-end without processing any accounts "
                "(workers likely aborted during setup) — marking FAILED"
            )
            job.finish("failed")
        else:
            job.finish("completed")

    except Exception as e:
        job.log(f"Fatal error: {e}")
        job.finish("failed")


# ═══════════════════════════════════════════════════════════════════
#  SMARTLEAD — API HELPERS
# ═══════════════════════════════════════════════════════════════════

def sl_fetch_existing(api_key, log):
    """Fetch all existing emails from Smartlead."""
    base = "https://server.smartlead.ai/api/v1/email-accounts/"
    accounts = []
    offset = 0
    try:
        while True:
            r = http_req.get(f"{base}?api_key={api_key}&offset={offset}&limit=100", timeout=30)
            if r.status_code != 200:
                log(f"Smartlead fetch error: {r.status_code}")
                break
            data = r.json()
            if not data:
                break
            accounts.extend(data)
            if len(data) < 100:
                break
            offset += 100
    except Exception as e:
        log(f"Smartlead fetch exception: {e}")
    emails = [a.get("from_email", "") for a in accounts]
    log(f"Smartlead: {len(emails)} existing accounts")
    return emails


def sl_check_added(api_key, email, log):
    """Verify a specific account exists in Smartlead.

    Paginates through /api/v1/email-accounts (100 per page, up to 5000
    accounts = 50 pages). Early-exits the moment we find the target email.

    HISTORICAL NOTE: parity fix with inst_check_v1. The old version only
    checked the first 100 accounts, which silently missed newly-added ones
    in Smartlead workspaces with >100 existing accounts (same false-
    negative pattern that made the Instantly uploader retry accounts
    that had actually landed). See PR #30 for the Instantly version of
    this fix.
    """
    try:
        offset = 0
        while True:
            r = http_req.get(
                f"https://server.smartlead.ai/api/v1/email-accounts/?api_key={api_key}&offset={offset}&limit=100",
                timeout=30,
            )
            if r.status_code != 200:
                log(f"Smartlead check HTTP {r.status_code}")
                return False
            accts = r.json()
            if not accts:
                return False
            if any(a.get("from_email", "") == email for a in accts):
                return True
            if len(accts) < 100:
                return False
            offset += 100
            if offset >= 5000:
                log(f"Smartlead check: hit 5000-account pagination cap while searching for {email}")
                return False
    except Exception as e:
        log(f"Smartlead check error: {e}")
    return False


# ═══════════════════════════════════════════════════════════════════
#  SMARTLEAD — SELENIUM UPLOAD  (exact flows from sl-python.py)
# ═══════════════════════════════════════════════════════════════════

def make_sl_driver():
    """Visible Chrome for local use — headless disabled so you can watch
    the OAuth flow and intervene if Microsoft prompts for 2FA / CAPTCHA.
    Set SMARTLEAD_HEADLESS=1 or HEADLESS=1 to re-enable headless (cloud)."""
    opts = webdriver.ChromeOptions()
    if os.environ.get("SMARTLEAD_HEADLESS") == "1":
        opts.add_argument("--headless")
    opts.add_argument("--no-sandbox")
    opts.add_argument("--disable-dev-shm-usage")
    opts.add_argument("--disable-gpu")
    _apply_cloud_opts(opts)
    return _build_chrome(opts)


def sl_oauth_flow(driver, email, password, log, job=None):
    """MS OAuth via Smartlead login URL — exact match to sl-python.py.
    Uses NoneType-tolerant helpers + cancelable_sleep so Stop interrupts within
    ~200ms even mid-OAuth."""
    if job is not None and job.should_stop:
        return False
    try:
        # Username
        log(f"Entering username: {email}")
        if not _wait_type(driver, By.NAME, "loginfmt", email, timeout=10, retries=3):
            return False
        if not _wait_click(driver, By.CSS_SELECTOR, 'input[type="submit"]', timeout=10, retries=3, log=log):
            return False
        if not cancelable_sleep(5, job):
            return False

        # Password
        log("Entering password")
        if not _wait_type(driver, By.NAME, "passwd", password, timeout=10, retries=3):
            return False
        if not _wait_click(driver, By.CSS_SELECTOR, 'input[type="submit"]', timeout=10, retries=3, log=log):
            return False
        if not cancelable_sleep(5, job):
            return False

        # Stay signed in (optional)
        if _wait_click(driver, By.ID, "KmsiCheckboxField", timeout=3, retries=1):
            _wait_click(driver, By.ID, "idBtn_Back", timeout=3, retries=1)
        if not cancelable_sleep(5, job):
            return False

        # Ask me later (optional MFA-setup nag)
        _wait_click(driver, By.ID, "btnAskLater", timeout=3, retries=1)
        if not cancelable_sleep(5, job):
            return False

        # Extra submit (optional — Smartlead callback)
        _wait_click(driver, By.CSS_SELECTOR, 'input[type="submit"]', timeout=3, retries=1)
        if not cancelable_sleep(2, job):
            return False

        return True
    except Exception as e:
        if job is not None and job.should_stop:
            return False
        log(f"Smartlead OAuth error: {e}")
        return False


def run_smartlead_upload(job):
    """Background thread: upload accounts to Smartlead via headless Chrome."""
    cfg = job.config
    api_key = cfg["api_key"]
    login_url = cfg["login_url"]

    try:
        job.log("Fetching existing Smartlead accounts…")
        existing = sl_fetch_existing(api_key, job.log)
        existing_set = set(existing)

        accounts = []
        with open(job.csv_path, newline="") as f:
            for row in csv.DictReader(f):
                accounts.append({
                    "email": (row.get("EmailAddress") or row.get("Email") or row.get("email") or "").strip(),
                    "password": (row.get("Password") or row.get("password") or "").strip(),
                    "row": row,
                })

        job.total = len(accounts)
        job.log(f"CSV loaded: {job.total} accounts")
        save_job(job)

        for acct in accounts:
            if job.should_stop:
                break
            if not job.wait_if_paused():
                break

            email = acct["email"]
            pw = acct["password"]

            # Resume-safety (see run_instantly_job for rationale): skip
            # accounts we already recorded a terminal state for, without
            # double-counting on restart-resume.
            prior_state = (job.account_status.get(email.lower()) or {}).get("state")
            if prior_state in ("succeeded", "failed", "skipped"):
                continue

            if email in existing_set:
                job.mark_skipped()
                job.set_account_status(email, "skipped", "already in Smartlead")
                job.log(f"Skipped (exists): {email}")
                save_job(job)
                continue

            job.set_account_status(email, "processing")
            success = False
            for attempt in range(MAX_RETRIES_SMARTLEAD):
                if job.should_stop:
                    break
                if not job.wait_if_paused():
                    break
                job.log(f"Processing {email}: attempt {attempt+1}/{MAX_RETRIES_SMARTLEAD}")
                driver = None
                try:
                    driver = make_sl_driver()
                    job.register_driver(driver)
                    driver.get(login_url)
                    if not cancelable_sleep(5, job):
                        break

                    if sl_oauth_flow(driver, email, pw, job.log, job=job):
                        if job.should_stop:
                            break
                        job.log(f"Checking if {email} was added…")
                        if sl_check_added(api_key, email, job.log):
                            job.log(f"✓ {email} added to Smartlead")
                            success = True
                            break
                        else:
                            job.log(f"{email} not found, retrying…")
                    else:
                        if job.should_stop:
                            break
                        job.log(f"OAuth failed for {email}, retrying…")
                except Exception as e:
                    if job.should_stop:
                        break
                    job.log(f"Error attempt {attempt+1}: {e}")
                finally:
                    if driver is not None:
                        job.unregister_driver(driver)
                        try:
                            driver.quit()
                        except Exception:
                            pass
                if not cancelable_sleep(2, job):
                    break

            if job.should_stop:
                break
            if success:
                job.mark_success()
                job.set_account_status(email, "succeeded")
            else:
                job.mark_failure(acct["row"])
                job.set_account_status(email, "failed", "All Smartlead OAuth attempts failed")

            save_job(job)

        # Reconcile + retry pass — mirror of the Instantly path. After the
        # main loop, anything in failed_accounts gets re-checked against
        # the Smartlead API; if landed late we flip to succeeded. If
        # genuinely missing, we run the OAuth flow once more with a fresh
        # browser. The function-level retry inside sl_oauth_flow already
        # handles per-attempt flakiness; this end-of-job pass catches the
        # cumulative-failure case (e.g. all 4 inner retries hit the
        # _wait_type race).
        if job.failed > 0 and not job.should_stop:
            job.log(f"Reconciling {job.failed} unverified account(s) against Smartlead API…")
            try:
                current_existing = sl_fetch_existing(api_key, job.log)
                current_set = set(current_existing)
                with job._lock:
                    reconciled, still_failed = [], []
                    for row in job.failed_accounts:
                        em = (
                            row.get("EmailAddress") or row.get("Email") or row.get("email") or ""
                        ).strip()
                        if em and em in current_set:
                            reconciled.append(row)
                        else:
                            still_failed.append(row)
                    if reconciled:
                        job.succeeded += len(reconciled)
                        job.failed -= len(reconciled)
                        job.failed_accounts = still_failed
                        for row in reconciled:
                            em = (
                                row.get("EmailAddress") or row.get("Email") or row.get("email") or ""
                            ).strip()
                            if em:
                                job.set_account_status(em, "succeeded", "reconciled post-OAuth")
                if reconciled:
                    job.log(f"✓ Reconciled {len(reconciled)} account(s) that landed late")
            except Exception as e:
                job.log(f"Smartlead reconcile non-fatal: {e}")

        if job.failed_accounts and not job.should_stop:
            retry_count = len(job.failed_accounts)
            job.log(f"♻ Smartlead retry pass on {retry_count} still-missing account(s)")

            with job._lock:
                retry_rows = list(job.failed_accounts)
                job.failed_accounts = []
                job.failed -= retry_count

            set_proxy_session(f"sl-retry-{uuid.uuid4().hex[:8]}")
            for idx, row in enumerate(retry_rows):
                if job.should_stop:
                    # Push back any row whose retry hasn't completed yet
                    # (current + remaining). Earlier rows that already
                    # mark_success'd or got their state set to failed are
                    # in their correct counter buckets and untouched here.
                    with job._lock:
                        for r in retry_rows[idx:]:
                            em = (r.get("EmailAddress") or r.get("Email") or r.get("email") or "").strip()
                            if not em:
                                continue
                            state = (job.account_status.get(em.lower()) or {}).get("state")
                            if state not in ("succeeded", "failed", "skipped"):
                                job.failed_accounts.append(r)
                                job.failed += 1
                    break

                email = (row.get("EmailAddress") or row.get("Email") or row.get("email") or "").strip()
                pw = (row.get("Password") or row.get("password") or "").strip()
                if not email or not pw:
                    with job._lock:
                        job.failed_accounts.append(row)
                        job.failed += 1
                    continue

                job.set_account_status(email, "processing", "retry pass")
                job.log(f"♻ Smartlead retry: {email}")
                driver = None
                landed = False
                try:
                    driver = make_sl_driver()
                    job.register_driver(driver)
                    driver.get(login_url)
                    if cancelable_sleep(5, job) and sl_oauth_flow(driver, email, pw, job.log, job=job):
                        if cancelable_sleep(3, job) and sl_check_added(api_key, email, job.log):
                            landed = True
                except Exception as e:
                    job.log(f"Smartlead retry error for {email}: {e}")
                finally:
                    if driver is not None:
                        job.unregister_driver(driver)
                        try:
                            driver.quit()
                        except Exception:
                            pass

                if landed:
                    job.mark_success()
                    job.set_account_status(email, "succeeded", "succeeded on retry pass")
                    job.log(f"✓ Retry succeeded: {email}")
                else:
                    with job._lock:
                        job.failed_accounts.append(row)
                        job.failed += 1
                    job.set_account_status(email, "failed", "still failed after retry pass")

            # Final reconcile after retry — accounts that OAuth'd but
            # missed sl_check_added's window.
            if job.failed_accounts and not job.should_stop:
                try:
                    current_existing = sl_fetch_existing(api_key, job.log)
                    current_set = set(current_existing)
                    with job._lock:
                        late_recon, still_failed = [], []
                        for row in job.failed_accounts:
                            em = (
                                row.get("EmailAddress") or row.get("Email") or row.get("email") or ""
                            ).strip()
                            if em and em in current_set:
                                late_recon.append(row)
                            else:
                                still_failed.append(row)
                        if late_recon:
                            job.succeeded += len(late_recon)
                            job.failed -= len(late_recon)
                            job.failed_accounts = still_failed
                    if late_recon:
                        job.log(f"✓ Post-retry reconcile: {len(late_recon)} more landed")
                except Exception as e:
                    job.log(f"Post-retry Smartlead reconcile non-fatal: {e}")

            job.log(
                f"♻ Smartlead retry pass complete — {job.succeeded} succeeded, "
                f"{job.failed} still failed, {job.skipped} skipped of {job.total}"
            )

        # Finish disposition: failed if non-zero accounts to process but
        # zero made it through. Otherwise normal completion.
        if job.should_stop:
            job.finish("cancelled")
        elif job.total > 0 and job.processed == 0:
            job.log(
                "⚠ Smartlead job ran end-to-end without processing any accounts — marking FAILED"
            )
            job.finish("failed")
        else:
            job.finish("completed")
    except Exception as e:
        job.log(f"Fatal error: {e}")
        job.finish("failed")


# ═══════════════════════════════════════════════════════════════════
#  SMARTLEAD — WARMUP & SENDING CONFIG  (from sl-complete.py)
# ═══════════════════════════════════════════════════════════════════

def slw_fetch_domain_ids(api_key, domain, log):
    """Fetch account IDs matching a domain."""
    base = "https://server.smartlead.ai/api/v1/email-accounts/"
    params = {"api_key": api_key, "offset": 0, "limit": 100}
    ids = []
    try:
        while True:
            r = http_req.get(base, params=params, timeout=30)
            r.raise_for_status()
            data = r.json()
            if not data:
                break
            for item in data:
                if domain in item.get("from_email", ""):
                    ids.append(item["id"])
            if len(data) < params["limit"]:
                break
            params["offset"] += params["limit"]
    except Exception as e:
        log(f"Domain fetch error: {e}")
    log(f"Found {len(ids)} accounts for {domain}")
    return ids


def slw_update_warmup(api_key, aid, log):
    url = f"https://server.smartlead.ai/api/v1/email-accounts/{aid}/warmup?api_key={api_key}"
    try:
        r = http_req.post(url, json={
            "warmup_enabled": True,
            "total_warmup_per_day": 5,
            "reply_rate_percentage": 30,
        }, headers={"Content-Type": "application/json"}, timeout=30)
        return r.status_code == 200
    except Exception as e:
        log(f"Warmup error {aid}: {e}")
        return False


def slw_update_sending(api_key, aid, log):
    url = f"https://server.smartlead.ai/api/v1/email-accounts/{aid}?api_key={api_key}"
    try:
        r = http_req.post(url, json={
            "max_email_per_day": 5,
            "time_to_wait_in_mins": 61,
        }, headers={"Content-Type": "application/json"}, timeout=30)
        return r.status_code == 200
    except Exception as e:
        log(f"Sending error {aid}: {e}")
        return False


def extract_domains(csv_path):
    domains = set()
    try:
        with open(csv_path, newline="") as f:
            for row in csv.DictReader(f):
                em = row.get("EmailAddress") or row.get("Email") or row.get("email") or ""
                if "@" in em:
                    d = em.split("@")[1].strip()
                    if d:
                        domains.add(d)
    except Exception as e:
        print(f"Domain extract error: {e}")
    return list(domains)


def run_smartlead_warmup(job):
    """Background thread: configure warmup & sending for Smartlead accounts."""
    cfg = job.config
    api_key = cfg["api_key"]
    domains = cfg.get("domains", [])

    try:
        all_ids = []
        for domain in domains:
            job.log(f"Fetching accounts for domain: {domain}")
            ids = slw_fetch_domain_ids(api_key, domain, job.log)
            all_ids.extend([(aid, domain) for aid in ids])

        if not all_ids:
            job.log("No accounts found for any domain")
            job.finish("completed")
            return

        job.total = len(all_ids)
        job.log(f"Total accounts to configure: {job.total}")
        save_job(job)

        warmup_ok = 0
        sending_ok = 0
        for aid, domain in all_ids:
            if job.should_stop:
                break
            if not job.wait_if_paused():
                break

            job.log(f"Configuring account {aid} ({domain})")
            if slw_update_warmup(api_key, aid, job.log):
                warmup_ok += 1
            if slw_update_sending(api_key, aid, job.log):
                sending_ok += 1
                job.succeeded += 1
            else:
                job.failed += 1

            job.processed += 1
            save_job(job)
            time.sleep(2)

        job.log(f"Warmup OK: {warmup_ok}/{job.total} | Sending OK: {sending_ok}/{job.total}")
        job.finish("cancelled" if job.should_stop else "completed")
    except Exception as e:
        job.log(f"Fatal error: {e}")
        job.finish("failed")


# ═══════════════════════════════════════════════════════════════════
#  JOB THREAD WRAPPER — releases concurrent-jobs semaphore on exit
# ═══════════════════════════════════════════════════════════════════

def _spawn_job_thread(target, job):
    """Start the job's background thread with a try/finally that releases
    the _job_slots semaphore when the target returns (success, error, or
    crash). Without this wrapper, a crash in run_instantly_job would leak
    a slot and the server would eventually refuse new jobs."""
    def _runner():
        try:
            target(job)
        finally:
            try:
                _job_slots.release()
            except ValueError:
                pass  # already released — defensive
    threading.Thread(target=_runner, daemon=True).start()


# ═══════════════════════════════════════════════════════════════════
#  RESUME — pick up where a previous process instance left off
# ═══════════════════════════════════════════════════════════════════

def load_active_jobs_and_resume():
    """Called at module import (gunicorn worker startup). Finds any jobs
    that were non-terminal when the previous process died and rebuilds their
    JobState in memory + re-spawns their worker threads.

    The worker functions re-fetch the existing-accounts set from the ESP API
    at start of run, so anything uploaded before the restart is picked up in
    that set. Combined with the account_status "prior_state" early-return in
    the per-account loops, this means resume is idempotent: accounts already
    recorded as succeeded/failed/skipped are skipped locally WITHOUT being
    re-counted, and untouched accounts continue as normal.

    Notes on edge cases:
      - CSV path persistence: CSVs live in UPLOAD_DIR which is rooted at
        DATA_DIR (the Railway volume mount). They survive container restarts.
      - Concurrency: we re-acquire _job_slots blocking. If MAX_CONCURRENT_JOBS
        changed between runs (e.g. env var bumped down), resumed jobs queue
        serially as slots free up — same behavior as if they'd been
        submitted via /api/start.
      - Failure during resume: if the resume itself throws, log and skip
        that row. The job stays in active_jobs (next restart tries again)
        rather than silently disappearing.
    """
    try:
        with sqlite3.connect(DB_PATH) as conn:
            conn.row_factory = sqlite3.Row
            rows = conn.execute("SELECT * FROM active_jobs").fetchall()
    except Exception as e:
        print(f"[resume] failed to read active_jobs: {e}", flush=True)
        return

    if not rows:
        return

    print(f"[resume] found {len(rows)} active_jobs row(s) to evaluate", flush=True)

    for row in rows:
        status = row["status"] or ""

        # Terminal rows shouldn't stay here (finish() calls clear_active_job),
        # but a crash mid-finish could leave one behind. Clean up.
        if status in ("completed", "failed", "cancelled"):
            try:
                with sqlite3.connect(DB_PATH) as conn:
                    conn.execute("DELETE FROM active_jobs WHERE id = ?", (row["id"],))
                    conn.commit()
            except Exception:
                pass
            continue

        # Verify CSV is still on disk — without it, resume is impossible.
        csv_path = row["csv_path"]
        if not csv_path or not os.path.exists(csv_path):
            print(f"[resume] job {row['id']} has no CSV at {csv_path!r} — marking failed", flush=True)
            try:
                with sqlite3.connect(DB_PATH) as conn:
                    conn.execute("DELETE FROM active_jobs WHERE id = ?", (row["id"],))
                    conn.commit()
            except Exception:
                pass
            continue

        try:
            config = json.loads(row["config_json"] or "{}")
            config_safe = json.loads(row["config_safe_json"] or "{}")
            job = JobState(
                row["id"], row["platform"], row["mode"], row["total"] or 0,
                csv_path, config, config_safe,
            )
            job.processed = row["processed"] or 0
            job.succeeded = row["succeeded"] or 0
            job.failed = row["failed"] or 0
            job.skipped = row["skipped"] or 0
            job.warnings = row["warnings"] or 0
            job.account_status = json.loads(row["account_status_json"] or "{}")
            job.failed_accounts = json.loads(row["failed_accounts_json"] or "[]")
            # Restore last 500 log lines so the UI + SSE has context on first poll.
            job.logs = json.loads(row["logs_json"] or "[]")
            job.started_at = row["started_at"] or job.started_at
            # Always flip status back to running — we're about to re-spawn
            # the threads. If the previous run was paused, a human can
            # pause again post-resume via /api/pause.
            job.status = "running"

            jobs[row["id"]] = job

            # Prominent resume log so Railway logs show what happened.
            job.log(
                f"♻ Resumed after uploader restart — {job.succeeded}/{job.total} succeeded, "
                f"{job.failed} failed, {job.skipped} skipped, {job.warnings} warnings. "
                f"Remaining work starts from where the previous worker stopped."
            )
            persist_job(job)

            # Re-acquire the concurrency slot. Blocks if MAX_CONCURRENT_JOBS
            # slots are already taken — which shouldn't happen at startup
            # but is safe if a future change introduces more resume parallelism.
            _job_slots.acquire()

            if job.platform == "instantly":
                _spawn_job_thread(run_instantly_job, job)
            elif job.platform == "smartlead_upload":
                _spawn_job_thread(run_smartlead_upload, job)
            elif job.platform == "smartlead_warmup":
                _spawn_job_thread(run_smartlead_warmup, job)
            else:
                job.log(f"Unknown platform {job.platform!r} — cannot resume, marking failed")
                job.finish("failed")
                # Release the slot we just grabbed since _spawn_job_thread
                # didn't get called.
                try:
                    _job_slots.release()
                except ValueError:
                    pass
        except Exception as e:
            print(f"[resume] failed to restore job {row['id']}: {e}", flush=True)
            # Leave the row in place so next restart retries. Better than
            # silently dropping work.


# ═══════════════════════════════════════════════════════════════════
#  FLASK ROUTES
# ═══════════════════════════════════════════════════════════════════

@app.route("/")
def index():
    return render_template("index.html")


@app.route("/health")
def health():
    """Liveness + basic metrics. Cheap to hit, no side effects."""
    running = [j for j in jobs.values() if j.status == "running"]
    return jsonify({
        "status": "ok",
        "uptime_seconds": int(time.time() - _startup_time),
        "server": "gunicorn" if _IS_GUNICORN else "flask-dev",
        "active_jobs": len(running),
        "tracked_jobs": len(jobs),
        "max_concurrent_jobs": MAX_CONCURRENT_JOBS,
        "recycle_after_n": RECYCLE_AFTER_N,
        "has_proxy": bool(os.environ.get("PROXY_URL")),
        "headless": os.environ.get("HEADLESS", "") == "1",
    })


@app.route("/api/start", methods=["POST"])
def api_start():
    platform = request.form.get("platform")

    # Save CSV (either a fresh upload or reuse a previous one by path)
    csv_file = request.files.get("csv_file")
    reuse_path = (request.form.get("reuse_csv_path") or "").strip()
    csv_path = None
    if csv_file and csv_file.filename:
        csv_path = os.path.join(UPLOAD_DIR, f"{uuid.uuid4().hex}_{csv_file.filename}")
        csv_file.save(csv_path)
    elif reuse_path and reuse_path.startswith(UPLOAD_DIR) and os.path.exists(reuse_path):
        # Safety check: only allow reusing files INSIDE our uploads dir. Never
        # let an arbitrary filesystem path in via the API.
        csv_path = reuse_path

    job_id = uuid.uuid4().hex[:12]

    if platform == "instantly":
        mode = request.form.get("mode", "single")
        try:
            workers = int(request.form.get("workers", "1"))
        except (TypeError, ValueError):
            workers = 1
        workers = max(1, min(5, workers))
        cfg = {
            "api_key": request.form.get("api_key", "").strip(),
            "api_version": request.form.get("api_version", "v1"),
            "instantly_email": request.form.get("instantly_email", "").strip(),
            "instantly_password": request.form.get("instantly_password", "").strip(),
            "workspace": request.form.get("workspace", "").strip() if mode == "multi" else "",
            "v2_api_key": request.form.get("v2_api_key", "").strip(),
            "workers": workers,
        }
        safe = {"platform": "Instantly", "mode": mode, "api_version": cfg["api_version"],
                "email": cfg["instantly_email"], "workspace": cfg.get("workspace", ""),
                "workers": workers}
        if not csv_path:
            return jsonify({"error": "CSV file is required"}), 400

        total = 0
        try:
            with open(csv_path) as f:
                total = sum(1 for _ in csv.DictReader(f))
        except Exception:
            pass

        # Concurrent-jobs cap: prevents OS thread exhaustion from parallel
        # uploads. Semaphore released at job end by _spawn_job_thread.
        if not _job_slots.acquire(blocking=False):
            return jsonify({
                "error": f"Too many concurrent jobs (max {MAX_CONCURRENT_JOBS}). Wait for a current job to finish."
            }), 429

        job = JobState(job_id, "instantly", mode, total, csv_path, cfg, safe)
        jobs[job_id] = job
        save_job(job)
        # Persist the initial job snapshot BEFORE the worker thread even
        # starts, so a crash between here and the first mark_* call still
        # leaves a resumable row in active_jobs.
        persist_job(job)
        _spawn_job_thread(run_instantly_job, job)

    elif platform == "smartlead_upload":
        cfg = {
            "api_key": request.form.get("api_key", "").strip(),
            "login_url": request.form.get("login_url", "").strip(),
        }
        safe = {"platform": "Smartlead", "mode": "upload"}
        if not csv_path:
            return jsonify({"error": "CSV file is required"}), 400

        total = 0
        try:
            with open(csv_path) as f:
                total = sum(1 for _ in csv.DictReader(f))
        except Exception:
            pass

        if not _job_slots.acquire(blocking=False):
            return jsonify({
                "error": f"Too many concurrent jobs (max {MAX_CONCURRENT_JOBS}). Wait for a current job to finish."
            }), 429
        job = JobState(job_id, "smartlead_upload", "upload", total, csv_path, cfg, safe)
        jobs[job_id] = job
        save_job(job)
        persist_job(job)
        _spawn_job_thread(run_smartlead_upload, job)

    elif platform == "smartlead_warmup":
        cfg = {"api_key": request.form.get("api_key", "").strip()}
        domain_input = request.form.get("domain", "").strip()
        domains = []
        if csv_path:
            domains = extract_domains(csv_path)
        if domain_input:
            domains.append(domain_input)
        domains = list(set(domains))
        cfg["domains"] = domains

        if not _job_slots.acquire(blocking=False):
            return jsonify({
                "error": f"Too many concurrent jobs (max {MAX_CONCURRENT_JOBS}). Wait for a current job to finish."
            }), 429
        safe = {"platform": "Smartlead", "mode": "warmup", "domains": domains}
        job = JobState(job_id, "smartlead_warmup", "warmup", 0, csv_path, cfg, safe)
        jobs[job_id] = job
        save_job(job)
        persist_job(job)
        _spawn_job_thread(run_smartlead_warmup, job)

    else:
        return jsonify({"error": "Invalid platform"}), 400

    return jsonify({"job_id": job_id, "status": "started"})


@app.route("/api/status/<job_id>")
def api_status(job_id):
    job = jobs.get(job_id)
    if not job:
        return jsonify({"error": "Job not found"}), 404
    # Include per-account status only when caller asks (?detail=1) — it can
    # be large for 99-account runs.
    detail = request.args.get("detail", "0") == "1"
    return jsonify(job.to_dict(include_full_logs=detail, include_account_status=detail))


@app.route("/api/stream/<job_id>")
def api_stream(job_id):
    """Server-Sent Events stream of log lines + counter updates for a running
    job. Powers the UI's live log view. Polls the in-memory job every 1s and
    emits new log lines + a summary event. Closes the stream on terminal state.
    NOTE: Flask's dev server serializes SSE across concurrent requests; under
    gunicorn with gthread workers, each SSE client gets its own thread so
    multiple viewers work fine."""
    job = jobs.get(job_id)
    if not job:
        return jsonify({"error": "Job not found"}), 404

    def gen():
        last_log_idx = 0
        last_sig = None
        heartbeat_counter = 0
        while True:
            # Snapshot
            with job._lock:
                logs_snap = list(job.logs)
                counters = (job.status, job.processed, job.succeeded,
                            job.failed, job.skipped, job.warnings)
            # Emit any new log lines
            if len(logs_snap) > last_log_idx:
                new_lines = logs_snap[last_log_idx:]
                last_log_idx = len(logs_snap)
                payload = json.dumps({"type": "logs", "lines": new_lines})
                yield f"data: {payload}\n\n"
            # Emit counters when they change
            if counters != last_sig:
                last_sig = counters
                payload = json.dumps({
                    "type": "counters",
                    "status": counters[0], "processed": counters[1],
                    "succeeded": counters[2], "failed": counters[3],
                    "skipped": counters[4], "warnings": counters[5],
                    "total": job.total,
                })
                yield f"data: {payload}\n\n"
            # Close on terminal state
            if counters[0] in ("completed", "failed", "cancelled"):
                yield f"data: {json.dumps({'type':'end','status':counters[0]})}\n\n"
                return
            # Heartbeat keeps intermediaries (Railway edge) from closing the stream
            heartbeat_counter += 1
            if heartbeat_counter % 15 == 0:
                yield ": heartbeat\n\n"
            time.sleep(1)

    from flask import Response
    return Response(gen(), mimetype="text/event-stream", headers={
        "Cache-Control": "no-cache",
        "X-Accel-Buffering": "no",  # disable buffering for nginx/proxies
    })


@app.route("/api/pause/<job_id>", methods=["POST"])
def api_pause(job_id):
    job = jobs.get(job_id)
    if not job:
        return jsonify({"error": "Job not found"}), 404
    job.pause()
    return jsonify({"status": "paused"})


@app.route("/api/resume/<job_id>", methods=["POST"])
def api_resume(job_id):
    job = jobs.get(job_id)
    if not job:
        return jsonify({"error": "Job not found"}), 404
    job.resume()
    return jsonify({"status": "running"})


@app.route("/api/stop/<job_id>", methods=["POST"])
def api_stop(job_id):
    job = jobs.get(job_id)
    if not job:
        return jsonify({"error": "Job not found"}), 404
    job.request_stop()
    return jsonify({"status": "stopping"})


@app.route("/api/history")
def api_history():
    return jsonify(load_history())


@app.route("/api/history/<job_id>/rerun-config")
def api_history_rerun_config(job_id):
    """Return the full saved config for a past job so the UI can restore
    form fields + pre-select the CSV without the user re-typing everything."""
    with sqlite3.connect(DB_PATH) as conn:
        conn.row_factory = sqlite3.Row
        row = conn.execute("SELECT * FROM job_history WHERE id = ?", (job_id,)).fetchone()
    if not row:
        return jsonify({"error": "Job not found"}), 404
    try:
        cfg = json.loads(row["config"]) if row["config"] else {}
    except Exception:
        cfg = {}
    csv_path = cfg.pop("_csv_path", None)
    cfg.pop("_safe", None)  # drop the display-safe subset; UI uses the full config
    csv_exists = bool(csv_path and os.path.exists(csv_path))
    csv_name = os.path.basename(csv_path) if csv_path else None
    # Strip our uuid_ prefix for display: "abc123_accounts.csv" -> "accounts.csv"
    if csv_name and "_" in csv_name:
        parts = csv_name.split("_", 1)
        if len(parts[0]) >= 8:
            csv_name = parts[1]
    return jsonify({
        "platform": row["platform"],
        "mode": row["mode"],
        "config": cfg,
        "csv_path": csv_path if csv_exists else None,
        "csv_name": csv_name,
        "csv_exists": csv_exists
    })


@app.route("/api/history/<job_id>", methods=["DELETE"])
def api_delete_history(job_id):
    with sqlite3.connect(DB_PATH) as conn:
        conn.execute("DELETE FROM job_history WHERE id = ?", (job_id,))
        conn.commit()
    return jsonify({"ok": True})


@app.route("/api/history/clear", methods=["POST"])
def api_clear_history():
    with sqlite3.connect(DB_PATH) as conn:
        conn.execute("DELETE FROM job_history")
        conn.commit()
    return jsonify({"ok": True})


# ═══════════════════════════════════════════════════════════════════
#  ENTRY POINT
# ═══════════════════════════════════════════════════════════════════

def _startup_banner():
    """Print a prominent banner so Railway logs make it obvious which WSGI
    server is actually running. Catches the class of bug where the Dockerfile
    says `gunicorn` but somehow Flask dev server boots instead."""
    server = "gunicorn" if _IS_GUNICORN else "flask-dev"
    print("=" * 60, flush=True)
    print(f"  Email Uploader — server={server}", flush=True)
    print(f"  MAX_CONCURRENT_JOBS={MAX_CONCURRENT_JOBS} "
          f"RECYCLE_AFTER_N={RECYCLE_AFTER_N} "
          f"HEADLESS={os.environ.get('HEADLESS','0')} "
          f"PROXY={'on' if os.environ.get('PROXY_URL') else 'off'}",
          flush=True)
    print(f"  DATA_DIR={DATA_DIR}", flush=True)
    print("=" * 60, flush=True)


# Fire at module import time too — gunicorn boots by importing the module,
# so this logs on cold start even though __main__ branch won't run.
init_db()
_startup_banner()
# Resume any jobs that were non-terminal when the previous process died.
# Needs init_db() above (for the active_jobs table) and all JobState +
# run_* functions defined below already — Python hoists function defs so
# the call at module bottom sees them.
load_active_jobs_and_resume()


if __name__ == "__main__":
    port = int(os.environ.get("PORT", "5050"))
    app.run(host="0.0.0.0", port=port, debug=False)
