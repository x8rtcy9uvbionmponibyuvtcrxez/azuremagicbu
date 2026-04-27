/**
 * Thin Instantly v2 API client. Centralizes the common operations the
 * Services tab needs: lookup an account, delete an account, update display
 * name. Other places (uploader-service/app.py, batch detail page) hit
 * Instantly via their own helpers — this file is for Node-side ops we run
 * from the worker / API routes.
 */

const INSTANTLY_BASE = "https://api.instantly.ai/api/v2";

type InstantlyAccount = {
  email: string;
  first_name?: string;
  last_name?: string;
  organization?: string;
  warmup_status?: number;
  status?: number;
  setup_pending?: boolean;
  daily_limit?: number;
  warmup?: { limit?: number };
};

type FetchInit = {
  method?: string;
  body?: unknown;
};

async function instantlyRequest<T>(
  apiKey: string,
  path: string,
  init: FetchInit = {}
): Promise<{ ok: boolean; status: number; data: T | null; error?: string }> {
  const url = `${INSTANTLY_BASE}${path}`;
  try {
    const resp = await fetch(url, {
      method: init.method || "GET",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
    });
    const text = await resp.text();
    let parsed: unknown = null;
    try {
      parsed = text ? JSON.parse(text) : null;
    } catch {
      parsed = { _raw: text.slice(0, 300) };
    }
    if (!resp.ok) {
      const errMsg =
        (parsed && typeof parsed === "object" && "message" in parsed
          ? String((parsed as { message: unknown }).message)
          : null) ||
        (parsed && typeof parsed === "object" && "error" in parsed
          ? String((parsed as { error: unknown }).error)
          : null) ||
        `HTTP ${resp.status}`;
      return { ok: false, status: resp.status, data: null, error: errMsg };
    }
    return { ok: true, status: resp.status, data: parsed as T };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { ok: false, status: 0, data: null, error: message };
  }
}

export async function getInstantlyAccount(
  apiKey: string,
  email: string
): Promise<InstantlyAccount | null> {
  const result = await instantlyRequest<InstantlyAccount>(
    apiKey,
    `/accounts/${encodeURIComponent(email)}`
  );
  if (!result.ok) return null;
  return result.data;
}

export async function deleteInstantlyAccount(
  apiKey: string,
  email: string
): Promise<{ ok: boolean; error?: string }> {
  // Instantly returns 200 on success and 404 if the account doesn't exist —
  // we treat 404 as success because the goal (account-not-present) is met.
  const result = await instantlyRequest<unknown>(
    apiKey,
    `/accounts/${encodeURIComponent(email)}`,
    { method: "DELETE" }
  );
  if (result.ok) return { ok: true };
  if (result.status === 404) return { ok: true };
  return { ok: false, error: result.error };
}

export async function updateInstantlyAccountName(
  apiKey: string,
  email: string,
  firstName: string,
  lastName: string
): Promise<{ ok: boolean; error?: string }> {
  // Note: Instantly's display name on outgoing emails is sometimes baked
  // into the OAuth token at first authorization. Updating first/last via
  // PATCH may not retroactively change what recipients see — the more
  // reliable path is delete + re-OAuth via the uploader. This helper is
  // kept around for cases where a quick metadata-only nudge is enough
  // (e.g. just to align the Instantly UI label with the M365 displayName).
  const result = await instantlyRequest<unknown>(
    apiKey,
    `/accounts/${encodeURIComponent(email)}`,
    {
      method: "PATCH",
      body: { first_name: firstName, last_name: lastName },
    }
  );
  if (result.ok) return { ok: true };
  return { ok: false, error: result.error };
}

/**
 * Split a display name into first/last — best-effort. "Kunal Goyal" → ("Kunal", "Goyal").
 * Single-word names get firstName=name, lastName="".
 */
export function splitDisplayName(displayName: string): { firstName: string; lastName: string } {
  const trimmed = displayName.trim();
  if (!trimmed) return { firstName: "", lastName: "" };
  const parts = trimmed.split(/\s+/);
  if (parts.length === 1) return { firstName: parts[0], lastName: "" };
  return { firstName: parts[0], lastName: parts.slice(1).join(" ") };
}
