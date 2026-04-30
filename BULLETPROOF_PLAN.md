# Bulletproof plan — making azuremagicbu reliable

**Last updated:** 2026-04-30
**Owner:** Kunal (single operator)
**Status of pipeline today:** Functional but fragile. First-pass success ~18% per the postmortem. Operator clicks 14+ times per 11-tenant batch. Uploader silently fails 100% of accounts and reports "completed."

This document supersedes nothing. It is a sequenced, no-hand-waving plan that combines:
- Everything in `PROJECT_STATE.md` (categories A-I, the 5-day architectural shift)
- The postmortem in `POSTMORTEM_BATCH_cmokasf7a.md`
- Findings from the live audit + the live batch debugging done in the next chat (this one)

The new findings — not in the previous tracker — are flagged **`[NEW]`** below.

---

## Goal in one line

**Get first-pass success above 80% with no operator clicks for the happy path.** Everything in this plan is sequenced toward that number.

---

## What changes vs. PROJECT_STATE.md's plan

PROJECT_STATE proposes a 5-day "Microsoft as truth, DB as cache" shift, then UI/UX work, then `safeDecrypt` cleanup. That plan is correct and stands. This document adds:

1. **A Phase 0 "stop bleeding" pass** — small things shipping in days, not weeks, that prevent the worst current failures from continuing on every batch.
2. **A real plan for the PowerShell service** — not just "persist state to Redis" but stopping the OOM that causes the restarts in the first place.
3. **The uploader silent-failure fix** — the v1 401 issue that destroyed every uploader run in the current batch wasn't on the previous tracker. It needs its own work item.
4. **Security work that can't wait** — `/api/history` and `/api/batch/[id]` return decrypted admin passwords with no auth. A reasonable bar for an "internal tool, one operator" still includes "don't ship admin passwords to the public internet."
5. **Concrete sequencing** — the previous plan listed phases but not the order or dependencies between them. This one does.

---

## Phase 0 — Stop bleeding (≤ 1 week, ship in pieces)

These are individually small. Each one prevents specific current pain. None of them blocks the bigger work.

### 0.1 Lock down the API surface

**Problem:** Every `/api/*` route is unauthenticated. `/api/history` and `/api/batch/[id]` decrypt `adminPassword` and ship cleartext in JSON. Anyone with a batch URL gets every tenant's Global Admin password.

**Fix:**
- Add a single auth check (Bearer token in env var, since one operator). Middleware-level — every `/api/*` requires it except a deliberate allowlist.
- Stop returning `adminPassword` in the standard endpoints. Move "give me the password" to a separate `/api/tenant/[id]/admin-password` route that's also authed and logs each access.
- Add the same auth to the PowerShell service's HTTP endpoints — right now any pod on the Railway network can hit it.

**Time:** ½ day.
**Kills:** the unauth password-leak vector.

### 0.2 Make the uploader stop lying about success **`[NEW]`**

**Problem:** The current batch's uploader runs all hit `V1 fetch error: 401` on the very first call (Instantly v1 API key rejected). Every per-account verification then 401s. Tenants get `uploaderStatus = completed` with `uploaderSucceeded = 0` and **no `uploaderErrorMessage`**. The dashboard reads "completed" while the reality is zero deliveries.

**Fix:**
- In `uploader-service/app.py`, when `inst_fetch_existing_v1` (or v2) returns 401 OR 4xx-not-temporary, **abort the run immediately** instead of "log and proceed."
- Set `uploaderErrorMessage` at the tenant level so the dashboard shows it.
- In `lib/services/emailUploader.ts`, when v1 returns 401 and a v2 key is present, auto-fall-back to v2 instead of continuing on the broken v1 path.
- Add a "test ESP credentials" endpoint that the batch-creation form calls **before** submitting, so a wrong key fails the form, not the run.

**Time:** ½ day.
**Kills:** silent 0-of-100 uploader runs. Future bad keys fail at form submission, not 4 hours into the run.

### 0.3 Fix `escapePowerShellString` for `$` and `'` **`[NEW]`**

**Problem:** The escape function in `powershell-service/server.js` only escapes `` ` `` and `"`. Generated tenant passwords often contain `$`. When they do, the password is interpolated into a double-quoted PowerShell string, and `$something` gets expanded by PowerShell before `ConvertTo-SecureString` sees it. Auth then fails with a misleading "auth failed" message.

