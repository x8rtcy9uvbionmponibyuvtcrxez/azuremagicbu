import { mkdir, writeFile } from "fs/promises";
import path from "path";

import { decryptSecret } from "@/lib/crypto";
import { prisma } from "@/lib/prisma";
import { generateEmailVariations } from "@/lib/services/email-generator";
import { isLikelyTenantIdentifier, isSyntheticTestTenantId } from "@/lib/tenant-identifier";
import { parseInboxNamesValue } from "@/lib/utils";

const GRAPH_BASE_URL = "https://graph.microsoft.com/v1.0";
const TEST_MODE = process.env.TEST_MODE === "true";
const PS_SERVICE_URL = process.env.PS_SERVICE_URL || "http://localhost:3099";

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

type TokenResponse = {
  access_token: string;
  expires_in: number;
  token_type: string;
};

type DeviceCodeResponse = {
  device_code: string;
  user_code: string;
  verification_uri: string;
  expires_in: number;
};

type GraphUserResponse = {
  id: string;
  userPrincipalName: string;
};

function tenantFromAdminEmail(adminEmail?: string | null): string | null {
  if (!adminEmail) return null;
  const atIndex = adminEmail.indexOf("@");
  if (atIndex < 0) return null;
  const domain = adminEmail.slice(atIndex + 1).trim().toLowerCase();
  return domain || null;
}

function resolveTenantAuthority(input: { adminEmail?: string | null; tenantId?: string | null }): string {
  return tenantFromAdminEmail(input.adminEmail) || input.tenantId || process.env.GRAPH_TENANT_ID || "common";
}

function assertGraphConfig() {
  const clientId = process.env.GRAPH_CLIENT_ID;
  const clientSecret = process.env.GRAPH_CLIENT_SECRET;

  if (!clientId) {
    throw new Error("Missing GRAPH_CLIENT_ID");
  }

  return { clientId, clientSecret: clientSecret || "" };
}

async function requestGraphToken(tenantIdentifier: string): Promise<string> {
  return requestTenantGraphToken(tenantIdentifier);
}

export async function requestTenantGraphToken(organizationId: string): Promise<string> {
  const { clientId, clientSecret } = assertGraphConfig();
  if (!clientSecret) {
    throw new Error("GRAPH_CLIENT_SECRET is required for client_credentials flow");
  }

  const tokenUrl = `https://login.microsoftonline.com/${organizationId}/oauth2/v2.0/token`;

  const response = await fetch(tokenUrl, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      scope: "https://graph.microsoft.com/.default",
      grant_type: "client_credentials"
    })
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Failed to get tenant token: ${response.status} - ${error}`);
  }

  const data = (await response.json()) as TokenResponse;
  return data.access_token;
}

async function graphRequest<T>(token: string, endpoint: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(`${GRAPH_BASE_URL}${endpoint}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      ...(init.headers || {})
    }
  });

  const text = await response.text();
  const payload = text ? JSON.parse(text) : {};

  if (!response.ok) {
    const message = payload.error?.message || payload.error_description || `Graph request failed (${response.status})`;
    throw new Error(message);
  }

  return payload as T;
}

function escapeCsv(value: string): string {
  if (value.includes(",") || value.includes('"') || value.includes("\n")) {
    return `"${value.replace(/"/g, '""')}"`;
  }
  return value;
}

function toCsv(rows: string[][]): string {
  return rows.map((row) => row.map((cell) => escapeCsv(cell)).join(",")).join("\n");
}

function escapeODataString(value: string): string {
  return value.replace(/'/g, "''");
}

type MailboxCheckpointState = {
  created: boolean;
  passwordSet: boolean;
  smtpEnabled: boolean;
  delegated: boolean;
  signInEnabled: boolean;
  cloudAppAdminAssigned: boolean;
};

type MailboxCheckpointMap = Record<string, MailboxCheckpointState>;

function normalizeMailboxStatuses(raw: unknown): MailboxCheckpointMap {
  if (!raw) {
    return {};
  }

  let parsed: unknown = raw;

  if (typeof raw === "string") {
    try {
      parsed = JSON.parse(raw);
    } catch {
      return {};
    }
  }

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return {};
  }

  const input = parsed as Record<string, unknown>;
  const normalized: MailboxCheckpointMap = {};

  for (const [email, value] of Object.entries(input)) {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      continue;
    }

    const item = value as Record<string, unknown>;
    normalized[email] = {
      created: item.created === true,
      passwordSet: item.passwordSet === true,
      smtpEnabled: item.smtpEnabled === true,
      delegated: item.delegated === true,
      signInEnabled: item.signInEnabled === true,
      cloudAppAdminAssigned: item.cloudAppAdminAssigned === true
    };
  }

  return normalized;
}

function serializeMailboxStatuses(statuses: MailboxCheckpointMap): string {
  return JSON.stringify(statuses);
}

