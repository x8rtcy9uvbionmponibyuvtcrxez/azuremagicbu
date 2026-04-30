# Prompt for the next chat — verify everything from scratch, then fix

Paste this into a new chat session. The previous session shipped several PRs, wrote two analysis documents, and made a recommendation. **Do not trust any of it.** Re-verify from first principles, then act.

---

## Mission

Two phases. **Do not start phase 2 until phase 1 is complete and you have your own opinion.**

### Phase 1 — Aggressive independent verification (~2 hours)

The previous chat (Claude) audited the codebase, declared bugs, shipped fixes, and wrote a postmortem of batch `cmokasf7a003bny1r3k6awkcf`. Re-run every claim from scratch. Look for:

- Bugs the previous chat missed
- Bugs the previous chat invented that don't actually exist
- Fixes that don't actually fix what they claim
- Diagnoses that are wrong
- Citations that don't match the code

Be hostile to the previous analysis. The previous chat made at least one wrong inference per hour during that session. Find them.

### Phase 2 — Solve it (timeline depends on what phase 1 finds)

Only after phase 1 is done and you have your own model of what's broken. Don't trust the recommendations in `PROJECT_STATE.md` or `POSTMORTEM_BATCH_cmokasf7a.md` until you've independently verified them.

---

## Starting points (read in this order, with skepticism)

1. `/Users/kunalgoyal/Desktop/claude/azure/PROJECT_STATE.md` — current state document, ~280 lines. Heavily edited by the previous chat. Treat the bug catalogue (categories A-I) as a starting hypothesis only.
2. `/Users/kunalgoyal/Desktop/claude/azure/POSTMORTEM_BATCH_cmokasf7a.md` — tenant-by-tenant root-cause claims for the recent batch. Every "true root cause" assertion in there should be independently verifiable. Several are inferred from a single signal — flag the ones that aren't actually proven.
3. `/Users/kunalgoyal/Desktop/claude/azure` — the actual codebase. Repo: `github.com/x8rtcy9uvbionmponibyuvtcrxez/azuremagicbu`. You have full git access via `gh` CLI under account `x8rtcy9uvbionmponibyuvtcrxez`.

---

## Phase 1 — verification checklist

### 1.1 Verify the bug claims

For **every** bug listed in `PROJECT_STATE.md` (categories A1-A5, B1-B5, C1-C3, D1-D4, E1-E6, F1, G1-G5, H1-H5, I1-I5):

