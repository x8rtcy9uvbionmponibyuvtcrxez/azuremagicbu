import { createHash } from "crypto";
import { readFile } from "fs/promises";
import path from "path";
import type { Prisma } from "@prisma/client";

import { decryptSecret } from "@/lib/crypto";
import { parseInboxNamesValue } from "@/lib/utils";

type TenantCsvInput = {
  tenantName: string;
  domain: string;
  inboxCount: number;
  inboxNames: Prisma.JsonValue | string;
  csvUrl: string | null;
  // Fields below are optional so callers that don't need DB-backed CSV
  // reconstruction can still pass the minimum. When all three are present,
  // we reconstruct the CSV from actual provisioned state instead of regenerating
  // from a naive pattern that won't match what's in Microsoft.
  licensedUserUpn?: string | null;
  adminPassword?: string | null;
  mailboxStatuses?: string | null;
};

function normalizeLocalPart(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]/g, "");
}

function escapeCsv(value: string): string {
  if (value.includes(",") || value.includes('"') || value.includes("\n")) {
    return `"${value.replace(/"/g, '""')}"`;
  }
  return value;
}

function rowsToCsv(rows: string[][]): string {
  return rows.map((row) => row.map((col) => escapeCsv(col)).join(",")).join("\n");
}

function buildDeterministicPassword(seed: string, length = 16): string {
  const bytes = createHash("sha256").update(seed).digest();
  const uppercase = "ABCDEFGHJKLMNPQRSTUVWXYZ";
  const lowercase = "abcdefghijkmnopqrstuvwxyz";
  const numbers = "23456789";
  const symbols = "!@#$%&*_+-=?";
  const alphanumeric = uppercase + lowercase + numbers;
  const all = alphanumeric + symbols;

  const chars: string[] = [
    uppercase[bytes[0] % uppercase.length],
    lowercase[bytes[1] % lowercase.length],
    numbers[bytes[2] % numbers.length],
    symbols[bytes[3] % symbols.length]
  ];

  while (chars.length < length) {
    const index = chars.length % bytes.length;
    chars.push(all[bytes[index] % all.length]);
  }

  for (let i = chars.length - 1; i > 0; i -= 1) {
    const j = bytes[(i + 7) % bytes.length] % (i + 1);
    [chars[i], chars[j]] = [chars[j], chars[i]];
  }

  if (/[^A-Za-z0-9]/.test(chars[0])) {
    const swapIndex = chars.findIndex((char, index) => index > 0 && /[A-Za-z0-9]/.test(char));
    if (swapIndex > 0) {
      [chars[0], chars[swapIndex]] = [chars[swapIndex], chars[0]];
    }
  }

  return chars.join("");
}

function generateFallbackCsv(tenant: TenantCsvInput): string {
  const names = parseInboxNamesValue(tenant.inboxNames);
  const safeNames = names.length > 0 ? names : ["Inbox User", "Ops User"];

  const rows: string[][] = [["DisplayName", "EmailAddress", "Password"]];

  for (let i = 0; i < tenant.inboxCount; i++) {
    const displayName = safeNames[i % safeNames.length];
    const [first = "user", last = "mail"] = displayName.split(/\s+/);
    const local = `${normalizeLocalPart(first)}.${normalizeLocalPart(last)}${i + 1}`;
    const password = buildDeterministicPassword(`${tenant.tenantName}:${tenant.domain}:${local}:${i + 1}`);
    rows.push([displayName, `${local}@${tenant.domain}`, password]);
  }

  return rowsToCsv(rows);
}

/**
 * Reconstruct the tenant CSV from the actual provisioning state in the database.
 *
 * This is the source of truth: mailboxStatuses holds the set of mailboxes the
 * worker actually created (keyed by the real email address, e.g. "kgoyal@...",
 * "k.goyal@...", "kunagoy@..." — the permutations produced by the email generator).
 * All shared mailboxes share the admin password (set via Graph PATCH in the
 * worker's mailbox phase), and the licensed user uses the same password too.
 *
 * Returns null if we don't have enough state to reconstruct — caller falls back
 * to csvUrl file or the naive generator.
 */
function generateCsvFromDbState(tenant: TenantCsvInput): string | null {
  if (!tenant.mailboxStatuses || !tenant.adminPassword) {
    return null;
  }

  let parsed: Record<string, { created?: boolean }>;
  try {
    parsed = JSON.parse(tenant.mailboxStatuses);
  } catch {
    return null;
  }

  if (!parsed || typeof parsed !== "object") {
    return null;
  }

  const createdEmails = Object.entries(parsed)
    .filter(([, status]) => status?.created === true)
    .map(([email]) => email.trim().toLowerCase())
    .filter(Boolean);

  // We need at least some provisioned mailboxes to produce a useful CSV.
  if (createdEmails.length === 0 && !tenant.licensedUserUpn) {
    return null;
  }

  let password: string;
  try {
    password = decryptSecret(tenant.adminPassword);
  } catch {
    return null;
  }

  const names = parseInboxNamesValue(tenant.inboxNames);
  const displayName = names[0] || "Inbox User";

  const licensedLower = (tenant.licensedUserUpn || "").trim().toLowerCase();
  const seen = new Set<string>();
  const rows: string[][] = [["DisplayName", "EmailAddress", "Password"]];

  // Licensed user first (she has a real mailbox backed by the single license).
  if (licensedLower) {
    rows.push([displayName, licensedLower, password]);
    seen.add(licensedLower);
  }

  // Then each shared mailbox that was actually created, deduped.
  for (const email of createdEmails) {
    if (seen.has(email)) continue;
    rows.push([displayName, email, password]);
    seen.add(email);
  }

  return rowsToCsv(rows);
}

async function fromCsvUrl(csvUrl: string): Promise<string> {
  if (/^https?:\/\//i.test(csvUrl)) {
    const response = await fetch(csvUrl);
    if (!response.ok) {
      throw new Error(`Unable to download remote CSV (${response.status})`);
    }
    return await response.text();
  }

  const resolvedPath = path.isAbsolute(csvUrl) ? csvUrl : path.resolve(process.cwd(), csvUrl);
  return await readFile(resolvedPath, "utf8");
}

export async function getTenantCsvContent(tenant: TenantCsvInput): Promise<string> {
  // Preferred source: actual provisioning state stored in the database.
  // This survives Railway redeploys (unlike csvUrl which points to ephemeral
  // filesystem) and always matches what's actually in the Microsoft tenant.
  const fromDb = generateCsvFromDbState(tenant);
  if (fromDb) return fromDb;

  // Secondary: a CSV file written to disk during provisioning. On Railway's
  // ephemeral filesystem this is wiped on every deploy, but try anyway.
  if (tenant.csvUrl) {
    try {
      return await fromCsvUrl(tenant.csvUrl);
    } catch {
      // fall through to fallback
    }
  }

  // Last resort: regenerate from the naive pattern. Will NOT match the
  // permutation-style emails actually created — use only when there's no
  // provisioning state at all (e.g. tenant never reached the mailbox phase).
  return generateFallbackCsv(tenant);
}

export function tenantCsvFilename(tenantName: string, clientName: string, domain: string): string {
  const parts = [tenantName, clientName, domain].filter(Boolean);
  const base = parts.length > 0 ? parts.join(" - ") : "tenant";
  return `${base.replace(/[^a-zA-Z0-9._-\s]/g, "")}.csv`;
}