function parsePositiveInt(value: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(value || "", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function isDomainAlreadyExistsError(message: string): boolean {
  const normalized = message.toLowerCase();
  return (
    normalized.includes("already exists") ||
    normalized.includes("already added") ||
    normalized.includes("already been added") ||
    normalized.includes("object reference already exists")
  );
}

function isDomainMissingInTenantError(message: string): boolean {
  const normalized = message.toLowerCase();
  return normalized.includes("does not exist") && normalized.includes("resource");
}

function isDomainUnverifiedUpdateError(message: string): boolean {
  const normalized = message.toLowerCase();
  return normalized.includes("unverified domains are not allowed");
}

async function waitForPowerShellService(maxWaitMs = 30000): Promise<void> {
  const startTime = Date.now();
  while (Date.now() - startTime < maxWaitMs) {
    try {
      const response = await fetch(`${PS_SERVICE_URL}/health`, { signal: AbortSignal.timeout(3000) });
      if (response.ok) return;
    } catch {}
    console.log("⏳ [PowerShell] Service not ready, waiting 3s...");
    await new Promise(resolve => setTimeout(resolve, 3000));
  }
  throw new Error("PowerShell service not available after 30s. Please ensure it is running on port 3099.");
}

export async function callPowerShellService(endpoint: string, body: Record<string, unknown>, timeout = 1200000): Promise<any> {
  const maxRetries = 3;
  const baseDelay = 5000;

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      console.log(`📡 [PowerShell] Calling ${endpoint} (attempt ${attempt}/${maxRetries})...`);
      const startTime = Date.now();
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), timeout);

      const response = await fetch(`${PS_SERVICE_URL}${endpoint}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal: controller.signal
      });

      clearTimeout(timeoutId);
      const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);

      if (!response.ok) {
        const error = (await response.json().catch(() => ({ error: response.statusText }))) as { error?: string };
        console.log(`❌ [PowerShell] ${endpoint} failed after ${elapsed}s: ${error.error}`);
        throw new Error(`PowerShell service error: ${error.error || response.statusText}`);
      }

      const data = await response.json();
      console.log(`✅ [PowerShell] ${endpoint} completed in ${elapsed}s`);
      return data;
    } catch (error: any) {
      const msg = error.message || "";
      const isTransient = msg.includes("fetch failed") ||
        msg.includes("ECONNREFUSED") ||
        msg.includes("ETIMEDOUT") ||
        msg.includes("socket hang up") ||
        msg.includes("aborted") ||
        msg.includes("network") ||
        error.name === "AbortError";

      if (isTransient && attempt < maxRetries) {
        const delay = baseDelay * Math.pow(2, attempt - 1);
        console.log(`⚠️ [PowerShell] Attempt ${attempt}/${maxRetries} failed (${msg}). Waiting ${delay / 1000}s before retry...`);
        await new Promise(resolve => setTimeout(resolve, delay));
        continue;
      }

      if (attempt === maxRetries && isTransient) {
        throw new Error(`PowerShell service unreachable after ${maxRetries} attempts on ${endpoint}. Is the service running on port 3099?`);
      }

      throw error;
    }
  }
  throw new Error("callPowerShellService: unexpected exit from retry loop");
}

const GRAPH_BASE_URL_INTERNAL = "https://graph.microsoft.com/v1.0";

/**
 * Idempotently ensure the Global Administrator directoryRole is activated in
 * the target tenant and return its id. If the role hasn't been activated yet
 * (Microsoft lazy-activates roles on first use), we POST to /directoryRoles
 * with the template id. Safe to call repeatedly.
 */
async function ensureGlobalAdminRoleActivated(accessToken: string): Promise<string | null> {
  const roles = await graphRequest<{ value: Array<{ id: string; displayName: string }> }>(
    accessToken,
    "/directoryRoles"
  );
  const existing = roles.value?.find((role) => role.displayName === "Global Administrator");
  if (existing) return existing.id;

  const templates = await graphRequest<{ value: Array<{ id: string; displayName: string }> }>(
    accessToken,
    "/directoryRoleTemplates"
  );
  const template = templates.value?.find((t) => t.displayName === "Global Administrator");
  if (!template) return null;

  try {
    const activated = await graphRequest<{ id: string }>(accessToken, "/directoryRoles", {
      method: "POST",
      body: JSON.stringify({ roleTemplateId: template.id })
    });
    console.log("✅ [Microsoft] Global Admin role activated:", activated.id);
    return activated.id;
  } catch (error) {
    console.log(
      "⚠️ [Microsoft] Could not activate Global Admin role:",
      error instanceof Error ? error.message : String(error)
    );
    return null;
  }
}

/**
 * Grant Global Administrator to a user or service principal. Idempotent:
 * Microsoft returns "already exists" when the principal already has the role,
 * which we treat as success. Returns `{ ok: true }` on success/already-assigned,
 * `{ ok: false, error }` when the role couldn't be found/activated or the grant
 * failed for some other reason.
 *
 * This is best-effort by default — callers decide whether to abort or just warn.
 * The SP grant during tenant prep is the critical one (needed for app-only
 * Graph calls); the primary-user grant is for Instantly/Smartlead admin-consent
 * UX and a missing grant can be retrofilled via /api/tenant/{id}/grant-primary-global-admin.
 */
export async function grantGlobalAdmin(
  accessToken: string,
  principal: { kind: "user" | "servicePrincipal"; id: string }
): Promise<{ ok: boolean; alreadyAssigned?: boolean; error?: string; roleId?: string }> {
  const roleId = await ensureGlobalAdminRoleActivated(accessToken);
  if (!roleId) {
    return { ok: false, error: "Global Administrator role could not be activated in this tenant" };
  }

  const refPath = principal.kind === "user" ? "users" : "servicePrincipals";
  try {
    await graphRequest<Record<string, unknown>>(accessToken, `/directoryRoles/${roleId}/members/$ref`, {
      method: "POST",
      body: JSON.stringify({
        "@odata.id": `${GRAPH_BASE_URL_INTERNAL}/${refPath}/${principal.id}`
      })
    });
    return { ok: true, alreadyAssigned: false, roleId };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const normalized = message.toLowerCase();
    if (
      normalized.includes("already exist") ||
      normalized.includes("added already") ||
      normalized.includes("one or more added object references already exist")
    ) {
      return { ok: true, alreadyAssigned: true, roleId };
    }
    return { ok: false, error: message, roleId };
  }
}

export async function setupTenantPrep(tenantId: string): Promise<void> {
  try {
    const tenant = await prisma.tenant.findUnique({
      where: { id: tenantId },
      select: {
        id: true,
        tenantId: true
      }
    });

    if (!tenant) {
      throw new Error(`Tenant ${tenantId} not found`);
    }

    await prisma.tenant.update({
      where: { id: tenant.id },
      data: {
        status: "tenant_prep",
        progress: 55,
        currentStep: "Ready for authentication"
      }
    });

    if (TEST_MODE) {
      console.log("🧪 TEST MODE: Skipping Microsoft Graph API call");
      await sleep(300);
      return;
    }

    console.log("🔄 [Microsoft] Tenant prep - skipping token, will use device auth");
  } catch (error) {
    await prisma.tenant.update({
      where: { id: tenantId },
      data: {
        status: "failed",
        errorMessage: error instanceof Error ? error.message : "Tenant prep failed",
        currentStep: "Tenant prep failed"
      }
    });
    throw error;
  }
}

export async function completeTenantPrep(tenantId: string, accessToken: string): Promise<void> {
  try {
    await prisma.tenant.update({
      where: { id: tenantId },
      data: {
        currentStep: "Disabling security defaults...",
        progress: 40
      }
    });

    let securityDefaultsDisabled = false;
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        await graphRequest<Record<string, unknown>>(accessToken, "/policies/identitySecurityDefaultsEnforcementPolicy", {
          method: "PATCH",
          body: JSON.stringify({ isEnabled: false })
        });
        securityDefaultsDisabled = true;
        console.log("✅ [Microsoft] Security defaults disabled");
        break;
      } catch (error) {
        console.log(
          `⚠️ [Microsoft] Attempt ${attempt}/3 to disable security defaults failed:`,
          error instanceof Error ? error.message : String(error)
        );
        if (attempt < 3) {
          await sleep(10000);
        }
      }
    }

    await prisma.tenant.update({
      where: { id: tenantId },
      data: { securityDefaultsDisabled }
    });

    if (!securityDefaultsDisabled) {
      console.log("⚠️ [Microsoft] Could not disable security defaults after 3 attempts, continuing anyway");
    }

    await prisma.tenant.update({
      where: { id: tenantId },
      data: {
        currentStep: "Creating service principal...",
        progress: 45
      }
    });

    const appId = process.env.GRAPH_APP_ID || process.env.GRAPH_CLIENT_ID;
    if (!appId) {
      throw new Error("Missing GRAPH_APP_ID or GRAPH_CLIENT_ID for service principal creation");
    }

    let servicePrincipalId: string | null = null;
    try {
      const spResult = await graphRequest<{ id: string }>(accessToken, "/servicePrincipals", {
        method: "POST",
        body: JSON.stringify({ appId })
      });
      servicePrincipalId = spResult.id;
      console.log("✅ [Microsoft] Service principal created:", servicePrincipalId);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (message.includes("conflicting object") || message.includes("already exists") || message.includes("already in use")) {
        console.log("ℹ️ [Microsoft] Service principal already exists, looking it up...");
        const existing = await graphRequest<{ value: Array<{ id: string }> }>(
          accessToken,
          `/servicePrincipals?$filter=appId eq '${appId}'`
        );
        servicePrincipalId = existing.value?.[0]?.id || null;
        console.log("✅ [Microsoft] Found existing SP:", servicePrincipalId);
      } else {
        throw error;
      }
    }

    await prisma.tenant.update({
      where: { id: tenantId },
      data: { servicePrincipalCreated: !!servicePrincipalId }
    });

    if (servicePrincipalId) {
      await prisma.tenant.update({
        where: { id: tenantId },
        data: {
          currentStep: "Assigning Global Administrator role...",
          progress: 50
        }
      });

      const assignResult = await grantGlobalAdmin(accessToken, {
        kind: "servicePrincipal",
        id: servicePrincipalId
      });
      if (assignResult.ok) {
        console.log("✅ [Microsoft] Global Admin role assigned to service principal");
        await prisma.tenant.update({
          where: { id: tenantId },
          data: { globalAdminAssigned: true }
        });
      } else {
        console.log("⚠️ [Microsoft] Could not assign Global Admin to SP:", assignResult.error);
      }
    }

    await prisma.tenant.update({
      where: { id: tenantId },
      data: {
        currentStep: "Tenant prep complete",
        progress: 55
      }
    });
  } catch (error) {
    await prisma.tenant.update({
      where: { id: tenantId },
      data: {
        status: "failed",
        errorMessage: error instanceof Error ? error.message : "Tenant prep configuration failed",
        currentStep: "Tenant configuration failed"
      }
    });
    throw error;
  }
}

export async function addDomainToTenant(tenantDbId: string, domain: string, accessToken: string): Promise<void> {
  await prisma.tenant.update({
    where: { id: tenantDbId },
    data: { currentStep: "Adding domain to tenant...", progress: 60, status: "domain_add" }
  });

  try {
    await graphRequest<Record<string, unknown>>(accessToken, "/domains", {
      method: "POST",
      body: JSON.stringify({ id: domain })
    });
    console.log(`✅ [Microsoft] Domain ${domain} added to tenant`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (isDomainAlreadyExistsError(message)) {
      console.log(`ℹ️ [Microsoft] Domain ${domain} already exists in tenant`);
    } else {
      throw error;
    }
  }

  await prisma.tenant.update({
    where: { id: tenantDbId },
    data: { domainAdded: true }
  });
}

export async function verifyDomainWithDns(
  tenantDbId: string,
  domain: string,
  zoneId: string,
  accessToken: string
): Promise<void> {
  await prisma.tenant.update({
    where: { id: tenantDbId },
    data: { currentStep: "Getting domain verification record...", progress: 63 }
  });

  let dnsRecords: {
    value: Array<{
      recordType: string;
      label: string;
      text: string;
      supportedService: string;
    }>;
  } | null = null;

  for (let attempt = 1; attempt <= 8; attempt++) {
    try {
      dnsRecords = await graphRequest<{
        value: Array<{
          recordType: string;
          label: string;
          text: string;
          supportedService: string;
        }>;
      }>(accessToken, `/domains/${encodeURIComponent(domain)}/verificationDnsRecords`);
      break;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (isDomainMissingInTenantError(message) && attempt < 8) {
        console.log(`⚠️ [Microsoft] Domain ${domain} not visible yet (attempt ${attempt}/8). Retrying in 10s...`);
        await sleep(10000);
        continue;
      }
      throw error;
    }
  }

  if (!dnsRecords) {
    throw new Error(`Domain ${domain} not visible in Microsoft after multiple retries`);
  }

  const txtRecord = dnsRecords.value?.find((record) => record.recordType === "Txt");

  if (!txtRecord) {
    throw new Error(`No TXT verification record found for domain ${domain}`);
  }

  console.log(`📋 [Microsoft] Verification TXT record: ${txtRecord.text}`);

  await prisma.tenant.update({
    where: { id: tenantDbId },
    data: { currentStep: "Adding verification TXT to Cloudflare...", progress: 65 }
  });

  const cfApiKey = process.env.CLOUDFLARE_API_KEY;
  const cfEmail = process.env.CLOUDFLARE_EMAIL;

  if (!cfApiKey || !cfEmail) {
    throw new Error("Missing CLOUDFLARE_API_KEY or CLOUDFLARE_EMAIL");
  }

  const cfResponse = await fetch(`https://api.cloudflare.com/client/v4/zones/${zoneId}/dns_records`, {
    method: "POST",
    headers: {
      "X-Auth-Key": cfApiKey,
      "X-Auth-Email": cfEmail,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      type: "TXT",
      name: "@",
      content: txtRecord.text,
      ttl: 1
    })
  });

  if (!cfResponse.ok) {
    const cfErrorText = await cfResponse.text();
    const normalized = cfErrorText.toLowerCase();
    if (!normalized.includes("already exists")) {
      throw new Error(`Failed to add TXT to Cloudflare: ${cfErrorText}`);
    }
    console.log("ℹ️ [Cloudflare] TXT record already exists");
  } else {
    console.log("✅ [Cloudflare] Verification TXT record added");
  }

  await prisma.tenant.update({
    where: { id: tenantDbId },
    data: {
      currentStep: "Verifying domain with Microsoft...",
      progress: 70,
      status: "domain_verify"
    }
  });

  let verified = false;
  for (let attempt = 1; attempt <= 5; attempt++) {
    try {
      await graphRequest<Record<string, unknown>>(accessToken, `/domains/${encodeURIComponent(domain)}/verify`, {
        method: "POST"
      });
      verified = true;
      console.log(`✅ [Microsoft] Domain ${domain} verified on attempt ${attempt}`);
      break;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (message.toLowerCase().includes("already verified")) {
        await prisma.tenant.update({
          where: { id: tenantDbId },
          data: { domainVerified: true }
        });
        console.log("ℹ️ [Microsoft] Domain already verified, skipping");
        return;
      }

      console.log(
        `⚠️ [Microsoft] Domain verification attempt ${attempt}/5 failed:`,
        message
      );
      if (attempt < 5) {
        await sleep(15000);
      }
    }
  }

  if (!verified) {
    throw new Error(`Domain ${domain} verification failed after 5 attempts`);
  }

  await prisma.tenant.update({
    where: { id: tenantDbId },
    data: { domainVerified: true }
  });
}

export async function setDomainAsDefault(tenantDbId: string, domain: string, accessToken: string): Promise<void> {
  await prisma.tenant.update({
    where: { id: tenantDbId },
    data: { currentStep: "Setting domain as default...", progress: 75 }
  });

  let defaultSet = false;
  let lastError: string | null = null;

  for (let attempt = 1; attempt <= 8; attempt++) {
    try {
      await graphRequest<Record<string, unknown>>(accessToken, `/domains/${encodeURIComponent(domain)}`, {
        method: "PATCH",
        body: JSON.stringify({ isDefault: true })
      });
      console.log(`✅ [Microsoft] Domain ${domain} set as default`);
      defaultSet = true;
      break;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      lastError = message;

      if (message.toLowerCase().includes("already")) {
        console.log(`ℹ️ [Microsoft] Domain ${domain} is already default (or already updated), skipping`);
        defaultSet = true;
        break;
      }

      const canRetry =
        (isDomainUnverifiedUpdateError(message) || isDomainMissingInTenantError(message)) &&
        attempt < 8;

      if (canRetry) {
        await prisma.tenant.update({
          where: { id: tenantDbId },
          data: {
            currentStep: `Domain verification still propagating (attempt ${attempt}/8). Retrying default domain...`,
            progress: 74
          }
        });
        console.log(`⚠️ [Microsoft] Domain ${domain} not ready for default update (attempt ${attempt}/8). Retrying in 10s...`);
        await sleep(10000);
        continue;
      }

      throw error;
    }
  }

  if (!defaultSet) {
    throw new Error(lastError || `Unable to set ${domain} as default domain`);
  }

  await prisma.tenant.update({
    where: { id: tenantDbId },
    data: { domainDefault: true }
  });
}

/**
 * Ensure the primary user (firstname.lastname@customdomain) has a license.
 *
 * 4-step algorithm:
 *   a. Is the primary user already licensed? → return, nothing to do.
 *   b. Is the license on any OTHER user in the tenant? → revoke it from them.
 *   c. Is there a free license seat in the pool? → PATCH usageLocation + assign to primary + verify.
 *   d. Retry assignment up to 3 times with backoff. If still not attached,
 *      throw an actionable error pointing to the admin portal.
 *
 * This function is idempotent and safe to call repeatedly — the initial "does
 * primary already have a license" short-circuit means re-runs are cheap.
 */
