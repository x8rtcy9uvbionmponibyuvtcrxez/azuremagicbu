/**
 * Profile photo pipeline.
 *
 * Flow:
 *   1. extractPersonas(tenantId) — parse Tenant.inboxNames (JSON array of
 *      display names) and upsert one TenantPersona row per unique name.
 *      Idempotent. Fires from provisioning Phase 4 (after mailbox creation)
 *      and from POST /api/tenant/{id}/extract-personas for backfill.
 *
 *   2. Operator uploads a photo per persona via POST /api/tenant/{id}/personas/
 *      {personaId}/photo (multipart). Bytes get stored in TenantPersona.photoData.
 *
 *   3. applyPhotosToTenant(tenantId) — for each mailbox in mailboxStatuses,
 *      look up the M365 user by email, match Display Name → personaName,
 *      and PUT the photo bytes to /users/{userId}/photo/$value via Microsoft
 *      Graph. Mailboxes whose persona has no photo yet are skipped (logged).
 *      Status is rolled up to Tenant.profilePhotosApplied/Completed/Failed.
 *
 *      Triggered automatically from worker Phase 4.5 (between mailbox creation
 *      and ESP upload) when ALL personas have photos. Manual button available
 *      from POST /api/tenant/{id}/apply-photos at any time after personas exist.
 *
 * Storage: photo binary lives in Postgres BYTEA on TenantPersona.photoData.
 * Realistic scale: ~200 KB × 2 personas × 1000 tenants = ~400 MB total. Fine
 * for Postgres at this scale; backups handle it without separate infra.
 */

import { prisma } from "@/lib/prisma";
import { graphRequest, requestTenantGraphToken } from "@/lib/services/microsoft";

const ALLOWED_MIME = new Set(["image/jpeg", "image/png"]);
const MAX_PHOTO_BYTES = 4 * 1024 * 1024; // Microsoft Graph caps at 4 MB

/**
 * Parse Tenant.inboxNames into a unique, trimmed list of persona names.
 * Tolerates the field being a JSON array, a comma-separated string, or empty.
 * Returns names in the order they first appear (preserves operator intent).
 */
export function parsePersonaNames(inboxNames: string | null | undefined): string[] {
  if (!inboxNames) return [];
  let raw: unknown = inboxNames;
  // First try JSON; many tenants store as `["John Smith", "Jane Doe"]`.
  if (typeof raw === "string") {
    const trimmed = raw.trim();
    if (trimmed.startsWith("[")) {
      try {
        raw = JSON.parse(trimmed);
      } catch {
        // Fall through to comma-split below
      }
    }
  }
  let arr: string[];
  if (Array.isArray(raw)) {
    arr = raw.map((v) => String(v));
  } else if (typeof raw === "string") {
    arr = raw.split(",");
  } else {
    return [];
  }
  const seen = new Set<string>();
  const out: string[] = [];
  for (const v of arr) {
    const name = v.trim();
    if (!name) continue;
    const key = name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(name);
  }
  return out;
}

/**
 * Idempotently create TenantPersona rows for each unique name in the tenant's
 * inboxNames. Existing rows with the same (tenantId, personaName) are left
 * untouched — operator-uploaded photos persist across re-extractions.
 *
 * Returns the full set of personas after extraction (existing + new).
 */
export async function extractPersonas(tenantDbId: string): Promise<
  Array<{ id: string; personaName: string; hasPhoto: boolean }>
> {
  const tenant = await prisma.tenant.findUniqueOrThrow({
    where: { id: tenantDbId },
    select: { id: true, inboxNames: true }
  });
  const names = parsePersonaNames(tenant.inboxNames);
  if (names.length === 0) {
    console.log(`[profilePhotos] Tenant ${tenantDbId} has no inboxNames — no personas extracted`);
    return [];
  }
  // Use createMany with skipDuplicates so we don't trample existing rows.
  // The unique constraint on (tenantId, personaName) does the dedupe.
  const created = await prisma.tenantPersona.createMany({
    data: names.map((personaName) => ({
      tenantId: tenantDbId,
      personaName
    })),
    skipDuplicates: true
  });
  console.log(
    `[profilePhotos] Tenant ${tenantDbId}: ${names.length} unique persona names, ${created.count} new rows`
  );
  // Return full state so callers can reason about photo readiness.
  const all = await prisma.tenantPersona.findMany({
    where: { tenantId: tenantDbId },
    select: { id: true, personaName: true, photoData: true }
  });
  return all.map((p) => ({
    id: p.id,
    personaName: p.personaName,
    hasPhoto: p.photoData !== null && p.photoData.length > 0
  }));
}

