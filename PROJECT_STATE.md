# azuremagicbu — current state, known bugs, and plan

**Last updated:** 2026-04-30
**Repo:** `azuremagicbu` (this one)
**Deploy:** `cooperative-delight-production.up.railway.app`
**Operator:** Kunal (single operator, internal tool — not a public SaaS)

This document is the single source of truth for what's working, what's broken, and what comes next.

---

## TL;DR

The internal tool provisions Microsoft 365 tenants for cold-email use: domain → DNS → device-code admin consent → tenant setup → 99 mailboxes → DKIM → ESP upload to Instantly/Smartlead. End-to-end works for ~1 in 11 tenants on first attempt. The other 10 need manual operator intervention because of bugs in our Microsoft Graph integration (eventual-consistency races) and brittle Selenium-based ESP upload (Instantly UI changes break us with no warning).

The pipeline is functional but fragile. Every layer has retries, the retries hide bugs, and operator pain is high. Roadmap below.

---

## What works (and works reliably)

- **Cloudflare DNS zone setup** — solid. No bugs, no retries needed.
- **Stripe billing** — out of scope for this tool but works.
- **Postgres + Redis + BullMQ + Next.js stack** — fine.
- **PowerShell-service for Exchange Online operations** — required for what Graph doesn't expose, works.
- **Bootstrap user + invite flow** — working.
- **Single-tenant, low-noise provisioning** — when nothing weird happens, takes ~15-25 min end-to-end.

---

## What's broken — by category

### A. Microsoft Graph eventual-consistency races

These are real Microsoft behaviors that our code doesn't handle robustly. Listed in order of operator-visible pain:

| # | Symptom | Where | Status |
|---|---|---|---|
| A1 | "Primary user 'X' not found in tenant" right after creating that user | `microsoft.ts:ensurePrimaryUserLicensed` | **Fixed PR #41** — now passes userId directly + 5-attempt poll fallback |
| A2 | "X/99 mailboxes claimed by PowerShell but not visible in Microsoft Graph" | `microsoft.ts:setupSharedMailboxes` | **Partially fixed PR #41** — 4-attempt poll up to 3min. Still hard-fails if 1 lingers past 3min. |
| A3 | "Resource not found" when granting Global Admin to a freshly created user | `microsoft.ts:createLicensedUser` (grant block) | Mitigated — 6-attempt backoff with up to 30s waits. Works in practice. |
| A4 | "Updates to unverified domains are not allowed" right after verify succeeds | `microsoft.ts:setDomainAsDefault` | Mitigated — 8-attempt loop with 10s sleeps. Magic number, not measured. |
| A5 | License attach returns 200 but the license never actually attaches | `microsoft.ts:ensurePrimaryUserLicensed` Step D | Mitigated — read-after-write verify, 3 attempts. |

### B. Consent / device-code / auth flow

| # | Symptom | Where | Status |
|---|---|---|---|
| B1 | AADSTS650051 "service principal already present" when re-running device-code consent | Whole device-code flow | **Fixed PR #42** — preflight `isAppConsentedInTenant` skips device-code if SP exists |
| B2 | "New code" click makes the row disappear from the device-auth list for ~5-30s | `app/api/tenant/[id]/retry/route.ts` | **Fixed PR #42** — stopped pre-nulling `authCode` on non-tenant_prep restarts |
| B3 | "I've Entered the Code" returns ok but UI keeps showing "Enter code..." | `app/api/tenant/[id]/confirm-auth/route.ts` short-circuit | **Fixed PR #43** — short-circuit now flips status to `mailboxes` |
| B4 | Stale `currentStep` saying "Enter code XYZ" after auth confirmed | UI/state desync | **Fixed PR #43** — `currentStep` cleared on auth confirm |
| B5 | Device codes expire before operator enters them (15-min Microsoft TTL) | UI / process | Open — needs a clearer countdown in the UI and auto-regen on click. |

### C. Domain conflict / ownership

