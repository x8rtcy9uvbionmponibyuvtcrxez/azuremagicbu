# Bulletproof plan — bug by bug

**Last updated:** 2026-04-30
**Scope:** Every bug we are fixing, every change we are making, with evidence, second-order consequences, and the argument for why each step contributes to making the pipeline bulletproof.
**Out of scope:**
- Security fixes (API auth, password leak via `/api/*`, PowerShell escape gaps) — explicitly descoped per operator: "doesn't matter right now." Was Area 1 + Area 3 in an earlier draft. Re-added later if priorities change.
- Selenium → API replacement (Phase 3 in `BULLETPROOF_PLAN.md`).
- Test infrastructure. Multi-operator. HA. Public API. The deferral of these is intentional and discussed at the end.

**Operator-requested feature work added in this revision:** see Area 12 ("UX + correctness asks"). Seven items: cumulative uploader log + queue, sort-tenant-by-name, unique mailbox passwords, sort progress cards by status, "I've Entered the Code" stays visible + verifies connection, display-name post-flow verification, drop Instantly v1 entirely.

---

## How to read this doc

Every entry has the same shape:

> **What's wrong** — the bug in plain English.
> **Where** — file/line citations.
> **Evidence** — what actually proves this is real (code, DB row, log line, commit history).
> **The fix** — concrete code-level change, not a hand-wave.
> **Why it makes the system bulletproof** — the argument tying this fix to the overall goal.
> **Second-order consequences** — what else changes because of this fix, including downsides.

The doc is grouped by Phase (matching `BULLETPROOF_PLAN.md`) but each entry stands alone. Read sequentially or jump to whichever Phase you care about.

---

# Phase 0 — Stop bleeding

These ship in days, in pieces, before any architectural work. Each one prevents specific current pain. The common pattern: small change, immediate operator-visible benefit, no dependency on later phases.

---

## Area 1 — API surface security

### Bug 1.1 — `/api/history` leaks every tenant's admin password

**What's wrong.** The `/api/history` endpoint decrypts every tenant's `adminPassword` (Microsoft 365 Global Admin password) and returns it in the JSON response, with no authentication.

**Where.** [app/api/history/route.ts:49-55](app/api/history/route.ts:49)

**Evidence.** The code literally reads:
```ts
adminPassword: (() => {
  try {
    return decryptSecret(tenant.adminPassword);
  } catch {
    return tenant.adminPassword;
  }
})(),
```
The route is a plain `export async function GET()` with no middleware, no token check, no session. `curl https://cooperative-delight-production.up.railway.app/api/history` from any IP returns plaintext admin passwords for every tenant.

**The fix.**
- Add a single Bearer-token auth check (operator-only token in Railway env var as `OPERATOR_TOKEN`). Middleware-level — every `/api/*` route is required to have the header except an explicit allowlist.
- Stop returning `adminPassword` from `/api/history` at all. Operators rarely need to see passwords from this endpoint; when they do, that goes through a separate `/api/tenant/[id]/admin-password` route that's authed AND logs each access to a `password_access_audit` table.
- Operator UI fetches the password lazily via the new endpoint when the operator clicks "show".

**Why it makes the system bulletproof.** The single largest current liability is "the entire batch's credentials are public-internet-accessible." A plan that calls itself bulletproof while the production deploy is leaking admin passwords to anyone with the URL is just a list of features. This is the smallest possible change that closes the gap.

**Second-order consequences.**
- Front-end fetch calls for `/api/*` need the header added. ~10 files touched. Token sent from a server-side handler so it isn't visible in the browser bundle.
- Anyone who used to share batch URLs for visibility — e.g. pasting `/batch/<id>` in Slack — still works (the page route renders normally to authenticated operators) but anonymous viewers get a 401 from the API call.
- Adding the audit log on password access is the foundation for "who looked at this password and when" — useful even at single-operator scale because future post-mortems can answer "did the password get pulled before or after the leak?"

---

### Bug 1.2 — `/api/batch/[id]` also leaks admin passwords

**What's wrong.** Same shape as 1.1, on a different route.

**Where.** [app/api/batch/[id]/route.ts:111-128](app/api/batch/[id]/route.ts:111)

**Evidence.** Same `decryptSecret(tenant.adminPassword)` pattern, returned inline as `adminPassword: adminPasswordPlain` in the response body. No auth.

**The fix.** Same as 1.1 — auth middleware + remove the password from the response payload. The page UI lazy-loads passwords via the new dedicated endpoint when needed.

**Why it makes the system bulletproof.** Two endpoints leaked the same secret. Closing one and not the other gives a false sense of security. Both must be closed in the same change.

**Second-order consequences.** The `/batch/[id]` page UI currently displays the password as part of the row data when expanded. After the fix, the password field shows a "Show" button that triggers the authed lazy fetch. One small UI change, ~30 lines.

---

### Bug 1.3 — No authentication on any `/api/*` route

**What's wrong.** Every `/api/*` route is open to the public internet. There is no middleware, no token check, no session validation anywhere.

**Where.** All of `app/api/`. Verified by grep: zero matches for `getServerSession|auth\(\)|x-api-key|Bearer` across `app/` and `lib/`.

**Evidence.** Direct grep result: empty. Multiple endpoints have been confirmed reachable anonymously: `/api/history`, `/api/batch/[id]`, `/api/services/operations`, `/api/esp-upload`, `/api/tenant/[id]/retry`, `/api/worker`, `/api/config/*`. Anything an operator can do from the UI can also be done via curl by anyone who can guess the URL.

**The fix.** Single Next.js middleware at the project root:
```ts
// middleware.ts
import { NextResponse } from "next/server";
export const config = { matcher: ["/api/:path*"] };
export function middleware(req) {
  const allowlist = ["/api/health"];
  if (allowlist.includes(req.nextUrl.pathname)) return NextResponse.next();
  if (req.headers.get("authorization") !== `Bearer ${process.env.OPERATOR_TOKEN}`) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  return NextResponse.next();
}
```
Front-end pages fetch via a thin server-side proxy that injects the token, so the secret never reaches the browser.

**Why it makes the system bulletproof.** This is the second necessary half of fixing 1.1/1.2 — without route-level enforcement, any new endpoint shipped tomorrow is unauthenticated by default. The middleware makes "authenticated" the default and "public" the explicit choice.

**Second-order consequences.**
- Any third-party integration that assumed an open API now needs the token. There aren't any — verified by reading the code — but worth flagging.
- Operator's mobile use case (open `/batch/<id>` on phone to check progress) needs the auth cookie to be set in their browser. Standard cookie/login flow handles it.
- Future ops automation (cron jobs that hit `/api/worker` to nudge things) can use the same token; no new infrastructure needed.

---

### Bug 1.4 — PowerShell service has no auth either

**What's wrong.** The PowerShell service (`powershell-service/server.js`) exposes routes like `/start-create-shared-mailboxes`, `/start-delegation`, `/configure-dkim` that take admin credentials in the request body. There's no authentication on these routes.

**Where.** [powershell-service/server.js:267, 384, 519, 573, 861](powershell-service/server.js) — every route handler.

**Evidence.** Each route is a plain `app.post(...)` with no auth middleware. The service binds to `0.0.0.0:3099` inside Railway. While Railway's internal network limits public access, any compromised pod in the same Railway project can hit it.

**The fix.** Same Bearer-token pattern. Service rejects requests without the matching `OPERATOR_TOKEN` (or a separate `PS_SERVICE_TOKEN` if we want internal/external split). Worker injects the token in every PS-service call.

**Why it makes the system bulletproof.** Defense in depth. Even if the API perimeter is locked, a future bug or misconfiguration that lets traffic reach the PS service shouldn't be a free pass to run arbitrary Exchange commands as Global Admin.

**Second-order consequences.** None for the operator. One config var added in two places. Health check endpoint stays unauthenticated for Railway's liveness probe.

---

## Area 2 — Uploader silent failure

This is the worst bug currently in production based on this batch's evidence. TN-010's uploader ran for 4.5 hours, hit 100/100 failures, and was marked `completed`. The dashboard lied. The cause is multi-layered.

### Bug 2.1 — Uploader continues after the v1 API key is rejected

**What's wrong.** The first call the uploader makes is to fetch existing accounts from Instantly. If that call returns HTTP 401, the uploader logs the error, sets the existing-set to empty, and proceeds to try uploading 100 accounts. Each per-account verification then also returns 401, every account fails after 3 retries, and the run is reported as "completed."

**Where.** [uploader-service/app.py:1364-1370](uploader-service/app.py:1364) and `inst_fetch_existing_v1` at [:578](uploader-service/app.py:578).

**Evidence.** Pulled the first 6 uploader_log events for TN-010 from production:
```
[20:44:02] Fetching existing accounts…
[20:44:03] V1 fetch error: 401          ← key rejected on the very first call
[20:44:03] V1: 0 existing accounts      ← swallowed; pretends 0 existing
[20:44:03] CSV loaded: 100 accounts • 2 parallel worker(s)
... [4.5 hours of OAuth + 401-verify cycles] ...
```
And TN-010's batch row at audit:
```
uploaderStatus      = completed
uploaderTotal       = 100
uploaderSucceeded   = 0
uploaderFailed      = 100
uploaderErrorMessage = (empty)
```
100% failure, no aggregated tenant-level error.

**The fix.**
- In `run_instantly_job` (around [uploader-service/app.py:1366](uploader-service/app.py:1366)), after `inst_fetch_existing_v1` returns 0 accounts, check whether the API call succeeded vs failed. Distinguish "0 results" from "API rejected the key."
- If the key is rejected, **abort the run**: set the tenant's `uploaderStatus = "failed"`, set `uploaderErrorMessage` to a human-readable error like "Instantly v1 API key was rejected (HTTP 401). Verify the key in the batch config and click Retry."
- Add a `verify_credentials` step at job start: a single read-only API call with each provided key, before any account work. Wrong creds fail in seconds, not hours.