/**
 * Validate + persist an uploaded photo file to a persona row. Returns the
 * persona with updated photoMime/photoSize/photoApplied=false (apply state
 * resets when a fresh photo is uploaded).
 */
export async function setPersonaPhoto(
  personaId: string,
  data: Buffer,
  mime: string
): Promise<{ ok: true; size: number } | { ok: false; error: string }> {
  if (!ALLOWED_MIME.has(mime)) {
    return { ok: false, error: `Unsupported MIME type ${mime}. Use JPEG or PNG.` };
  }
  if (data.length === 0) {
    return { ok: false, error: "Empty file" };
  }
  if (data.length > MAX_PHOTO_BYTES) {
    return {
      ok: false,
      error: `Photo too large (${data.length} bytes). Microsoft Graph caps at ${MAX_PHOTO_BYTES} bytes.`
    };
  }
  await prisma.tenantPersona.update({
    where: { id: personaId },
    data: {
      photoData: data,
      photoMime: mime,
      photoSize: data.length,
      photoApplied: false,
      applyError: null,
      appliedAt: null
    }
  });
  return { ok: true, size: data.length };
}

/**
 * Look up an M365 user by email (mailbox SMTP address) via Graph and return
 * { id, displayName }. We need the user GUID for the photo PUT endpoint —
 * mailbox email is what the operator's CSV gives us.
 */
async function resolveMailboxUser(
  accessToken: string,
  email: string
): Promise<{ id: string; displayName: string } | null> {
  try {
    // Try direct lookup first (works for primary UPN matches).
    const direct = await graphRequest<{ id: string; displayName: string }>(
      accessToken,
      `/users/${encodeURIComponent(email)}?$select=id,displayName`
    );
    if (direct?.id) return { id: direct.id, displayName: direct.displayName || "" };
  } catch {
    // Fall through to filter-based lookup
  }
  try {
    const filtered = await graphRequest<{ value: Array<{ id: string; displayName: string }> }>(
      accessToken,
      `/users?$filter=${encodeURIComponent(`proxyAddresses/any(p:p eq 'smtp:${email.toLowerCase()}')`)}&$select=id,displayName`
    );
    const hit = filtered.value?.[0];
    if (hit?.id) return { id: hit.id, displayName: hit.displayName || "" };
  } catch {
    // Fall through
  }
  return null;
}

/**
 * Apply each persona's photo to every matching mailbox in the tenant.
 *
 * Matches by case-insensitive equality of Mailbox.displayName (from M365)
 * against TenantPersona.personaName. Mailboxes whose persona has no photo
 * are skipped with a warning. Mailboxes with no persona match are skipped
 * with a warning.
 *
 * Returns a per-email map of outcomes; also rolls up to Tenant.profilePhotos*
 * fields. Idempotent — re-running for an already-applied tenant just skips
 * everything (Graph PUT is replace-not-append for the photo endpoint, so
 * re-applying would just re-overwrite which is harmless but wasteful).
 */
