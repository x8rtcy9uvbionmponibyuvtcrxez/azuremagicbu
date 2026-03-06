import { createHash } from "crypto";
import { readFile } from "fs/promises";
import path from "path";
import type { Prisma } from "@prisma/client";

import { parseInboxNamesValue } from "@/lib/utils";

type TenantCsvInput = {
  tenantName: string;
  domain: string;
  inboxCount: number;
  inboxNames: Prisma.JsonValue | string;
  csvUrl: string | null;
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
  if (tenant.csvUrl) {
    try {
      return await fromCsvUrl(tenant.csvUrl);
    } catch {
      return generateFallbackCsv(tenant);
    }
  }

  return generateFallbackCsv(tenant);
}

export function tenantCsvFilename(tenantName: string, domain: string): string {
  const base = tenantName || domain || "tenant";
  return `${base.replace(/[^a-zA-Z0-9_-]/g, "_")}.csv`;
}