**Why it makes the system bulletproof.** Bulletproof code does not lie about success. Either the operator sees correctness, or they see a clear error. There is no third state. Today there are two third states: "completed but 0/100 succeeded" and "running for 4 hours when there's no chance of success." Both go away with this change.

**Second-order consequences.**
- Past batches that hit this bug may have actually delivered some accounts via the Selenium OAuth flow (the Selenium part works; only the verify-via-API step was failing). Aborting on first 401 means those past mostly-broken runs would have aborted too. This is the right outcome — we want to fix the credentials, not paper over them.
- Operator gets clearer signal but loses the false comfort of "at least it tried." Net positive — the false comfort was a bug.
- Aborts on the first 401 mean a transient Instantly outage causes a hard abort. Mitigation: distinguish 401 (auth) from 5xx (transient) in the abort logic. 5xx retries the read once, then aborts. 401 aborts immediately.

---

### Bug 2.2 — No automatic v1 → v2 fallback when v1 is rejected

**What's wrong.** When the operator submits a batch and provides only a v1 key (no v2 key), the uploader uses v1 exclusively. If v1 returns 401, the code does not try v2 even when both keys are present.

**Where.** [lib/services/emailUploader.ts:93-94](lib/services/emailUploader.ts:93)
```ts
const apiVersion = cfg.instantlyApiVersion === "v2" && cfg.instantlyV2Key ? "v2" : "v1";
const apiKey = cfg.instantlyV1Key || cfg.instantlyV2Key;
```
Selection is purely based on the operator's checkbox, not on which key actually works.

**Evidence.** This batch (`cmokasf7a003bny1r3k6awkcf`) has `instantlyApiVersion = "v1"` and `instantlyV2Key = empty`. So the v2 path is never tried, even if the v1 key is dead.

**The fix.**
- At batch creation time, **probe both keys** if both are provided. If v2 works, prefer v2 (it's faster, and Instantly is deprecating v1).
- If v1 fails at runtime, automatically retry the request with v2 (if a v2 key is on the batch).
- Log which key was actually used in the run, so post-mortems can confirm.

**Why it makes the system bulletproof.** Bulletproof code uses the path that works, not the path the operator selected if it doesn't work. Operators are humans who paste the wrong key sometimes. The system should figure out which key works rather than failing because the form selection didn't match the working key.

**Second-order consequences.**
- A small risk: if an operator deliberately wanted to test only v1, the auto-fallback hides that. Mitigation: add a `force_api_version` flag for that case. In practice no operator wants this — they want their accounts uploaded.
- Reveals when v1 is silently dead for an account. Good — Instantly is rolling v1 down, and we want to know early.

---

### Bug 2.3 — No batch-creation-time credential validation

**What's wrong.** When the operator submits the ESP form, the wrong key gets stored encrypted, and the failure is discovered hours later when the uploader actually runs.

**Where.** [app/esp-upload/page.tsx](app/esp-upload/page.tsx) and [app/api/batches/route.ts](app/api/batches/route.ts) (batch creation handlers).

**Evidence.** Today's batch was submitted yesterday at 16:57 UTC, ran cleanly through 5 setup phases, then hit the bad-key issue at 20:44 UTC when the uploader started. Almost 4 hours between "operator made the typo" and "operator could see the typo."

**The fix.** A `POST /api/esp/validate` route on the web app that the form calls before submitting. Takes credentials (encrypted in transit), runs one read-only call per provided key, returns `{instantlyV1Ok, instantlyV2Ok, smartleadOk}` plus error reasons. Form blocks submission if all selected ESPs fail validation.

**Why it makes the system bulletproof.** Catching a bad key at form-submission time is hours-of-operator-pain cheaper than catching it during run. This is also the right place to catch it — the data is fresh, the operator is at the keyboard, the cost of a re-paste is zero.

**Second-order consequences.**
- Form submission becomes ~2-5 seconds slower (the validation calls). Acceptable.
- Reveals quirks of Instantly's APIs early — e.g. some workspaces require the workspace ID header even for read-only calls. Ship the fixes inline with this work.
- Sets up a nice pattern for other credential validation (Cloudflare, Microsoft Graph, Smartlead) — all should have similar pre-flight checks.

---

### Bug 2.4 — Uploader doesn't aggregate per-account failures into a tenant-level error

**What's wrong.** When 100 accounts all fail with the same per-account error ("V1 check HTTP 401"), the dashboard shows `uploaderFailed=100` but `uploaderErrorMessage` stays empty. The operator sees "completed" with no indication of what went wrong.

**Where.** Uploader poll handler in [lib/workers/uploadWorker.ts](lib/workers/uploadWorker.ts) and the uploader Python service writing `uploader_log` events.

**Evidence.** TN-010 row from the prod DB:
```
uploaderStatus       = completed
uploaderFailed       = 100 of 100
uploaderErrorMessage = NULL
```

**The fix.**
- When the uploader's poll reports the run is done, examine the result: if ≥80% of accounts failed AND they all share a similar error pattern, set `uploaderErrorMessage` to a summary like "97/100 accounts failed: V1 check HTTP 401 (key likely rejected)."
- Mark `uploaderStatus = "failed"` instead of `"completed"` if `uploaderSucceeded == 0`.

**Why it makes the system bulletproof.** Same principle as 2.1 — the system must not lie about success. A run that landed zero accounts is a failed run, regardless of whether the runner exited cleanly.

**Second-order consequences.**
- Edge case: a batch with 0 accounts in CSV (legit empty) would now mark "failed" — fix: only apply the 0-success rule when total > 0.
- Operator gets aggregated failure messages instead of having to dig through `uploader_log` JSON. Speeds debugging significantly.

---

## Area 3 — PowerShell injection and silent auth failures

### Bug 3.1 — `escapePowerShellString` does not escape `$`

**What's wrong.** The escape function only handles backticks and double-quotes. The admin password is interpolated into a double-quoted PowerShell string. Microsoft-generated tenant passwords commonly contain `$`. PowerShell expands `$something` inside double-quoted strings before `ConvertTo-SecureString` sees them. The password becomes garbage. Auth fails with a misleading "auth failed" message.

**Where.** [powershell-service/server.js:15-19](powershell-service/server.js:15) and the password interpolation site at [:299](powershell-service/server.js:299), [:422](powershell-service/server.js:422).

**Evidence.** The function:
```js
function escapePowerShellString(value) {
  return String(value || "")
    .replace(/`/g, "``")
    .replace(/"/g, '`"');
}
```
And the call site:
```powershell
$securePassword = ConvertTo-SecureString "${escapedAdminPassword}" -AsPlainText -Force
```
A password like `Hello$2026!` becomes `Hello!` (since `$2026` evaluates to nothing in PowerShell, then `!` is literal).

**The fix.** Three options, in order of preference:
1. **Stop interpolating credentials into PowerShell strings entirely.** Pass them through stdin as JSON. The PowerShell script reads with `[Console]::In.ReadToEnd() | ConvertFrom-Json`. No escaping required at all.
2. If (1) is too invasive: switch from double-quoted (`"..."`) to single-quoted (`'...'`) PowerShell strings, which don't expand variables. Escape `'` inside the value. **No `$`-expansion problem at all.**
3. If neither is feasible: also escape `$` and `'` in the existing function.

I'd ship (1) — secrets out of pwsh argv entirely.

**Why it makes the system bulletproof.** Bulletproof code doesn't have a class of "passwords that contain certain characters silently fail authentication." Either auth works or it fails loud with the real error. The current shape of the bug is the worst kind: silent failure with a misleading error. Operators retry the same broken run forever.

