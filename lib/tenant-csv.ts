import { readFile } from "fs/promises";
import path from "path";
import type { Prisma } from "@prisma/client";

type TenantCsvInput = {
  tenantName: string;
  domain: string;
  inboxCount: number;
  inboxNames: Prisma.JsonValue | string;
  csvUrl: string | null;
};

function parseInboxNamesValue(value: Prisma.JsonValue | string): string[] {
  if (Array.isArray(value)) {
    return value.map((item) => (typeof item === "string" ? item.trim() : "")).filter(Boolean);
  }
  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value);
      if (Array.isArray(parsed)) {
        return parsed.map((item) => (typeof item === "string" ? item.trim() : "")).filter(Boolean);
      }
    } catch {
      // fall through
    }
  }
  return [];
}

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

function generateFallbackCsv(tenant: TenantCsvInput): string {
  const names = parseInboxNamesValue(tenant.inboxNames);
  const safeNames = names.length > 0 ? names : ["Inbox User", "Ops User"];

  const rows: string[][] = [["DisplayName", "EmailAddress", "Password"]];

  for (let i = 0; i < tenant.inboxCount; i++) {
    const displayName = safeNames[i % safeNames.length];
    const [first = "user", last = "mail"] = displayName.split(/\s+/);
    const local = `${normalizeLocalPart(first)}.${normalizeLocalPart(last)}${i + 1}`;
    rows.push([displayName, `${local}@${tenant.domain}`, "TemporaryPass#123"]);
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
