import { mkdir, writeFile } from "fs/promises";
import path from "path";

import { decryptSecret } from "@/lib/crypto";
import { prisma } from "@/lib/prisma";
import { generateEmailVariations } from "@/lib/services/email-generator";

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

function isDomainAlreadyExistsError(message: string): boolean {
  const normalized = message.toLowerCase();
  return (
    normalized.includes("already exists") ||
    normalized.includes("already added") ||
    normalized.includes("already been added") ||
    normalized.includes("object reference already exists")
  );
}

async function callPowerShellService(endpoint: string, body: any, timeout = 1200000): Promise<any> {
  const maxRetries = 3;
  const baseDelay = 5000;

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      console.log(`📡 [PowerShell] Calling ${endpoint} (attempt ${attempt}/${maxRetries})...`);
      const startTime = Date.now();

      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), timeout);

      const response = await fetch(`http://localhost:3099${endpoint}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal: controller.signal
      });

      clearTimeout(timeoutId);

      const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);

      const data = await response.json();

      if (!response.ok) {
        console.log(`❌ [PowerShell] ${endpoint} failed after ${elapsed}s: ${data.error}`);
        throw new Error(`PowerShell service error: ${data.error || JSON.stringify(data)}`);
      }

      console.log(`✅ [PowerShell] ${endpoint} completed in ${elapsed}s`);
      return data;
    } catch (error: any) {
      const msg = error.message || "";
      const isTransient =
        msg.includes("fetch failed") ||
        msg.includes("ECONNREFUSED") ||
        msg.includes("ETIMEDOUT") ||
        msg.includes("socket hang up") ||
        msg.includes("aborted") ||
        msg.includes("network") ||
        error.name === "AbortError";

      if (isTransient && attempt < maxRetries) {
        const delay = baseDelay * Math.pow(2, attempt - 1);
        console.log(`⚠️ [PowerShell] Attempt ${attempt}/${maxRetries} failed (${msg}). Waiting ${delay / 1000}s before retry...`);
        await new Promise((resolve) => setTimeout(resolve, delay));
        continue;
      }

      if (attempt === maxRetries && isTransient) {
        throw new Error(`PowerShell service unreachable after ${maxRetries} attempts. Is the service running on port 3099?`);
      }

      throw error;
    }
  }

  throw new Error("PowerShell service failed after maximum retries");
}

async function waitForPowerShellService(maxWaitMs = 30000): Promise<void> {
  const startTime = Date.now();
  while (Date.now() - startTime < maxWaitMs) {
    try {
      const response = await fetch("http://localhost:3099/health", {
        signal: AbortSignal.timeout(3000)
      });
      if (response.ok) return;
    } catch {}
    console.log("⏳ [PowerShell] Service not ready, waiting 3s...");
    await new Promise((resolve) => setTimeout(resolve, 3000));
  }
  throw new Error("PowerShell service not available after 30s. Please ensure it is running.");
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

      let globalAdminRoleId: string | null = null;

      const roles = await graphRequest<{ value: Array<{ id: string; displayName: string }> }>(accessToken, "/directoryRoles");
      const gaRole = roles.value?.find((role) => role.displayName === "Global Administrator");

      if (gaRole) {
        globalAdminRoleId = gaRole.id;
      } else {
        console.log("ℹ️ [Microsoft] Global Admin role not activated, activating from template...");
        const templates = await graphRequest<{ value: Array<{ id: string; displayName: string }> }>(
          accessToken,
          "/directoryRoleTemplates"
        );
        const gaTemplate = templates.value?.find((template) => template.displayName === "Global Administrator");

        if (gaTemplate) {
          const activated = await graphRequest<{ id: string }>(accessToken, "/directoryRoles", {
            method: "POST",
            body: JSON.stringify({ roleTemplateId: gaTemplate.id })
          });
          globalAdminRoleId = activated.id;
          console.log("✅ [Microsoft] Global Admin role activated:", globalAdminRoleId);
        }
      }

      if (globalAdminRoleId) {
        try {
          await graphRequest<Record<string, unknown>>(accessToken, `/directoryRoles/${globalAdminRoleId}/members/$ref`, {
            method: "POST",
            body: JSON.stringify({
              "@odata.id": `https://graph.microsoft.com/v1.0/servicePrincipals/${servicePrincipalId}`
            })
          });
          console.log("✅ [Microsoft] Global Admin role assigned to service principal");

          await prisma.tenant.update({
            where: { id: tenantId },
            data: { globalAdminAssigned: true }
          });
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          if (message.includes("already exist") || message.includes("added already")) {
            console.log("ℹ️ [Microsoft] SP already has Global Admin role");
            await prisma.tenant.update({
              where: { id: tenantId },
              data: { globalAdminAssigned: true }
            });
          } else {
            console.log("⚠️ [Microsoft] Could not assign Global Admin:", message);
          }
        }
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

  const dnsRecords = await graphRequest<{
    value: Array<{
      recordType: string;
      label: string;
      text: string;
      supportedService: string;
    }>;
  }>(accessToken, `/domains/${encodeURIComponent(domain)}/verificationDnsRecords`);

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

  try {
    await graphRequest<Record<string, unknown>>(accessToken, `/domains/${encodeURIComponent(domain)}`, {
      method: "PATCH",
      body: JSON.stringify({ isDefault: true })
    });

    console.log(`✅ [Microsoft] Domain ${domain} set as default`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message.toLowerCase().includes("already")) {
      console.log(`ℹ️ [Microsoft] Domain ${domain} is already default (or already updated), skipping`);
    } else {
      throw error;
    }
  }

  await prisma.tenant.update({
    where: { id: tenantDbId },
    data: { domainDefault: true }
  });
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

  const extractedNames: string[] = [];
  const rawInboxNames = tenant?.inboxNames;

  if (Array.isArray(rawInboxNames)) {
    for (const entry of rawInboxNames) {
      if (typeof entry === "string") {
        extractedNames.push(
          ...entry
            .split(",")
            .map((value) => value.trim())
            .filter(Boolean)
        );
      }
    }
  } else if (typeof rawInboxNames === "string") {
    extractedNames.push(
      ...rawInboxNames
        .split(",")
        .map((value) => value.trim())
        .filter(Boolean)
    );
  }

  const fallbackLocalPart = adminEmail.split("@")[0].replace(/[^a-zA-Z0-9]/g, "").toLowerCase() || "admin";
  const firstInboxName = extractedNames[0] || fallbackLocalPart;
  const [firstName = fallbackLocalPart, ...rest] = firstInboxName.split(/\s+/).filter(Boolean);
  const lastName = rest.join(" ");
  const displayName = [firstName, lastName].filter(Boolean).join(" ");
  const mailNickname = firstName.toLowerCase().replace(/[^a-zA-Z0-9]/g, "") || fallbackLocalPart;
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

  await prisma.tenant.update({
    where: { id: tenantDbId },
    data: { currentStep: "Assigning Exchange Online license...", progress: 85 }
  });

  const skus = await graphRequest<{
    value: Array<{
      skuId: string;
      skuPartNumber: string;
      prepaidUnits: { enabled: number };
      consumedUnits: number;
    }>;
  }>(accessToken, "/subscribedSkus");

  const exchangeSkuNames = [
    "EXCHANGESTANDARD",
    "EXCHANGEENTERPRISE",
    "EXCHANGE_S_STANDARD",
    "O365_BUSINESS_ESSENTIALS",
    "O365_BUSINESS_PREMIUM",
    "SMB_BUSINESS_ESSENTIALS"
  ];

  let targetSku = skus.value?.find((sku) =>
    exchangeSkuNames.some((name) => sku.skuPartNumber?.toUpperCase().includes(name))
  );

  if (!targetSku) {
    targetSku = skus.value?.find((sku) => sku.prepaidUnits?.enabled > sku.consumedUnits);
  }

  if (!targetSku) {
    console.log("⚠️ [Microsoft] No available Exchange Online SKU found. License needs manual assignment.");
  } else {
    try {
      await graphRequest<Record<string, unknown>>(accessToken, `/users/${userId}/assignLicense`, {
        method: "POST",
        body: JSON.stringify({
          addLicenses: [{ skuId: targetSku.skuId }],
          removeLicenses: []
        })
      });
      console.log(`✅ [Microsoft] License ${targetSku.skuPartNumber} assigned to user`);
    } catch (error) {
      console.log("⚠️ [Microsoft] License assignment failed:", error instanceof Error ? error.message : String(error));
    }
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

  const resolvedAdminPassword = (() => {
    try {
      return decryptSecret(adminPassword);
    } catch {
      return adminPassword;
    }
  })();

  const accessToken = await requestTenantGraphToken(organizationId);

  if (!tenant.domainAdded) {
    try {
      await addDomainToTenant(tenantDbId, domain, accessToken);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (isDomainAlreadyExistsError(message)) {
        console.log(`ℹ️ [Microsoft] Domain ${domain} already exists in tenant, continuing`);
        await prisma.tenant.update({
          where: { id: tenantDbId },
          data: { domainAdded: true }
        });
      } else {
        throw error;
      }
    }
  }

  if (!tenant.domainVerified) {
    await verifyDomainWithDns(tenantDbId, domain, zoneId, accessToken);
  }

  if (!tenant.domainDefault) {
    await setDomainAsDefault(tenantDbId, domain, accessToken);
  }

  if (!tenant.licensedUserId) {
    await createLicensedUser(tenantDbId, domain, adminEmail, resolvedAdminPassword, accessToken);
  }
}