export async function applyPhotosToTenant(tenantDbId: string): Promise<{
  applied: number;
  failed: number;
  skipped: number;
  perMailbox: Record<string, { state: "applied" | "failed" | "skipped"; reason?: string }>;
}> {
  const tenant = await prisma.tenant.findUniqueOrThrow({
    where: { id: tenantDbId },
    select: { id: true, tenantId: true, mailboxStatuses: true, domain: true }
  });
  if (!tenant.tenantId) {
    throw new Error(`Tenant ${tenantDbId} has no Microsoft tenant ID — provisioning incomplete`);
  }

  const personas = await prisma.tenantPersona.findMany({
    where: { tenantId: tenantDbId },
    select: { id: true, personaName: true, photoData: true, photoMime: true, photoSize: true }
  });
  const personaByName = new Map<string, (typeof personas)[number]>();
  for (const p of personas) personaByName.set(p.personaName.toLowerCase(), p);

  // mailboxStatuses is a JSON-string map: { email: { ...flags } }. We don't
  // strictly need the existing flags here — we just want the email list — but
  // we'll write back per-mailbox photo status to keep it the single source of
  // truth for mailbox state in the UI.
  const statusesRaw = tenant.mailboxStatuses ? JSON.parse(tenant.mailboxStatuses) : {};
  const emails = Object.keys(statusesRaw);
  if (emails.length === 0) {
    console.log(`[profilePhotos] Tenant ${tenantDbId} has no mailboxStatuses — nothing to apply`);
    return { applied: 0, failed: 0, skipped: 0, perMailbox: {} };
  }

  const accessToken = await requestTenantGraphToken(tenant.tenantId);
  const perMailbox: Record<string, { state: "applied" | "failed" | "skipped"; reason?: string }> = {};
  let applied = 0;
  let failed = 0;
  let skipped = 0;

  for (const email of emails) {
    const user = await resolveMailboxUser(accessToken, email);
    if (!user) {
      perMailbox[email] = { state: "skipped", reason: "user not found in M365" };
      skipped++;
      continue;
    }
    const persona = personaByName.get((user.displayName || "").toLowerCase());
    if (!persona) {
      perMailbox[email] = { state: "skipped", reason: `no persona match for displayName="${user.displayName}"` };
      skipped++;
      continue;
    }
    if (!persona.photoData || !persona.photoMime) {
      perMailbox[email] = { state: "skipped", reason: `persona "${persona.personaName}" has no photo uploaded` };
      skipped++;
      continue;
    }
    try {
      // Microsoft Graph: PUT /users/{id}/photo/$value, raw body, Content-Type
      // is the image MIME. Returns 200/204 on success.
      await graphRequest<unknown>(accessToken, `/users/${user.id}/photo/$value`, {
        method: "PUT",
        body: persona.photoData,
        headers: { "Content-Type": persona.photoMime }
      });
      perMailbox[email] = { state: "applied" };
      applied++;
      // Best-effort: also flag persona as applied (last-write wins)
      await prisma.tenantPersona.update({
        where: { id: persona.id },
        data: { photoApplied: true, applyError: null, appliedAt: new Date() }
      }).catch(() => {});
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      perMailbox[email] = { state: "failed", reason: message.slice(0, 300) };
      failed++;
      await prisma.tenantPersona.update({
        where: { id: persona.id },
        data: { applyError: message.slice(0, 500) }
      }).catch(() => {});
    }
  }

  // Write per-mailbox state back to mailboxStatuses so the UI shows it next
  // to the existing flags (signInEnabled, cloudAppAdminAssigned, etc.).
  const merged = { ...statusesRaw };
  for (const [email, outcome] of Object.entries(perMailbox)) {
    merged[email] = {
      ...(merged[email] || {}),
      profilePhotoState: outcome.state,
      profilePhotoReason: outcome.reason || null
    };
  }
  await prisma.tenant.update({
    where: { id: tenantDbId },
    data: {
      profilePhotosApplied: failed === 0 && applied > 0,
      profilePhotosCompleted: applied,
      profilePhotosFailed: failed,
      mailboxStatuses: JSON.stringify(merged)
    }
  });

  console.log(
    `[profilePhotos] Tenant ${tenantDbId}: applied=${applied} failed=${failed} skipped=${skipped} (of ${emails.length} mailboxes)`
  );
  return { applied, failed, skipped, perMailbox };
}

/**
 * Helper for the worker auto-trigger: returns true if every persona has a
 * photo uploaded, so the auto-apply step is safe to fire. False otherwise
 * (the operator hasn't finished uploading; manual trigger required later).
 */
export async function allPersonasHavePhotos(tenantDbId: string): Promise<boolean> {
  const personas = await prisma.tenantPersona.findMany({
    where: { tenantId: tenantDbId },
    select: { photoData: true }
  });
  if (personas.length === 0) return false;
  return personas.every((p) => p.photoData !== null && p.photoData.length > 0);
}