async function ensurePrimaryUserLicensed(
  accessToken: string,
  primaryUpn: string
): Promise<{ skuPartNumber: string }> {
  // Step A: Does primary already have a license?
  const primaryFilter = encodeURIComponent(`userPrincipalName eq '${escapeODataString(primaryUpn)}'`);
  const primaryResult = await graphRequest<{
    value: Array<{ id: string; userPrincipalName?: string; assignedLicenses?: Array<{ skuId: string }> }>;
  }>(accessToken, `/users?$filter=${primaryFilter}&$select=id,userPrincipalName,assignedLicenses`);

  const primary = primaryResult.value?.[0];
  if (!primary?.id) {
    throw new Error(
      `Primary user '${primaryUpn}' not found in tenant. Ensure the licensed user was created before attempting license allocation.`
    );
  }

  if (Array.isArray(primary.assignedLicenses) && primary.assignedLicenses.length > 0) {
    const skuId = primary.assignedLicenses[0].skuId || "unknown";
    console.log(`✅ [License] ${primaryUpn} already has ${primary.assignedLicenses.length} license(s) (${skuId}) — continuing`);
    return { skuPartNumber: skuId };
  }

  console.log(`🔄 [License] ${primaryUpn} has no license — starting allocation sequence`);

  // Step B: Is a license on some OTHER user? (Including admin@<tenant>.onmicrosoft.com.)
  const allUsers = await graphRequest<{
    value: Array<{ id: string; userPrincipalName?: string; assignedLicenses?: Array<{ skuId: string }> }>;
  }>(accessToken, `/users?$select=id,userPrincipalName,assignedLicenses&$top=999`);

  const otherLicensed = (allUsers.value || []).filter(
    (u) => u.id !== primary.id && Array.isArray(u.assignedLicenses) && u.assignedLicenses.length > 0
  );

  if (otherLicensed.length > 0) {
    for (const user of otherLicensed) {
      const skuIds = (user.assignedLicenses || []).map((l) => l.skuId).filter(Boolean);
      console.log(
        `🔄 [License] Revoking ${skuIds.length} license(s) from ${user.userPrincipalName || user.id} to free a seat for ${primaryUpn}`
      );
      try {
        await graphRequest<Record<string, unknown>>(accessToken, `/users/${user.id}/assignLicense`, {
          method: "POST",
          body: JSON.stringify({ addLicenses: [], removeLicenses: skuIds })
        });
      } catch (error) {
        console.log(
          `⚠️ [License] Failed to revoke from ${user.userPrincipalName || user.id}:`,
          error instanceof Error ? error.message : String(error)
        );
      }
    }
    // Let Microsoft actually free the seat before we query /subscribedSkus.
    await sleep(5000);
  }

  // Step C: Find a free SKU in the pool.
  const skus = await graphRequest<{
    value: Array<{ skuId: string; skuPartNumber: string; prepaidUnits: { enabled: number }; consumedUnits: number }>;
  }>(accessToken, "/subscribedSkus");

  const availableSku = (skus.value || []).find(
    (s) => (s.prepaidUnits?.enabled || 0) > (s.consumedUnits || 0)
  );

  if (!availableSku) {
    throw new Error(
      `No available license seats in this tenant. Open admin.microsoft.com → Billing → Licenses and make sure at least one seat is available, then Retry.`
    );
  }

  // Step D: PATCH usageLocation (required by Graph), then POST assignLicense, verify. Retry up to 3 times.
  try {
    await graphRequest<Record<string, unknown>>(accessToken, `/users/${primary.id}`, {
      method: "PATCH",
      body: JSON.stringify({ usageLocation: "US" })
    });
  } catch (error) {
    console.log(
      `⚠️ [License] Could not set usageLocation on ${primaryUpn} (may already be set):`,
      error instanceof Error ? error.message : String(error)
    );
  }

  const backoffsMs = [0, 15_000, 45_000]; // 3 attempts, ~1 min total
  let lastError: unknown = null;
  for (let attempt = 0; attempt < backoffsMs.length; attempt += 1) {
    if (backoffsMs[attempt] > 0) {
      console.log(
        `⏳ [License] Waiting ${backoffsMs[attempt] / 1000}s before assignment attempt ${attempt + 1}/${backoffsMs.length}...`
      );
      await sleep(backoffsMs[attempt]);
    }

    try {
      await graphRequest<Record<string, unknown>>(accessToken, `/users/${primary.id}/assignLicense`, {
        method: "POST",
        body: JSON.stringify({ addLicenses: [{ skuId: availableSku.skuId }], removeLicenses: [] })
      });
    } catch (error) {
      lastError = error;
      console.log(
        `⚠️ [License] assignLicense failed on attempt ${attempt + 1}:`,
        error instanceof Error ? error.message : String(error)
      );
      continue;
    }

    // Verify the license actually attached — Graph can return 2xx with nothing applied.
    try {
      const verify = await graphRequest<{ assignedLicenses?: Array<{ skuId: string }> }>(
        accessToken,
        `/users/${primary.id}?$select=assignedLicenses`
      );
      const stuck =
        Array.isArray(verify.assignedLicenses) && verify.assignedLicenses.some((l) => l?.skuId === availableSku.skuId);
      if (stuck) {
        console.log(`✅ [License] ${availableSku.skuPartNumber} attached and verified on ${primaryUpn}`);
        return { skuPartNumber: availableSku.skuPartNumber };
      }
    } catch (error) {
      console.log(
        `⚠️ [License] Verify failed on attempt ${attempt + 1}:`,
        error instanceof Error ? error.message : String(error)
      );
    }
  }

  const suffix = lastError ? ` Last error: ${lastError instanceof Error ? lastError.message : String(lastError)}.` : "";
  throw new Error(
    `License ${availableSku.skuPartNumber} could not be attached to ${primaryUpn} after 3 attempts.${suffix} ` +
      `Open admin.microsoft.com → Active users → ${primaryUpn} → Licenses and apps, assign a license manually, then Retry.`
  );
}

export async function createLicensedUser(
  tenantDbId: string,
  domain: string,
  adminEmail: string,
  adminPassword: string,
  accessToken: string
): Promise<void> {
  await prisma.tenant.update({
    where: { id: tenantDbId },
    data: { currentStep: "Creating licensed user...", progress: 80, status: "licensed_user" }
  });

  const tenant = await prisma.tenant.findUnique({
    where: { id: tenantDbId },
    select: { inboxNames: true }
  });

  const extractedNames = parseInboxNamesValue(tenant?.inboxNames);

  const fallbackLocalPart = adminEmail.split("@")[0].replace(/[^a-zA-Z0-9]/g, "").toLowerCase() || "admin";
  const firstInboxName = extractedNames[0] || fallbackLocalPart;
  const [firstName = fallbackLocalPart, ...rest] = firstInboxName.split(/\s+/).filter(Boolean);
  const lastName = rest.join(" ");
  const displayName = [firstName, lastName].filter(Boolean).join(" ");
  const mailNickname = [firstName, ...rest].filter(Boolean).join(".").toLowerCase().replace(/[^a-z0-9.]/g, "") || fallbackLocalPart;
  const userPrincipalName = `${mailNickname}@${domain}`;

  let userId: string;
  try {
    const user = await graphRequest<{ id: string }>(accessToken, "/users", {
      method: "POST",
      body: JSON.stringify({
        accountEnabled: true,
        displayName,
        mailNickname,
        userPrincipalName,
        usageLocation: "US",
        passwordProfile: {
          forceChangePasswordNextSignIn: false,
          password: adminPassword
        }
      })
    });
    userId = user.id;
    console.log(`✅ [Microsoft] User created: ${userPrincipalName} (ID: ${userId})`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message.includes("already exists")) {
      console.log(`ℹ️ [Microsoft] User ${userPrincipalName} already exists, looking up...`);
      const existing = await graphRequest<{ value: Array<{ id: string }> }>(
        accessToken,
        `/users?$filter=${encodeURIComponent(`userPrincipalName eq '${userPrincipalName}'`)}`
      );
      userId = existing.value?.[0]?.id || "";
      if (!userId) {
        throw new Error(`User ${userPrincipalName} exists but couldn't find ID`);
      }
    } else {
      throw error;
    }
  }

  try {
    await graphRequest<Record<string, unknown>>(accessToken, `/users/${userId}`, {
      method: "PATCH",
      body: JSON.stringify({
        displayName,
        mailNickname
      })
    });
  } catch (error) {
    console.log(
      `⚠️ [Microsoft] Could not normalize licensed user profile for ${userPrincipalName}:`,
      error instanceof Error ? error.message : String(error)
    );
  }

  await prisma.tenant.update({
    where: { id: tenantDbId },
    data: { currentStep: "Allocating license to primary user...", progress: 85 }
  });

  // Centralised license allocation — see ensurePrimaryUserLicensed() for the 4-step algorithm.
  await ensurePrimaryUserLicensed(accessToken, userPrincipalName);

  // Grant Global Administrator to the primary user. This is what lets the user
  // self-consent during Instantly/Smartlead OAuth (their tenant-wide consent
  // prompt only shows the "on behalf of organization" option if the signing-in
  // user holds an admin role). Best-effort — failure here doesn't block
  // provisioning; we can retroactively grant via /api/tenant/{id}/grant-primary-global-admin.
  try {
    const grantResult = await grantGlobalAdmin(accessToken, { kind: "user", id: userId });
    if (grantResult.ok) {
      console.log(
        grantResult.alreadyAssigned
          ? `ℹ️ [Microsoft] Primary user ${userPrincipalName} already had Global Admin`
          : `✅ [Microsoft] Granted Global Admin to primary user ${userPrincipalName}`
      );
    } else {
      console.log(
        `⚠️ [Microsoft] Could not grant Global Admin to primary user ${userPrincipalName}: ${grantResult.error}`
      );
    }
  } catch (error) {
    console.log(
      `⚠️ [Microsoft] Global Admin grant to primary user threw: ${error instanceof Error ? error.message : String(error)}`
    );
  }

  await prisma.tenant.update({
    where: { id: tenantDbId },
    data: {
      licensedUserId: userId,
      licensedUserUpn: userPrincipalName,
      currentStep: "Domain setup complete",
      progress: 90
    }
  });

  console.log(`✅ [Microsoft] Phase 2 complete for ${domain}`);
}

