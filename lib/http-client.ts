type JsonLike = Record<string, unknown> | Array<unknown>;

function compactWhitespace(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function stripHtml(value: string): string {
  return value.replace(/<[^>]+>/g, " ");
}

function preview(value: string, maxLength = 220): string {
  if (value.length <= maxLength) return value;
  return `${value.slice(0, maxLength)}...`;
}

export async function parseJsonResponse<T>(response: Response): Promise<T> {
  const raw = await response.text();
  const trimmed = raw.trim();

  if (!trimmed) {
    return {} as T;
  }

  try {
    return JSON.parse(trimmed) as T;
  } catch {
    const contentType = (response.headers.get("content-type") || "").toLowerCase();
    const looksLikeHtml =
      contentType.includes("text/html") ||
      trimmed.startsWith("<!DOCTYPE") ||
      trimmed.startsWith("<html") ||
      trimmed.startsWith("<");

    const normalized = looksLikeHtml ? compactWhitespace(stripHtml(trimmed)) : compactWhitespace(trimmed);
    const kind = looksLikeHtml ? "HTML" : "text";

    throw new Error(
      `Expected JSON but received ${kind} (HTTP ${response.status}). Preview: ${preview(normalized)}`
    );
  }
}

export function extractApiError(payload: unknown, fallback: string): string {
  if (!payload || typeof payload !== "object") return fallback;

  const maybePayload = payload as JsonLike & {
    error?: unknown;
    message?: unknown;
    details?: unknown;
  };

  const base =
    (typeof maybePayload.error === "string" && maybePayload.error) ||
    (typeof maybePayload.message === "string" && maybePayload.message) ||
    fallback;

  if (maybePayload.details == null) {
    return base;
  }

  if (typeof maybePayload.details === "string") {
    return `${base}: ${maybePayload.details}`;
  }

  try {
    return `${base}: ${JSON.stringify(maybePayload.details)}`;
  } catch {
    return base;
  }
}