- Re-read the code at the cited file:line.
- Confirm the bug actually exists in current `main` (PR #38-#47 are merged; check `git log` on main).
- For "Fixed" bugs: confirm the fix actually fixes the bug AND doesn't introduce a new one.
- For "Open" bugs: confirm the bug is real, not just speculation.
- Specifically scrutinize bug **D4 (PowerShell service loses job state on restart)** — the previous chat inferred this from a single symptom (TN-002's 404 on poll) without checking the PS service code or logs. The diagnosis may be wrong.

### 1.2 Verify the postmortem citations

`POSTMORTEM_BATCH_cmokasf7a.md` cites specific timestamps, error messages, and code lines for each tenant. For at least 3 tenants of your choice:

- Re-query the DB and confirm the events, timestamps, and error messages match what's in the postmortem.
- Re-read the cited code line and confirm the bug matches the description.
- For TN-002 specifically: independently determine whether the PS service really restarted (check Railway logs if accessible, or PS service container's uptime).
- For TN-003: confirm the OIDC discovery actually returns a different tenant ID for `trysibillitalia.com`.

### 1.3 Verify the headline number

The postmortem claims "first-pass success rate is 2 of 11 (18%)." Define what counts as "first-pass" — does manual operator code-entry count as intervention? Recompute from the event log. Could be 18%, could be 30%, could be 9%. Get your own number.

### 1.4 Verify the architectural recommendation

`PROJECT_STATE.md` recommends a 5-day plan to "treat Microsoft as source of truth, DB as cache." Decide for yourself if this is:

- **Actually right** — and if so, what's the smallest version that captures 80% of the value?
- **Right in principle but wrong in scope** — does it actually need 5 days? Could 1 day of polling-helper additions cover most of it?
- **Wrong direction** — is there a better architectural fix? E.g., is the real problem that the worker should be a stricter state machine with explicit transition guards, not "Microsoft as truth"?
- **Overengineered for an internal tool** — would just fixing the specific bugs be enough?

### 1.5 Find what the previous chat missed

The previous chat scoped the audit to bugs that surfaced in the recent batch + ones inferred from code review. Things that probably weren't audited deeply:

- **The uploader (`uploader-service/app.py`)** — only inspected for the workspace-button bug. There may be more.
- **The PowerShell service** — never inspected. Source code path: probably `powershell-service/server.js` or similar.
- **The test mode flag (`TEST_MODE=true`)** — hardcoded synthetic flows in `microsoft.ts`. Not audited for divergence from real flow.
- **Edge runtime / middleware** — not inspected. Auth or state-handling bugs there?
- **The `inboxNames` parser** — `lib/utils.ts:parseInboxNamesValue`. The CSV display-name bug (PR #40) suggests the wider name-handling logic may have other issues.
- **Rate limiting / Microsoft Graph throttling** — never tested. What happens if we hit `Retry-After` from Graph?
- **Concurrent tenant runs** — only ever tested with `WORKER_CONCURRENCY=1`. Race conditions at higher concurrency completely unaudited.

For each of these, do a 15-minute pass and flag anything suspicious.

---

## Access you have

### Code

```
local repo: /Users/kunalgoyal/Desktop/claude/azure
remote: github.com/x8rtcy9uvbionmponibyuvtcrxez/azuremagicbu
gh CLI: authed as x8rtcy9uvbionmponibyuvtcrxez (full repo scope)
```

### Database (read-write — be careful)

The Postgres connection string is in friend's Railway env (`DATABASE_PUBLIC_URL` on the Postgres service of project `cooperative-delight`). **Ask Kunal to share it** — do not copy/paste it into any committed file. Same for any other secret on this list.

This is friend's production Postgres. The previous chat made manual `UPDATE` writes to this DB (TN-006/007/011 in batch `cmokasf7a003bny1r3k6awkcf`). Verify those manual updates didn't leave anything in an inconsistent state.

`pg` driver is available at `/Users/kunalgoyal/.tmp-pg/node_modules/pg`. Example:

```bash
DATABASE_URL="postgresql://..." /usr/local/bin/node -e '
  const { Client } = require("/Users/kunalgoyal/.tmp-pg/node_modules/pg");
  const c = new Client({ connectionString: process.env.DATABASE_URL });
  await c.connect();
  // ... query ...
  await c.end();
'
```

### Microsoft Graph (read-only inspection of customer tenants)

The `vibes` multi-tenant app credentials are in friend's Railway env on the worker / web service. **Ask Kunal to share** the `GRAPH_CLIENT_ID` and `GRAPH_CLIENT_SECRET` env vars — do not paste them into any committed file.

Once you have them, you can mint app-only tokens for any customer tenant where the `vibes` SP exists:

```bash
TENANT_ID="..."  # the customer tenant GUID, from DB tenant.tenantId
CLIENT_ID="..."
CLIENT_SECRET="..."
curl -s -X POST "https://login.microsoftonline.com/$TENANT_ID/oauth2/v2.0/token" \
  -d "client_id=$CLIENT_ID&client_secret=$CLIENT_SECRET&scope=https://graph.microsoft.com/.default&grant_type=client_credentials"
```

Use it to verify tenant state independently of friend's DB.

### Railway

You DO NOT have Railway access for friend's `cooperative-delight` project. Only Kunal's account is logged in via `railway` CLI, and that account doesn't have access to `cooperative-delight`. If you need worker logs or env var changes, the human (Kunal) has to do it via the Railway dashboard.

If you really need to check whether a deploy landed, the way that worked last time is to fetch the JS chunk hash from the public `/esp-upload` page and grep for known strings:

```bash
curl -s https://cooperative-delight-production.up.railway.app/esp-upload | \
  grep -oE '/_next/static/chunks/app/esp-upload/page-[a-f0-9]+\.js'
```

Then download the chunk and grep for strings introduced in recent PRs.

### Friend's app endpoints (public)

```
https://cooperative-delight-production.up.railway.app/
  /api/tenant/{id}/diagnose          — inspect tenant Graph state
  /api/tenant/{id}/retry              — trigger retry
  /api/tenant/{id}/retry-upload       — retry ESP upload
  /api/tenant/{id}/confirm-auth       — confirm device-code auth
  /api/batch/{id}                     — list tenants in a batch
```

Most are auth-walled but the `diagnose` endpoint accepts public requests.

---

## Things the previous chat is suspected of getting wrong

The previous chat (you, in the previous session) had the following weaknesses. Look for evidence of them:

1. **Inferred too aggressively from single signals.** Multiple "true root cause" claims in the postmortem are based on a single error message + a hypothesis about why. Where the cited code path obviously matches, the diagnosis is probably right. Where it's inferred from system behavior alone (D4 is the prime example), suspect it.
2. **Did not always verify deploys landed.** Said things like "PR #41 is now live" when only the web service was confirmed deployed; the worker and PS services may have been on stale code.
3. **Made manual DB writes** to TN-006/007/011 without rolling them back when the worker autonomously completed TN-006. May have left other rows in slightly off states.
4. **Conflated separate failure modes.** The "Mailbox visibility race" (PR #41) and the "PS service jobId 404" (D4) may be the same bug or two unrelated bugs — the previous chat treated them as separate without proving it.
5. **Promised fixes that only addressed the surface.** PR #41 was claimed to "fix" the mailbox race, then TN-006 immediately failed with a similar error post-deploy. The fix reduced occurrence rate but didn't eliminate it. The postmortem acknowledges this; the chat-time messaging did not.
6. **Wrote PROJECT_STATE.md and the postmortem in the same session as the bugs were being fixed**, which means they reflect the chat's understanding at a moment of partial information, not a settled analysis. Take everything in those docs as a draft.

---

## Phase 2 — solve it (when you're ready)

After phase 1, you should have:

- A list of bugs that ARE real and need fixing (some overlap with `PROJECT_STATE.md`, some new, some removed)
- A list of fixes the previous chat shipped that are wrong or incomplete (revert / re-do)
- An architectural recommendation that you actually believe in (could be the previous chat's "Microsoft as truth" or could be different)

Ship the fix. Constraints from Kunal:

- This is the **internal tool**, not the white-label SaaS. Scope is "1 operator, small batches" — don't overengineer.
- No test infrastructure required (acceptable trade-off for internal tool).
- Selenium → API replacement for ESP upload is the single biggest fragility win. May be worth doing first regardless of architectural plan.
- Communication style preferences (from Kunal's memory): plain English, short sentences, no jargon. No corporate hedging. If something's broken, say so.

---

## Recommended first 5 commands

1. `cd /Users/kunalgoyal/Desktop/claude/azure && git log --oneline -20` — see what's been shipped recently.
2. `cat /Users/kunalgoyal/Desktop/claude/azure/PROJECT_STATE.md` — read the inherited state doc.
3. `cat /Users/kunalgoyal/Desktop/claude/azure/POSTMORTEM_BATCH_cmokasf7a.md` — read the inherited postmortem.
4. Query the DB for the current state of every tenant in batch `cmokasf7a003bny1r3k6awkcf` — does it match the postmortem's narrative?
5. Pick one of the "Fixed PR #X" claims in `PROJECT_STATE.md` at random. Re-read the cited code on `main`. Confirm it does what the doc claims.

If commands 1-5 turn up no surprises, the previous chat's analysis is mostly right and phase 2 is the architectural shift. If they turn up surprises, phase 1 is more involved than expected and the architectural shift may not be the right move.

---

## What to deliver back to Kunal

After phase 1: a short report (200 words max) titled "what previous Claude got right, what got wrong" — with citations.

After phase 2: shipped PRs + a one-paragraph summary of what was actually wrong vs what the previous chat thought was wrong.

Don't sugar-coat. If the previous chat's diagnosis was right, say so. If it was wrong, say which parts and why.