| # | Symptom | Where | Status |
|---|---|---|---|
| C1 | "Domain is being used by an active tenant" 30+ minutes into provisioning | `microsoft.ts:verifyDomainWithDns` | **Fixed PR #43** — preflight via OIDC discovery, fail fast with takeover instructions |
| C2 | Customer claims domain is fresh but it's verified in another MS tenant (unmanaged/viral tenant or forgotten earlier signup) | Customer side, not code | Open — process documented in `PROMPT_NEXT_CHAT_DOMAIN_DIAGNOSIS.md`. Customer must do Internal Admin Takeover via admin.microsoft.com or open MS Support ticket. |
| C3 | Microsoft Graph error code parsing is string-matching the message text instead of `error.code` | `processor.ts:isDomainPropagationError` etc | Open — brittle, breaks if Microsoft rephrases. ~1 hour to fix. |

### D. Mailbox provisioning (PowerShell + Graph)

| # | Symptom | Where | Status |
|---|---|---|---|
| D1 | Long-tail mailbox propagation (>3min for 1/99) hard-fails the phase | `microsoft.ts:setupSharedMailboxes` | Open — should silently downgrade missing ones and advance, let next run pick them up. ~30 min. |
| D2 | Delegation step occasionally hits "principal not found" for mailboxes that exist | PowerShell `setupSharedMailboxes` | Mitigated — own retry loop. |
| D3 | Sign-in enable / SMTP auth / Cloud App Admin steps run sequentially per mailbox in PowerShell, slow for 99-mailbox batches | `setupSharedMailboxes` | Open but acceptable — takes 5-15 min for 99 mailboxes. |
| D4 | **PowerShell service loses in-memory job state on restart** — worker calls `/start-create-shared-mailboxes` and gets a jobId, then polls `/create-shared-mailboxes-status/{jobId}` and gets HTTP 404 because the PS service restarted (Railway redeploy / OOM kill) and forgot the job. Worker fails after 6 consecutive 404s with "Mailbox creation status unavailable after 6 consecutive checks." | `uploader-service`-style fix needed in PowerShell service | **Open — biggest current production risk.** Same class of bug the uploader had pre-PR-#32; PS service needs persistent job state on a Railway volume. TN-002 hit this in the current batch. Workaround: click Retry (new PS jobId, new attempt). |

### E. ESP upload (Selenium-based)

| # | Symptom | Where | Status |
|---|---|---|---|
| E1 | "Could not find workspace button" — Instantly UI changed, all 6 XPath selectors miss | `uploader-service/app.py:inst_switch_workspace` | Open — would need fresh diag PNG to update selectors. |
| E2 | Featurebase changelog overlay can re-appear at any time, breaking clicks | `uploader-service/app.py` | Mitigated — `inst_dismiss_overlays` called before every click. Defensive but ugly. |
| E3 | "fetch failed" red banner on `/esp-upload` stayed forever after one transient poll error | `app/esp-upload/page.tsx` | **Fixed PR #39** — banner clears on next successful poll |
| E4 | Workspace Name field was required on the form — couldn't run single-workspace mode | `app/esp-upload/page.tsx` | **Fixed PR #39** — now optional, blank = single mode |
| E5 | Whole Selenium architecture is fundamentally fragile against Instantly's UI changes | `uploader-service/app.py` | Open — should be replaced with Instantly v2 API (which is already partially used for fetching existing accounts). |
| E6 | No "rerun a failed manual upload" button on `/esp-upload` page | UI | Open — uploader has the API, friend's UI doesn't expose it. ~15 min. |

### F. CSV download / generation

| # | Symptom | Where | Status |
|---|---|---|---|
| F1 | All 99 rows in downloaded CSV said the same DisplayName ("Emma Johnson") instead of per-persona | `lib/tenant-csv.ts:generateCsvFromDbState` | **Fixed PR #40** — re-runs `generateEmailVariations` to recover the email→name mapping |

### G. UI / state-sync / observability