export async function setupDomainAndUser(tenantDbId: string): Promise<void> {
  const tenant = await prisma.tenant.findUniqueOrThrow({
    where: { id: tenantDbId },
    include: { batch: true }
  });

  const domain = tenant.domain;
  const organizationId = tenant.tenantId;
  const zoneId = tenant.zoneId;
  const adminEmail = tenant.adminEmail;
  const adminPassword = tenant.adminPassword;

  if (!domain || !organizationId || !zoneId) {
    throw new Error(`Missing required data for domain setup: domain=${domain}, orgId=${organizationId}, zoneId=${zoneId}`);
  }

  if (!adminEmail || !adminPassword) {
    throw new Error("Missing admin credentials for domain setup");
  }

  if (isSyntheticTestTenantId(organizationId) || !isLikelyTenantIdentifier(organizationId)) {
    throw new Error(
      `Invalid tenant identifier '${organizationId}'. Re-authorize this tenant before continuing.`
    );
  }

  const resolvedAdminPassword = (() => {
    try {
      return decryptSecret(adminPassword);
    } catch {
      return adminPassword;
    }
  })();

  const accessToken = await requestTenantGraphToken(organizationId);

  let domainAdded = tenant.domainAdded;
  let domainVerified = tenant.domainVerified;
  let domainDefault = tenant.domainDefault;

  if (domainAdded) {
    try {
      await graphRequest<Record<string, unknown>>(accessToken, `/domains/${encodeURIComponent(domain)}`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (isDomainMissingInTenantError(message)) {
        console.log(`⚠️ [Microsoft] Domain ${domain} flag was set but resource is missing. Re-adding domain.`);
        domainAdded = false;
        domainVerified = false;
        domainDefault = false;
        await prisma.tenant.update({
          where: { id: tenantDbId },
          data: {
            domainAdded: false,
            domainVerified: false,
            domainDefault: false,
            currentStep: "Domain missing in tenant. Re-adding domain...",
            progress: 60
          }
        });
      } else {
        throw error;
      }
    }
  }

  if (!domainAdded) {
    try {
      await addDomainToTenant(tenantDbId, domain, accessToken);
      domainAdded = true;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (isDomainAlreadyExistsError(message)) {
        console.log(`ℹ️ [Microsoft] Domain ${domain} already exists in tenant, continuing`);
        await prisma.tenant.update({
          where: { id: tenantDbId },
          data: { domainAdded: true }
        });
        domainAdded = true;
      } else {
        throw error;
      }
    }
  }

  if (!domainVerified) {
    await verifyDomainWithDns(tenantDbId, domain, zoneId, accessToken);
    domainVerified = true;
  }

  if (!domainDefault) {
    await setDomainAsDefault(tenantDbId, domain, accessToken);
    domainDefault = true;
  }

  if (!tenant.licensedUserId) {
    await createLicensedUser(tenantDbId, domain, adminEmail, resolvedAdminPassword, accessToken);
  }
}

export async function setupSharedMailboxes(tenantDbId: string): Promise<void> {
  const tenant = await prisma.tenant.findUniqueOrThrow({
    where: { id: tenantDbId },
    include: { batch: true }
  });
  await waitForPowerShellService();

  const domain = tenant.domain;
  const organizationId = tenant.tenantId;
  const adminEmail = tenant.adminEmail;
  const adminPassword = tenant.adminPassword;
  const licensedUserUpn = tenant.licensedUserUpn;
  const licensedUserId = tenant.licensedUserId;

  if (!domain || !organizationId || !adminEmail || !adminPassword) {
    throw new Error("Missing tenant data for mailbox setup");
  }

  const names = parseInboxNamesValue(tenant.inboxNames);

  const resolvedAdminPassword = (() => {
    try {
      return decryptSecret(adminPassword);
    } catch {
      return adminPassword;
    }
  })();

  const mailboxData = generateEmailVariations(names, domain, tenant.inboxCount).map((mailbox) => ({
    email: mailbox.email,
    displayName: mailbox.displayName || mailbox.email.split("@")[0],
    password: resolvedAdminPassword
  }));
  // Exclude the delegation principal AND the first-name user (who was provisioned as a regular
  // user, not a shared mailbox). The first inbox name generates the licensed user UPN, which may
  // differ from the current delegation target if it was changed after initial provisioning.
  const firstInboxNameParts = names[0]?.split(/\s+/).filter(Boolean) || [];
  const firstNameMailNickname = firstInboxNameParts.join(".").toLowerCase().replace(/[^a-z0-9.]/g, "");
  const firstNameUpn = firstNameMailNickname ? `${firstNameMailNickname}@${domain}` : null;
  const filteredMailboxData = mailboxData.filter(
    (mb) => mb.email !== licensedUserUpn && mb.email !== firstNameUpn
  );
  const mailboxStatuses = normalizeMailboxStatuses(tenant.mailboxStatuses);
  const totalMailboxTarget = filteredMailboxData.length;
  const countCreated = () => filteredMailboxData.filter((mailbox) => mailboxStatuses[mailbox.email]?.created).length;
  const countDelegated = () => filteredMailboxData.filter((mailbox) => mailboxStatuses[mailbox.email]?.delegated).length;

  for (const mailbox of filteredMailboxData) {
    if (!mailboxStatuses[mailbox.email]) {
      mailboxStatuses[mailbox.email] = {
        created: false,
        passwordSet: false,
        smtpEnabled: false,
        delegated: false,
        signInEnabled: false,
        cloudAppAdminAssigned: false
      };
    }
  }

  if (filteredMailboxData.length === 0) {
    console.log("ℹ️ [Microsoft] No new mailboxes to create");
    return;
  }

  const accessToken = await requestTenantGraphToken(organizationId);
  const normalizeEmail = (value?: string | null) => (value || "").trim().toLowerCase();
  const userIdByEmail = new Map<string, string>();

  const resolveUserId = async (email: string): Promise<string | null> => {
    if (userIdByEmail.has(email)) {
      return userIdByEmail.get(email) || null;
    }

    const filter = encodeURIComponent(
      `mail eq '${escapeODataString(email)}' or userPrincipalName eq '${escapeODataString(email)}'`
    );

    const users = await graphRequest<{ value: Array<{ id: string }> }>(accessToken, `/users?$filter=${filter}`);
    const userId = users.value?.[0]?.id || null;
    if (userId) {
      userIdByEmail.set(email, userId);
    }
    return userId;
  };

  const resolveDelegationPrincipal = async (): Promise<string> => {
    const preferredUpn = normalizeEmail(licensedUserUpn);
    if (preferredUpn) {
      // Pre-flight: make sure the primary user is actually licensed before we
      // attempt any delegation. This runs the full 4-step license-allocation
      // algorithm — revokes from other users, picks a free SKU, assigns to
      // primary, verifies. If it fails, delegation fails fast with a clear
      // license error instead of burning PowerShell attempts against a user
      // who has no Exchange mailbox.
      await ensurePrimaryUserLicensed(accessToken, preferredUpn);

      const preferredFilter = encodeURIComponent(`userPrincipalName eq '${escapeODataString(preferredUpn)}'`);
      const preferredUsers = await graphRequest<{
        value: Array<{ userPrincipalName?: string; assignedLicenses?: unknown[] }>;
      }>(accessToken, `/users?$filter=${preferredFilter}&$select=userPrincipalName,assignedLicenses`);

      // First try: user exists AND is licensed
      const licensedMatch = preferredUsers.value?.find((user) => {
        const upn = normalizeEmail(user.userPrincipalName);
        return upn === preferredUpn && Array.isArray(user.assignedLicenses) && user.assignedLicenses.length > 0;
      });
      if (licensedMatch?.userPrincipalName) {
        return normalizeEmail(licensedMatch.userPrincipalName);
      }

      // Fallback: user exists but unlicensed — allow as delegation principal anyway
      // Fallback: user exists but unlicensed — hard-fail with an actionable error.
      // Without a license the user has no Exchange mailbox, so delegation will
      // blow up in PowerShell with a cryptic "principal not found" error anyway.
      const unlicensedMatch = preferredUsers.value?.find((user) => {
        const upn = normalizeEmail(user.userPrincipalName);
        return upn === preferredUpn;
      });
      if (unlicensedMatch?.userPrincipalName) {
        throw new Error(
          `Licensed user '${preferredUpn}' exists but has no license assigned. ` +
            `Open admin.microsoft.com → Active users → ${preferredUpn} → Licenses and apps, assign a license, then Retry.`
        );
      }

      throw new Error(
        `Configured licensed user '${preferredUpn}' is missing from the tenant. Re-run licensed user setup before delegation.`
      );
    }

    if (licensedUserId) {
      const user = await graphRequest<{ userPrincipalName?: string; assignedLicenses?: unknown[] }>(
        accessToken,
        `/users/${licensedUserId}?$select=userPrincipalName,assignedLicenses`
      );
      const resolvedUpn = normalizeEmail(user.userPrincipalName);
      if (resolvedUpn) {
        if (!(Array.isArray(user.assignedLicenses) && user.assignedLicenses.length > 0)) {
          throw new Error(
            `Licensed user '${resolvedUpn}' exists but has no license assigned. ` +
              `Open admin.microsoft.com → Active users → ${resolvedUpn} → Licenses and apps, assign a license, then Retry.`
          );
        }
        return resolvedUpn;
      }
    }

    throw new Error(
      "Licensed user identity is missing for delegation. Complete licensed user setup before mailbox delegation."
    );
  };

  type MailboxCreateStatus = {
    email?: string;
    status?: string;
    error?: string | null;
  };

  const markCreatedFromResults = (results: MailboxCreateStatus[]): { created: number; failed: number } => {
    let created = 0;
    let failed = 0;

    for (const result of results) {
      const email = result.email?.trim().toLowerCase();
      const status = result.status?.trim().toLowerCase();
      if (!email || !status) continue;

      if (status === "created" || status === "exists") {
        mailboxStatuses[email] = {
          ...(mailboxStatuses[email] || {
            created: false,
            passwordSet: false,
            smtpEnabled: false,
            delegated: false,
            signInEnabled: false,
            cloudAppAdminAssigned: false
          }),
          created: true
        };
        created += 1;
      } else if (status === "failed") {
        failed += 1;
      }
    }

    return { created, failed };
  };

  const pendingCreate = filteredMailboxData.filter((mailbox) => !mailboxStatuses[mailbox.email]?.created);

  if (!tenant.sharedMailboxesCreated || pendingCreate.length > 0) {
    const createdAtStart = countCreated();
    await prisma.tenant.update({
      where: { id: tenantDbId },
      data: {
        currentStep: `Creating shared mailboxes... (${createdAtStart}/${totalMailboxTarget})`,
        progress: 60,
        status: "mailboxes"
      }
    });

    if (pendingCreate.length > 0) {
      const startResult = await callPowerShellService("/start-create-shared-mailboxes", {
        adminUpn: adminEmail,
        adminPassword: resolvedAdminPassword,
        organizationId,
        mailboxes: pendingCreate
      });

      const createJobId = (startResult as { jobId?: string })?.jobId;
      if (!createJobId) {
        throw new Error("Mailbox creation job did not return a jobId");
      }

      let resultArray: MailboxCreateStatus[] = [];
      let createDone = false;
      const pollIntervalMs = 5000;
      let pollAttempts = 0;
      let lastPollError: string | null = null;
      let consecutiveStatusErrors = 0;
      const maxConsecutiveStatusErrors = parsePositiveInt(process.env.MAILBOX_CREATE_MAX_STATUS_ERRORS, 6);
      const mailboxCreateStallPollLimit = parsePositiveInt(process.env.MAILBOX_CREATE_STALL_POLLS, 36);
      let stallPolls = 0;
      let bestProgress = createdAtStart;
      let persistedCreatedCount = createdAtStart;

      const persistMailboxCreateProgress = async (statusLabel: string, overallCreated: number, forcePersist = false) => {
        const createdNow = countCreated();
        const shouldPersistStatuses = forcePersist || createdNow > persistedCreatedCount;

        await prisma.tenant.update({
          where: { id: tenantDbId },
          data: {
            currentStep: `Creating shared mailboxes... (${overallCreated}/${totalMailboxTarget}) • ${statusLabel}`,
            ...(shouldPersistStatuses
              ? { mailboxStatuses: { set: serializeMailboxStatuses(mailboxStatuses) } }
              : {})
          }
        });

        if (shouldPersistStatuses) {
          persistedCreatedCount = createdNow;
        }
      };

      while (!createDone) {
        pollAttempts += 1;
        await sleep(pollIntervalMs);

        try {
          const statusResponse = await fetch(`${PS_SERVICE_URL}/create-shared-mailboxes-status/${createJobId}`, {
            signal: AbortSignal.timeout(8000)
          });
          if (!statusResponse.ok) {
            throw new Error(`Mailbox create status endpoint returned ${statusResponse.status}`);
          }

          const status = (await statusResponse.json()) as {
            status?: string;
            completed?: number;
            total?: number;
            error?: string;
            results?: MailboxCreateStatus[];
          };

          const statusLabel = status.status || "unknown";
          const completed = status.completed ?? 0;
          const total = status.total ?? pendingCreate.length;
          const completedClamped = Math.max(0, Math.min(completed, total));
          const polledResults = Array.isArray(status.results) ? status.results : [];
          if (polledResults.length > 0) {
            markCreatedFromResults(polledResults);
          }
          const checkpointCreated = countCreated();
          const overallCreated = Math.min(
            totalMailboxTarget,
            Math.max(checkpointCreated, createdAtStart + completedClamped)
          );
          lastPollError = null;
          consecutiveStatusErrors = 0;

          if (statusLabel === "running") {
            if (overallCreated > bestProgress) {
              bestProgress = overallCreated;
              stallPolls = 0;
            } else {
              stallPolls += 1;
              if (stallPolls >= mailboxCreateStallPollLimit) {
                throw new Error(
                  `Mailbox creation stalled: no progress for ${(stallPolls * pollIntervalMs) / 1000}s (job ${createJobId})`
                );
              }
            }
          } else if (overallCreated > bestProgress) {
            bestProgress = overallCreated;
            stallPolls = 0;
          }

          await persistMailboxCreateProgress(statusLabel, overallCreated, statusLabel !== "running");

          if (statusLabel === "completed") {
            createDone = true;
            resultArray = polledResults;
          } else if (statusLabel === "failed") {
            createDone = true;
            throw new Error(`Mailbox creation failed: ${status.error || "unknown error"}`);
          }
        } catch (error: unknown) {
          const message = error instanceof Error ? error.message : String(error);
          lastPollError = message;
          if (message.includes("Mailbox creation failed") || message.includes("Mailbox creation stalled")) throw error;
          consecutiveStatusErrors += 1;
          if (consecutiveStatusErrors >= maxConsecutiveStatusErrors) {
            throw new Error(
              `Mailbox creation status unavailable after ${consecutiveStatusErrors} consecutive checks. Last error: ${message}`
            );
          }
          console.log(
            `⚠️ [MailboxCreate] Status check failed (${consecutiveStatusErrors}/${maxConsecutiveStatusErrors}), retrying in 5s...`
          );
        }
      }

      if (resultArray.length > 0) {
        markCreatedFromResults(resultArray);
      }

      if (resultArray.length === 0 && pendingCreate.length > 0 && countCreated() === createdAtStart) {
        throw new Error(`Mailbox creation returned no usable results for ${pendingCreate.length} mailboxes.`);
      }

      const created = Math.max(0, countCreated() - createdAtStart);
      const failed = resultArray.filter((result) => result.status === "failed").length;
      console.log(`✅ [Microsoft] Shared mailboxes: ${created} created/existing, ${failed} failed out of ${pendingCreate.length}`);

      if (failed > 0) {
        const failedEmails = resultArray
          .filter((result) => result.status === "failed")
          .map((result) => `${result.email}: ${result.error}`);
        console.log("⚠️ [Microsoft] Failed mailboxes:", failedEmails.join("; "));
      }

      if (created === 0 && pendingCreate.length > 0) {
        throw new Error(`All ${pendingCreate.length} mailbox creations failed. First error: ${resultArray[0]?.error || "unknown"}`);
      }
    }

    // Verify each mailbox we marked as "created" actually exists in Microsoft.
    // PowerShell sometimes reports status="created" for mailboxes that silently
    // never materialise (rate limiting on rapid user creation, Exchange flagging
    // short/odd-looking names, transient internal errors, etc). Ghost-marked
    // mailboxes then cause downstream delegation failures with a cryptic
    // "X/98 missing delegated permissions" error 2 phases later. Catch them
    // here by cross-checking Graph's user list against what PowerShell claimed.
    try {
      const claimed = filteredMailboxData
        .filter((mailbox) => mailboxStatuses[mailbox.email]?.created)
        .map((mailbox) => mailbox.email);

      if (claimed.length > 0) {
        // Match against UPN, mail, AND proxyAddresses. When Exchange creates a
        // shared mailbox via New-Mailbox with a -Name that collides with any
        // existing Azure AD object, it silently suffixes the auto-derived UPN
        // ("kgoyal" -> UPN "kgoyal1@domain") while keeping the requested
        // primary SMTP ("kgoyal@domain"). Checking only UPN misses these as
        // "ghosts" when they're actually fully-functional mailboxes whose
        // primarySMTP matches what we asked for.
        const graphUsers = await graphRequest<{
          value: Array<{
            userPrincipalName?: string;
            mail?: string | null;
            proxyAddresses?: string[];
          }>;
        }>(accessToken, "/users?$select=userPrincipalName,mail,proxyAddresses&$top=999");

        const graphKnownEmails = new Set<string>();
        for (const u of graphUsers.value || []) {
          if (u.userPrincipalName) graphKnownEmails.add(u.userPrincipalName.trim().toLowerCase());
          if (u.mail) graphKnownEmails.add(u.mail.trim().toLowerCase());
          for (const addr of u.proxyAddresses || []) {
            if (typeof addr !== "string") continue;
            // proxyAddresses come as "SMTP:primary@..." or "smtp:alias@..."
            const lower = addr.toLowerCase();
            if (lower.startsWith("smtp:")) {
              graphKnownEmails.add(lower.slice(5));
            } else {
              graphKnownEmails.add(lower);
            }
          }
        }

        const ghosts = claimed.filter((email) => !graphKnownEmails.has(email));
        if (ghosts.length > 0) {
          console.log(
            `⚠️ [Microsoft] ${ghosts.length}/${claimed.length} mailboxes PowerShell claimed to create are missing in Graph. Downgrading. Examples: ${ghosts.slice(0, 5).join(", ")}`
          );
          for (const email of ghosts) {
            if (mailboxStatuses[email]) {
              mailboxStatuses[email] = {
                ...mailboxStatuses[email],
                created: false
              };
            }
          }
        } else {
          console.log(`✅ [Microsoft] Verified all ${claimed.length} mailboxes exist in Graph.`);
        }
      }
    } catch (error) {
      console.log(
        `⚠️ [Microsoft] Could not verify mailboxes in Graph (best-effort):`,
        error instanceof Error ? error.message : String(error)
      );
    }

    const createdNow = countCreated();
    const allCreated = filteredMailboxData.every((mailbox) => mailboxStatuses[mailbox.email]?.created);

    await prisma.tenant.update({
      where: { id: tenantDbId },
      data: {
        sharedMailboxesCreated: allCreated,
        currentStep: `Shared mailboxes ready (${createdNow}/${totalMailboxTarget})`,
        mailboxStatuses: { set: serializeMailboxStatuses(mailboxStatuses) }
      }
    });

    // If Graph verification caught ghosts, stop the run now with a clear
    // error. Retrying will see `sharedMailboxesCreated = false` + missing
    // `created` flags on the ghost emails, and re-attempt creation only
    // for those specific ones (the existing 77+ will be skipped via the
    // "status === 'exists'" branch in markCreatedFromResults).
    if (!allCreated) {
      const stillMissing = filteredMailboxData
        .filter((mailbox) => !mailboxStatuses[mailbox.email]?.created)
        .map((mailbox) => mailbox.email);
      throw new Error(
        `Mailbox provisioning incomplete: ${stillMissing.length}/${filteredMailboxData.length} mailboxes ` +
          `claimed by PowerShell but not visible in Microsoft Graph. Retry will attempt creation again for the missing ones. ` +
          `Examples: ${stillMissing.slice(0, 5).join(", ")}`
      );
    }

    console.log("⏳ [Microsoft] Cooling down 5s before next step...");
    await sleep(5000);
  }

  await prisma.tenant.update({
    where: { id: tenantDbId },
    data: { currentStep: "Updating email addresses...", progress: 70 }
  });

  for (const mailbox of filteredMailboxData) {
    try {
      const userId = await resolveUserId(mailbox.email);
      if (!userId) {
        console.log(`⚠️ [Graph] Could not find user for ${mailbox.email}`);
        continue;
      }

      const mailNickname = mailbox.email.split("@")[0].replace(/[^a-zA-Z0-9]/g, "");

      await graphRequest<Record<string, unknown>>(accessToken, `/users/${userId}`, {
        method: "PATCH",
        body: JSON.stringify({
          userPrincipalName: mailbox.email,
          mailNickname
        })
      });
    } catch (error) {
      console.log(`⚠️ [Graph] Failed to update ${mailbox.email}:`, error instanceof Error ? error.message : String(error));
    }
  }

  const pendingPasswordMailboxes = filteredMailboxData.filter(
    (mailbox) => mailboxStatuses[mailbox.email]?.created && !mailboxStatuses[mailbox.email]?.passwordSet
  );

  if (!tenant.passwordsSet || pendingPasswordMailboxes.length > 0) {
    await prisma.tenant.update({
      where: { id: tenantDbId },
      data: { currentStep: "Setting mailbox passwords...", progress: 75 }
    });

    for (const mailbox of pendingPasswordMailboxes) {
      try {
        const userId = await resolveUserId(mailbox.email);
        if (!userId) continue;

        await graphRequest<Record<string, unknown>>(accessToken, `/users/${userId}`, {
          method: "PATCH",
          body: JSON.stringify({
            passwordProfile: {
              forceChangePasswordNextSignIn: false,
              password: resolvedAdminPassword
            }
          })
        });
        mailboxStatuses[mailbox.email] = {
          ...(mailboxStatuses[mailbox.email] || {
            created: false,
            passwordSet: false,
            smtpEnabled: false,
            delegated: false,
            signInEnabled: false,
            cloudAppAdminAssigned: false
          }),
          passwordSet: true
        };
      } catch (error) {
        console.log(
          `⚠️ [Graph] Failed to set password for ${mailbox.email}:`,
          error instanceof Error ? error.message : String(error)
        );
      }
    }

    const allPasswordsSet = filteredMailboxData.every((mailbox) => mailboxStatuses[mailbox.email]?.passwordSet);

    await prisma.tenant.update({
      where: { id: tenantDbId },
      data: {
        passwordsSet: allPasswordsSet,
        mailboxStatuses: { set: serializeMailboxStatuses(mailboxStatuses) }
      }
    });
  }

  const pendingSmtpEmails = filteredMailboxData
    .filter((mailbox) => mailboxStatuses[mailbox.email]?.created && !mailboxStatuses[mailbox.email]?.smtpEnabled)
    .map((mailbox) => mailbox.email);

  if (!tenant.smtpAuthEnabled || pendingSmtpEmails.length > 0) {
    await prisma.tenant.update({
      where: { id: tenantDbId },
      data: { currentStep: "Enabling SMTP auth...", progress: 80, status: "mailbox_config" }
    });

    if (pendingSmtpEmails.length > 0) {
      const smtpResult = await callPowerShellService("/enable-smtp-auth", {
        adminUpn: adminEmail,
        adminPassword: resolvedAdminPassword,
        organizationId,
        emails: pendingSmtpEmails
      });

      type SmtpResultStatus = {
        email?: string;
        status?: string;
      };

      const resultArray: SmtpResultStatus[] = Array.isArray((smtpResult as { results?: unknown })?.results)
        ? ((smtpResult as { results: SmtpResultStatus[] }).results || [])
        : [];

      for (const result of resultArray) {
        if (!result.email) continue;
        if (result.status === "enabled") {
          mailboxStatuses[result.email] = {
            ...(mailboxStatuses[result.email] || {
              created: false,
              passwordSet: false,
              smtpEnabled: false,
              delegated: false,
              signInEnabled: false,
              cloudAppAdminAssigned: false
            }),
            smtpEnabled: true
          };
        }
      }
    }

    const allSmtpEnabled = filteredMailboxData.every((mailbox) => mailboxStatuses[mailbox.email]?.smtpEnabled);

    await prisma.tenant.update({
      where: { id: tenantDbId },
      data: {
        smtpAuthEnabled: allSmtpEnabled,
        mailboxStatuses: { set: serializeMailboxStatuses(mailboxStatuses) }
      }
    });

    console.log("⏳ [Microsoft] Cooling down 5s before delegation...");
    await sleep(5000);
  }

  let pendingDelegationEmails = filteredMailboxData
    .filter((mailbox) => mailboxStatuses[mailbox.email]?.created && !mailboxStatuses[mailbox.email]?.delegated)
    .map((mailbox) => mailbox.email);

  if (!tenant.delegationComplete || pendingDelegationEmails.length > 0) {
    const previousDelegationPrincipal = normalizeEmail(tenant.licensedUserUpn);
    const delegationPrincipalUpn = await resolveDelegationPrincipal();
    const staleDelegateUpn =
      previousDelegationPrincipal && previousDelegationPrincipal !== delegationPrincipalUpn
        ? previousDelegationPrincipal
        : null;

    if (delegationPrincipalUpn !== previousDelegationPrincipal) {
      await prisma.tenant.update({
        where: { id: tenantDbId },
        data: { licensedUserUpn: delegationPrincipalUpn }
      });
      console.log(
        `ℹ️ [Delegation] Updated delegation principal for ${domain}: ${tenant.licensedUserUpn || "none"} -> ${delegationPrincipalUpn}`
      );
    }

    const delegatedAtStart = countDelegated();
    const maxDelegationAttempts = parsePositiveInt(process.env.DELEGATION_MAX_ATTEMPTS, 3);
    const delegationRetryDelayMs = parsePositiveInt(process.env.DELEGATION_RETRY_DELAY_MS, 5000);
    const forceCompletePolls = parsePositiveInt(process.env.DELEGATION_FORCE_COMPLETE_POLLS, 2);

    await prisma.tenant.update({
      where: { id: tenantDbId },
      data: {
        currentStep: `Setting mailbox delegation... (${delegatedAtStart}/${totalMailboxTarget})`,
        progress: 85
      }
    });

    if (pendingDelegationEmails.length > 0) {
      for (let attempt = 1; attempt <= maxDelegationAttempts; attempt += 1) {
        const attemptLabel = `${attempt}/${maxDelegationAttempts}`;

        pendingDelegationEmails = filteredMailboxData
          .filter((mailbox) => mailboxStatuses[mailbox.email]?.created && !mailboxStatuses[mailbox.email]?.delegated)
          .map((mailbox) => mailbox.email);

        if (pendingDelegationEmails.length === 0) {
          console.log(`✅ [Delegation] No pending mailbox delegation before attempt ${attemptLabel}`);
          break;
        }

        if (attempt > 1) {
          await prisma.tenant.update({
            where: { id: tenantDbId },
            data: {
              currentStep:
                `Retrying mailbox delegation (attempt ${attemptLabel})... ` +
                `(${countDelegated()}/${totalMailboxTarget} delegated, ${pendingDelegationEmails.length} pending)`,
              progress: 85
            }
          });
          await sleep(delegationRetryDelayMs);
        }

        try {
          const attemptEmails = [...pendingDelegationEmails];
          const startResult = await callPowerShellService("/start-delegation", {
            adminUpn: adminEmail,
            adminPassword: resolvedAdminPassword,
            licensedUserUpn: delegationPrincipalUpn,
            staleDelegateUpn,
            emails: attemptEmails
          });

          const jobId = (startResult as { jobId?: string }).jobId;
          if (!jobId) {
            throw new Error("Delegation job did not return a jobId");
          }
          console.log(`📡 [Delegation] Started async job: ${jobId} (attempt ${attemptLabel})`);

          let delegationDone = false;
          const pollIntervalMs = 10000;
          let pollAttempts = 0;
          let consecutiveStatusErrors = 0;
          const maxConsecutiveStatusErrors = parsePositiveInt(process.env.DELEGATION_MAX_STATUS_ERRORS, 6);
          const delegationStallPollLimit = parsePositiveInt(process.env.DELEGATION_STALL_POLLS, 36);
          let stallPolls = 0;
          let bestCheckedProgress = countDelegated();
          let persistedDelegatedCount = countDelegated();
          let normalizedResults: Array<{ email?: string; status?: string; errors?: string }> = [];
          let fullProgressRunningPolls = 0;

          while (!delegationDone) {
            pollAttempts += 1;
            await sleep(pollIntervalMs);

            try {
              const statusResponse = await fetch(`${PS_SERVICE_URL}/delegation-status/${jobId}`, {
                signal: AbortSignal.timeout(8000)
              });
              if (!statusResponse.ok) {
                throw new Error(`Delegation status endpoint returned ${statusResponse.status}`);
              }

              const status = (await statusResponse.json()) as {
                status?: string;
                completed?: number;
                total?: number;
                error?: string;
                results?: Array<{ email?: string; status?: string; errors?: string }> | string;
              };
              let statusLabel = status.status || "unknown";
              const completed = status.completed ?? 0;
              const total = status.total ?? attemptEmails.length;
              const completedClamped = Math.max(0, Math.min(completed, total));
              const liveResults = Array.isArray(status.results) ? status.results : [];
              if (liveResults.length > 0) {
                for (const item of liveResults) {
                  const email = item.email?.trim().toLowerCase();
                  const resultStatus = item.status?.trim().toLowerCase();
                  if (!email || (resultStatus !== "delegated" && resultStatus !== "applied")) continue;
                  mailboxStatuses[email] = {
                    ...(mailboxStatuses[email] || {
                      created: false,
                      passwordSet: false,
                      smtpEnabled: false,
                      delegated: false,
                      signInEnabled: false,
                      cloudAppAdminAssigned: false
                    }),
                    delegated: true
                  };
                }
              }

              const delegatedDone = countDelegated();
              const checkedOverall = Math.min(totalMailboxTarget, delegatedDone + completedClamped);
              const shouldPersistDelegated = delegatedDone > persistedDelegatedCount;
              consecutiveStatusErrors = 0;

              const fullyDoneWhileRunning =
                statusLabel === "running" &&
                total > 0 &&
                completedClamped >= total &&
                delegatedDone >= totalMailboxTarget;
              if (fullyDoneWhileRunning) {
                fullProgressRunningPolls += 1;
              } else {
                fullProgressRunningPolls = 0;
              }

              if (fullyDoneWhileRunning && fullProgressRunningPolls >= forceCompletePolls) {
                statusLabel = "force-complete";
                console.log(
                  `✅ [Delegation] Force-completing job ${jobId} after ${fullProgressRunningPolls} full-progress running polls (attempt ${attemptLabel})`
                );
              }

              if (statusLabel === "running") {
                if (checkedOverall > bestCheckedProgress) {
                  bestCheckedProgress = checkedOverall;
                  stallPolls = 0;
                } else {
                  stallPolls += 1;
                  if (stallPolls >= delegationStallPollLimit) {
                    throw new Error(
                      `Delegation stalled: no progress for ${(stallPolls * pollIntervalMs) / 1000}s (job ${jobId})`
                    );
                  }
                }
              } else if (checkedOverall > bestCheckedProgress) {
                bestCheckedProgress = checkedOverall;
                stallPolls = 0;
              }

              console.log(`📡 [Delegation] Progress: ${completed}/${total} - ${statusLabel} (attempt ${attemptLabel})`);

              await prisma.tenant.update({
                where: { id: tenantDbId },
                data: {
                  currentStep:
                    `Delegating mailboxes... (${delegatedDone}/${totalMailboxTarget} delegated, ` +
                    `${checkedOverall}/${totalMailboxTarget} checked) • ${statusLabel} (attempt ${attemptLabel})`,
                  ...(shouldPersistDelegated
                    ? { mailboxStatuses: { set: serializeMailboxStatuses(mailboxStatuses) } }
                    : {})
                }
              });
              if (shouldPersistDelegated) {
                persistedDelegatedCount = delegatedDone;
              }

              if (statusLabel === "completed" || statusLabel === "force-complete") {
                delegationDone = true;

                normalizedResults = Array.isArray(status.results)
                  ? status.results
                  : typeof status.results === "string"
                    ? status.results
                        .split(/\r?\n/)
                        .map((line) => line.trim())
                        .filter(Boolean)
                        .map((line) => {
                          const match = line.match(/\[\d+\s*\/\s*\d+\]\s+(.+?)\s+->\s+([a-zA-Z]+)/);
                          if (!match) return null;
                          return { email: match[1]?.trim(), status: match[2]?.trim().toLowerCase() };
                        })
                        .filter((item): item is { email: string; status: string } => Boolean(item?.email && item?.status))
                    : [];
              } else if (statusLabel === "failed") {
                delegationDone = true;
                throw new Error(`Delegation failed: ${status.error || "unknown error"}`);
              }
            } catch (error: unknown) {
              const message = error instanceof Error ? error.message : String(error);
              const normalized = message.toLowerCase();
              if (message.includes("Delegation failed") || message.includes("Delegation stalled")) throw error;
              if (normalized.includes("returned 404") || normalized.includes("job not found")) {
                throw new Error(`Delegation status lost for job ${jobId}: ${message}`);
              }
              consecutiveStatusErrors += 1;
              if (consecutiveStatusErrors >= maxConsecutiveStatusErrors) {
                throw new Error(`Delegation status unavailable after ${consecutiveStatusErrors} consecutive checks: ${message}`);
              }
              console.log(
                `⚠️ [Delegation] Status check failed (${consecutiveStatusErrors}/${maxConsecutiveStatusErrors}), retrying in 10s... (attempt ${attemptLabel})`
              );
            }
          }

          for (const item of normalizedResults) {
            const email = item.email?.trim().toLowerCase();
            const status = item.status?.trim().toLowerCase();
            if (!email || (status !== "delegated" && status !== "applied")) continue;

            mailboxStatuses[email] = {
              ...(mailboxStatuses[email] || {
                created: false,
                passwordSet: false,
                smtpEnabled: false,
                delegated: false,
                signInEnabled: false,
                cloudAppAdminAssigned: false
              }),
              delegated: true
            };
          }

          pendingDelegationEmails = filteredMailboxData
            .filter((mailbox) => mailboxStatuses[mailbox.email]?.created && !mailboxStatuses[mailbox.email]?.delegated)
            .map((mailbox) => mailbox.email);

          await prisma.tenant.update({
            where: { id: tenantDbId },
            data: {
              mailboxStatuses: { set: serializeMailboxStatuses(mailboxStatuses) },
              currentStep:
                `Delegation attempt ${attemptLabel} complete ` +
                `(${countDelegated()}/${totalMailboxTarget} delegated, ${pendingDelegationEmails.length} pending)`
            }
          });

          if (pendingDelegationEmails.length === 0) {
            console.log(`✅ [Delegation] All mailboxes delegated after attempt ${attemptLabel}`);
            break;
          }

          console.log(
            `⚠️ [Delegation] ${pendingDelegationEmails.length} mailbox(es) still pending after attempt ${attemptLabel}`
          );
        } catch (error: unknown) {
          const message = error instanceof Error ? error.message : String(error);
          if (attempt >= maxDelegationAttempts) {
            throw new Error(`Delegation failed after ${attempt}/${maxDelegationAttempts} attempts: ${message}`);
          }
          console.log(`⚠️ [Delegation] Attempt ${attemptLabel} failed, will retry: ${message}`);
        }
      }
    }

    let finalPendingDelegationEmails = filteredMailboxData
      .filter((mailbox) => mailboxStatuses[mailbox.email]?.created && !mailboxStatuses[mailbox.email]?.delegated)
      .map((mailbox) => mailbox.email);

    if (finalPendingDelegationEmails.length > 0) {
      const finalVerifyAttempts = parsePositiveInt(process.env.DELEGATION_FINAL_VERIFY_ATTEMPTS, 6);
      const finalVerifyDelayMs = parsePositiveInt(process.env.DELEGATION_FINAL_VERIFY_DELAY_MS, 10000);

      for (let verifyAttempt = 1; verifyAttempt <= finalVerifyAttempts; verifyAttempt += 1) {
        if (verifyAttempt > 1) {
          await sleep(finalVerifyDelayMs);
        }

        await prisma.tenant.update({
          where: { id: tenantDbId },
          data: {
            currentStep:
              `Final delegation verification (${verifyAttempt}/${finalVerifyAttempts})... ` +
              `(${countDelegated()}/${totalMailboxTarget} delegated, ${finalPendingDelegationEmails.length} pending)`,
            progress: 85
          }
        });

        const verifyResult = await callPowerShellService("/verify-delegation", {
          adminUpn: adminEmail,
          adminPassword: resolvedAdminPassword,
          licensedUserUpn: delegationPrincipalUpn,
          emails: finalPendingDelegationEmails
        });

        type VerifyRow = { email?: string; status?: string };
        const verifyRows: VerifyRow[] = Array.isArray((verifyResult as { results?: unknown })?.results)
          ? ((verifyResult as { results: VerifyRow[] }).results || [])
          : [];

        for (const row of verifyRows) {
          const email = row.email?.trim().toLowerCase();
          const status = row.status?.trim().toLowerCase();
          if (!email || status !== "delegated") continue;

          mailboxStatuses[email] = {
            ...(mailboxStatuses[email] || {
              created: false,
              passwordSet: false,
              smtpEnabled: false,
              delegated: false,
              signInEnabled: false,
              cloudAppAdminAssigned: false
            }),
            delegated: true
          };
        }

        finalPendingDelegationEmails = filteredMailboxData
          .filter((mailbox) => mailboxStatuses[mailbox.email]?.created && !mailboxStatuses[mailbox.email]?.delegated)
          .map((mailbox) => mailbox.email);

        await prisma.tenant.update({
          where: { id: tenantDbId },
          data: {
            mailboxStatuses: { set: serializeMailboxStatuses(mailboxStatuses) },
            currentStep:
              `Final delegation verification ${verifyAttempt}/${finalVerifyAttempts} complete ` +
              `(${countDelegated()}/${totalMailboxTarget} delegated, ${finalPendingDelegationEmails.length} pending)`
          }
        });

        if (finalPendingDelegationEmails.length === 0) {
          break;
        }
      }
    }

    const allDelegated = filteredMailboxData.every((mailbox) => mailboxStatuses[mailbox.email]?.delegated);

    await prisma.tenant.update({
      where: { id: tenantDbId },
      data: {
        delegationComplete: allDelegated,
        mailboxStatuses: { set: serializeMailboxStatuses(mailboxStatuses) }
      }
    });

    if (!allDelegated) {
      const undelegated = filteredMailboxData
        .filter((mailbox) => mailboxStatuses[mailbox.email]?.created && !mailboxStatuses[mailbox.email]?.delegated)
        .map((mailbox) => mailbox.email);
      const preview = undelegated.slice(0, 5).join(", ");
      const allMissing = undelegated.length === filteredMailboxData.length;
      const rootCauseHint = allMissing
        ? ` Most likely cause: the delegation principal (${licensedUserUpn || "licensed user"}) has no Exchange mailbox — typically because the license didn't actually attach. Verify in admin.microsoft.com → Active users → Licenses and apps.`
        : "";
      throw new Error(
        `Delegation incomplete: ${undelegated.length}/${filteredMailboxData.length} mailboxes missing delegated permissions.${rootCauseHint}` +
          (preview ? ` (examples of undelegated: ${preview})` : "")
      );
    }
  }

  if (!tenant.signInEnabled) {
    await prisma.tenant.update({
      where: { id: tenantDbId },
      data: { currentStep: "Enabling sign-in...", progress: 90 }
    });

    for (const mailbox of filteredMailboxData) {
      if (mailboxStatuses[mailbox.email]?.signInEnabled) continue;

      try {
        const userId = await resolveUserId(mailbox.email);
        if (!userId) continue;

        await graphRequest<Record<string, unknown>>(accessToken, `/users/${userId}`, {
          method: "PATCH",
          body: JSON.stringify({ accountEnabled: true })
        });

        mailboxStatuses[mailbox.email] = { ...mailboxStatuses[mailbox.email], signInEnabled: true };
      } catch (error) {
        console.log(`⚠️ [Graph] Failed to enable sign-in for ${mailbox.email}:`, error instanceof Error ? error.message : String(error));
      }
    }

    const allSignInEnabled = filteredMailboxData.every((m) => mailboxStatuses[m.email]?.signInEnabled);
    await prisma.tenant.update({
      where: { id: tenantDbId },
      data: { signInEnabled: allSignInEnabled, mailboxStatuses: { set: serializeMailboxStatuses(mailboxStatuses) } }
    });
  }

  if (!tenant.cloudAppAdminAssigned) {
    await prisma.tenant.update({
      where: { id: tenantDbId },
      data: { currentStep: "Assigning Cloud App Admin role...", progress: 95 }
    });

    const cloudAppAdminTemplateId = "158c047a-c907-4556-b7ef-446551a6b5f7";

    for (const mailbox of filteredMailboxData) {
      if (mailboxStatuses[mailbox.email]?.cloudAppAdminAssigned) continue;

      try {
        const userId = await resolveUserId(mailbox.email);
        if (!userId) continue;

        await graphRequest<Record<string, unknown>>(accessToken, "/roleManagement/directory/roleAssignments", {
          method: "POST",
          body: JSON.stringify({
            roleDefinitionId: cloudAppAdminTemplateId,
            principalId: userId,
            directoryScopeId: "/"
          })
        });

        mailboxStatuses[mailbox.email] = { ...mailboxStatuses[mailbox.email], cloudAppAdminAssigned: true };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (message.includes("already exists")) {
          // Role already assigned — treat as success
          mailboxStatuses[mailbox.email] = { ...mailboxStatuses[mailbox.email], cloudAppAdminAssigned: true };
        } else {
          console.log(`⚠️ [Graph] Failed to assign Cloud App Admin to ${mailbox.email}: ${message}`);
        }
      }
    }

    const allCloudAppAdminAssigned = filteredMailboxData.every((m) => mailboxStatuses[m.email]?.cloudAppAdminAssigned);
    await prisma.tenant.update({
      where: { id: tenantDbId },
      data: { cloudAppAdminAssigned: allCloudAppAdminAssigned, mailboxStatuses: { set: serializeMailboxStatuses(mailboxStatuses) } }
    });
  }

  // Final remediation pass — retry any mailboxes that failed sign-in or Cloud App Admin
  const signInFailed = filteredMailboxData.filter((m) => !mailboxStatuses[m.email]?.signInEnabled);
  const cloudAppAdminFailed = filteredMailboxData.filter((m) => !mailboxStatuses[m.email]?.cloudAppAdminAssigned);

  if (signInFailed.length > 0 || cloudAppAdminFailed.length > 0) {
    console.log(
      `🔄 [Microsoft] Remediation pass: ${signInFailed.length} sign-in failures, ${cloudAppAdminFailed.length} Cloud App Admin failures`
    );

    await prisma.tenant.update({
      where: { id: tenantDbId },
      data: { currentStep: "Remediating failed mailboxes..." }
    });

    for (const mailbox of signInFailed) {
      try {
        const userId = await resolveUserId(mailbox.email);
        if (!userId) continue;
        await graphRequest<Record<string, unknown>>(accessToken, `/users/${userId}`, {
          method: "PATCH",
          body: JSON.stringify({ accountEnabled: true })
        });
        mailboxStatuses[mailbox.email] = { ...mailboxStatuses[mailbox.email], signInEnabled: true };
        console.log(`✅ [Graph] Remediated sign-in for ${mailbox.email}`);
      } catch (error) {
        console.log(
          `⚠️ [Graph] Remediation failed for sign-in ${mailbox.email}:`,
          error instanceof Error ? error.message : String(error)
        );
      }
    }

    const cloudAppAdminTemplateId = "158c047a-c907-4556-b7ef-446551a6b5f7";
    for (const mailbox of cloudAppAdminFailed) {
      try {
        const userId = await resolveUserId(mailbox.email);
        if (!userId) continue;
        await graphRequest<Record<string, unknown>>(accessToken, "/roleManagement/directory/roleAssignments", {
          method: "POST",
          body: JSON.stringify({
            roleDefinitionId: cloudAppAdminTemplateId,
            principalId: userId,
            directoryScopeId: "/"
          })
        });
        mailboxStatuses[mailbox.email] = { ...mailboxStatuses[mailbox.email], cloudAppAdminAssigned: true };
        console.log(`✅ [Graph] Remediated Cloud App Admin for ${mailbox.email}`);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (message.includes("already exists")) {
          mailboxStatuses[mailbox.email] = { ...mailboxStatuses[mailbox.email], cloudAppAdminAssigned: true };
        } else {
          console.log(`⚠️ [Graph] Remediation failed for Cloud App Admin ${mailbox.email}: ${message}`);
        }
      }
    }

    const allSignInEnabledFinal = filteredMailboxData.every((m) => mailboxStatuses[m.email]?.signInEnabled);
    const allCloudAppAdminFinal = filteredMailboxData.every((m) => mailboxStatuses[m.email]?.cloudAppAdminAssigned);

    await prisma.tenant.update({
      where: { id: tenantDbId },
      data: {
        signInEnabled: allSignInEnabledFinal,
        cloudAppAdminAssigned: allCloudAppAdminFinal,
        mailboxStatuses: { set: serializeMailboxStatuses(mailboxStatuses) }
      }
    });

    const stillFailedSignIn = filteredMailboxData.filter((m) => !mailboxStatuses[m.email]?.signInEnabled);
    const stillFailedCloudApp = filteredMailboxData.filter((m) => !mailboxStatuses[m.email]?.cloudAppAdminAssigned);
    if (stillFailedSignIn.length > 0 || stillFailedCloudApp.length > 0) {
      console.log(
        `⚠️ [Microsoft] After remediation: ${stillFailedSignIn.length} sign-in still failing, ${stillFailedCloudApp.length} Cloud App Admin still failing — will retry on next run`
      );
    } else {
      console.log(`✅ [Microsoft] All mailboxes remediated successfully`);
    }
  }

  const csvRows: string[][] = [["DisplayName", "EmailAddress", "Password"]];
  const csvMailboxRows = [...mailboxData];
  if (
    licensedUserUpn &&
    !csvMailboxRows.some((mailbox) => normalizeEmail(mailbox.email) === normalizeEmail(licensedUserUpn))
  ) {
    const fallbackDisplayName =
      parseInboxNamesValue(tenant.inboxNames)[0] ||
      licensedUserUpn.split("@")[0].replace(/[._-]+/g, " ").trim() ||
      "Licensed User";
    csvMailboxRows.unshift({
      email: licensedUserUpn,
      displayName: fallbackDisplayName,
      password: resolvedAdminPassword
    });
  }
  for (const mailbox of csvMailboxRows) {
    csvRows.push([mailbox.displayName, mailbox.email, resolvedAdminPassword]);
  }

  const csvBody = toCsv(csvRows);
  const folder = path.resolve(process.cwd(), ".data", "csv");
  await mkdir(folder, { recursive: true });
  const filename = `${tenant.tenantName.replace(/[^a-zA-Z0-9_-]/g, "_")}-shared-${Date.now()}.csv`;
  const absolutePath = path.join(folder, filename);
  await writeFile(absolutePath, csvBody, "utf8");

  await prisma.tenant.update({
    where: { id: tenantDbId },
    data: {
      status: "mailbox_config",
      currentStep: "Mailbox setup complete",
      progress: 96,
      csvUrl: absolutePath
    }
  });

  console.log(`✅ [Microsoft] Phase 3 complete for ${domain} — ${filteredMailboxData.length} shared mailboxes ready`);
}

type DkimConfigurationResult =
  | { status: "configured"; verificationDeferred?: boolean; reason?: string };

function isDkimPropagationPendingError(message: string): boolean {
  const normalized = message.toLowerCase();
  return (
    normalized.includes("cname record does not exist for this config") ||
    (normalized.includes("sync will take") && normalized.includes("retry this step later"))
  );
}

export async function configureDkim(tenantDbId: string): Promise<DkimConfigurationResult> {
  const tenant = await prisma.tenant.findUniqueOrThrow({
    where: { id: tenantDbId }
  });

  const domain = tenant.domain;
  const adminPassword = tenant.adminPassword;
  const zoneId = tenant.zoneId;
  const adminEmail = tenant.adminEmail;

  if (!domain || !adminPassword || !zoneId) {
    throw new Error("Missing data for DKIM setup");
  }

  const adminUpn = adminEmail;
  if (!adminUpn) {
    throw new Error("Missing admin UPN for DKIM setup");
  }

  const resolvedAdminPassword = (() => {
    try {
      return decryptSecret(adminPassword);
    } catch {
      return adminPassword;
    }
  })();

  await prisma.tenant.update({
    where: { id: tenantDbId },
    data: {
      status: "dkim_config",
      currentStep: "Configuring DKIM...",
      progress: 97
    }
  });

  const dkimResult = await callPowerShellService("/configure-dkim", {
    adminUpn,
    adminPassword: resolvedAdminPassword,
    domain
  });

  const { selector1CNAME, selector2CNAME } = dkimResult as {
    selector1CNAME?: string;
    selector2CNAME?: string;
  };

  if (!selector1CNAME || !selector2CNAME) {
    throw new Error("Could not get DKIM selectors");
  }

  console.log(`📋 [DKIM] Selector 1: ${selector1CNAME}`);
  console.log(`📋 [DKIM] Selector 2: ${selector2CNAME}`);

  const cfApiKey = process.env.CLOUDFLARE_API_KEY;
  const cfEmail = process.env.CLOUDFLARE_EMAIL;
  if (!cfApiKey || !cfEmail) {
    throw new Error("Missing CLOUDFLARE_API_KEY or CLOUDFLARE_EMAIL");
  }

  for (const [name, target] of [
    ["selector1._domainkey", selector1CNAME],
    ["selector2._domainkey", selector2CNAME]
  ] as const) {
    const response = await fetch(`https://api.cloudflare.com/client/v4/zones/${zoneId}/dns_records`, {
      method: "POST",
      headers: {
        "X-Auth-Key": cfApiKey,
        "X-Auth-Email": cfEmail,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        type: "CNAME",
        name,
        content: target,
        ttl: 1,
        proxied: false
      })
    });

    if (!response.ok) {
      const text = await response.text();
      const normalized = text.toLowerCase();
      if (normalized.includes("already exists")) {
        console.log(`⚠️ [Cloudflare] DKIM CNAME might already exist: ${name}`);
      } else {
        throw new Error(`Failed to add DKIM CNAME ${name}: ${text}`);
      }
    } else {
      console.log(`✅ [Cloudflare] DKIM CNAME added: ${name}`);
    }
  }

  try {
    await callPowerShellService("/enable-dkim", {
      adminUpn,
      adminPassword: resolvedAdminPassword,
      domain
    });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    const propagationPending = isDkimPropagationPendingError(message);

    if (propagationPending) {
      // DKIM CNAME records take up to 48h to propagate — keep going; real
      // signing will start automatically once DNS is visible. Mark configured
      // so the tenant doesn't block on this.
      await prisma.tenant.update({
        where: { id: tenantDbId },
        data: {
          dkimConfigured: true,
          currentStep: "DKIM DNS submitted. Microsoft will finish propagation within 48h.",
          progress: 98
        }
      });
      console.log(
        `ℹ️ [DKIM] ${domain} DNS not yet visible; deferring verification. Reason: ${message}`
      );
      return { status: "configured", verificationDeferred: true, reason: message };
    }

    // Any OTHER failure (bad creds, wrong domain, permission issue) is a real
    // problem and shouldn't silently mark the tenant as DKIM-complete.
    console.log(`❌ [DKIM] Hard failure for ${domain}. Reason: ${message}`);
    throw new Error(`DKIM enable failed for ${domain}: ${message}`);
  }

  await prisma.tenant.update({
    where: { id: tenantDbId },
    data: {
      dkimConfigured: true,
      currentStep: "DKIM configured",
      progress: 98
    }
  });

  console.log(`✅ [DKIM] Enabled for ${domain}`);
  return { status: "configured" };
}

