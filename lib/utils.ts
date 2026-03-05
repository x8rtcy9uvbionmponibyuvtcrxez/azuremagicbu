import { type ClassValue, clsx } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

function trimInboxToken(value: string): string {
  let next = value.trim();
  for (let i = 0; i < 4; i += 1) {
    const prev = next;
    next = next.replace(/^["'`]+|["'`]+$/g, "").trim();
    next = next.replace(/^\[+|\]+$/g, "").trim();
    next = next.replace(/^\\+|\\+$/g, "").trim();
    if (next === prev) break;
  }
  return next;
}

function collectInboxNames(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.flatMap((item) => collectInboxNames(item));
  }

  if (typeof value !== "string") {
    return [];
  }

  const trimmed = value.trim();
  if (!trimmed) return [];

  const maybeQuoted =
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'")) ||
    (trimmed.startsWith("`") && trimmed.endsWith("`"));
  if (maybeQuoted) {
    return collectInboxNames(trimmed.slice(1, -1));
  }

  try {
    const parsed = JSON.parse(trimmed) as unknown;
    if (parsed !== value) {
      return collectInboxNames(parsed);
    }
  } catch {
    // fall through to delimiter parsing
  }

  return trimmed
    .split(/\n|,/)
    .map((token) => trimInboxToken(token))
    .map((token) => token.replace(/\s+/g, " "))
    .filter(Boolean);
}

export function parseInboxNamesValue(value: unknown): string[] {
  const parsed = collectInboxNames(value);
  const deduped: string[] = [];
  const seen = new Set<string>();
  for (const name of parsed) {
    const key = name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(name);
  }
  return deduped;
}

export function serializeInboxNames(names: string[]): string {
  return JSON.stringify(names);
}