| # | Symptom | Where | Status |
|---|---|---|---|
| G1 | "Processing in progress" useless message with no current step or progress | `app/batch/[id]/page.tsx` | **Fixed PR #41** — replaced with sub-step checklist + stale-detection warning |
| G2 | UI doesn't show whether worker is alive / working on a tenant | UI | Partially fixed PR #41 — sub-step checklist helps. But no way to see "queue position" or "stuck on phase X for Y min." |
| G3 | No first-attempt-success metrics for any operation | Whole codebase | Open — without this, we can't tune retry budgets or know what's flaky. |
| G4 | No structured logging — all `console.log` strings | Whole codebase | Open — major debugging pain. |
| G5 | `safeDecrypt` silently returns plaintext on decryption failure | `lib/services/emailUploader.ts:safeDecrypt` | Open — masks encryption bugs. ~15 min to fix but risky to ship without testing all callers. |

### H. Worker / queue / concurrency

| # | Symptom | Where | Status |
|---|---|---|---|
| H1 | Default `WORKER_CONCURRENCY = 1` — only 1 tenant provisions at a time | `lib/workers/processor.ts` | Open — bump via Railway env var, recommended `WORKER_CONCURRENCY=3`. |
| H2 | BullMQ jobs use 30 attempts × 30s = 15-min worst-case retry budget | `lib/queue.ts` | Open — too long, no circuit breaker. |
| H3 | Race in retry route (post-auth restarts): clears `authCode` before worker writes new one → row vanishes from UI for 5-30s | `app/api/tenant/[id]/retry/route.ts` | **Fixed PR #42** |
| H4 | Same race for the `tenant_prep` rewind path (which is the most common case for clicking "New code" on a pre-consent tenant) | `app/api/tenant/[id]/retry/route.ts` | **Fixed PR #45** — retry route now eagerly mints the device code synchronously before returning |
| H5 | Device-auth grid hid tenants the moment they advanced past auth_pending — operators thought rows were deleted | `app/batch/[id]/page.tsx` | **Fixed PR #46** — grid now shows ALL tenants from the original CSV unconditionally; per-row UI branches on status for the action/badge |

### I. Architectural

| # | Symptom | Status |
|---|---|---|
| I1 | DB flags treated as source of truth instead of "Microsoft is truth, DB is cache" — leads to status field lying about real state | Open — affects state-sync bugs |
| I2 | String-matched error classifiers (`isDomainPropagationError`, `isPermissionPropagationError`) instead of typed Graph error codes | Open — brittle |
| I3 | Phase logic implicitly defined by boolean flag combinations instead of an explicit state machine with allowed transitions | Open — hard to reason about |
| I4 | No tests anywhere | Open — accepted for internal-tool scope |
| I5 | Selenium-based ESP integration when both Instantly and Smartlead have official APIs | Open — biggest single source of fragility |

---

## What was shipped today (Apr 30, 2026)

- **PR #38** — Surface Microsoft's real domain-verify error instead of "5 attempts failed" generic
- **PR #39** — ESP upload workspace optional + fetch banner clears on next good poll
- **PR #40** — CSV download uses correct DisplayName per email
- **PR #41** — Graph eventual-consistency races + per-step UI visibility
- **PR #42** — Consent loop fix (AADSTS650051 + retry-row vanishing + I've Entered the Code stuck)
- **PR #43** — confirm-auth status flip + domain preflight via OIDC discovery
- **PR #45** — Retry route eagerly mints device code on tenant_prep rewind (fixes "click New code → row vanishes" for early-auth tenants)
- **PR #46** — Device-auth grid shows all tenants from the original CSV unconditionally; no longer hides rows that advance past auth_pending

---

## The actual architectural fix (the only thing that breaks the retry-everywhere pattern)

Every retry layer in this codebase exists because the worker assumes the DB is the source of truth and Microsoft is consistent. Both assumptions are wrong:

- The DB drifts from Microsoft constantly (writes from the worker, retry route, confirm-auth route, manual operator pushes)
- Microsoft is eventually consistent across at least 5 internal boundaries (POST → $filter, PowerShell → AAD sync, license attach, role assignment, domain verify)