**Second-order consequences.**
- Switching to stdin-passed credentials also fixes the related issue that `ps -ef` on the container shows admin passwords in the process argv. Bonus security win.
- All ~12 PowerShell scripts in `powershell-service/server.js` need to be migrated. Mechanical change but requires care — wrong migration silently breaks auth (the same shape as the bug we're fixing).
- Once stdin is the credential channel, we can also pass the encrypted-keys-on-disk approach for long-running pwsh sessions (Phase 2.2).

---

### Bug 3.2 — Same escape function does not escape `'`

**What's wrong.** Same function, same site. Single quotes in tenant input (display names, company names) break PowerShell string parsing.

**Where.** Same as 3.1.

**Evidence.** Customer name "O'Brien Inc" interpolated into a single-quoted PS string would close the string early. Currently this hits when display names with `'` are passed to `Set-Mailbox -DisplayName ...`.

**The fix.** Same as 3.1 — fix it at the architecture level by removing string interpolation, not by adding more replacements.

**Why bulletproof / second-order.** Same argument as 3.1. Both addressed by the same change.

---

### Bug 3.3 — Secrets visible in `pwsh -Command` argv

**What's wrong.** The PS service spawns `pwsh -NoProfile -NonInteractive -Command "<full-script-with-credentials-baked-in>"`. The full script string, including embedded admin password, is passed as a single argv element. Anything on the host reading `/proc/<pid>/cmdline` can see it. `ps -ef` inside the container shows it.

**Where.** [powershell-service/server.js:82, 109](powershell-service/server.js:82) and [:1126](powershell-service/server.js:1126) (the file-based variant).

**Evidence.** Direct read of the spawn call. Argv visibility is an OS-level fact — confirmed in any Linux container.

**The fix.** Same as 3.1 — credentials via stdin or temp file (mode 0600), not argv. The stdin approach is cleaner because the credential never touches disk.

**Why bulletproof.** Defense in depth. Even with the API auth (1.3) and PS service auth (1.4) in place, secrets shouldn't be readable by anyone inside the container who doesn't already have OS root.

**Second-order consequences.** Same as 3.1 — all 12+ scripts migrate together.

---

## Area 4 — Concurrency and memory

### Bug 4.1 — `WORKER_CONCURRENCY` defaults to 1

**What's wrong.** The worker processes one tenant at a time unless an env var overrides it. With 11 tenants in a batch, that means a single stuck tenant blocks the other 10 from progressing.

**Where.** [lib/workers/processor.ts:771](lib/workers/processor.ts:771):
```ts
concurrency: Math.max(1, Number(process.env.WORKER_CONCURRENCY || 1))
```

**Evidence.** This batch had TN-001/007/009/011 all sitting with no worker activity for 30-110 minutes because the single worker slot was busy on TN-002. Bumping `WORKER_CONCURRENCY=3` immediately had 4 of them running in parallel.

**The fix.** Change the default to 2. Add an explicit upper bound (5) via env. Document the trade-off in the code: higher concurrency = more parallel Microsoft Graph calls = more chance of hitting Graph rate limits, but with the polling-helper architecture (Phase 1) this is fine because rate-limit responses become "wait and retry" not "fail."

**Why bulletproof.** A 1-tenant-at-a-time batch is operator-pain in a happy world and disaster in any non-happy world. 2 is the smallest change that removes the head-of-line blocking. 3+ requires Phase 2 (PS service durability) to be safe.

**Second-order consequences.**
- More parallel Graph calls. Microsoft's per-application rate limits are well above what 2 concurrent tenants will hit; 5 starts to risk it.
- Phase 0.4 says 2 because Phase 2 isn't shipped yet. After Phase 2 (long-lived pwsh, no per-job module load), 5 is safe.
- The default change also reduces the risk that "deploys reset to default of 1 because the env var got removed accidentally."

---

### Bug 4.2 — BullMQ retry budget is 30 attempts × 30 seconds

**What's wrong.** A failed worker job retries up to 30 times with 30-second backoff. That's 15 minutes of retries. During those retries, the failure mode is invisible — the operator sees "still working" with no indication that 25 attempts have already failed. When it finally hard-fails, the operator has no idea what was happening for 15 minutes.

**Where.** Documented in `PROJECT_STATE.md` H2. Code is in [lib/queue.ts](lib/queue.ts) BullMQ defaults.

**Evidence.** PROJECT_STATE.md call-out + commit `955bc7d` "Document BullMQ defaultJobOptions gotcha on tenant-upload queue" — this has bitten us before.

**The fix.** Drop attempts to 3, increase backoff to 60s. If 3 minutes of retries don't fix it, the issue is real and operator should see it. With Phase 1's polling helpers handling transient state internally, BullMQ retries become reserved for "the worker process actually died" — which is rare.

**Why bulletproof.** Long retry budgets *hide* problems. A bulletproof system surfaces real problems quickly so they can be diagnosed and fixed, not buried under another 25 transparent retries. This change forces operations to either work in 3 attempts or be visible as failed.

**Second-order consequences.**
- Failures that previously self-recovered after attempt 25 will now hard-fail. Phase 4 (observability) is required to see what those were and either fix them or extend the budget back. Don't ship 4.2 without 4.1+4.2 metrics in place.
- Operator may see more "failed" tenants in the short term as we tune. That's fine — better to see them than have them lurk for 15 minutes invisibly.

---

### Bug 4.3 — PowerShell service container memory limit is too low for concurrent jobs

**What's wrong.** Each PowerShell mailbox-creation job spawns a fresh `pwsh` process and loads the `ExchangeOnlineManagement` module (~hundreds of MB resident). Two or three of those concurrently exceed the container's memory limit. The container OOMs and restarts. The in-memory job map is wiped. All in-flight tenants fail with the misleading "Mailbox create status endpoint returned 404" error.

**Where.** PS service container in Railway. No explicit memory request set in `powershell-service/Dockerfile`.

**Evidence.** This batch — TN-007 and TN-011 both failed at `08:21:55` with the identical error message at the identical second. Two tenants failing identically at one timestamp is the smoking gun for "the PS service died, taking both with it." After bumping `WORKER_CONCURRENCY` from 1 to 3, this happened within 13 minutes.

**The fix.** Two-part:
1. **Phase 0:** Bump the container's memory limit in Railway from default (~512MB on hobby) to ≥2GB. Stops OOMs at the current concurrency.
2. **Phase 2.2:** The real fix — long-lived pwsh process so the module loads once, not per-job. Memory drops back to ~half what it is today even at concurrency 5.

**Why bulletproof.** The Phase 0 piece is mitigation, not a fix — the underlying behavior (per-job module load) is wasteful and fragile. But it lets us ship Phase 1 without the PS service crashing every 20 minutes. Phase 2 is the actual bulletproofing.

**Second-order consequences.**
- Bumping memory has cost. Acceptable for one-operator scale.
- Post-Phase 2, the memory bump can come back down — leave it for now as belt-and-suspenders.

---

## Area 5 — Deploy drift

### Bug 5.1 — Services drift behind `main` when no source files in their dir change

**What's wrong.** Railway's per-service deploys watch the service's own directory (`./uploader-service`, `./powershell-service`, etc.). When a commit only changes other directories, only those services redeploy. A service can sit on an old commit indefinitely if nothing in its dir changes — even though the deployed image's runtime depends on shared code or shared assumptions.

**Where.** Railway service config + the lack of per-commit redeploy markers.

**Evidence.** During this audit, the production deployment state showed:
- `azuremagicbu` (web) — commit `76f85f1`
- `worker` — `76f85f1`
- `powershell` — `76f85f1`
- `uploader` — `43eaf52` (**9 commits behind**)

The 9 missing commits include PR #38 (real domain-verify error), PR #41 (Graph race fixes), PR #42 (consent loop fix). None of those touched files in `uploader-service/`, but they touched the contracts the uploader-service interacts with — like the shape of error messages it reports to the worker.

**The fix.**
- Add a `version.txt` file in each service directory that's regenerated on every commit (via a simple git hook or CI step). Even a doc-only commit changes `version.txt` in every service dir, forcing a redeploy of every service.
- Each service's `/health` endpoint returns the deployed git SHA. Operator can spot-check at any time.
- Bonus: a small `/api/deploy-status` that aggregates SHAs across services and screams red if they don't match.

**Why bulletproof.** Bulletproof code includes "the code that's actually running matches the code in main." A 9-commit drift means 9 PRs of fixes are lying inert in git while production is still running the buggy code those PRs fixed. The class of bugs this surfaces is very hard to diagnose because it looks like "I fixed that yesterday — why is it still failing?"

**Second-order consequences.**
- Every commit redeploys every service. CI-time goes up. For a single-operator tool with infrequent commits, fine.
- Surfaces drift bugs that have always been there but invisible. Worth uncovering.

---

# Phase 1 — Architectural shift: Microsoft as truth, DB as cache

The most leveraged change in the entire plan. This kills the largest class of bugs — the ones where DB state and Microsoft state get out of sync, the worker reads stale DB, makes a Graph call that races with Microsoft's eventual consistency, and either fails or silently progresses with wrong assumptions.

The change in one sentence: every phase boundary in the worker reads Microsoft state, reconciles DB to match, and only advances when Microsoft confirms.

## Area 6 — Microsoft Graph eventual consistency

This area's bugs all share a root cause. Each is fixed by the same pattern: replace inline retry-on-error sites with named polling helpers that wait for the desired Microsoft state to hold, then return.

### Bug 6.1 — A1: "Primary user 'X' not found in tenant" right after creating that user

**What's wrong.** The worker `POST`s `/users` to create the user, then immediately `GET /users?$filter=userPrincipalName eq 'x@y'` to look the user up by UPN. Microsoft's `$filter` index is eventually consistent — it can take 5-75 seconds to see the user that was just created. The lookup returns 0 rows. The code throws "user not found." Everything downstream fails.

**Where.** [lib/services/microsoft.ts:ensurePrimaryUserLicensed](lib/services/microsoft.ts).

**Evidence.** PROJECT_STATE.md A1; root-caused in `POSTMORTEM_BATCH_cmokasf7a.md` for TN-011. PR #41 partially fixed it by passing the `id` directly from the create response (strongly consistent) and adding a `lookupUserByUpnWaitingForPropagation` helper.

**The fix.** Replace the partial fix with a single helper:
```ts
awaitUserExistsInTenant(tenantId, upn): Promise<{ id: string } | null>
```
- Polls `/users?$filter=...` with `ConsistencyLevel: eventual` header
- Up to N attempts with measured backoff (initial 0s, then 5s, 15s, 30s, 30s — 80s total budget)
- Returns the user id when found, `null` when budget expires
- Worker callers branch: if `null`, log a structured failure with the budget exceeded; if found, proceed.

**Why bulletproof.** The bug is about treating a single Graph read as authoritative. The fix is to treat reads as observations of an eventually-consistent system — keep observing until the desired state holds, or accept that it never will. This pattern, applied uniformly, eliminates the entire class.

**Second-order consequences.**
- Adds 5-75 seconds to the phase in a hot-cache miss case. Acceptable.
- Removes a class of operator-clicks-Retry-it-works-on-the-second-try recovery, which masks how often the issue happens. Phase 4 metrics will reveal the real first-attempt-success rate.
- The helper becomes a reusable building block. Every other "wait for X to be true" check in the codebase migrates to this pattern.

---

### Bug 6.2 — A2: Mailbox visibility race after PowerShell New-Mailbox

**What's wrong.** PowerShell's `New-Mailbox` succeeds, then the worker reads Graph to confirm all 99 mailboxes exist. Microsoft's Exchange-to-Azure-AD sync is eventually consistent. The Graph read shows 0 of 99, or 92 of 99 — the worker throws "X/99 mailboxes claimed by PowerShell but not visible." Tenant is marked failed even though the mailboxes exist.

**Where.** [lib/services/microsoft.ts:setupSharedMailboxes](lib/services/microsoft.ts).

**Evidence.** PROJECT_STATE.md A2; postmortem for TN-006 and TN-009. PR #41 partially fixed with 4-attempt poll up to 3 minutes — but TN-006 still failed in this batch because 1 mailbox propagated past the 3-min budget.

**The fix.**
```ts
awaitMailboxesVisible(tenantId, expectedEmails): Promise<{ missing: string[] }>
```
- Polls Graph with measured backoff
- Returns the list of still-missing mailboxes when budget expires (NOT a thrown error)
- Caller decides: if `missing.length === 0`, advance phase. If `missing.length > 0`, log structured warning, advance phase anyway, let the next phase's check pick up the stragglers.

**Why bulletproof.** The bug today is "1 of 99 missing → fail entire tenant." The fix is "1 of 99 missing → continue with 98, the next phase's checks will catch the 1 if it's still missing." Bulletproof code degrades gracefully, not catastrophically.

**Second-order consequences.**
- Changes failure semantics — a missing mailbox no longer fails the phase. Gets caught at delegation time (delegation skips mailboxes that don't exist) and surfaced in the final report.
- Need a clear "tenant has missing mailboxes after full pipeline" signal. Phase 4 metrics handle this.

---

### Bug 6.3 — A3: "Resource not found" granting Global Admin to a freshly-created user

**What's wrong.** The worker creates a user via `POST /users`, then immediately `POST /roleManagement/directory/roleAssignments` to make them Global Admin. Microsoft hasn't propagated the user across role-management replicas yet. The role assignment fails with "Resource not found."

**Where.** [lib/services/microsoft.ts:createLicensedUser](lib/services/microsoft.ts) (grant block).

**Evidence.** PROJECT_STATE.md A3; mitigated with 6-attempt backoff up to 30s. Works in practice, but the magic number is unmeasured.

**The fix.**
```ts
awaitGlobalAdminGranted(tenantId, userId): Promise<{ granted: boolean }>
```
- Tries the role assignment
- On any "not found" error, polls until user exists in role management (NOT until grant succeeds — those are separate)
- Retries the grant when user is visible
- Returns `granted: true` once verified

**Why bulletproof.** Same pattern as 6.1 — replace ad-hoc retry magic numbers with named, budgeted polling that reflects the underlying eventual-consistency model.

**Second-order consequences.**
- Slightly slower in the hot path (one extra read to check user visibility). Negligible.
- The 6-attempt-30s magic number gets retired. With Phase 4 metrics, the real timing tail can be observed and the budget tuned.

---

### Bug 6.4 — A4: "Updates to unverified domains are not allowed" right after verify

**What's wrong.** Worker calls verify-domain, gets 200 OK, immediately tries `PATCH /domains/{x}` to set as default. Microsoft's domain-verification state hasn't propagated to the update endpoint yet. PATCH returns 400 "domain unverified."

**Where.** [lib/services/microsoft.ts:setDomainAsDefault](lib/services/microsoft.ts).

**Evidence.** PROJECT_STATE.md A4; mitigated with 8-attempt loop with 10s sleeps.

**The fix.**
```ts
awaitDomainVerified(tenantId, domain): Promise<{ verified: boolean }>
```
- Polls `GET /domains/{x}` until `isVerified === true` AND `state === Verified`
- Returns `verified: true`
- Caller proceeds to `setDomainAsDefault` only after this returns true

**Why bulletproof.** Same pattern. Stop trusting the verify response; trust the state read.

**Second-order consequences.** None notable. The helper replaces an ad-hoc loop with a named, reusable one.

---

### Bug 6.5 — A5: License attach returns 200 but license never actually attaches

**What's wrong.** Worker calls `POST /users/{x}/assignLicense` with the license SKU. Returns 200 OK. But the license isn't actually attached — Microsoft returned the API call success without the underlying SKU pool having capacity, or with internal queueing that didn't complete.

**Where.** [lib/services/microsoft.ts:ensurePrimaryUserLicensed](lib/services/microsoft.ts) Step D.

**Evidence.** PROJECT_STATE.md A5; mitigated with read-after-write verify, 3 attempts.

**The fix.**
```ts
awaitLicenseAttached(tenantId, userId, sku): Promise<{ attached: boolean }>
```
- Polls `GET /users/{x}?$select=assignedLicenses` until the SKU is in the list
- Returns `attached: true` once verified

**Why bulletproof.** Same pattern.

**Second-order consequences.** None.

---

### Bug 6.6 — D1: Long-tail mailbox propagation hard-fails the phase

**What's wrong.** A single mailbox out of 99 takes longer than the polling budget (today: 3 minutes). The phase hard-fails with "1/99 missing." Operator clicks Retry. By retry time, the missing one has propagated.

**Where.** Same as 6.2 — `setupSharedMailboxes`.

**Evidence.** PROJECT_STATE.md D1; postmortem for TN-006.

**The fix.** Already fixed by 6.2 — the helper returns the missing list, the caller advances phase anyway.

**Why bulletproof.** Same as 6.2.

**Second-order consequences.** Removes a category of operator-Retry-clicks. Phase 4 metrics let us measure the true propagation tail and either tune the budget or accept it.

---

### Bug 6.7 — D4: PowerShell service in-memory job state lost on restart

**What's wrong.** Worker calls PS service `/start-create-shared-mailboxes`, gets a `jobId`, polls `/status/{jobId}`. PS service container restarts (Railway redeploy, OOM, crash). The in-memory `mailboxCreationJobs` Map is wiped. Worker polls get 404 for 6 consecutive checks. Tenant fails with the misleading "Mailbox creation status unavailable" error — even though the mailboxes were actually created on the Exchange side.

**Where.** [powershell-service/server.js:13](powershell-service/server.js:13) (the in-memory Map). Worker side at [lib/services/microsoft.ts:1526](lib/services/microsoft.ts:1526).

**Evidence.** TN-002 hit this twice in this batch (07:18 and 07:39). TN-007 and TN-011 hit it together at 08:21:55 after we bumped concurrency. PROJECT_STATE.md D4.

**The fix.** Two-part:
1. **Phase 1:** Worker stops trusting the PS jobId entirely. Worker calls PS service to start the job, then queries Graph directly (via `awaitMailboxesVisible`) to check if mailboxes exist. PS service restart no longer matters — Microsoft is the truth.
2. **Phase 2.1:** PS service persists its job map to Redis (belt-and-suspenders). Restart doesn't lose state.

After Phase 1 alone, D4 is functionally invisible — even if the PS service forgets the jobId, the worker just confirms via Graph. After Phase 2, the PS jobId polling also keeps working across restarts.

**Why bulletproof.** This is the canonical example of "trust the source of truth, not your own state." The PS service's Map is local state. Microsoft is the truth. Bulletproof code reads from the truth.

**Second-order consequences.**
- The PS service /status endpoint becomes informational (nice-to-have for progress UI), not authoritative. Worker doesn't fail tenants based on its responses.
- Combined with Phase 2.1, restarts are zero-impact. With Phase 1 alone, restarts add ~30s latency (one polling cycle to confirm via Graph) but zero failures.

---

### Bug 6.8 — `[NEW]` /users queries silently truncate at the first page

**What's wrong.** Three places in `microsoft.ts` query `/users` with `$top=999` (the max page size) but never read `@odata.nextLink` to fetch the next page. Tenants with more than 999 users see truncated results. One spot — the filter query — uses no `$top` at all, so Microsoft defaults to 100.

**Where.**
- [lib/services/microsoft.ts:897](lib/services/microsoft.ts:897) — `ensurePrimaryUserLicensed` user list
- [lib/services/microsoft.ts:1666](lib/services/microsoft.ts:1666) — `listDomainUsers`
- [lib/services/microsoft.ts:1348](lib/services/microsoft.ts:1348) — UPN filter, no `$top`

**Evidence.** Direct grep of the file. None of these read `@odata.nextLink`.

**The fix.** Add a generic pagination helper:
```ts
async function* paginate<T>(accessToken, path): AsyncIterable<T> {
  let url = path;
  while (url) {
    const r = await graphRequest<{ value: T[]; '@odata.nextLink'?: string }>(accessToken, url);
    for (const item of r.value || []) yield item;
    url = r['@odata.nextLink'] ?? null;
  }
}
```
Replace each `/users?$top=999` site with iteration over `paginate(...)`.

**Why bulletproof.** Today this bug is mostly invisible because most customer tenants have few users. But the "free up a license seat" code at line 894+ depends on seeing all licensed users. With > 999 users, it could conclude "no other users have licenses" while there are 200 of them off-page — so it skips the revoke step and license assignment then fails with no obvious cause. Bulletproof code is correct at scale, not just at the small scale we usually see.

**Second-order consequences.**
- Slightly slower for big tenants (each page is a Graph call, ~200ms). Acceptable.
- Reveals if any tenant in our flow ever actually has > 999 users. Useful data.

---

### Bug 6.9 — `[NEW]` Filter values not URL-encoded

**What's wrong.** [lib/services/microsoft.ts:1348](lib/services/microsoft.ts:1348) builds the URL as `/users?$filter=${filter}` — `filter` is interpolated raw. If `filter` contains a `+` (URL-encoded as space), the query is wrong. Primary email `kunal+main@example.com` → URL becomes `/users?$filter=userPrincipalName eq 'kunal main@example.com'` → returns no user.

**Where.** [lib/services/microsoft.ts:1348](lib/services/microsoft.ts:1348) and similar sites with raw `${filter}` interpolation.

**Evidence.** Direct read of the file.

**The fix.** `encodeURIComponent(filter)` at every interpolation site. Better: a `buildGraphUrl(path, query)` helper that encodes consistently.

**Why bulletproof.** Bulletproof code handles inputs it might not have personally tested. The number of customers using `+` in their admin email is low but not zero. The cost of fixing this is one helper. The cost of NOT fixing this is "tenant fails for no obvious reason because the operator's email contains a `+`."

**Second-order consequences.** None. Pure correctness fix.

---

### Bug 6.10 — `[NEW]` `ConsistencyLevel: eventual` header missing on advanced filter queries

**What's wrong.** Microsoft Graph requires the `ConsistencyLevel: eventual` header on certain `$filter`+`$count` queries against `/users` and similar collections. Without it, Graph either returns stale results or 400s outright. Several filter queries in `microsoft.ts` don't send the header.

**Where.** Multiple sites in `lib/services/microsoft.ts`, particularly any `$filter=...` against `/users`.

**Evidence.** Microsoft documentation specifies the header is required for these queries. Direct grep of the codebase shows it's set in some places (PR #41 added it for the propagation lookup) but not in all sites.

**The fix.** Standardize: every `/users?$filter=...` request goes through a helper that sets `ConsistencyLevel: eventual` and `$count=true`. The helpers from 6.1-6.7 all use this consistently.

**Why bulletproof.** "Sometimes it returns stale data" is exactly the shape of bug we're trying to eliminate. Standardizing the header at the helper layer means no future caller forgets it.

**Second-order consequences.** The `$count=true` requirement adds a tiny per-query overhead. Acceptable.

---

## Area 7 — DB-vs-Microsoft drift (the architectural piece)

This is the big one. The root cause analysis in `POSTMORTEM_BATCH_cmokasf7a.md` is unambiguous: 5 of 11 tenants in this batch hit some variant of "DB says one thing, Microsoft says another, UI shows stale, operator clicks repeatedly because nothing changes."

### Bug 7.1 — I1: DB flags treated as source of truth

**What's wrong.** The worker reads boolean flags on the Tenant row (`domainAdded`, `domainVerified`, `licensedUserId`, `sharedMailboxesCreated`, ...) to decide what phase to run. These flags are written by the worker, the retry route, the confirm-auth route, and manual operator DB pushes. They drift from Microsoft's actual state constantly. The worker then makes Graph calls assuming a state that isn't true.

**Where.** Throughout `lib/workers/processor.ts` — every `if (!tenant.X) doX()` pattern.

**Evidence.** Postmortem TN-006 (DB said `authConfirmed=true` but `status=auth_pending`), TN-007 (same), TN-008 (auth grid filter dropping rows mid-update). All five DB-drift cases stem from this pattern.

**The fix.** At each phase boundary in `processor.ts`, the worker:
1. Reads Microsoft state via the polling helpers from Area 6
2. Reconciles the DB to match Microsoft (e.g., if Graph confirms domain exists, set `domainAdded=true` regardless of what flag was)
3. Decides next phase based on Microsoft state, not DB flags

The flags become informational (UI hints) rather than authoritative (worker decisions).

**Why bulletproof.** Half the bugs in `PROJECT_STATE.md` and POSTMORTEM are downstream of this single pattern. Once Microsoft is the truth, the DB drift class of bugs becomes structurally impossible. The retry route stops being load-bearing. Operators stop clicking Retry to "fix" drift.

**Second-order consequences.**
- Adds 5-10 Graph calls per phase. Acceptable.
- Forces every phase boundary to handle "Microsoft says X, DB says Y, reconcile to X." This is real complexity that's been hidden behind retries until now.
- Eliminates the need for ~half the operator escape hatches (manual DB pushes, Retry button to clear drift). Phase 5.3's state machine cleans up what's left.
- Phase 4 (observability) becomes essential — the new pattern is more complex; without per-call logging, debugging is hard.

---

### Bug 7.2 — H2: BullMQ retry budget too long, masking real failures

Already covered as Bug 4.2. Listed here too because it's downstream of the architectural shift — once Phase 1's helpers handle transient state internally, BullMQ retries are reserved for "the worker process actually died," and 30 attempts is absurd for that.

---

# Phase 2 — PowerShell service durability

Phase 1 makes PS service restarts survivable (worker doesn't trust the jobId). Phase 2 makes restarts rare in the first place.

## Area 8 — PS service single point of failure

### Bug 8.1 — D4 root cause: in-memory job map (not just survivability)

Phase 1 made D4's symptom invisible. Phase 2 fixes the root cause.

**The fix.**
- Replace `mailboxCreationJobs = new Map()` and `delegationJobs = new Map()` with Redis hashes:
  ```js
  await redis.hset(`ps:job:${jobId}`, { status, completed, total, results });
  ```
- `/status/<jobId>` reads from Redis, not memory
- Job records expire after 24 hours

**Why bulletproof.** Even with Phase 1 making the worker resilient, the PS service's own UI/observability is broken across restarts (the /status endpoint just lies). Persisting state to Redis fixes that and removes any lingering "but what if the worker DOES need the PS jobId for something" footgun.

**Second-order consequences.**
- PS service now depends on Redis. Redis is already a dependency for BullMQ; the worker can't run without it. So no new failure mode.
- Slight latency on /status reads (Redis round trip vs. memory access). Negligible.

---

### Bug 8.2 — `[NEW]` `runPowerShell(script, null)` disables timeout

**What's wrong.** [powershell-service/server.js:358](powershell-service/server.js:358) calls `runPowerShell(script, null)` with a `null` timeout. The function checks `Number.isFinite(timeout)` and only sets a timeout if true. `null` is not finite, so no timeout is set. A 99-mailbox loop can hang forever if PowerShell hangs.

**Where.** [powershell-service/server.js:76-105](powershell-service/server.js:76) (the function) and [:358](powershell-service/server.js:358) (the call site).

**Evidence.** Direct read of the function and call site.

**The fix.** Default timeout 30 minutes. Streaming variant already has an inactivity timer; the non-streaming variant should too. Treat `null` as "use default" rather than "disable."

**Why bulletproof.** A request that hangs forever consumes a worker slot (and a pwsh process) until something kills it. With long-lived pwsh in 8.3, a hung session takes down a long-lived resource. A bounded timeout keeps the system recoverable.

**Second-order consequences.** None. The default is conservative enough to handle 99-mailbox loops.

---

### Bug 8.3 — `[NEW]` Per-job pwsh fork OOMs at concurrency > 1

**What's wrong.** Each request to `/start-create-shared-mailboxes` etc. spawns a fresh `pwsh` process. The first thing the script does is `Connect-ExchangeOnline`, which loads the `ExchangeOnlineManagement` module (~200-400MB resident). Two or three of those concurrently exceed Railway's container memory.

**Where.** [powershell-service/server.js:82, 109, 1126](powershell-service/server.js:82).

**Evidence.** PS service container memory pattern — observed via the OOM-restart pattern that produces D4 symptoms. Confirmed by this batch's TN-007/TN-011 simultaneous failure.

**The fix.** A single (or a small pool of) long-lived `pwsh` process(es) that the Node service keeps warm. Module loads once. Operations are queued onto the pool via stdin/stdout JSON RPC. Idle session is killed and respawned every N hours to avoid memory leaks in the EXO module.

**Why bulletproof.** This is the architectural fix that lets the PS service handle real concurrency without OOM. After 8.3, `WORKER_CONCURRENCY=5` is safe.

**Second-order consequences.**
- Major code change. ~1-2 days of work.
- Risk: a hung pwsh session takes down a pool slot until restart. Mitigation: per-operation timeout (8.2) plus periodic recycle.
- Memory pressure drops 70%. Container can run on smaller instance, saving cost.

---

### Bug 8.4 — `[NEW]` App-only Exchange auth wired wrong; always falls back to admin password

**What's wrong.** Every Exchange Online connection in [powershell-service/server.js](powershell-service/server.js) tries this first:
```powershell
Connect-ExchangeOnline -CertificateThumbprint $null -AppId $clientId -Organization $orgId -Credential $credential -ShowBanner:$false
```
This combination is invalid — `-CertificateThumbprint $null` with `-Credential` doesn't work in the EXO module. The call always throws. The script then falls into the `catch` block and uses the admin user-credential path.

**Where.** [powershell-service/server.js:297, 420](powershell-service/server.js:297).

**Evidence.** Direct read of the script. The try/catch swallows the actual error. Every Exchange operation requires the plaintext admin password.

**The fix.** Two valid paths:
1. **Cert-based app auth** (recommended): `-CertificateThumbprint <thumb> -AppId <id> -Organization <org>`. Requires generating a cert in Microsoft and uploading to the registered app. No password needed for Exchange.
2. **Drop the broken try block.** Always use admin credentials. Honest about what we're doing.

I'd ship (1) — it's the right answer and means we can stop persisting the admin password long-term.

**Why bulletproof.** The current shape is dead code masquerading as an auth fallback. Worse, it forces us to keep the plaintext admin password live in the system (because Exchange always falls back to it). Fixing this enables actually retiring the admin-password storage path.

**Second-order consequences.**
- Cert generation + upload per tenant. One-time setup at tenant creation. Doable but adds a step.
- Password storage can be retired once cert auth works. Closes a whole class of secret-handling bugs (3.1, 3.2, 3.3).

---

### Bug 8.5 — D2: Delegation principal not found for mailboxes that exist

**What's wrong.** PowerShell's delegation step occasionally hits "principal not found" for shared mailboxes that just got created. Same Exchange-to-AAD-sync issue as A2 / D4 on a different code path.

**Where.** PowerShell `setupSharedMailboxes` delegation block.

**Evidence.** PROJECT_STATE.md D2; mitigated with retry loop.

**The fix.** Once Phase 1 is shipped, the delegation step can poll Microsoft state ("is this mailbox visible to the delegation API yet?") instead of retrying-on-error. With Phase 2.3 (long-lived pwsh) this is cheap to implement.

**Why bulletproof.** Same as the rest of Area 6 — replace retry-on-error with poll-until-ready.

**Second-order consequences.** None.

---

# Phase 4 — Observability

Phase 1 introduces complexity (more Graph calls, more polling). Without observability, debugging that complexity is painful. Phase 4 is the small investment that lets every other phase be tunable.

## Area 9 — Diagnosability

### Bug 9.1 — G3: No first-attempt-success metrics

**What's wrong.** We don't know which Microsoft operations succeed first try, which need 3 retries, which take 60 seconds. Every retry budget in the codebase is a magic number ("8 attempts, 10s sleep") with no measured basis. We can't tell whether a budget is too short (false negatives), too long (slow), or right.

**Where.** Throughout the service layer.

**Evidence.** PROJECT_STATE.md G3.

**The fix.** Per-call logging emits a structured line:
```json
{"op":"createUser","tenantId":"...","attempt":1,"latency_ms":230,"ok":true}
{"op":"awaitUserExistsInTenant","tenantId":"...","attempts":3,"latency_ms":12300,"ok":true}
```
A small jq script over `railway logs --json` aggregates. Or a `/api/metrics` route returns rolling counts.

**Why bulletproof.** Bulletproof code is tunable code. Without metrics, every tuning is a guess. With metrics, the polling-helper budgets from Phase 1 become measured numbers.

**Second-order consequences.**
- Log volume goes up ~5-10x. Railway log retention may need bump.
- Surfaces operations that have always been flaky but invisible. Forces investigation. Good but might reveal uncomfortable truths.

---

### Bug 9.2 — G4: No structured logging in service layer

Same as 9.1 — they're the same fix. Listed separately in PROJECT_STATE.md but they ship together.

---

### Bug 9.3 — G2: UI doesn't show queue position or stale-tenant signal

**What's wrong.** The `/batch/[id]` UI shows status and currentStep but not "this tenant's job has been queued for 8 minutes" or "the worker is busy on TN-X right now, you're 3rd in line."

**Where.** [app/batch/[id]/page.tsx](app/batch/[id]/page.tsx).

**Evidence.** PROJECT_STATE.md G2; partially fixed in PR #41.

**The fix.** A small `/api/batch/[id]/queue-status` route returns BullMQ queue state for the batch's tenants. UI shows "queued", "active", "delayed (resumes at HH:MM)", "stalled" with timestamps.

**Why bulletproof.** Operators need to know whether a "no progress" state is "actively working but slow" vs. "stuck waiting for a worker slot" vs. "broken." Today they can't distinguish. With this, they can.

**Second-order consequences.** Adds a small Redis hit per UI poll. Negligible.

---

# Phase 5 — Cleanup

Once the architecture is right, the defensive cruft can come out. Each removal is small but they compound.

## Area 10 — Defensive fallbacks that mask bugs

### Bug 10.1 — G5: `safeDecrypt` returns plaintext (or ciphertext) on decrypt failure

**What's wrong.** The `safeDecrypt` helper catches decryption errors and returns the input. If the input was actually plaintext (legacy data), this works. If the input was ciphertext but decryption failed (key mismatch, corruption, encryption-version mismatch), the function returns the ciphertext as if it were plaintext. Callers then send the ciphertext to upstream services as a credential, get rejected, and report a misleading error.

**Where.** [lib/services/emailUploader.ts:safeDecrypt](lib/services/emailUploader.ts) and ~5 callers.

**Evidence.** PROJECT_STATE.md G5. Possibly the cause of the v1 401 issue in the current batch — if decryption silently failed, Instantly would receive ciphertext as the api_key.

**The fix.**
- Make decryption fail loud. Throw on failure.
- Each call site that previously caught the silent fallback either:
  - Genuinely doesn't care if the secret is missing (rare; document each one)
  - Does care; surface the error properly
- Add a one-time migration: for each existing batch, attempt decryption of every secret column, log which ones fail, give the operator a chance to re-enter them.

**Why bulletproof.** Silent fallback to ciphertext is precisely the shape of "code that lies." The fix is to fail loud. With Phase 4's metrics, decryption failures would be visible — but better to make them throw at the call site so the failure path is immediate.

**Second-order consequences.**
- Risk: an unaudited callsite throws and crashes a flow that previously silently worked (with wrong credentials). Mitigation: audit every callsite before shipping. There are ~5; manageable.
- Probably surfaces real encryption-key-rotation issues that have been hiding. Worth uncovering.

---

### Bug 10.2 — C3+I2: String-matched error classifiers

**What's wrong.** Functions like `isDomainPropagationError` and `isPermissionPropagationError` examine `error.message` text for substrings ("insufficient privileges", "authorization_requestdenied"). If Microsoft rephrases the error message, the classifier silently fails to match — auto-retry doesn't trigger — tenant marked failed.

**Where.** [lib/workers/processor.ts:51-59](lib/workers/processor.ts:51) and similar.

**Evidence.** PROJECT_STATE.md C3 and I2.

**The fix.** Microsoft Graph errors have stable structured codes (`error.code`). Replace string-matching with code-matching:
```ts
function isPermissionPropagationError(err) {
  return err?.code === "Authorization_RequestDenied"
      || err?.error?.code === "Authorization_RequestDenied";
}
```

**Why bulletproof.** Bulletproof code does not depend on stable text in error messages from external services. It depends on the structured fields those services commit to.

**Second-order consequences.**
- Some non-Graph errors (network, parse) need separate handling. Wrap in a typed `GraphError` discriminator at the request layer.
- Once codes are used, the ad-hoc retry sites (the ones not yet migrated to Phase 1 helpers) become much cleaner.

---

### Bug 10.3 — I3: Phase logic implicit in boolean flags, not a real state machine

**What's wrong.** A tenant's phase is implicit in a combination of ~12 boolean flags (`domainAdded`, `domainVerified`, `licensedUserId`, ...). The valid combinations form an undocumented state graph. Code reads "if !tenant.domainAdded, do X" with no central catalog of "what phase is this tenant actually in?"

**Where.** Throughout `lib/workers/processor.ts` and the retry/confirm-auth routes.

**Evidence.** PROJECT_STATE.md I3. Almost every drift bug stems from "two routes wrote different combinations of these flags and now no phase is consistent with reality."

**The fix.** A single `phase` enum on the Tenant row (`tenant_prep`, `auth_pending`, `domain_add`, `domain_verify`, `licensed_user`, `mailboxes`, `mailbox_config`, `dkim`, `complete`, `failed`). A `transitions` table:
```ts
const TRANSITIONS = {
  tenant_prep: ["auth_pending", "failed"],
  auth_pending: ["domain_add", "tenant_prep"],
  // ...
};
```
A helper `await advancePhase(tenantId, target)` checks the transition is valid; throws if not. Operator escape hatch: a special `force_advance(tenantId, target, reason)` that's authed and audited.

**Why bulletproof.** A real state machine makes invalid states impossible by construction. Today, "tenant has `authConfirmed=true` but `status=auth_pending` and no `tenantId` set" is a possible state — and it's exactly the bug TN-006 hit. With a real state machine, that state can't exist.

**Second-order consequences.**
- Every flag-write site migrates to the helper. Mechanical change but touches many files.
- Operator workflows that relied on direct DB updates need to use `force_advance`. This is a feature, not a regression — operator actions become auditable.
- Phase 1's helpers compose naturally with this state machine. Each helper's success advances the phase; failure logs and stays in current phase.

---

## Area 11 — Small UX bugs to ship along the way

### Bug 11.1 — E6: No retry-upload button on `/esp-upload` page

**What's wrong.** The uploader has the API; the friend's UI doesn't expose it. Operator has to call the API by hand to retry an uploader run.

**Where.** [app/esp-upload/page.tsx](app/esp-upload/page.tsx).

**Evidence.** PROJECT_STATE.md E6.

**The fix.** A button that POSTs to `/api/tenant/[id]/retry-upload`. ~15 minutes.

**Why bulletproof.** Tiny, ships in 15 min, covers a real operator pain. Worth doing as part of Phase 0 cleanup since it's adjacent to Bug 2.x work.

**Second-order consequences.** None.

---

# Phase 6 — UX + correctness asks (Area 12)

Seven items requested by the operator after seeing this batch's pain in real time. These are smaller than Phases 1/2 but address the actual day-to-day friction of running the tool. They ship in pieces alongside the architectural work.

---

## Area 12 — UX + correctness asks

### Bug 12.1 — No cumulative uploader log + no CSV queue view in bulk upload

**What's wrong.** The `/esp-upload` page (and the per-tenant uploader log section) only shows one tenant's logs at a time, in a polling-driven UI. There's no "give me a single live feed of every uploader log across the whole batch" view, and no visible queue of CSVs waiting to upload. The operator has to click into each tenant separately to see what's happening, which is unworkable at 11+ tenants.

**Where.** `app/esp-upload/page.tsx` and the related `app/api/esp-upload/...` routes.

**Evidence.** Operator has been pulling DB queries by hand throughout this batch to see uploader logs across multiple tenants because the UI doesn't show them together.

**The fix.**
- New API route `GET /api/batch/[id]/uploader-stream` that aggregates `uploader_log` events across every tenant in a batch, ordered by timestamp DESC, paginated. Returns the latest N (~200) lines, plus a cursor for "fetch since cursor."
- New UI section on the batch detail page: "Uploader live feed" — a streaming log view (poll every 5s) showing the last 200 lines across all tenants, each line tagged with its tenant name.
- A queue panel above the feed: "Queued: TN-007, TN-009. Running: TN-004 (52/100). Done: TN-006, TN-010." Reads BullMQ + the per-tenant `uploaderStatus` field.

**Why bulletproof.** A bulletproof system is observable. A 100% silent uploader run (TN-010, this batch) is the canonical case where the operator needs aggregate visibility. With this view, "all 11 tenants are 401-ing in unison" is visible in seconds, not after 4 hours of digging.

**Second-order consequences.**
- Slight load: polling every 5s × open operator browser sessions hits the new endpoint. Negligible at one-operator scale.
- Forces a sane shape on `uploader_log` event details (right now it's a JSON blob with `lines` array). Standardize per-line shape (`{tenantId, timestamp, level, message}`) for the aggregated view to work cleanly.

---

### Bug 12.2 — Tenant table not sorted by name

**What's wrong.** The big tenant table in `/batch/[id]` orders rows by `createdAt ASC` (or whatever Prisma's default is), so TN-001 might appear after TN-010 if they were inserted out of order. Hard to scan visually.

**Where.** `app/batch/[id]/page.tsx` rendering, and the underlying `app/api/batch/[id]/route.ts` Prisma query at line 21:
```ts
tenants: { orderBy: { createdAt: "asc" }, ... }
```

**Evidence.** Operator request: "in the big table have it be organised by the tenant name so TN01."

**The fix.**
- Change `orderBy` to `tenantName: "asc"`.
- For names like `TN-001` … `TN-099` (zero-padded, three digits) string sort works correctly. If we ever ship two-digit names (`TN-1`, `TN-10`), use a numeric-aware sort — split on `-`, sort by trailing number.
- Apply consistently to `/api/history` and any other tenant-listing endpoint.

**Why bulletproof.** A predictable order is part of "the system doesn't lie." Today the table looks shuffled. Operators have to mentally re-sort every time they look at it.

**Second-order consequences.** None.

---

### Bug 12.3 — All shared mailboxes get the same password (or not unique-per-user)

**What's wrong.** The current shared-mailbox setup flow probably uses one password for all 99 mailboxes (or generates passwords that aren't truly per-user-unique). Each user/persona should have their own unique password.

**Where.** Mailbox password generation lives in the PowerShell flow — likely [powershell-service/server.js](powershell-service/server.js)'s mailbox-password section + the CSV-generation logic in [lib/tenant-csv.ts](lib/tenant-csv.ts) and [lib/services/email-generator.ts](lib/services/email-generator.ts).

**Evidence.** Operator request. Need to confirm current behavior — flagged as a verification step.

**The fix.**
- Generate a strong, unique password per email at CSV creation time. Store per-row in the DB / in the CSV.
- The PS service's set-passwords flow reads the per-row password from the CSV (or the DB) and applies it via `Set-MgUserPassword` (or the equivalent Exchange cmdlet) for each user.
- Ensure passwords avoid characters that breaks the current PowerShell escape (Bug 3.1 — `$`) until that's fixed. Or, use Bug 3.1's stdin-based credential passing.
- Log password generation policy in code so this is visible and auditable.

**Why bulletproof.** Per-user unique passwords are the bulletproof default. A single shared password would mean compromising one mailbox compromises all 99.

**Second-order consequences.**
- Larger CSV / DB row size (small).
- The downloaded CSV that the operator shares with end-users now has different passwords per row. Already the expectation, just confirming reality matches.
- Bug 3.1 (`$` in passwords) becomes more pressing — with 99 unique passwords per tenant, the chance of one containing `$` is high. Fix 3.1 should ship before or alongside this.

---

### Bug 12.4 — Progress cards not sorted: failed → running → completed

**What's wrong.** The per-tenant progress cards on `/batch/[id]` show in DB order (or createdAt order). Failed and stuck tenants are visually buried among completed ones. Operator has to scan every card to find the ones that need attention.

**Where.** `app/batch/[id]/page.tsx` rendering, in the section that maps over tenants and renders cards.

**Evidence.** Operator request.

**The fix.**
- Client-side comparator that sorts:
  1. `failed` first
  2. Anything in-progress (every status that's not `completed`/`failed`) second
  3. `completed` last
- Within each bucket, sort by tenantName ASC (consistent with 12.2).
- Server can also do this — easier to do client-side for instant re-render as statuses change.

**Why bulletproof.** Sorting puts "what needs attention" at the top. Reduces operator scan time from O(N) to O(failed count).

**Second-order consequences.** None.

---

### Bug 12.5 — "I've Entered the Code" makes the row disappear and doesn't verify the actual M365 connection

**What's wrong.** Today, clicking "I've Entered the Code" calls the `confirm-auth` route. Two issues:
1. The row vanishes from the device-auth grid after click (or appears to — race between status update and UI re-fetch).
2. The route flips DB status but doesn't actually verify the resulting M365 access works. Operator can click and the system says "great, moving on" even if Microsoft refused the auth.

**Where.**
- Disappearing row: [app/batch/[id]/page.tsx](app/batch/[id]/page.tsx) device-auth grid (PR #46 fixed the unconditional show; need to verify "I've entered the code" specifically still has the bug).
- Connection not verified: [app/api/tenant/[id]/confirm-auth/route.ts](app/api/tenant/[id]/confirm-auth/route.ts).

**Evidence.** Operator request. PR #46 in PROJECT_STATE.md fixed the device-auth grid filter; this bug may be a separate path (the "I've Entered the Code" button specifically).

**The fix.**
- After confirm-auth, the route should make a single sanity-check Graph call (e.g. `GET /organization`) using the freshly-acquired token. If 401/403, do not flip status to "complete" — surface the real Microsoft error to the operator.
- Keep the row visible. The card transitions to a "Verifying connection…" state with a spinner, then either "Connected ✓" or "Auth failed: [real error]." No disappearing.
- The verification call's result is stored as a structured event (`auth_verified` or `auth_verification_failed`) on TenantEvent for the audit trail.

**Why bulletproof.** A button that claims success without verifying success is a lying button. The fix forces the system to actually check Microsoft accepted the auth before reporting OK. Catches the entire class of "operator entered the wrong code" / "code expired during click" / "AAD propagation hasn't caught up" issues at the moment they happen.

**Second-order consequences.**
- Adds ~500ms-2s to the confirm-auth flow (one Graph call).
- A successful confirm-auth that fails Graph verification surfaces an error the operator can act on. Today they'd see the next phase fail with a misleading error. Net win.
- Combines naturally with Phase 1's polling helpers — `awaitOrganizationVisible(token)` is the same pattern as the other helpers.

---

### Bug 12.6 — Personas / display names are not verified end-of-flow

**What's wrong.** The pipeline generates per-persona display names (e.g., "Emma Thompson", "Abigail Morris") and assigns them to mailboxes. There's no end-of-flow check that "user `e.thompson@x.com` actually has displayName `Emma Thompson` in Microsoft." If something silently misapplies (because the PS script ran but Microsoft rejected the displayName change, or two mailboxes got the same name because of generation logic), the operator finds out only when end-users see the wrong names in their inboxes.

**Where.** End-of-pipeline verification step in [lib/workers/processor.ts](lib/workers/processor.ts), or a new helper `verifyPersonas(tenantId, expected)`.

**Evidence.** Operator request. Commit `c06e7f8` (PR #40) fixed the CSV-generation side; this is verifying that the M365-side state matches the CSV.

**The fix.**
- After mailbox setup completes, fetch every user from Graph (`GET /users?$filter=accountEnabled eq true&$select=userPrincipalName,displayName`) for the tenant.
- Compare against the expected `(email, displayName)` pairs from the persona generator.
- Mismatches go into a structured `phase_warning` event with the list of bad pairs.
- Optional: auto-correct mismatches by re-PATCHing the displayName.

**Why bulletproof.** "The system did what it claimed" should be verifiable. End-of-flow verification turns "I think it worked" into "I confirmed it worked." This catches both bugs (display name silently wrong) and Microsoft-side issues (renamed in their dashboard).

**Second-order consequences.**
- One extra Graph call per tenant at end-of-flow. Negligible.
- Surfaces past bugs: if display names have been silently wrong for some past batches, this verification will reveal it. May produce uncomfortable findings but the right thing to know.
- The same pattern (verify-after-write) generalizes to license assignment, role assignment, DKIM. Worth standardizing.

---

### Bug 12.7 — Drop Instantly v1 entirely

**What's wrong.** The form has a v1/v2 toggle. Today's batch defaulted to v1. v1 is being deprecated by Instantly, returns 401 unpredictably for some accounts, and is the root cause of this batch's silent uploader failure. Keeping v1 around is a footgun.

**Where.**
- Form: [app/esp-upload/page.tsx](app/esp-upload/page.tsx).
- Service config: [lib/services/emailUploader.ts:93-94](lib/services/emailUploader.ts:93).
- Python uploader: [uploader-service/app.py:1352+](uploader-service/app.py:1352) (`run_instantly_job` v1 branch).

**Evidence.** Direct evidence from this batch — every uploader run hit `V1 fetch error: 401`. Plus operator request.

**The fix.**
- Remove the v1 option from the ESP form. Only field: `instantlyV2Key`. Make it required (or required if Instantly is selected as ESP).
- Drop the `instantlyApiVersion` / `instantlyV1Key` columns from the Batch model after a one-time migration that copies any existing v1 keys forward (warning the operator that v1 is dead, prompting for a v2 key).
- Delete the v1 code path in `lib/services/emailUploader.ts` and `uploader-service/app.py`. Net code removal of ~150 lines.
- Update Bug 0.2 / Phase 0.2's "auto-fallback v1→v2" to "v2 only — no fallback needed."

**Why bulletproof.** Bulletproof code doesn't ship two paths when one is broken. Removing v1 closes the entire "wrong-key footgun" class. The operator can no longer accidentally select the broken path.

**Second-order consequences.**
- Operator has to provide a v2 key for every new batch. Today's already-in-flight batches with only v1 keys need a v2 key entered before retry.
- Existing/old code in `inst_check_v1`, `inst_fetch_existing_v1` etc. gets deleted — simplifies the codebase.
- Bug 2.2 (auto-fallback v1→v2) becomes moot — there's only v2.
- Loses backward compat for any operator workflow that depended on v1. Verified: no such workflow exists in this tool.

---



| Bug | Why deferred |
|---|---|
| **Security fixes (entire Area 1, Bugs 3.1-3.3)** | **Descoped per operator: "doesn't matter right now."** The plan still notes them so they can be re-prioritized later. Implications: `/api/history` and `/api/batch/[id]` continue returning plaintext admin passwords; no API auth; PS service accepts unauthenticated requests; passwords with `$` continue silently failing. Bug 12.3 (unique passwords per mailbox) is partially blocked by Bug 3.1 — the workaround there is to generate passwords that avoid `$` until 3.1 is fixed, OR ship 3.1 as part of 12.3. |
| E1-E5 — Selenium fragility | Phase 3 in `BULLETPROOF_PLAN.md`, deferred per operator. The Phase 0.2 fix (uploader fails loud on bad creds) addresses the immediate operator pain. The Selenium → API replacement removes the fragility class entirely but requires 5 days of focused work that we're choosing to skip for now. |
| I4 — No tests anywhere | Out of scope per `PROJECT_STATE.md`. Acceptable for an internal tool with one operator. Bug discovery happens in production. The bulletproof plan substitutes for tests with: (a) Phase 4 metrics that make every failure visible, (b) Phase 1's "Microsoft as truth" pattern that prevents the largest class of bugs by design, (c) Phase 5's state machine that makes invalid states impossible. |
| C2 — Domain in another tenant | External; Microsoft requires customer Admin Takeover. PR #43 already fails fast with clear instructions. Nothing more to do in code. |
| B5 — Device code countdown timer | UX polish, not fragility. Defer to a later UX-focused pass. |
| I5 — Selenium → API | Same as E1-E5. |
| I4 (test infra) | See above. |

---

# Why this makes the system bulletproof — the cross-cutting argument

The plan's bug list is long, but the underlying logic is short. The system has three structural weaknesses today:

## 1. The system trusts its own state instead of the truth

The DB is treated as authoritative. Microsoft Graph is the actual truth, and they drift. Today's recovery mechanism is "retry until they re-converge." That works most of the time and fails painfully sometimes — and even when it works, it hides the underlying drift, which compounds.

**Phase 1 inverts this.** Microsoft is the truth. The DB caches it. Every phase boundary reconciles. Drift can't accumulate past one phase.

This single change kills:
- A1, A2, A3, A5 (Graph eventual consistency races) — helpers wait until Microsoft is consistent
- B3, B4, H3, H4, H5 (DB drift) — drift gets reconciled at each boundary
- D1, D4 (mailbox propagation, PS jobId loss) — worker queries Microsoft directly
- ~All operator manual DB pushes — drift can't accumulate

That's roughly 60% of the open bugs in `PROJECT_STATE.md` killed by one architectural shift.

## 2. The system lies about success

Today, multiple paths produce "success" outcomes that are actually failures:
- The uploader marks a tenant `completed` after delivering 0 of 100 accounts.
- The worker marks a phase complete based on flags that don't reflect Microsoft state.
- Decryption silently returns ciphertext when the key is wrong.
- The PowerShell try/catch silently falls back to admin auth when app auth fails.

**Bulletproof code does not lie.** Every success path in the plan either confirms reality or surfaces a real error. Bugs 2.1, 2.2, 2.4, 8.4, 10.1 are all instances of "stop lying."

This kills:
- Silent uploader runs that destroy hours of compute
- "Completed" tenants that aren't actually complete
- Fallbacks that mask credentials being broken

## 3. The system is unobservable

We can't tell which operations are flaky, which retry budgets are wrong, which failures are transient vs. real. So we tune by guess and watch the operator suffer.

**Phase 4 fixes this.** Per-call structured logs + first-attempt-success metrics turn guesses into measurements.

This enables:
- Tuning the polling helper budgets from Phase 1 with data
- Spotting silent failures before the operator does
- Post-mortems that don't require digging through `console.log` strings

## What "bulletproof" specifically means here

I'm not promising 100% success rate. Microsoft has real outages, customers have real domain conflicts, the network has real bad days. What I'm promising:

1. **Failures are loud.** Every failure has a real, structured error message — not "5 attempts failed."
2. **Failures don't silently destroy work.** The uploader doesn't run for 4 hours producing 0 deliveries while reporting "completed."
3. **Retries are reserved for "the worker died."** Phase 1's polling helpers handle the eventual-consistency cases internally; BullMQ retries are for actual process failures.
4. **State is consistent.** A tenant's phase is definitely one of N enum values, with auditable transitions. Invalid combinations don't exist by construction.
5. **The deployed code matches main.** Deploy stamps catch drift.
6. **Credentials are not on the public internet.** API auth + sensible secret handling.
7. **First-attempt success rate is observable.** We can tell when something gets worse.

Everything in the plan is in service of these seven properties. Anything that doesn't contribute to one of them is not in the plan.

---

# Definition of done

This plan is "shipped" when, on a fresh 11-tenant batch with valid customer inputs:

1. ☐ First-pass success rate ≥ 80% (vs. 18% today).
2. ☐ Zero operator clicks for happy-path tenants.
3. ☐ ~~No `/api/*` route returns plaintext credentials. None is unauthenticated.~~ **Descoped per operator.**
4. ☐ Uploader runs either succeed cleanly OR fail loud at form submission OR fail loud during run with a real `uploaderErrorMessage`. Never silent.
5. ☐ PowerShell service can OOM-restart without failing any in-flight tenant.
6. ☐ Bad ESP credentials fail at form submission, not 4 hours into the run.
7. ☐ Per-call structured logs visible. First-attempt-success metrics tracked per Microsoft op.
8. ☐ Every PR's commit SHA is reflected in every service's `/health` within 5 minutes of merge.
9. ☐ No `console.log("...string...")` in service-layer code; all calls structured-logged.
10. ☐ Every `safeDecrypt` callsite either fails loud or has a documented "we don't care if the secret is missing" reason.
11. ☐ Tenant phase is a typed enum + transition table. No phase logic implicit in boolean-flag combinations.
12. ☐ All 14+ retry layers from PROJECT_STATE.md are either replaced by polling helpers (kills the bug class) or documented as deliberately retained (with reasoning).
13. ☐ Cumulative uploader log + queue panel visible on batch detail page (Area 12.1).
14. ☐ Tenant table sorted by tenantName ascending; progress cards sorted failed-first then in-progress then completed (Area 12.2 + 12.4).
15. ☐ Each shared mailbox has a unique strong password; verified per-row in CSV and in Microsoft (Area 12.3).
16. ☐ "I've Entered the Code" keeps the row visible and verifies the resulting M365 connection with a real Graph call before claiming success (Area 12.5).
17. ☐ End-of-flow check confirms every persona's display name in Microsoft matches what was generated; mismatches surface as warnings (Area 12.6).
18. ☐ Instantly v1 path removed from form, code, and DB schema. Only v2 supported (Area 12.7).

If any of these aren't true, we're not done.

---

# Sequencing

Total: ~15 working days for one operator. Roughly 11-12 days if work in independent areas runs in parallel.

```
Phase 0 (5 days)  ─┐
                   ├─→ Phase 1 (5 days) ──┐
                                          │
Phase 2 (3 days)  ─────────────────────────┼─→ Phase 4 (2 days) ──→ Phase 5 (2 days)
                                          │
                                          ┘
```

| Phase | Days | Independent? | Dependencies |
|---|---|---|---|
| Phase 0 | 5 (parallel-able) | Yes | None |
| Phase 1 | 5 | Mostly | Phase 0.1, 0.4 (auth, concurrency default) |
| Phase 2 | 3 | Mostly | None — can start in parallel with Phase 1 |
| Phase 4 | 2 | No | Phase 1 (so metrics reflect new architecture) |
| Phase 5 | 2 | No | Phase 1 (helpers exist to replace the legacy retry sites) |

Recommended ship order:
1. Phase 0 entirely (Week 1)
2. Phase 1 (Week 2) — biggest single win
3. Phase 2 (Week 2-3, parallel with Phase 1's tail)
4. Phase 4 (Week 3)
5. Phase 5 (Week 3)

3 weeks calendar time, 11-15 days actual work.

---

# Live-batch carryover (out-of-band)

Things that need to happen for the current batch `cmokasf7a003bny1r3k6awkcf` independent of the plan:

1. TN-001 needs operator to enter the device code at login.microsoft.com/device.
2. TN-003 is blocked on customer Admin Takeover for the domain conflict.
3. TN-004, TN-006, TN-010 setup completed but uploader hit the silent-failure bug. Need:
   - The right Instantly key (operator paste; encrypt + write to batch row).
   - Re-trigger uploads via `/api/tenant/[id]/retry-upload`.
4. TN-002, TN-005, TN-007, TN-008, TN-009, TN-011 — actively progressing or about to complete.

These are recovery actions for one batch, not part of the bulletproof code work.
