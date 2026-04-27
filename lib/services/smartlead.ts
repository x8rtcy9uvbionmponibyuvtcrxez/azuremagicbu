/**
 * Thin Smartlead REST client. Right now we only need the delete-account
 * operation for the Services tab (Remove + Swap services). Other Smartlead
 * ops (account add, email warmup config, campaign mgmt) go through the
 * uploader's Selenium flow at uploader-service/app.py.
 *
 * Smartlead lookups are by numeric account ID — but operators provide
 * email addresses. So delete works in two steps: list-accounts → find
 * matching email → delete by ID.
 */

const SMARTLEAD_BASE = "https://server.smartlead.ai/api/v1";

type SmartleadAccount = {
  id: number;
  from_email: string;
  from_name?: string;
};

type ListResponse = {
  // Smartlead's list endpoint returns either an array directly or an envelope.
  // We probe both shapes to be safe across versions.
  data?: SmartleadAccount[];
  accounts?: SmartleadAccount[];
} | SmartleadAccount[];

async function smartleadRequest<T>(
  apiKey: string,
  path: string,
  init: { method?: string; body?: unknown } = {}
): Promise<{ ok: boolean; status: number; data: T | null; error?: string }> {
  // Smartlead expects api_key as a query parameter, not a header.
  const sep = path.includes("?") ? "&" : "?";
  const url = `${SMARTLEAD_BASE}${path}${sep}api_key=${encodeURIComponent(apiKey)}`;
  try {
    const resp = await fetch(url, {
      method: init.method || "GET",
      headers: { "Content-Type": "application/json" },
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
      const message =
        (parsed && typeof parsed === "object" && "message" in parsed
          ? String((parsed as { message: unknown }).message)
          : null) || `HTTP ${resp.status}`;
      return { ok: false, status: resp.status, data: null, error: message };
    }
    return { ok: true, status: resp.status, data: parsed as T };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { ok: false, status: 0, data: null, error: message };
  }
}

/**
 * Resolve an email to its Smartlead numeric account ID. Returns null if
 * not found — caller treats that as "already absent" for delete idempotency.
 */
export async function findSmartleadAccountIdByEmail(
  apiKey: string,
  email: string
): Promise<number | null> {
  // Smartlead's email-accounts list is paginated. We walk pages until we
  // find a match or run out. limit=100 is typical max per page.
  const target = email.toLowerCase().trim();
  for (let offset = 0; offset < 5000; offset += 100) {
    const result = await smartleadRequest<ListResponse>(
      apiKey,
      `/email-accounts/?offset=${offset}&limit=100`
    );
    if (!result.ok || !result.data) return null;
    const items: SmartleadAccount[] = Array.isArray(result.data)
      ? result.data
      : result.data.data || result.data.accounts || [];
    if (items.length === 0) return null;
    const hit = items.find((a) => (a.from_email || "").toLowerCase().trim() === target);
    if (hit) return hit.id;
    if (items.length < 100) return null; // last page
  }
  return null;
}

export async function deleteSmartleadAccount(
  apiKey: string,
  email: string
): Promise<{ ok: boolean; error?: string }> {
  const id = await findSmartleadAccountIdByEmail(apiKey, email);
  if (id === null) {
    // Account already absent — treat as success for idempotency.
    return { ok: true };
  }
  const result = await smartleadRequest<unknown>(apiKey, `/email-accounts/${id}`, {
    method: "DELETE",
  });
  if (result.ok) return { ok: true };
  return { ok: false, error: result.error };
}