So the worker reads stale DB flags, makes a Graph call assuming state, hits a race, retries on error. Retry layer covers up the design mistake. Bugs live in the seams between retry layers.

### The fix

**DB becomes a cache. Microsoft is the truth. Every phase boundary asks Microsoft "is this really done?" before advancing.**

Replace the inline retry-on-error sites in `lib/services/microsoft.ts` with named polling helpers that each:
1. GET the relevant Microsoft state
2. Check if the desired condition holds
3. Wait + re-poll until budget is exhausted (NOT retry-on-error — poll-until-ready)
4. Return a result; caller branches on it

```ts
awaitUserExistsInTenant(tenantId, upn): Promise<{ id: string } | null>
awaitDomainVerified(tenantId, domain): Promise<{ verified: boolean }>
awaitMailboxesVisible(tenantId, expectedEmails): Promise<{ missing: string[] }>
awaitLicenseAttached(tenantId, userId, sku): Promise<{ attached: boolean }>
awaitGlobalAdminGranted(tenantId, userId): Promise<{ granted: boolean }>
```

The worker phase machine reads Microsoft, reconciles DB to match, and only advances when Microsoft confirms. Retry counts in BullMQ drop from 30 to 3, because the polling handles transient state internally — BullMQ retries are reserved for real "the worker process died" failures.

### Why this kills entire categories of the bugs above

| Bug class | How this fix kills it |
|---|---|
| A1, A2, A3, A5 — Graph eventual-consistency races | Polling helper waits the propagation window out instead of throwing on first miss |
| B3, B4, H3, H4, H5 — DB-vs-Microsoft state drift | Worker reads Microsoft, reconciles DB; drift can't accumulate |
| D1, D4 — PowerShell propagation + restart loses jobId | Worker doesn't trust the PS jobId; queries Graph for mailbox visibility directly. PS restart no longer matters. |
| C3 — string-matched error classifiers | The polling helpers branch on Graph response shape, not message text. AADSTS / structured codes stay relevant; the brittle text classifier path goes away. |
| Most operator manual-DB-push interventions today | DB drift gets reconciled automatically each phase boundary |

### What this takes — 5 days, single operator

| Day | What |
|---|---|
| 1 | Build the 5 polling helpers in `lib/services/microsoft.ts`. Smoke-test against a test tenant. Old code unchanged. |
| 2 | Rewrite `setupDomainAndUser` to call helpers instead of inline retry loops. Behind a feature flag. |
| 3 | Same for `setupSharedMailboxes`. The mailbox visibility race + PS 404 issue both go away here. |
| 4 | Rewrite `processor.ts` phase machine to read Microsoft state and reconcile DB at every phase boundary. Drop BullMQ retry budget from 30 × 30s to 3 × 60s. |
| 5 | 5-tenant smoke batch end-to-end on the new path. Pull flag if it works, roll back if not. Post-mortem either way. |

### Trade-offs (honest)

- **Adds ~5-10 Graph calls per phase** → each phase ~5-10s slower. Acceptable.
- **Introduces a dependency on Microsoft being responsive** for state checks → already the case.
- **Polling helpers can mask "I'm slow but not really broken"** if budgets are too long → keep budgets tight (60-180s typical), surface real errors when they expire.
- **Doesn't add tests** → still no automated regression catching. Acceptable for internal-tool scope.

### What this is NOT

- Not the 3-month rewrite. Not test infrastructure. Not the Selenium → API replacement. Not observability dashboards. All real work, but separate weeks.
- Not theoretical. This is the smallest change that empirically would have prevented the bugs we hit in batch `cmokasf7a003bny1r3k6awkcf` — see the postmortem for one-by-one root-cause mappings.

---

## Plan

### Phase 1 — finish the current batch (`cmokasf7a003bny1r3k6awkcf`)

In progress. Manually unstuck TN-006/007/011 in DB. Click Retry on TN-002 / TN-009 / TN-008. TN-003 blocked on customer admin takeover. 4 of 11 currently complete.

### Phase 2 — Selenium → API for ESP upload (1 week)

