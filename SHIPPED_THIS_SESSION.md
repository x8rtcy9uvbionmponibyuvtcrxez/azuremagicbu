# Shipped this session — verified present on `main`

**Session date:** 2026-04-29 → 2026-04-30
**Total PRs merged this session:** 10 (PR #39 through PR #48)
**Verification method:** for each PR, confirm (a) its merge SHA is in `origin/main` history via `git merge-base --is-ancestor`, and (b) at least one signature string from the diff is grep-able in the file at the expected path on current `main` HEAD.

All 10 PRs verified ✅. The merge SHAs and the key code/text changes are present in the live repo at the time of writing.

---

## PR-by-PR log

### PR #39 — `f45357e` — `2026-04-29T16:47:46Z`
**Title:** ESP upload UI: workspace optional + clear stale fetch errors

**Files changed:** `app/esp-upload/page.tsx`

**What it does:**
- Workspace Name field on `/esp-upload` is no longer required. Blank submission auto-flips the uploader to `mode=single` instead of `multi`, skipping the broken Selenium workspace switch.
- The red "fetch failed" banner now clears on the next successful poll, instead of pinning forever after one transient hiccup.

**Verification on main:** ✅
- `app/esp-upload/page.tsx` contains the string `default workspace` (new placeholder) and `setError(null)` (clear-on-success).

---

### PR #40 — `c06e7f8` — `2026-04-29T17:03:30Z`
**Title:** CSV download: use the right display name per mailbox, not just the first

**Files changed:** `lib/tenant-csv.ts`

**What it does:**
- Re-runs `generateEmailVariations(names, domain, count)` inside `generateCsvFromDbState` to recover the email→DisplayName mapping. Each row in the downloaded CSV now uses the correct persona name for that specific email, instead of `names[0]` for everything.

**Verification on main:** ✅
- `lib/tenant-csv.ts` contains `buildEmailToDisplayNameMap` (helper) and `displayNameFor` (per-row lookup).

---

### PR #41 — `7c00127` — `2026-04-29T17:10:23Z`
**Title:** Fix Graph eventual-consistency races + per-step UI visibility

**Files changed:** `lib/services/microsoft.ts`, `app/api/batch/[id]/route.ts`, `app/api/tenant/[id]/retry/route.ts`, `app/batch/[id]/page.tsx`

**What it does:**
- `ensurePrimaryUserLicensed` now accepts `{ id, upn }` and prefers `GET /users/{id}` (strongly consistent) over `$filter` (eventually consistent). Eliminates the "Primary user not found in tenant" race after `POST /users`.
- New `lookupUserByUpnWaitingForPropagation` helper for UPN-only lookups: 5 attempts spaced 0/5/15/25/30s with `ConsistencyLevel: eventual`.
- Mailbox visibility check polls Graph 4 times with waits 0/30/60/90s instead of one-shot.
- `licensedUserId`/`licensedUserUpn` are persisted immediately after `POST /users`, not at end-of-phase.
- Retry route's `isLicenseError` matches "primary user … not found in tenant" so the rewind is correct.
- Batch GET API now returns every per-step boolean (`domainAdded`, `domainVerified`, `domainDefault`, `licensedUserId`, `sharedMailboxesCreated`, `passwordsSet`, `smtpAuthEnabled`, `delegationComplete`, `signInEnabled`, `cloudAppAdminAssigned`, `dkimConfigured`, `smartleadConnected`, `instantlyConnected`).
- `/batch/[id]` page replaces "Processing in progress." with sub-step checklist (✅/🔄/⏳), last-update freshness ("updated 12s ago" / amber "no update for 8m"), and stale-detection warning when worker hasn't moved for >5min.

**Verification on main:** ✅
- `lib/services/microsoft.ts` contains `lookupUserByUpnWaitingForPropagation` and the `{ id?: string; upn: string }` parameter shape.
- `app/api/batch/[id]/route.ts` selects `sharedMailboxesCreated: true` etc.
- `app/batch/[id]/page.tsx` renders sub-step labels including "Mailboxes created" and "Sign-in enabled".

---

### PR #42 — `4197e99` — `2026-04-30T07:17:28Z`
**Title:** Fix consent loop + retry-row vanishing + 'I've Entered the Code' deadend

**Files changed:** `lib/services/microsoft.ts`, `app/api/tenant/[id]/confirm-auth/route.ts`, `app/api/tenant/[id]/retry/route.ts`

**What it does:**
- New `isAppConsentedInTenant(orgId)` helper. Tries client_credentials; success means the SP exists and consent is done.
- `initiateDeviceAuth` preflights with the helper. If SP is in the customer tenant, mark `authConfirmed=true` and skip device-code consent — no more AADSTS650051 ("service principal already present") on retries.
- `confirm-auth` catch handler recognises AADSTS650051 as recoverable. Verifies SP via the helper, advances the tenant. Rescues already-stuck tenants.
- Retry route stops pre-nulling `authCode`/`deviceCode`/`authCodeExpiry` for non-tenant_prep restarts. Removes the 5-30s window where the device-auth UI row would vanish after clicking "New code".

**Verification on main:** ✅
- `lib/services/microsoft.ts` contains `isAppConsentedInTenant`.
- `app/api/tenant/[id]/confirm-auth/route.ts` imports `isAppConsentedInTenant` and matches on `AADSTS650051`.

---

### PR #43 — `e596734` — `2026-04-30T07:35:07Z`
**Title:** Setup process cleanup: confirm-auth status flip + domain preflight via OIDC

**Files changed:** `app/api/tenant/[id]/confirm-auth/route.ts`, `lib/services/microsoft.ts`

**What it does:**
- `confirm-auth` short-circuit (when `authConfirmed=true` already) now also flips `status` from `auth_pending` to `mailboxes` and clears device-code fields. UI stops showing "Enter code..." for tenants past consent.
- `addDomainToTenant` now calls `https://login.microsoftonline.com/<domain>/.well-known/openid-configuration` BEFORE attempting the add. If the issuer's tenant ID isn't ours, fail fast with a clear "domain locked in another tenant — needs Admin Takeover" error. Saves 30+ minutes of futile DNS polling.

**Verification on main:** ✅
- `lib/services/microsoft.ts` contains `preflightDomainNotInOtherTenant`.
- `app/api/tenant/[id]/confirm-auth/route.ts` contains the new "Continuing mailbox setup" status-flip code path.

---

### PR #44 — `ff00d5d` — `2026-04-30T07:38:34Z`
**Title:** Add PROJECT_STATE.md (state + known bugs + plan)

**Files changed:** `PROJECT_STATE.md` (new file)

**What it does:**
Single-source-of-truth project state document. Includes what works reliably, every known bug categorised by area (A–I) with status (Fixed/Mitigated/Open) and code citations, the 5-phase plan to make the pipeline reliable, and an operator runbook for stuck tenants.

**Verification on main:** ✅
- `PROJECT_STATE.md` exists at repo root and contains the "Cloudflare DNS zone setup" baseline reference.

---

### PR #45 — `1937d47` — `2026-04-30T07:51:40Z`
**Title:** Retry route: eagerly generate device code on tenant_prep rewind

**Files changed:** `app/api/tenant/[id]/retry/route.ts`

**What it does:**
When operator clicks "New code" on a tenant in early auth (status=auth_pending, authConfirmed=false), the retry route rewinds to `tenant_prep` and previously wiped `authCode`/`deviceCode`/`authCodeExpiry`. The device-auth UI grid filter required `auth_pending` status OR `Boolean(authCode)` — both became false in the gap, row vanished.

Fix: call `initiateDeviceAuth` synchronously in the retry route after the DB update when restartStatus is `tenant_prep`. The new auth fields land before the response returns; row stays visible the entire time.

**Verification on main:** ✅
- `app/api/tenant/[id]/retry/route.ts` contains the eager `initiateDeviceAuth(tenant.id)` call with the "Eager initiateDeviceAuth failed" log line for the catch.

---

### PR #46 — `76f85f1` — `2026-04-30T07:57:58Z`
**Title:** Device-auth grid: show all tenants unconditionally

**Files changed:** `app/batch/[id]/page.tsx`

**What it does:**
Stop hiding rows in the Device Authorization grid the moment they advance past `auth_pending`. Per-row rendering already handles every state (Completed/Failed badge for terminal, "New code" + "I've Entered the Code" buttons for in-flight). Filtering hid the row from operators who thought it had been deleted.

**Verification on main:** ✅
- `app/batch/[id]/page.tsx` contains the comment "Show ALL tenants from the original CSV unconditionally".

---

### PR #47 — `9ed692b` — `2026-04-30T08:10:46Z`
**Title:** Docs: postmortem of batch cmokasf7a + architectural fix in PROJECT_STATE

**Files changed:** `POSTMORTEM_BATCH_cmokasf7a.md` (new), `PROJECT_STATE.md` (updated)

**What it does:**
- New postmortem covering all 11 tenants in batch `cmokasf7a003bny1r3k6awkcf` with true root cause + citations for each.
- New section in `PROJECT_STATE.md`: "The actual architectural fix" — describes the single shift (Microsoft as source of truth, DB as cache) and a 5-day plan to ship it. Adds new bugs D4, H4, H5 to the catalogue and updates "What was shipped today" with PRs #45/#46.

**Verification on main:** ✅
- `POSTMORTEM_BATCH_cmokasf7a.md` exists with "Cross-cutting root causes" section.
- `PROJECT_STATE.md` contains "The actual architectural fix" section.

---

### PR #48 — `7bd9bbe` — `2026-04-30T08:15:41Z`
**Title:** Add PROMPT_NEXT_CHAT.md (verification + fix prompt)

**Files changed:** `PROMPT_NEXT_CHAT.md` (new file)

**What it does:**
Self-contained handoff prompt for the next Claude session. Phase 1 = aggressively verify everything from this session's analysis from scratch (treats `PROJECT_STATE.md` and `POSTMORTEM` as suspect). Phase 2 = solve it, only after forming an independent opinion.

Includes: pointers to all required access (DB / Graph creds — referenced by name only, secrets shared out-of-band), suspected weaknesses of this session's analysis, and a recommended first-5-commands list to flush out whether phase 1 is shallow or deep.

**Verification on main:** ✅
- `PROMPT_NEXT_CHAT.md` exists with "Aggressive independent verification" header and "Phase 1 — verification checklist" section.

---

## Summary table

| PR | SHA | Date (UTC) | Type | Verified |
|----|-----|---|---|---|
| #39 | `f45357e` | 2026-04-29 16:47:46 | Code (UI) | ✅ |
| #40 | `c06e7f8` | 2026-04-29 17:03:30 | Code (CSV) | ✅ |
| #41 | `7c00127` | 2026-04-29 17:10:23 | Code (provisioning + UI) | ✅ |
| #42 | `4197e99` | 2026-04-30 07:17:28 | Code (auth/consent) | ✅ |
| #43 | `e596734` | 2026-04-30 07:35:07 | Code (auth + domain) | ✅ |
| #44 | `ff00d5d` | 2026-04-30 07:38:34 | Docs | ✅ |
| #45 | `1937d47` | 2026-04-30 07:51:40 | Code (retry route) | ✅ |
| #46 | `76f85f1` | 2026-04-30 07:57:58 | Code (UI) | ✅ |
| #47 | `9ed692b` | 2026-04-30 08:10:46 | Docs | ✅ |
| #48 | `7bd9bbe` | 2026-04-30 08:15:41 | Docs | ✅ |

**Code PRs:** 7
**Doc PRs:** 3
**All present on `origin/main`:** yes
**All key signature strings present in expected files at current HEAD:** yes

---

## Manual DB writes done this session (NOT shipped as code)

These are direct UPDATEs to friend's production Postgres for batch `cmokasf7a003bny1r3k6awkcf`. They exist as one-time interventions, not as committed code.

| Tenant | Domain | Action | Rationale |
|---|---|---|---|
| TN-006 | findoursibill.com | Pushed `status` from `auth_pending` to `mailboxes` (then later overwritten back to `completed` after I noticed the worker had already finished the tenant in parallel) | Stuck on DB-vs-Microsoft drift before PR #43 deployed |
| TN-007 | sicurosibill.com | Pushed `status` from `auth_pending` to `domain_add` (rewound to its actual phase) | Same drift |
| TN-011 | inviasibill.com | Pushed `status` from `auth_pending` to `licensed_user`, with `licensedUserId` cleared so worker re-runs license assignment | Same drift + license phase had previously failed |

These pushes are no longer needed for any future tenant — PR #43's `confirm-auth` status-flip handles this drift automatically going forward.

---

## How to re-verify yourself

Run this from `/Users/kunalgoyal/Desktop/claude/azure` after a `git fetch`:

```bash
for sha in f45357e c06e7f8 7c00127 4197e99 e596734 ff00d5d 1937d47 76f85f1 9ed692b 7bd9bbe; do
  if git merge-base --is-ancestor $sha origin/main 2>/dev/null; then
    echo "✅ $sha on main"
  else
    echo "❌ $sha NOT on main"
  fi
done
```

If all 10 print `✅`, every PR from this session is still in the repo's main branch.
