import { prisma } from "@/lib/prisma";

type CloudflareRecord = {
  type: "TXT" | "MX" | "CNAME" | "A";
  name: string;
  content: string;
  ttl?: number;
  proxied?: boolean;
  priority?: number;
};

type CloudflareApiResponse<T> = {
  success: boolean;
  errors: Array<{ code: number; message: string }>;
  result: T;
};

const CLOUDFLARE_API_BASE = "https://api.cloudflare.com/client/v4";
const TEST_MODE = process.env.TEST_MODE === "true";

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function buildHeaders() {
  const apiKey = process.env.CLOUDFLARE_API_KEY;
  const email = process.env.CLOUDFLARE_EMAIL;

  if (!apiKey || !email) {
    throw new Error("Missing CLOUDFLARE_API_KEY or CLOUDFLARE_EMAIL");
  }

  return {
    "Content-Type": "application/json",
    "X-Auth-Key": apiKey,
    "X-Auth-Email": email
  };
}

async function requestCloudflare<T>(path: string, init: RequestInit): Promise<T> {
  const response = await fetch(`${CLOUDFLARE_API_BASE}${path}`, init);
  const payload = (await response.json()) as CloudflareApiResponse<T>;

  if (!response.ok || !payload.success) {
    const reason = payload.errors?.map((error) => error.message).join(", ") || `HTTP ${response.status}`;
    throw new Error(`Cloudflare API failed: ${reason}`);
  }

  return payload.result;
}

function domainToMxTarget(domain: string): string {
  return `${domain.replace(/\./g, "-")}.mail.protection.outlook.com`;
}

async function upsertZone(domain: string, headers: Record<string, string>) {
  try {
    return await requestCloudflare<{ id: string; name_servers: string[] }>("/zones", {
      method: "POST",
      headers,
      body: JSON.stringify({
        name: domain,
        type: "full"
      })
    });
  } catch {
    const existing = await requestCloudflare<Array<{ id: string; name_servers: string[] }>>(
      `/zones?name=${encodeURIComponent(domain)}`,
      {
        method: "GET",
        headers
      }
    );

    if (!existing[0]) {
      throw new Error(`Unable to create or locate zone for ${domain}`);
    }

    return existing[0];
  }
}

async function clearDnsRecords(zoneId: string, headers: Record<string, string>) {
  const records = await requestCloudflare<Array<{ id: string }>>(`/zones/${zoneId}/dns_records?per_page=500`, {
    method: "GET",
    headers
  });

  for (const record of records) {
    await requestCloudflare<{ id: string }>(`/zones/${zoneId}/dns_records/${record.id}`, {
      method: "DELETE",
      headers
    });
  }
}

async function createDnsRecords(zoneId: string, domain: string, headers: Record<string, string>) {
  const records: CloudflareRecord[] = [
    { type: "TXT", name: "@", content: "v=spf1 include:spf.protection.outlook.com -all" },
    { type: "TXT", name: "_dmarc", content: "v=DMARC1; p=none;" },
    { type: "MX", name: "@", content: domainToMxTarget(domain), priority: 0 },
    { type: "CNAME", name: "autodiscover", content: "autodiscover.outlook.com" },
    { type: "A", name: "@", content: "44.227.65.245", proxied: true },
    { type: "A", name: "www", content: "44.227.65.245", proxied: true }
  ];

  for (const record of records) {
    await requestCloudflare<{ id: string }>(`/zones/${zoneId}/dns_records`, {
      method: "POST",
      headers,
      body: JSON.stringify(record)
    });
  }
}

async function createForwardingRule(zoneId: string, domain: string, forwardingUrl: string, headers: Record<string, string>) {
  await requestCloudflare<{ id: string }>(`/zones/${zoneId}/rulesets`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      name: `Forward ${domain}`,
      kind: "zone",
      phase: "http_request_dynamic_redirect",
      rules: [
        {
          expression: `(http.host eq \"${domain}\") or (http.host eq \"www.${domain}\")`,
          description: "Redirect root + www",
          enabled: true,
          action: "redirect",
          action_parameters: {
            from_value: {
              status_code: 301,
              target_url: {
                value: forwardingUrl
              }
            }
          }
        }
      ]
    })
  });
}

export async function setupCloudflare(tenantId: string): Promise<void> {
  try {
    const tenant = await prisma.tenant.findUnique({
      where: { id: tenantId },
      select: {
        id: true,
        domain: true,
        forwardingUrl: true,
        status: true
      }
    });

    if (!tenant) {
      throw new Error(`Tenant ${tenantId} not found`);
    }

    await prisma.tenant.update({
      where: { id: tenant.id },
      data: {
        status: "cloudflare",
        progress: 10,
        currentStep: "Creating Cloudflare zone"
      }
    });

    if (TEST_MODE) {
      console.log("🧪 TEST MODE: Skipping Cloudflare API call");
      console.log("🔄 [Cloudflare] Creating zone for:", tenant.domain);
      await sleep(2000);
      const zoneId = `test-zone-${Math.random().toString(36).slice(2, 11)}`;
      console.log("✅ [Cloudflare] Zone created:", zoneId);
      await prisma.tenant.update({
        where: { id: tenant.id },
        data: {
          zoneId,
          progress: 50,
          currentStep: "Cloudflare complete (test mode)"
        }
      });
      return;
    }

    const headers = buildHeaders();
    console.log("🔄 [Cloudflare] Creating zone for:", tenant.domain);
    const zone = await upsertZone(tenant.domain, headers);
    console.log("✅ [Cloudflare] Zone created:", zone.id);

    await prisma.tenant.update({
      where: { id: tenant.id },
      data: {
        zoneId: zone.id,
        progress: 20,
        currentStep: "Clearing DNS records"
      }
    });

    await clearDnsRecords(zone.id, headers);

    await prisma.tenant.update({
      where: { id: tenant.id },
      data: {
        currentStep: "Creating DNS records",
        progress: 30
      }
    });

    await createDnsRecords(zone.id, tenant.domain, headers);

    await prisma.tenant.update({
      where: { id: tenant.id },
      data: {
        progress: 40,
        currentStep: "DNS records configured"
      }
    });

    if (tenant.forwardingUrl) {
      await createForwardingRule(zone.id, tenant.domain, tenant.forwardingUrl, headers);
    }

    await prisma.tenant.update({
      where: { id: tenant.id },
      data: {
        progress: 50,
        currentStep: "Cloudflare complete"
      }
    });
  } catch (error) {
    await prisma.tenant.update({
      where: { id: tenantId },
      data: {
        status: "failed",
        errorMessage: error instanceof Error ? error.message : "Cloudflare setup failed",
        currentStep: "Cloudflare failed"
      }
    });
    throw error;
  }
}
