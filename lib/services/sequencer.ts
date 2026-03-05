import { readFile } from "fs/promises";

import { decryptSecret } from "@/lib/crypto";
import { prisma } from "@/lib/prisma";
import { generateEmailVariations } from "@/lib/services/email-generator";
import { parseInboxNamesValue } from "@/lib/utils";

const SMARTLEAD_API_URL = "https://server.smartlead.ai/api/v1";
const SMARTLEAD_API_KEY = process.env.SMARTLEAD_API_KEY;

const INSTANTLY_API_URL = "https://api.instantly.ai/api/v2";
const INSTANTLY_API_KEY = process.env.INSTANTLY_API_KEY;

type MailboxCredential = {
  email: string;
  password: string;
  displayName: string;
};

type SequencerResult = {
  email: string;
  status: string;
  error?: string;
};

interface SmartleadAccountPayload {
  from_name: string;
  from_email: string;
  username: string;
  password: string;
  smtp_host: string;
  smtp_port: number;
  smtp_port_type: string;
  imap_host: string;
  imap_port: number;
  imap_port_type: string;
}

function parseCsvLine(line: string): string[] {
  const cells: string[] = [];
  let current = "";
  let inQuotes = false;

  for (let i = 0; i < line.length; i++) {
    const char = line[i];

    if (char === '"') {
      const nextChar = line[i + 1];
      if (inQuotes && nextChar === '"') {
        current += '"';
        i += 1;
      } else {
        inQuotes = !inQuotes;
      }
      continue;
    }

    if (char === "," && !inQuotes) {
      cells.push(current.trim());
      current = "";
      continue;
    }

    current += char;
  }

  cells.push(current.trim());
  return cells;
}

async function loadMailboxCredentials(tenantId: string): Promise<MailboxCredential[]> {
  const tenant = await prisma.tenant.findUniqueOrThrow({
    where: { id: tenantId },
    select: {
      csvUrl: true,
      inboxNames: true,
      domain: true,
      inboxCount: true,
      adminPassword: true
    }
  });

  if (tenant.csvUrl) {
    const content = await readFile(tenant.csvUrl, "utf8");
    const lines = content.split(/\r?\n/).filter((line) => line.trim().length > 0);
    if (lines.length > 1) {
      const rows = lines.slice(1).map(parseCsvLine);
      const parsed = rows
        .filter((row) => row.length >= 3)
        .map((row) => ({
          displayName: row[0],
          email: row[1],
          password: row[2]
        }))
        .filter((row) => row.email && row.password);

      if (parsed.length > 0) {
        return parsed;
      }
    }
  }

  const names = parseInboxNamesValue(tenant.inboxNames);

  const resolvedAdminPassword = (() => {
    try {
      return decryptSecret(tenant.adminPassword);
    } catch {
      return tenant.adminPassword || "";
    }
  })();

  return generateEmailVariations(names, tenant.domain, tenant.inboxCount).map((mailbox) => ({
    email: mailbox.email,
    password: mailbox.password || resolvedAdminPassword,
    displayName: mailbox.displayName
  }));
}