export async function initiateDeviceAuth(tenantId: string): Promise<void> {
  try {
    const tenant = await prisma.tenant.findUnique({
      where: { id: tenantId },
      select: {
        id: true,
        tenantId: true,
        adminEmail: true
      }
    });

    if (!tenant) {
      throw new Error(`Tenant ${tenantId} not found`);
    }

    await prisma.tenant.update({
      where: { id: tenant.id },
      data: {
        status: "auth_pending",
        progress: 65,
        currentStep: "Requesting device authentication code"
      }
    });

    if (TEST_MODE) {
      console.log("🧪 TEST MODE: Skipping Microsoft Graph API call");
      const fakeUserCode = `TEST-${Math.random().toString(36).slice(2, 8).toUpperCase()}`;
      const fakeDeviceCode = `test-device-${Math.random().toString(36).slice(2)}-${Date.now()}`;
      const expiry = new Date(Date.now() + 15 * 60 * 1000);
      await prisma.tenant.update({
        where: { id: tenant.id },
        data: {
          authCode: fakeUserCode,
          deviceCode: fakeDeviceCode,
          authCodeExpiry: expiry,
          currentStep: `Enter code ${fakeUserCode} at https://microsoft.com/devicelogin (test mode)`
        }
      });
      return;
    }

    const { clientId } = assertGraphConfig();
    const tenantIdentifier = resolveTenantAuthority({
      adminEmail: tenant.adminEmail,
      tenantId: tenant.tenantId
    });

    const response = await fetch(`https://login.microsoftonline.com/${encodeURIComponent(tenantIdentifier)}/oauth2/v2.0/devicecode`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: clientId,
        scope: [
          "offline_access",
          "openid",
          "profile",
          "User.Read",
          "Policy.Read.All",
          "Policy.ReadWrite.ConditionalAccess",
          "Domain.ReadWrite.All",
          "Directory.ReadWrite.All",
          "RoleManagement.ReadWrite.Directory",
          "Application.ReadWrite.All",
          "Organization.Read.All"
        ].join(" ")
      })
    });

    const payload = (await response.json()) as Partial<DeviceCodeResponse> & { error_description?: string };

    if (!response.ok || !payload.device_code || !payload.expires_in) {
      throw new Error(payload.error_description || "Failed to initiate device auth");
    }

    const expiry = new Date(Date.now() + payload.expires_in * 1000);

    await prisma.tenant.update({
      where: { id: tenant.id },
      data: {
        authCode: payload.user_code || null,
        deviceCode: payload.device_code,
        authCodeExpiry: expiry,
        currentStep: `Enter code ${payload.user_code || "(check portal)"} at ${payload.verification_uri || "https://microsoft.com/devicelogin"}`
      }
    });
  } catch (error) {
    await prisma.tenant.update({
      where: { id: tenantId },
      data: {
        status: "failed",
        errorMessage: error instanceof Error ? error.message : "Device auth initialization failed",
        currentStep: "Auth initialization failed"
      }
    });
    throw error;
  }
}

