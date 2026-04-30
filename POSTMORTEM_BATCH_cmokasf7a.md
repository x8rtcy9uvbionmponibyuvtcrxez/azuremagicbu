# Postmortem — batch `cmokasf7a003bny1r3k6awkcf` (Apr 29-30, 2026)

**Batch:** `cmokasf7a003bny1r3k6awkcf`
**Total tenants:** 11
**Submitted:** 2026-04-29 16:57:11 UTC
**Audited end-of-batch state:** 2026-04-30 ~07:55 UTC
**Operator:** 1 (Kunal)

This is a tenant-by-tenant breakdown of every problem that surfaced during this batch, with the **true root cause** for each (not the surface symptom), citations to code/DB/event-log/Microsoft-API where relevant.

---

## Outcome at audit time

| # | Tenant | Domain | Final state | Was the original error a real bug, an MS-side issue, or a design problem? |
|---|---|---|---|---|
| TN-001 | Prewarmed | prewarmedforge.com | in-flight, cloudflare phase | recovered after multiple retries — design (DB drift) |
| TN-002 | Prewarmed | warmdomains.com | recovered after manual retry | design (PS service restart) + masked by retry |
| TN-003 | Prewarmed | trysibillitalia.com | **failed permanently** — DomainInUse | external (customer's domain locked in another MS tenant) |
| TN-004 | Prewarmed | mattersibill.com | **completed cleanly** | none — happy path |
| TN-005 | Prewarmed | matterssibill.com | in-flight, mailbox_config | recovered — design (auto-retry on permission propagation worked) |
| TN-006 | Prewarmed | findoursibill.com | completed after manual DB push | design (Graph race + DB drift) |
| TN-007 | Prewarmed | sicurosibill.com | in-flight after manual DB push | design (DB drift after consent) |
| TN-008 | Prewarmed | sicurasibill.com | in-flight after operator entered code | normal flow |
| TN-009 | Prewarmed | turnonsibill.com | recovered after retry | design (Graph race) |
| TN-010 | Prewarmed | matterssibills.com | **completed cleanly** | none — happy path |
| TN-011 | Prewarmed | inviasibill.com | recovered after manual DB push | design (Graph race + DB drift) |

**First-pass success rate: 2 / 11 (18%).** Everything else needed at least one retry, manual DB intervention, or external customer action to make progress. Of the 9 non-happy-path cases, 8 were caused by problems in our own code; 1 (TN-003) was an external Microsoft-side block.

---

## Per-tenant root cause analysis

### TN-001 — prewarmedforge.com — auth_pending, recovered

**Surface symptom:** Operator entered code multiple times. Worker emitted `auth_confirmed: Auth already confirmed. Resuming processing.` event 4 times in 30 seconds (`TenantEvent` rows at 22:57:03, 22:57:07, 22:57:09, 22:57:11 UTC). Tenant did not visibly advance for ~14 hours despite the apparent confirmations.

**True root cause:** the `confirm-auth` route's short-circuit at `app/api/tenant/[id]/confirm-auth/route.ts:43-52` (pre-PR-#43 code) saw `tenant.authConfirmed === true` already and bailed early, just enqueuing a worker job. **It did not update `status` from `auth_pending` to `mailboxes`**, so the UI continued displaying "Enter code..." and the operator had no signal that anything was happening.

The DB-vs-Microsoft state drift: `authConfirmed=true` and `tenantId` populated (Microsoft consent done) but `status='auth_pending'` (DB-side phase tracking out of sync).

**Fix shipped:** PR #43 — `confirm-auth` short-circuit now flips `status` to `mailboxes` and clears device-code fields when auth is already confirmed.

---

### TN-002 — warmdomains.com — failed → recovered after retry

**Surface symptom:** `errorMessage = "Mailbox creation status unavailable after 6 consecutive checks. Last error: Mailbox create status endpoint returned 404"` at 23:39:40 UTC.

**True root cause:** the worker called the PowerShell service's `/start-create-shared-mailboxes` endpoint, got back a `jobId`, then polled `/create-shared-mailboxes-status/{jobId}` to track progress. The PowerShell service **lost its in-memory job map** between job creation and the first poll — most likely because of a Railway redeploy or container restart of the PS service mid-run (PS service has no persistent job state, unlike the uploader which got that fix in PR #32).

The worker's polling loop in `lib/services/microsoft.ts:setupSharedMailboxes` got 404 responses six times, hit its `maxPolls` budget, threw with the misleading "status unavailable" message — even though the actual mailboxes might have been created successfully on the Exchange side.

This is bug **D4 in PROJECT_STATE.md** and is the same class of issue the uploader had pre-PR-#32.

**Recovery:** retry created a new PS job with a fresh `jobId`, and the PS service didn't restart again during this attempt → succeeded.

**Fix not yet shipped:** Either (a) make the PS service persist job state across restarts to a Railway volume, or (b) have the worker query Graph for mailbox visibility directly rather than trust the PS jobId. Option (b) is the architectural fix described in `PROJECT_STATE.md`.

---

### TN-003 — trysibillitalia.com — failed permanently

**Surface symptom:** `errorMessage = "Domain trysibillitalia.com is registered in another Microsoft 365 tenant and must be released before it can be verified here. Microsoft response: Domain verification failed with the following error: 'Domain is being used by an active tenant'."`

**True root cause:** the customer's domain `trysibillitalia.com` is verified in a Microsoft Entra ID tenant other than the one we're trying to provision against. Microsoft Graph returns `Request_BadRequest` with detail code `DomainInUse` (target `Name.Conflict`) when we attempt to verify the domain in our target tenant.

This is **not a code bug**. The customer (or someone with `@trysibillitalia.com` email access) at some point signed up for a Microsoft service that auto-created an Entra ID tenant claiming the domain — most commonly a Power BI / Microsoft Teams free / Office 365 trial signup, which creates an "unmanaged" / "viral" tenant that holds the domain hostage until released.

OIDC discovery confirms: `https://login.microsoftonline.com/trysibillitalia.com/.well-known/openid-configuration` returns an `issuer` whose tenant GUID is **not** the tenant we provisioned for the customer.

**Recovery (customer action, not code):** customer must do **Internal Admin Takeover** at https://admin.microsoft.com (sign in with any `@trysibillitalia.com` address; Microsoft will offer the takeover flow), then release the domain. Or open a Microsoft Support ticket citing the conflicting tenant ID.

**Fix shipped:** PR #43 — `addDomainToTenant` now does a public OIDC pre-flight before attempting the add. Future tenants with this state fail fast with the takeover instructions, instead of burning 30+ minutes of DNS polling and verify retries.

---

### TN-004 — mattersibill.com — completed cleanly

**Surface:** completed at 100%, `currentStep = "All mailboxes configured and connected"`. No retries, no errors.

**Root cause:** N/A. This is what the happy path looks like. The fact that we got 2 of 11 happy-path completions and 9 had to recover from something is the actual signal.

---

### TN-005 — matterssibill.com — in-flight, mailbox_config

**Surface symptom:** Repeated `phase_warning: Permission propagation delay detected; scheduled automatic retry` events. Auto-retry timer of 6m 22s on the page.

**True root cause:** Microsoft Entra ID's permission propagation lag — after a Global Admin role is granted to a freshly-created user, Graph operations under that user's identity can hit `Authorization_RequestDenied` for ~30s to 5min while the role assignment propagates across Microsoft's internal replicas.

Our code at `lib/workers/processor.ts:51-59` (function `isPermissionPropagationError`) detects this via **string-matching the error message** for substrings like "insufficient privileges" or "authorization_requestdenied", and schedules an auto-retry after `PRIVILEGE_PROPAGATION_RETRY_DELAY_MS` (default ~6 minutes).

This worked for TN-005 — the auto-retry mechanism did its job. But the design is fragile:

- If Microsoft ever rephrases the error from "Authorization_RequestDenied" to anything that doesn't match the regex, the classifier fails silently → no auto-retry → tenant marked failed.
- The 6-minute delay is a magic number, not a measured value. We don't know if 6 minutes is right, too long, or too short.

**This is bug C3 in PROJECT_STATE.md** — string-matched error classifiers instead of typed Graph error codes.

**Fix not yet shipped:** replace `isPermissionPropagationError` with structured Graph `error.code` matching (Microsoft returns `code: "Authorization_RequestDenied"` as a stable structured field). Also covered by the architectural shift (polling helper `awaitGlobalAdminGranted` would just keep polling rather than throw on the first 403).

---

### TN-006 — findoursibill.com — recovered via manual DB push

**Surface symptoms over the lifecycle:**
1. First failure (22:44 UTC): `errorMessage = "Mailbox provisioning incomplete: 1/99 mailboxes claimed by PowerShell but not visible in Microsoft Graph. Retry will attempt creation again for the missing ones. Examples: e.thompson@findoursibill.com"`
2. Second state (07:11 UTC): operator clicked retry → restartStatus rewound to `licensed_user`/`mailboxes`, `authConfirmed=true`, `tenantId` set, but `status` flipped to `auth_pending` and `currentStep` showed "Enter code..."
3. Operator clicked "I've Entered the Code" 0 times for TN-006 (per event log), but tenant later shifted to `completed` autonomously after manual DB intervention.

**True root cause(s) — there were two stacked:**

**Cause 1 (mailbox phase failure):** Exchange Online → Azure AD sync delay. PowerShell created all 99 mailboxes and reported `created` for each. The verification code at `lib/services/microsoft.ts:setupSharedMailboxes` (mailbox-visibility check) read Graph **once**, found 1 of 99 not yet visible, and threw the "1/99 missing" error. The 1 missing mailbox propagated to Graph within seconds after the throw.

**Cause 2 (state drift after retry):** the retry route at `app/api/tenant/[id]/retry/route.ts:251-261` (pre-PR-#42 code) cleared `authCode`, `deviceCode`, `authCodeExpiry` for non-tenant_prep restarts but kept `authConfirmed=true`. The `confirm-auth` route then short-circuited (because `authConfirmed=true`) without updating `status`, leaving the tenant frozen at `status=auth_pending` while consent was already done.

**Recovery:** Manual DB UPDATE pushed status forward to `mailboxes`, worker resumed, completed cleanly.

**Fixes shipped:**
- PR #41 — mailbox visibility check now polls 4 times with waits 0/30/60/90s instead of single-read. Reduces but does not eliminate the long-tail propagation case.
- PR #42 — retry route stops pre-nulling `authCode` so the device-auth UI doesn't lie.
- PR #43 — confirm-auth short-circuit now updates status.

**Architectural fix needed:** mailbox phase should poll until propagated and never hard-fail on the count. If 1 mailbox truly didn't get created, the next phase will tell us (via Graph not returning it) — and we can recreate just that one. The PR #41 fix made this less painful but did not solve it: a 99/99 ghost case can still occur if Microsoft's queue is genuinely backed up beyond the 90s polling budget.

---

### TN-007 — sicurosibill.com — in-flight, recovered partly via manual DB push

**Surface symptom:** stuck at `status=auth_pending`, `authConfirmed=true`, `tenantId` set, four `auth_confirmed: Auth already confirmed. Resuming processing.` events between 22:57:03 and 22:57:11 UTC, no progress for ~14 hours, then post-deploy events at 23:09:44 (retry from domain_add) and 23:11:22 (auth_code_generated).

**True root cause:** identical to TN-006's Cause 2. Operator clicked "I've Entered the Code" multiple times. Each click hit the `authConfirmed=true` short-circuit at `app/api/tenant/[id]/confirm-auth/route.ts:43-52` and just enqueued a worker job without updating status. The worker picked up the jobs but the tenant's phase state was inconsistent (status=auth_pending while phase flags said domain wasn't even added).

This is the same DB-vs-Microsoft drift bug that affected TN-006/011.

**Recovery:** Manual DB UPDATE rewound to `domain_add` so the worker would re-run that phase from a known state.

**Fixes shipped:** PR #43.

---

### TN-008 — sicurasibill.com — in-flight, recovered normally

**Surface symptom:** at one point clicking "New code" caused the row to disappear from the device-auth grid for ~30s.

**True root cause:** "New code" button at `app/batch/[id]/page.tsx:914` calls `callTenantAction(tenant.id, "retry")`. The retry route at `app/api/tenant/[id]/retry/route.ts:140-149` for tenants in pre-consent state rewinds to `restartStatus = "tenant_prep"`, which at line 256-257 wipes `authConfirmed`, `tenantId`, `authCode`, `deviceCode`, `authCodeExpiry`.

The device-auth UI grid filter at `app/batch/[id]/page.tsx:560-563` (pre-PR-#46 code) was:
```ts
authGridTenants = tenants.filter((tenant) => tenant.status === "auth_pending" || Boolean(tenant.authCode));
```

After the retry route's update, status was `tenant_prep` and `authCode` was null → both filter conditions false → row hidden. The worker would then pick up the queued job, call `initiateDeviceAuth`, generate a fresh code, set `status=auth_pending` and write a new `authCode` — at which point the row reappears. The gap between retry-clicked and worker-runs-initiateDeviceAuth is typically 5-30s, during which the operator stares at an empty list.

**True root cause: the retry route doesn't atomically replace the auth-state fields with a fresh device code; it nulls them and waits for the worker.**

**Fixes shipped:**
- PR #45 — retry route now eagerly calls `initiateDeviceAuth` synchronously before returning. The new authCode/deviceCode/authCodeExpiry land before the response goes back to the UI; row stays visible the entire time.
- PR #46 — device-auth grid no longer filters at all; shows every tenant from the original CSV with appropriate per-row badges/buttons. Even if a future filter bug regresses, the operator never loses sight of a row.

---

### TN-009 — turnonsibill.com — failed → recovered after retry

**Surface symptom:** `errorMessage = "Mailbox provisioning incomplete: 99/99 mailboxes claimed by PowerShell but not visible in Microsoft Graph"` at 04:19:27 UTC (pre-PR-#41 code, when the verifier was a single-shot Graph read).

**True root cause:** identical to TN-006's Cause 1 (Exchange → AAD sync delay), but at the worst extreme: NONE of the 99 mailboxes had propagated to Graph in the brief window between PowerShell finishing and our verifier reading. PowerShell had created them; Graph just hadn't seen them yet.

**Recovery:** retry created a new PS job. By the time the second attempt's verifier ran, all 99 had propagated. Succeeded.

**Fix shipped:** PR #41 — 4-attempt polling with 90s total wait window. Reduces the rate at which this hits, doesn't eliminate it.

**Architectural fix:** same as TN-006 — phase boundary should poll until verified, not throw + force operator retry.

---

### TN-010 — matterssibills.com — completed cleanly

**Surface:** completed at 01:09:26 UTC, `currentStep = "All mailboxes configured and connected"`. No retries.

**Root cause:** N/A. This is the second of 2 happy-path completions in this batch.

---

### TN-011 — inviasibill.com — recovered via manual DB push

**Surface symptom:** `errorMessage = "Primary user 'emma.thompson@inviasibill.com' not found in tenant. Ensure the licensed user was created before attempting license allocation."` at 09:13:24 UTC.

**True root cause:** the canonical Microsoft Graph eventual-consistency footgun. The code at `lib/services/microsoft.ts:createLicensedUser` `POST`s to `/users` and successfully creates the user (Microsoft returns 201 with the user id). It then calls `ensurePrimaryUserLicensed` at `lib/services/microsoft.ts:807` (pre-PR-#41 signature) passing only the UPN. That function does:

```ts
const primaryFilter = encodeURIComponent(`userPrincipalName eq '${escapeODataString(primaryUpn)}'`);
const primaryResult = await graphRequest<{ value: ... }>(
  accessToken,
  `/users?$filter=${primaryFilter}&$select=id,userPrincipalName,assignedLicenses`
);
const primary = primaryResult.value?.[0];
if (!primary?.id) {
  throw new Error(
    `Primary user '${primaryUpn}' not found in tenant. ...`
  );
}
```

Microsoft's `$filter` queries hit a different (eventually-consistent) replica from the one POST writes to. A user POSTed seconds ago is **immediately** visible at `/users/{id}` (read-by-id is strongly consistent) but **not yet** visible to `$filter` queries. The lookup returned 0 results; the code threw "user not found" — even though the user existed and was returned successfully by the POST that created them moments before.

**Recovery:** manual DB push to `licensed_user` phase with `licensedUserId` cleared so the worker would re-run from license allocation. The retry succeeded because by then enough time had passed for the user to be visible to `$filter`.

**Fix shipped:** PR #41 — `ensurePrimaryUserLicensed` now accepts `{ id, upn }`. `createLicensedUser` passes the userId from POST `/users` directly, so the function does `GET /users/{id}` (strongly consistent) and never has to race against the filter index. For the unavoidable UPN-only paths, the new `lookupUserByUpnWaitingForPropagation` helper polls for ~75s with `ConsistencyLevel: eventual`.

---

## Cross-cutting root causes

### 1. DB-vs-Microsoft state drift is the single most common source of operator pain

5 of the 11 tenants (TN-001, TN-006, TN-007, TN-008, TN-011) hit some variant of "DB says one thing, Microsoft says another, UI lies, operator clicks repeatedly because nothing visibly changes." The root pattern:

- A retry, a manual operator action, or a partial worker run updates one set of DB fields
- The matching Microsoft-side state is in a different lifecycle phase
- The UI reads DB fields and shows stale information
- Operator clicks again, retry route updates more DB fields, drift accumulates

**Single fix:** treat Microsoft as the source of truth, the DB as a cache to be reconciled at every phase boundary.

### 2. Microsoft Graph eventual-consistency races account for ~half the in-flight failures

3 of 11 tenants (TN-002, TN-006, TN-009, TN-011 partially) hit a Graph propagation race. The pattern:

- Worker writes to Microsoft (POST /users, addDomain, PowerShell New-Mailbox, etc.)
- Worker IMMEDIATELY reads back and verifies via a different Microsoft surface
- Microsoft hasn't propagated the write to the read surface yet → read returns nothing/stale → worker throws

**Single fix:** every read-after-write should be a polling helper with a measured budget, not a single-attempt + retry-on-error.

### 3. PowerShell service has no persistent job state

TN-002 hit this once (D4 in PROJECT_STATE.md). The PS service is a single point of failure: if it restarts during a tenant's mailbox phase, the worker's polling jobId becomes orphan and the tenant fails with a misleading 404 error. The uploader had this exact same class of bug pre-PR-#32 and was fixed by persisting job state to a Railway volume.

**Single fix:** mirror the uploader's PR #32 fix in the PowerShell service. OR: stop trusting the PS jobId entirely; have the worker query Graph for mailbox visibility directly.

### 4. The retry mechanism papers over the above three bugs and prevents real diagnosis

Operators clicked Retry **at least 14 times** during this batch (per `retry_requested` events in the TenantEvent log). Each click rotates the tenant through more DB writes, more state drift, more chances to hit a propagation race. Half the time it works; half the time the operator clicks again. Without the retry layer, all of the above bugs would have been louder and more obvious.

Quote from the conversation that led to this batch's debugging:
> "the problem is we are soo deeply relying on retry to fix that the main path is so weak"

That's the correct diagnosis. The retries are NOT the safety net everyone thinks they are. They mask design problems that compound over time.

---

## What this batch proves

1. **First-pass success rate is ~18%** (2 of 11 tenants completed without retry/intervention). Anything else needed at least one operator click or DB push.
2. **The dominant failure modes are not Microsoft's fault.** Of the 9 non-happy-path tenants, 8 were caused by our code's design (race assumptions, state drift, no persistent PS state) — only TN-003 was a genuine Microsoft-side block.
3. **The fixes shipped today (PRs #38-#46) materially reduce future occurrences** — but they're patches, not the architectural shift. The next batch will hit the same classes of bugs less often, but it will hit them.
4. **The root cause is a single architectural assumption: that the DB is authoritative and Microsoft is consistent.** Both are wrong. Until that assumption is replaced, retry-as-recovery will continue to be the operator's primary tool.

---

## Recommendation

Do the architectural shift described in the new "The actual architectural fix" section of `PROJECT_STATE.md`. 5 working days, single-operator scope, no test infrastructure required.

Until then, expect the same per-batch pain we just experienced. Each subsequent batch will get incrementally better as bugs are squashed (PRs #38-#46 already removed several), but the underlying pattern will keep producing new bugs in the same shape.
