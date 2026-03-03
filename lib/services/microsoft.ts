import { mkdir, writeFile } from "fs/promises";
import path from "path";

import { decryptSecret } from "@/lib/crypto";
import { prisma } from "@/lib/prisma";
import { generateEmailVariations } from "@/lib/services/email-generator";

const GRAPH_BASE_URL = "https://graph.microsoft.com/v1.0";
const TEST_MODE = process.env.TEST_MODE === "true";

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

function assertGraphConfig() {
  const clientId = process.env.GRAPH_CLIENT_ID;
  const clientSecret = process.env.GRAPH_CLIENT_SECRET;

  if (!clientId || !clientSecret) {
    throw new Error("Missing GRAPH_CLIENT_ID or GRAPH_CLIENT_SECRET");
  }

  return { clientId, clientSecret };
}

async function requestGraphToken(tenantIdentifier: string): Promise<string> {
  const { clientId, clientSecret } = assertGraphConfig();

  const response = await fetch(`https://login.microsoftonline.com/${encodeURIComponent(tenantIdentifier)}/oauth2/v2.0/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      scope: "https://graph.microsoft.com/.default",
      grant_type: "client_credentials"
    })
  });

  const payload = (await response.json()) as Partial<TokenResponse> & { error_description?: string };

  if (!response.ok || !payload.access_token) {
    throw new Error(payload.error_description || "Failed to fetch Graph token");
  }

  return payload.access_token;
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
        currentStep: "Requesting organization details"
      }
    });

    if (TEST_MODE) {
      console.log("🧪 TEST MODE: Skipping Microsoft Graph API call");
      await sleep(1000);
      await prisma.tenant.update({
        where: { id: tenant.id },
        data: {
          tenantId: `test-tenant-${Math.random().toString(36).slice(2, 11)}`,
          progress: 60,
          currentStep: "Tenant prep complete (test mode)"
        }
      });
      return;
    }

    const tenantIdentifier = tenant.tenantId || process.env.GRAPH_TENANT_ID || "common";
    console.log("🔄 [Microsoft] Getting token");
    const token = await requestGraphToken(tenantIdentifier);

    const org = await graphRequest<{ value: Array<{ id: string }> }>(token, "/organization");
    const orgId = org.value?.[0]?.id;

    if (!orgId) {
      throw new Error("No organization ID returned by Graph");
    }

    await prisma.tenant.update({
      where: { id: tenant.id },
      data: {
        tenantId: orgId,
        progress: 60,
        currentStep: "Tenant prep complete"
      }
    });
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

export async function initiateDeviceAuth(tenantId: string): Promise<void> {
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
        status: "auth_pending",
        progress: 65,
        currentStep: "Requesting device authentication code"
      }
    });

    if (TEST_MODE) {
      console.log("🧪 TEST MODE: Skipping Microsoft Graph API call");
      const fakeCode = `TEST-${Math.random().toString(36).slice(2, 8).toUpperCase()}`;
      const expiry = new Date(Date.now() + 15 * 60 * 1000);
      await prisma.tenant.update({
        where: { id: tenant.id },
        data: {
          authCode: fakeCode,
          authCodeExpiry: expiry,
          currentStep: `Enter code ${fakeCode} at https://microsoft.com/devicelogin (test mode)`
        }
      });
      return;
    }

    const { clientId } = assertGraphConfig();
    const tenantIdentifier = tenant.tenantId || process.env.GRAPH_TENANT_ID || "common";

    const response = await fetch(`https://login.microsoftonline.com/${encodeURIComponent(tenantIdentifier)}/oauth2/v2.0/devicecode`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: clientId,
        scope: "offline_access openid profile User.Read"
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
        authCode: payload.device_code,
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

export async function pollDeviceAuthToken(tenantId: string, deviceCode: string): Promise<boolean> {
  if (TEST_MODE) {
    console.log("🧪 TEST MODE: Skipping Microsoft Graph API call");
    return true;
  }

  const tenant = await prisma.tenant.findUnique({
    where: { id: tenantId },
    select: { tenantId: true }
  });

  if (!tenant) {
    throw new Error(`Tenant ${tenantId} not found`);
  }

  const { clientId } = assertGraphConfig();
  const tenantIdentifier = tenant.tenantId || process.env.GRAPH_TENANT_ID || "common";

  const response = await fetch(`https://login.microsoftonline.com/${encodeURIComponent(tenantIdentifier)}/oauth2/v2.0/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:device_code",
      client_id: clientId,
      device_code: deviceCode
    })
  });

  const payload = (await response.json()) as { access_token?: string; error?: string; error_description?: string };

  if (response.ok && payload.access_token) {
    return true;
  }

  if (payload.error === "authorization_pending" || payload.error === "slow_down") {
    return false;
  }

  throw new Error(payload.error_description || payload.error || "Device auth verification failed");
}