async function createGraphUser(
  token: string,
  displayName: string,
  emailAddress: string,
  password: string
): Promise<GraphUserResponse> {
  const mailNickname = emailAddress.split("@")[0].replace(/[^a-zA-Z0-9]/g, "");

  return graphRequest<GraphUserResponse>(token, "/users", {
    method: "POST",
    body: JSON.stringify({
      accountEnabled: true,
      displayName,
      mailNickname,
      userPrincipalName: emailAddress,
      passwordProfile: {
        forceChangePasswordNextSignIn: false,
        password
      }
    })
  });
}

export async function createMailboxes(tenantId: string): Promise<void> {
  try {
    const tenant = await prisma.tenant.findUnique({
      where: { id: tenantId },
      select: {
        id: true,
        tenantName: true,
        domain: true,
        inboxNames: true,
        inboxCount: true,
        adminPassword: true,
        tenantId: true
      }
    });

    if (!tenant) {
      throw new Error(`Tenant ${tenantId} not found`);
    }

    await prisma.tenant.update({
      where: { id: tenant.id },
      data: {
        status: "mailboxes",
        progress: 70,
        currentStep: "Generating mailbox identities"
      }
    });

    // Decryption validates the stored credential integrity before automation continues.
    const resolvedAdminPassword = (() => {
      try {
        return decryptSecret(tenant.adminPassword);
      } catch {
        return tenant.adminPassword;
      }
    })();

    const names = parseInboxNamesValue(tenant.inboxNames);

    const generated = generateEmailVariations(names, tenant.domain, tenant.inboxCount);
    const rows: string[][] = [["DisplayName", "EmailAddress", "Password"]];

    if (TEST_MODE) {
      console.log("🧪 TEST MODE: Skipping Microsoft Graph API call");
      for (let index = 0; index < generated.length; index++) {
        await sleep(100);
        const mailbox = generated[index];
        rows.push([mailbox.displayName, mailbox.email, "TestPass123!"]);

        const percent = 70 + Math.round(((index + 1) / generated.length) * 25);
        await prisma.tenant.update({
          where: { id: tenant.id },
          data: {
            progress: Math.min(percent, 95),
            currentStep: `Creating mailbox ${index + 1}/${generated.length} (test mode)`
          }
        });

        if ((index + 1) % 10 === 0 || index + 1 === generated.length) {
          console.log("✅ [Microsoft] Creating mailbox", index + 1, "of", generated.length);
        }
      }

      const csvBody = toCsv(rows);
      const folder = path.resolve(process.cwd(), ".data", "csv");
      await mkdir(folder, { recursive: true });
      const filename = `${tenant.tenantName.replace(/[^a-zA-Z0-9_-]/g, "_")}-test-${Date.now()}.csv`;
      const absolutePath = path.join(folder, filename);
      await writeFile(absolutePath, csvBody, "utf8");

      await prisma.tenant.update({
        where: { id: tenant.id },
        data: {
          csvUrl: absolutePath,
          progress: 100,
          status: "completed",
          currentStep: "Completed (test mode)",
          errorMessage: null,
          authCode: null,
          deviceCode: null,
          authCodeExpiry: null
        }
      });
      return;
    }

    const tenantIdentifier = tenant.tenantId || process.env.GRAPH_TENANT_ID || "common";
    console.log("🔄 [Microsoft] Getting token");
    const token = await requestGraphToken(tenantIdentifier);

    for (let index = 0; index < generated.length; index++) {
      const mailbox = generated[index];
      const password = mailbox.password || resolvedAdminPassword;
      console.log("✅ [Microsoft] Creating mailbox", index + 1, "of", generated.length);

      await createGraphUser(token, mailbox.displayName, mailbox.email, password);
      rows.push([mailbox.displayName, mailbox.email, password]);

      const percent = 70 + Math.round(((index + 1) / generated.length) * 25);
      await prisma.tenant.update({
        where: { id: tenant.id },
        data: {
          progress: Math.min(percent, 95),
          currentStep: `Mailbox ${index + 1}/${generated.length} provisioned`
        }
      });
    }

    const csvBody = toCsv(rows);
    const folder = path.resolve(process.cwd(), ".data", "csv");
    await mkdir(folder, { recursive: true });
    const filename = `${tenant.tenantName.replace(/[^a-zA-Z0-9_-]/g, "_")}-${Date.now()}.csv`;
    const absolutePath = path.join(folder, filename);
    await writeFile(absolutePath, csvBody, "utf8");

    await prisma.tenant.update({
      where: { id: tenant.id },
      data: {
        csvUrl: absolutePath,
        progress: 100,
        status: "completed",
        currentStep: "Mailbox provisioning complete",
        errorMessage: null,
        authCode: null,
        deviceCode: null,
        authCodeExpiry: null
      }
    });
  } catch (error) {
    await prisma.tenant.update({
      where: { id: tenantId },
      data: {
        status: "failed",
        errorMessage: error instanceof Error ? error.message : "Mailbox provisioning failed",
        currentStep: "Mailbox provisioning failed"
      }
    });
    throw error;
  }
}