export async function setupSharedMailboxes(tenantDbId: string): Promise<void> {
  await waitForPowerShellService();

  const tenant = await prisma.tenant.findUniqueOrThrow({
    where: { id: tenantDbId },
    include: { batch: true }
  });

  const domain = tenant.domain;
  const organizationId = tenant.tenantId;
  const adminEmail = tenant.adminEmail;
  const adminPassword = tenant.adminPassword;
  const licensedUserUpn = tenant.licensedUserUpn;

  if (!domain || !organizationId || !adminEmail || !adminPassword) {
    throw new Error("Missing tenant data for mailbox setup");
  }

  const names = Array.isArray(tenant.inboxNames)
    ? tenant.inboxNames.filter((value): value is string => typeof value === "string")
    : [];

  const mailboxData = generateEmailVariations(names, domain, tenant.inboxCount).map((mailbox) => ({
    email: mailbox.email,
    displayName: mailbox.displayName || mailbox.email.split("@")[0],
    password: mailbox.password
  }));

  if (mailboxData.length === 0) {
    console.log("ℹ️ [Microsoft] No new mailboxes to create");
    return;
  }

  const resolvedAdminPassword = (() => {
    try {
      return decryptSecret(adminPassword);
    } catch {
      return adminPassword;
    }
  })();

  const accessToken = await requestTenantGraphToken(organizationId);
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

  if (!tenant.sharedMailboxesCreated) {
    await prisma.tenant.update({
      where: { id: tenantDbId },
      data: { currentStep: "Creating shared mailboxes...", progress: 60, status: "mailboxes" }
    });

    const createResult = await callPowerShellService("/create-shared-mailboxes", {
      adminUpn: adminEmail,
      adminPassword: resolvedAdminPassword,
      organizationId,
      mailboxes: mailboxData
    });

    type MailboxCreateStatus = {
      email?: string;
      status?: string;
      error?: string | null;
    };

    const resultArray: MailboxCreateStatus[] = Array.isArray(
      (createResult as { results?: unknown })?.results
    )
      ? ((createResult as { results: MailboxCreateStatus[] }).results || [])
      : [];
    const created = resultArray.filter((result) => result.status === "created" || result.status === "exists").length;
    const failed = resultArray.filter((result) => result.status === "failed").length;
    console.log(`✅ [Microsoft] Shared mailboxes: ${created} created/existing, ${failed} failed out of ${mailboxData.length}`);

    if (failed > 0) {
      const failedEmails = resultArray
        .filter((result) => result.status === "failed")
        .map((result) => `${result.email}: ${result.error}`);
      console.log("⚠️ [Microsoft] Failed mailboxes:", failedEmails.join("; "));
    }

    if (created === 0 && mailboxData.length > 0) {
      throw new Error(`All ${mailboxData.length} mailbox creations failed. First error: ${resultArray[0]?.error || "unknown"}`);
    }

    console.log("⏳ [Microsoft] Cooling down 5s before password setting...");
    await new Promise((resolve) => setTimeout(resolve, 5000));

    await prisma.tenant.update({
      where: { id: tenantDbId },
      data: { sharedMailboxesCreated: true }
    });
  }

  await prisma.tenant.update({
    where: { id: tenantDbId },
    data: { currentStep: "Updating email addresses...", progress: 70 }
  });

  for (const mailbox of mailboxData) {
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

  if (!tenant.passwordsSet) {
    await prisma.tenant.update({
      where: { id: tenantDbId },
      data: { currentStep: "Setting mailbox passwords...", progress: 75 }
    });

    for (const mailbox of mailboxData) {
      try {
        const userId = await resolveUserId(mailbox.email);
        if (!userId) continue;

        await graphRequest<Record<string, unknown>>(accessToken, `/users/${userId}`, {
          method: "PATCH",
          body: JSON.stringify({
            passwordProfile: {
              forceChangePasswordNextSignIn: false,
              password: mailbox.password || resolvedAdminPassword
            }
          })
        });
      } catch (error) {
        console.log(
          `⚠️ [Graph] Failed to set password for ${mailbox.email}:`,
          error instanceof Error ? error.message : String(error)
        );
      }
    }

    await prisma.tenant.update({
      where: { id: tenantDbId },
      data: { passwordsSet: true }
    });
  }

  if (!tenant.smtpAuthEnabled) {
    await prisma.tenant.update({
      where: { id: tenantDbId },
      data: { currentStep: "Enabling SMTP auth...", progress: 80, status: "mailbox_config" }
    });

    await callPowerShellService("/enable-smtp-auth", {
      adminUpn: adminEmail,
      adminPassword: resolvedAdminPassword,
      organizationId,
      emails: mailboxData.map((mailbox) => mailbox.email)
    });

    console.log("⏳ [Microsoft] Cooling down 5s before delegation...");
    await new Promise((resolve) => setTimeout(resolve, 5000));

    await prisma.tenant.update({
      where: { id: tenantDbId },
      data: { smtpAuthEnabled: true }
    });
  }

  if (!tenant.delegationComplete) {
    await prisma.tenant.update({
      where: { id: tenantDbId },
      data: { currentStep: "Setting mailbox delegation...", progress: 85 }
    });

    await callPowerShellService("/set-delegation", {
      adminUpn: adminEmail,
      adminPassword: resolvedAdminPassword,
      licensedUserUpn: licensedUserUpn || `admin@${tenant.domain}`,
      emails: mailboxData.map((mailbox) => mailbox.email)
    });

    await prisma.tenant.update({
      where: { id: tenantDbId },
      data: { delegationComplete: true }
    });
  }

  if (!tenant.signInEnabled) {
    await prisma.tenant.update({
      where: { id: tenantDbId },
      data: { currentStep: "Enabling sign-in...", progress: 90 }
    });

    for (const mailbox of mailboxData) {
      try {
        const userId = await resolveUserId(mailbox.email);
        if (!userId) continue;

        await graphRequest<Record<string, unknown>>(accessToken, `/users/${userId}`, {
          method: "PATCH",
          body: JSON.stringify({ accountEnabled: true })
        });
      } catch (error) {
        console.log(`⚠️ [Graph] Failed to enable sign-in for ${mailbox.email}:`, error instanceof Error ? error.message : String(error));
      }
    }

    await prisma.tenant.update({
      where: { id: tenantDbId },
      data: { signInEnabled: true }
    });
  }

  if (!tenant.cloudAppAdminAssigned) {
    await prisma.tenant.update({
      where: { id: tenantDbId },
      data: { currentStep: "Assigning Cloud App Admin role...", progress: 95 }
    });

    const cloudAppAdminTemplateId = "158c047a-c907-4556-b7ef-446551a6b5f7";

    for (const mailbox of mailboxData) {
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
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (!message.includes("already exists")) {
          console.log(`⚠️ [Graph] Failed to assign Cloud App Admin to ${mailbox.email}: ${message}`);
        }
      }
    }

    await prisma.tenant.update({
      where: { id: tenantDbId },
      data: { cloudAppAdminAssigned: true }
    });
  }

  const csvRows: string[][] = [["DisplayName", "EmailAddress", "Password"]];
  for (const mailbox of mailboxData) {
    csvRows.push([mailbox.displayName, mailbox.email, mailbox.password || resolvedAdminPassword]);
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

  console.log(`✅ [Microsoft] Phase 3 complete for ${domain} — ${mailboxData.length} shared mailboxes ready`);
}

export async function configureDkim(tenantDbId: string): Promise<void> {
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

  await sleep(30000);

  await callPowerShellService("/enable-dkim", {
    adminUpn,
    adminPassword: resolvedAdminPassword,
    domain
  });

  await prisma.tenant.update({
    where: { id: tenantDbId },
    data: {
      dkimConfigured: true,
      currentStep: "DKIM configured",
      progress: 98
    }
  });

  console.log(`✅ [DKIM] Enabled for ${domain}`);
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
    void decryptSecret(tenant.adminPassword);

    const names = Array.isArray(tenant.inboxNames)
      ? tenant.inboxNames.filter((value): value is string => typeof value === "string")
      : [];

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
      const password = mailbox.password;
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

  console.log("🔍 [Debug] Token exchange params:");
  console.log("- Client ID:", clientId);
  console.log("- Tenant domain:", tenantIdentifier);
  console.log("- Device code length:", deviceCode?.length ?? 0);
  console.log("🔍 [Debug] URLSearchParams keys:", Object.keys(bodyParams));

  const response = await fetch(`https://login.microsoftonline.com/${encodeURIComponent(tenantIdentifier)}/oauth2/v2.0/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(bodyParams)
  });

  const payload = (await response.json()) as { access_token?: string; error?: string; error_description?: string };
  console.log("🔍 [Debug] Token endpoint response:", response.status, payload.error || "ok");
  if (payload.error_description) {
    console.log("🔍 [Debug] Token error description:", payload.error_description);
  }

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