Single biggest source of fragility. Replace the Selenium-based Instantly upload with Instantly v2 API calls. Same for Smartlead's API. Selenium uploader is deprecated but kept available for fallback for 1-2 weeks before deletion.

After this:
- E1, E2, E5 above resolved entirely
- "Could not find workspace button" / "Featurebase overlay" go away
- Throughput improves (parallel API calls vs serial Chrome sessions)
- Memory pressure on the uploader service drops (no more headless Chromium)

### Phase 3 — Microsoft Graph layer cleanup (1 week)

Address category I bugs (architectural) and remaining A/C bugs:
- Replace `console.log` in service layer with structured per-call logging: `{op, tenantId, attempt, latency, ok|errCode}`. Just to console for now — even unstructured-but-consistent logs make debugging 10x faster.
- Replace string-matched error classifiers with typed `GraphError` keyed on `error.code`.
- Rebuild `microsoft.ts` retry sites as named polling helpers: `awaitUserVisible(id)`, `awaitLicenseAttached(userId, sku)`, `awaitDomainVerified(domain)`. Each with measured budgets.
- Reduce arbitrary 8-attempt loops to data-driven values once we have first-attempt metrics.

### Phase 4 — UI / operator UX (~3 days)

- Force-advance button on a per-tenant card (operator escape hatch when DB drifts from Microsoft state)
- Manual rerun button on `/esp-upload`
- Better stale-state detection (already partially done in PR #41)
- Device-code countdown timer with auto-regen at <2min remaining

### Phase 5 — `safeDecrypt` and other defensive-fallback removal (~1 day)

Audit every "if X fails, fall back to Y" pattern. Most of them mask bugs. Convert the obvious ones to fail-loud. Keep the genuinely-defensive ones (like Cloudflare delete being best-effort) but add explicit logs when the fallback fires.

---

## What's deliberately deferred

- Test infrastructure (acceptable for an internal tool — bug discovery happens in production)
- Multi-operator support / RBAC (single operator, not needed)
- Reseller / white-label / public API (was scoped out — focus on internal tool only)
- Microsoft 365 Business Premium / advanced licenses (current `EXCHANGESTANDARD` is enough)
- High availability / failover (one operator can tolerate 30-min downtime)

---

## Operator runbook for stuck tenants

Quick decision tree when a tenant is stuck in this batch or future ones:

1. **`status: failed` with `errorMessage` containing "Domain is being used by an active tenant"** → blocked on customer Admin Takeover. Mark blocked, contact customer.
2. **`status: failed` with `errorMessage` containing "Primary user ... not found in tenant"** → PR #41/#42 race that should now self-recover. Click Retry once.
3. **`status: failed` with `errorMessage` containing "X/99 mailboxes ... not visible in Microsoft Graph"** → Microsoft propagation tail. Click Retry — by retry time, missing mailboxes will have appeared.
4. **`status: auth_pending` with `authConfirmed: true` in DB** → state desync (PR #43 fixes the source). Click "I've Entered the Code" — the route now flips status correctly.
5. **`status: auth_pending` with `authConfirmed: false` and an active device code** → operator action. Open microsoft.com/devicelogin, sign in as that tenant's `adminEmail`, enter the code, click "I've Entered the Code".
6. **`status: auth_pending` and the row disappears when "New code" is clicked** → PR #42 fixes this. Hard-refresh once the deploy lands.
7. **Worker hasn't moved a tenant for >5 min, no error** → Likely the worker is busy on a different tenant (concurrency=1). Bump `WORKER_CONCURRENCY=3` in Railway env vars.

---

## Last-known-good commits

- `4197e99` (PR #42) — consent loop fix
- `7c00127` (PR #41) — Graph races + UI
- `c06e7f8` (PR #40) — CSV display name
- `f45357e` (PR #39) — ESP upload UI + fetch banner
- `c76da3e` (PR #38) — domain-verify real error message

Each merged into `main`, auto-deployed to `cooperative-delight-production.up.railway.app`.