**Fix:**
- Stop interpolating credentials into PowerShell strings entirely. Pass them through `stdin` as JSON or write to a tmp file the script reads with `Get-Content -Raw | ConvertFrom-Json`.
- If that's too invasive for Phase 0, at minimum: also escape `$` and `'`, and switch the wrapping quotes to a here-string (`@'…'@`) so expansion is off.

**Time:** 2 hours.
**Kills:** silent auth failures for any tenant with `$` in admin password.

### 0.4 Bump PS service memory + sensible default concurrency

**Problem:** The PS service OOMs when 2-3 PowerShell mailbox-creation jobs run concurrently. That's how bug D4 fires repeatedly. Today's recovery is "drop concurrency back to 1" which serializes the whole batch.

**Fix:**
- Bump the PowerShell-service container memory in Railway. If on a free plan, upgrade.
- Set `WORKER_CONCURRENCY = 2` as the *committed default* in the worker boot path, not env-var-only. (3 is too aggressive given the PS service can't handle 3 concurrent heavy jobs reliably; 1 is too slow.)
- Set BullMQ `concurrency` differently for setup vs. uploader queues — uploader at 2 is fine, setup at 2 needs the PS service to keep up.

**Time:** 1 hour (mostly Railway clicks + a small code change).
**Kills:** ~half of the D4 occurrences while we ship the real fix in Phase 2.

### 0.5 Surface uploader-service deploy lag

**Problem:** During this audit, the web/worker/powershell services were all on commit `76f85f1`. The uploader service was on `43eaf52` — **9 commits behind**. Railway only redeploys services whose source files changed. So uploader fixes shipped in master never deploy unless a `uploader-service/*` file changes.

**Fix:**
- Add a tiny "version stamp" file to each service that includes the git SHA, regenerated on every commit. Forces a redeploy of every service on every push.
- Or: switch the Railway service config to "deploy on every commit" regardless of touched paths.
- Add the deployed SHA to every service's `/health` endpoint so this can be detected at a glance.

**Time:** 2 hours.
**Kills:** "I shipped that fix yesterday but it isn't running" mystery.

**Phase 0 total:** ~3 days. Each piece independently shippable. None blocks anything else.

---

## Phase 1 — The architectural shift (5 days, exactly as in PROJECT_STATE.md)

This is the highest-leverage change in the entire plan. **Microsoft becomes the source of truth, DB becomes a cache.** Reproducing the plan from `PROJECT_STATE.md` here so the document stands alone:

### 1.1 Build the polling helpers (Day 1)

In `lib/services/microsoft.ts`, add five named helpers, each with a measured budget:

```ts
awaitUserExistsInTenant(tenantId, upn): Promise<{ id: string } | null>
awaitDomainVerified(tenantId, domain): Promise<{ verified: boolean }>
awaitMailboxesVisible(tenantId, expectedEmails): Promise<{ missing: string[] }>
awaitLicenseAttached(tenantId, userId, sku): Promise<{ attached: boolean }>
awaitGlobalAdminGranted(tenantId, userId): Promise<{ granted: boolean }>
```

Each one polls Graph until the desired state holds OR budget expires. **Crucially these are poll-until-ready, not retry-on-error.** They do not throw on a single miss.

Smoke test against a test tenant. Old code untouched.

### 1.2 Rewrite domain + user setup (Day 2)

Replace `setupDomainAndUser`'s inline retry loops with calls to the helpers. Behind a `USE_POLL_HELPERS` feature flag so we can roll back fast.

### 1.3 Rewrite mailbox setup (Day 3)

Same for `setupSharedMailboxes`. **This is also where bug D4 gets killed.** The worker no longer trusts the PS jobId — it queries Graph for mailbox visibility. PS service restart becomes invisible to the user (worst case: a 30-second wait while the polling helper confirms via Graph).

### 1.4 Rewrite the phase machine (Day 4)

`processor.ts` reads Microsoft state at every phase boundary and reconciles the DB to match. Drop BullMQ retry budget from 30 × 30s to 3 × 60s — the helpers handle transient state internally; BullMQ retries are only for "the worker process actually died."

### 1.5 5-tenant smoke batch (Day 5)

Run a fresh 5-tenant batch on the new path. Pull the flag if it works. Roll back if not. Postmortem either way.

### What this kills

| Bug class | How |
|---|---|
| A1, A2, A3, A5 (Graph eventual consistency) | Helpers wait the propagation window out |
| B3, B4, H3, H4, H5 (DB drift) | Worker reconciles DB to MS state every phase |
| **D4 (PS service restart)** | Worker queries Graph directly, not the PS jobId |
| C3 (string-matched classifiers) | Helpers branch on Graph response shape, not text |
| ~All operator manual DB pushes | DB drift can't accumulate across boundaries |

After this: no more "click Retry, it sometimes works, click again."

---

## Phase 2 — Make the PowerShell service durable (3 days)

Phase 1 made PS service restarts *survivable*. This phase makes them *rare* — and when they do happen, less destructive.

### 2.1 Persist job state to Redis (1 day)

Replace the two in-memory Maps in `powershell-service/server.js` with Redis writes. Every state change writes back. `/status/<jobId>` reads from Redis, not memory.

Now even without Phase 1, restarts don't kill jobs. With Phase 1, this is belt-and-suspenders.

### 2.2 Single long-lived pwsh process (or small pool) (2 days)

Right now every operation forks a fresh `pwsh` process and reloads `ExchangeOnlineManagement` (~hundreds of MB). Three of those at once OOMs the container.

**Fix:** one (or 2-3 in a pool) long-lived `pwsh` processes that the Node service talks to over stdin/stdout. The EXO module loads once. Operations are queued onto the pool.

Memory drops by ~70%. OOM under concurrency goes away. We can safely run `WORKER_CONCURRENCY = 5` if we want.

### What this kills

| Bug class | How |
|---|---|
| D4 occurrences (root cause, not just survivability) | OOMs that cause restarts stop happening |
| Slow concurrency | Higher concurrent batches without crashing |

---

## Phase 3 — Replace Selenium with API (5 days)

The Selenium-based ESP uploader is the single biggest source of fragility. Even after Phase 0.2 fixes the silent-failure bug, the Selenium flow itself is one Instantly UI redesign away from breaking again.

Both Instantly and Smartlead have official APIs. Smartlead is already used (read-only) at `lib/services/smartlead.ts`. The work is in two parts.

### 3.1 Instantly v2 API for account upload (3 days)

`POST /api/v2/accounts` with the M365 SMTP credentials creates an Instantly account directly — no OAuth Selenium flow needed. This replaces:

- `inst_oauth` (Selenium-driven OAuth)
- `inst_dismiss_overlays` (defensive churn)
- `inst_switch_workspace` (Selenium clicks)
- `inst_check_v1` / `inst_check_v2` (since the create call returns the account, no separate verify needed)

The Instantly v2 API supports per-workspace targeting via the `workspace_id` field in headers, so multi-workspace mode works without Selenium.

### 3.2 Smartlead full upload via API (2 days)

`POST /api/v1/email-accounts/save` with M365 SMTP creds. The existing `lib/services/smartlead.ts` already authenticates fine; just expand it to write, not just read.

### 3.3 Decommission Selenium uploader (later — 1-2 weeks after smoke)

Keep the Selenium uploader available as a fallback for 1-2 weeks while we watch the API path. Then delete `uploader-service/app.py`'s 2,747 lines of Selenium logic.

### What this kills

| Bug class | How |
|---|---|
| E1 (workspace selector breaks) | No Selenium |
| E2 (Featurebase overlay) | No Selenium |
| E5 (Selenium fragility in general) | No Selenium |
| 401-on-v1-key blocked uploader (Phase 0.2 mitigation now permanent) | API path uses v2 by default |
| Throughput on uploader | Parallel API calls vs. serial Chrome sessions |
| Memory pressure on uploader-service | No headless Chromium |

---

## Phase 4 — Observability (2 days)

You can't tune what you can't see. PROJECT_STATE.md flags G3 (no first-attempt-success metrics) and G4 (no structured logging) as open. They're worth shipping early so the polling helpers from Phase 1 can be tuned with real data.

### 4.1 Structured per-call logging (1 day)

Replace `console.log("...string...")` in service-layer files with one-line JSON:
```json
{ "op": "createUser", "tenantId": "...", "attempt": 1, "latency_ms": 230, "ok": true, "errCode": null }
```

Just to console for now. No log aggregator needed for a one-operator tool. The `railway logs --json` view becomes greppable and aggregatable with jq.

### 4.2 First-attempt-success metrics (1 day)

Tally per-op:
- Total attempts
- First-attempt successes
- Median attempts to success
- p95 latency

Surface in a `/api/metrics` endpoint (authed, per Phase 0.1) or just via a CLI script that reads logs.

After a week of running with these metrics, the magic numbers in `PRIVILEGE_PROPAGATION_RETRY_DELAY_MS` etc. become *measured* numbers.

---

## Phase 5 — Cleanup (2 days)

Once the architecture is right, the defensive cruft can come out without losing the safety net.

### 5.1 Remove `safeDecrypt` fallback (½ day)

`safeDecrypt` returns plaintext on decryption failure. That masks real encryption bugs (which is what's possibly happening with the v1 key). Convert to fail-loud — throw on decryption failure, callers handle it.

### 5.2 Remove string-matched error classifiers (½ day)

`isDomainPropagationError`, `isPermissionPropagationError` etc. match on error message text. Microsoft can rephrase any time. Replace with `error.code` matching (Graph errors have stable structured codes like `Authorization_RequestDenied`).

This also gets killed implicitly by Phase 1 — the polling helpers don't classify errors, they just keep polling — but the legacy classifiers should still be cleaned up.

### 5.3 Real state machine for phases (1 day)

Today: phase logic is implicit in boolean-flag combinations on the Tenant row. The combinations form an undocumented state graph; it's hard to reason about.

Replace with: a single `phase` enum + a small `transitions` table. Code reads "given current phase X and condition Y, allowed next phase is Z." Invalid transitions throw.

Side benefit: makes "Force advance" / "Reset to phase X" operator buttons cleanly possible instead of ad-hoc DB updates.

---

## Cross-cutting requirement: input validation

For every place we accept operator input (CSV upload, ESP form, retry calls), validate at the boundary:
- Required fields actually present
- Encrypted secrets actually decrypt to plausible plaintext (catches G5 issues)
- API keys actually authenticate against the upstream service (Phase 0.2 covers this for ESPs)
- Domain names are well-formed
- Email addresses parse

The pattern is already established with Zod schemas in `lib/validation.ts`. Just consistently used at every API boundary.

**Time:** ½ day at end of Phase 5.

---

## What I am NOT proposing

- **Test infrastructure.** Per PROJECT_STATE.md scope, accepted as deferred.
- **Multi-operator / RBAC.** Single operator.
- **High availability / failover.** One-operator tool tolerates 30-min downtime.
- **Public API / SaaS / reseller.** Out of scope.
- **Replacing Postgres / Redis / BullMQ.** They work fine.
- **Replacing Next.js.** Works fine.

---

## Sequencing & dependencies

```
Phase 0  ─┐
          ├─→  Phase 1 (5 days)  ─┐
Phase 0.2 ┘                       │
                                  ├─→  Phase 4 (2 days)
Phase 2 (3 days)  ────────────────┤
                                  ├─→  Phase 5 (2 days)
Phase 3 (5 days)  ────────────────┘
```

- **Phase 0** can ship in pieces while Phase 1 is being built. None of Phase 0 blocks Phase 1.
- **Phase 1** is the biggest single change. Its feature flag protects rollback. Should ship before Phases 2/3 because it changes the contract those phases work against.
- **Phase 2** can run in parallel with Phase 3 (different services).
- **Phase 4** depends on Phase 1 being done so the metrics reflect the new architecture, not the legacy one.
- **Phase 5** is cleanup; it depends on Phase 1's helpers being live so we can delete the old retry sites.

**Total elapsed:** ~4 weeks single-operator. **Reasonably parallel:** ~3 weeks if you're focused.

---

## Definition of done — bulletproof means

For a fresh 11-tenant batch with valid customer inputs:

- [ ] First-pass success rate ≥ 80% (vs. 18% today)
- [ ] Zero operator clicks for happy-path tenants
- [ ] Zero plaintext credentials returned by API endpoints
- [ ] Uploader either succeeds or fails loudly with a real error message — never "completed" with 0 successes
- [ ] PS service can OOM-restart without failing any in-flight tenant
- [ ] Bad ESP credentials fail at form submission, not 4 hours into the run
- [ ] First-attempt success metrics visible per Microsoft op, used to tune retry budgets
- [ ] No `console.log` strings in service-layer code; all calls structured-logged

If any of these aren't true, we're not done.

---

## Live-batch recovery actions (one-time, separate from this plan)

For batch `cmokasf7a003bny1r3k6awkcf` (currently in-flight as of writing):
- TN-007 / TN-011 are recovering after manual retries (this chat).
- TN-004 / TN-006 / TN-010 uploader runs all hit the v1 401 silent-failure pattern. Need:
  1. The right Instantly key (operator paste, then encrypt + write to batch row in production).
  2. Re-trigger uploads via `/api/tenant/[id]/retry-upload`.
  3. Verify the new run actually lands accounts in Instantly.

These are once-off operator actions, not part of the bulletproof-code work. Tracked as TODO outside this plan.