async function getOrganizationIdFromToken(accessToken: string): Promise<string | null> {
  const org = await graphRequest<{ value: Array<{ id: string }> }>(accessToken, "/organization");
  return org.value?.[0]?.id || null;
}

export async function pollDeviceAuthToken(
  tenantId: string,
  deviceCode: string
): Promise<{ verified: boolean; organizationId: string | null }> {
  if (TEST_MODE) {
    console.log("🧪 TEST MODE: Skipping Microsoft Graph API call");
    return { verified: true, organizationId: `test-tenant-${Math.random().toString(36).slice(2, 11)}` };
  }

  const tenant = await prisma.tenant.findUnique({
    where: { id: tenantId },
    select: {
      tenantId: true,
      adminEmail: true
    }
  });

  if (!tenant) {
    throw new Error(`Tenant ${tenantId} not found`);
  }

  const { clientId } = assertGraphConfig();
  const tenantIdentifier = resolveTenantAuthority({
    adminEmail: tenant.adminEmail,
    tenantId: tenant.tenantId
  });

  const bodyParams = {
    grant_type: "urn:ietf:params:oauth:grant-type:device_code",
    client_id: clientId,
    device_code: deviceCode
  };

  const response = await fetch(`https://login.microsoftonline.com/${encodeURIComponent(tenantIdentifier)}/oauth2/v2.0/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(bodyParams)
  });

  const payload = (await response.json()) as { access_token?: string; error?: string; error_description?: string };

  if (response.ok && payload.access_token) {
    const organizationId = await getOrganizationIdFromToken(payload.access_token);
    await completeTenantPrep(tenantId, payload.access_token);
    return { verified: true, organizationId };
  }

  if (payload.error === "authorization_pending" || payload.error === "slow_down") {
    return { verified: false, organizationId: null };
  }

  throw new Error(payload.error_description || payload.error || "Device auth verification failed");
}