export async function connectToSmartlead(mailboxes: MailboxCredential[]): Promise<SequencerResult[]> {
  if (!SMARTLEAD_API_KEY) {
    throw new Error("Missing SMARTLEAD_API_KEY");
  }

  const results: SequencerResult[] = [];

  for (const mailbox of mailboxes) {
    try {
      const payload: SmartleadAccountPayload = {
        from_name: mailbox.displayName,
        from_email: mailbox.email,
        username: mailbox.email,
        password: mailbox.password,
        smtp_host: "smtp.office365.com",
        smtp_port: 587,
        smtp_port_type: "TLS",
        imap_host: "outlook.office365.com",
        imap_port: 993,
        imap_port_type: "SSL"
      };

      const response = await fetch(`${SMARTLEAD_API_URL}/email-accounts/?api_key=${SMARTLEAD_API_KEY}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload)
      });

      if (!response.ok) {
        const error = await response.text();
        results.push({ email: mailbox.email, status: "failed", error });
      } else {
        results.push({ email: mailbox.email, status: "connected" });
      }
    } catch (error) {
      results.push({
        email: mailbox.email,
        status: "failed",
        error: error instanceof Error ? error.message : String(error)
      });
    }

    await new Promise((resolve) => setTimeout(resolve, 1000));
  }

  return results;
}

export async function connectToInstantly(mailboxes: MailboxCredential[]): Promise<SequencerResult[]> {
  if (!INSTANTLY_API_KEY) {
    throw new Error("Missing INSTANTLY_API_KEY");
  }

  const results: SequencerResult[] = [];

  for (const mailbox of mailboxes) {
    try {
      const nameParts = mailbox.displayName.split(" ");
      const payload = {
        email: mailbox.email,
        first_name: nameParts[0] || mailbox.displayName,
        last_name: nameParts.slice(1).join(" ") || "",
        provider_code: "microsoft",
        imap_username: mailbox.email,
        imap_password: mailbox.password,
        imap_host: "outlook.office365.com",
        imap_port: 993,
        smtp_username: mailbox.email,
        smtp_password: mailbox.password,
        smtp_host: "smtp.office365.com",
        smtp_port: 587
      };

      const response = await fetch(`${INSTANTLY_API_URL}/accounts`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${INSTANTLY_API_KEY}`
        },
        body: JSON.stringify(payload)
      });

      if (!response.ok) {
        const error = await response.text();
        results.push({ email: mailbox.email, status: "failed", error });
      } else {
        results.push({ email: mailbox.email, status: "connected" });
      }
    } catch (error) {
      results.push({
        email: mailbox.email,
        status: "failed",
        error: error instanceof Error ? error.message : String(error)
      });
    }

    await new Promise((resolve) => setTimeout(resolve, 1000));
  }

  return results;
}

export async function connectMailboxesToSequencer(
  tenantDbId: string,
  sequencer: "smartlead" | "instantly"
): Promise<void> {
  const tenant = await prisma.tenant.findUniqueOrThrow({
    where: { id: tenantDbId },
    select: {
      id: true,
      adminPassword: true
    }
  });

  const fallbackPassword = (() => {
    try {
      return decryptSecret(tenant.adminPassword);
    } catch {
      return tenant.adminPassword;
    }
  })();

  const mailboxData = (await loadMailboxCredentials(tenantDbId)).map((mailbox) => ({
    email: mailbox.email,
    password: mailbox.password || fallbackPassword,
    displayName: mailbox.displayName || mailbox.email.split("@")[0]
  }));

  await prisma.tenant.update({
    where: { id: tenantDbId },
    data: {
      status: "sequencer_connect",
      currentStep: `Connecting to ${sequencer}...`,
      progress: 99
    }
  });

  const results = sequencer === "smartlead"
    ? await connectToSmartlead(mailboxData)
    : await connectToInstantly(mailboxData);

  const connected = results.filter((result) => result.status === "connected").length;
  const failed = results.filter((result) => result.status === "failed").length;
  const allConnected = failed === 0 && (connected > 0 || results.length === 0);
  console.log(`✅ [${sequencer}] Connected: ${connected}, Failed: ${failed}`);

  if (sequencer === "smartlead") {
    await prisma.tenant.update({
      where: { id: tenantDbId },
      data: {
        smartleadConnected: allConnected,
        smartleadConnectedCount: connected,
        smartleadFailedCount: failed,
        currentStep: `${sequencer}: ${connected} connected, ${failed} failed`
      }
    });
    if (failed > 0) {
      throw new Error(`Smartlead connection failed for ${failed} mailbox(es).`);
    }
    return;
  }

  await prisma.tenant.update({
    where: { id: tenantDbId },
    data: {
      instantlyConnected: allConnected,
      instantlyConnectedCount: connected,
      instantlyFailedCount: failed,
      currentStep: `${sequencer}: ${connected} connected, ${failed} failed`
    }
  });
  if (failed > 0) {
    throw new Error(`Instantly connection failed for ${failed} mailbox(es).`);
  }
}
