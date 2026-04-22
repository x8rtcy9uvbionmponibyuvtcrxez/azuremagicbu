/**
 * Tenant diagnostics — reads the live state of a Microsoft tenant via Graph
 * and returns a structured health report. Read-only; safe to call at any time.
 *
 * Uses the same app-level Graph authentication the worker uses, so no new
 * credentials or permissions are required — we're just querying what we
 * already have access to.
 */

import { prisma } from "@/lib/prisma";
import { requestTenantGraphToken } from "@/lib/services/microsoft";

const GRAPH_BASE_URL = "https://graph.microsoft.com/v1.0";

type CheckStatus = "pass" | "warn" | "fail" | "skip";

export type DiagnosticCheck = {
  name: string;
  status: CheckStatus;
  detail: string;
  data?: unknown;
};

export type DiagnosticResult = {
  tenantDbId: string;
  tenantName: string;
  domain: string;
  organizationId: string | null;
  overall: "healthy" | "warnings" | "broken";
  checks: DiagnosticCheck[];
  suggestion: string | null;
  timingMs: number;
  ranAt: string;
};

async function graphGet<T>(token: string, path: string): Promise<T> {
  const response = await fetch(`${GRAPH_BASE_URL}${path}`, {
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json"
    }
  });

  const text = await response.text();
  const payload = text ? JSON.parse(text) : {};

  if (!response.ok) {
    const message = payload.error?.message || payload.error_description || `Graph ${response.status}`;
    const err = new Error(message) as Error & { status?: number };
    err.status = response.status;
    throw err;
  }

  return payload as T;
}

function escapeOData(value: string): string {
  return value.replace(/'/g, "''");
}

function normalizeEmail(value: string | null | undefined): string {
  return (value || "").trim().toLowerCase();
}

function rollUp(checks: DiagnosticCheck[]): "healthy" | "warnings" | "broken" {
  if (checks.some((c) => c.status === "fail")) return "broken";
  if (checks.some((c) => c.status === "warn")) return "warnings";
  return "healthy";
}

/**
 * Build a human-readable "what's wrong + what to do" string based on the
 * check results. Matches specific failure patterns to specific fixes the
 * user can take right now.
 */
function buildSuggestion(checks: DiagnosticCheck[]): string | null {
  const by = (name: string) => checks.find((c) => c.name === name);

  const primaryLicensed = by("primary_has_license");
  const licensePool = by("license_pool");
  const strayLicenses = by("stray_licenses");
  const primaryExists = by("primary_user_exists");
  const primaryMailbox = by("primary_has_mailbox");
  const domainVerified = by("domain_verified");
  const deletedBlocking = by("deleted_users_blocking");

  if (deletedBlocking?.status === "warn") {
    return "Missing mailboxes are sitting in Azure AD's deleted-users recycle bin — Microsoft won't let us recreate them while the UPN is reserved. Hit /api/tenant/{id}/purge-deleted-users to hard-delete them from the recycle bin, then /reset-mailboxes to recreate.";
  }

  if (primaryExists?.status === "fail") {
    return "Primary user was never created in Microsoft. Hit Retry — the licensed_user phase will provision them.";
  }

  if (primaryLicensed?.status === "fail") {
    if (licensePool?.status === "fail") {
      return "Tenant has no available license seats. Open admin.microsoft.com → Billing → Licenses and buy a seat, then Retry.";
    }
    if (strayLicenses?.status === "warn") {
      return "A license is held by another user (admin or stray) while the primary has none. Hitting Retry will auto-swap it via ensurePrimaryUserLicensed(). If that's failed before, revoke manually in admin.microsoft.com → Active users → remove license → then Retry.";
    }
    return "Primary user has no license, but pool appears free. Hit Retry — the assignment + verify loop will try again for ~1 min.";
  }

  if (primaryMailbox?.status === "fail") {
    return "Primary user is licensed but Exchange hasn't materialized the mailbox yet. Wait 2-5 minutes and hit Retry.";
  }

  if (domainVerified?.status === "fail") {
    return "Custom domain isn't verified in Microsoft. Check DNS records and retry domain verification.";
  }

  if (rollUp(checks) === "healthy") {
    return "All checks green. No action needed.";
  }

  return null;
}

/**
 * Run the full battery of health checks against a tenant.
 */
export async function diagnoseTenant(tenantDbId: string): Promise<DiagnosticResult> {
  const start = Date.now();

  const tenant = await prisma.tenant.findUnique({
    where: { id: tenantDbId },
    select: {
      id: true,
      tenantName: true,
      domain: true,
      adminEmail: true,
      licensedUserUpn: true,
      tenantId: true,
      mailboxStatuses: true
    }
  });

  if (!tenant) {
    throw new Error("Tenant not found");
  }

  const checks: DiagnosticCheck[] = [];

  // Pre-check: do we have a tenant ID to talk to Microsoft about?
  if (!tenant.tenantId) {
    checks.push({
      name: "tenant_alive",
      status: "skip",
      detail: "No Microsoft tenant ID stored yet — tenant hasn't completed device auth."
    });
    return {
      tenantDbId: tenant.id,
      tenantName: tenant.tenantName,
      domain: tenant.domain,
      organizationId: null,
      overall: "broken",
      checks,
      suggestion: "Tenant hasn't completed device auth. No Microsoft state to inspect yet.",
      timingMs: Date.now() - start,
      ranAt: new Date().toISOString()
    };
  }

  // Get a token for this specific tenant.
  let token: string;
  try {
    token = await requestTenantGraphToken(tenant.tenantId);
  } catch (error) {
    checks.push({
      name: "service_principal_auth",
      status: "fail",
      detail: `Cannot acquire Graph token for tenant ${tenant.tenantId}: ${error instanceof Error ? error.message : String(error)}. The app's service principal may have been revoked from this tenant.`
    });
    return {
      tenantDbId: tenant.id,
      tenantName: tenant.tenantName,
      domain: tenant.domain,
      organizationId: tenant.tenantId,
      overall: "broken",
      checks,
      suggestion: "Re-authorize the app in admin.microsoft.com → Enterprise applications, or re-run the device-code flow to re-consent.",
      timingMs: Date.now() - start,
      ranAt: new Date().toISOString()
    };
  }

  // Run everything we can in parallel.
  const primaryUpn = normalizeEmail(tenant.licensedUserUpn);
  const adminUpn = normalizeEmail(tenant.adminEmail);

  const [orgResult, skusResult, domainsResult, primaryResult, allUsersResult] = await Promise.allSettled([
    graphGet<{ value: Array<{ id: string; displayName: string; verifiedDomains?: unknown[] }> }>(token, "/organization"),
    graphGet<{
      value: Array<{
        skuId: string;
        skuPartNumber: string;
        prepaidUnits: { enabled: number };
        consumedUnits: number;
      }>;
    }>(token, "/subscribedSkus"),
    graphGet<{ value: Array<{ id: string; isVerified: boolean; isDefault: boolean; supportedServices?: string[] }> }>(
      token,
      "/domains"
    ),
    primaryUpn
      ? graphGet<{
          value: Array<{
            id: string;
            userPrincipalName: string;
            usageLocation?: string;
            accountEnabled?: boolean;
            assignedLicenses?: Array<{ skuId: string }>;
          }>;
        }>(
          token,
          `/users?$filter=${encodeURIComponent(`userPrincipalName eq '${escapeOData(primaryUpn)}'`)}&$select=id,userPrincipalName,usageLocation,accountEnabled,assignedLicenses`
        )
      : Promise.reject(new Error("No primary UPN configured")),
    graphGet<{
      value: Array<{
        id: string;
        userPrincipalName: string;
        mail?: string | null;
        proxyAddresses?: string[];
        assignedLicenses?: Array<{ skuId: string }>;
      }>;
    }>(token, `/users?$select=id,userPrincipalName,mail,proxyAddresses,assignedLicenses&$top=999`)
  ]);

  // 1. Tenant alive
  if (orgResult.status === "fulfilled") {
    const org = orgResult.value.value?.[0];
    checks.push({
      name: "tenant_alive",
      status: "pass",
      detail: `Tenant responding (${org?.displayName || "unnamed"})`,
      data: { id: org?.id, displayName: org?.displayName }
    });
  } else {
    checks.push({
      name: "tenant_alive",
      status: "fail",
      detail: `Graph /organization failed: ${(orgResult.reason as Error)?.message || String(orgResult.reason)}`
    });
  }

  // 2. License pool
  if (skusResult.status === "fulfilled") {
    const skus = skusResult.value.value || [];
    const totalAvailable = skus.reduce(
      (sum, s) => sum + Math.max(0, (s.prepaidUnits?.enabled || 0) - (s.consumedUnits || 0)),
      0
    );
    const summary = skus
      .filter((s) => (s.prepaidUnits?.enabled || 0) > 0)
      .map((s) => `${s.skuPartNumber}: ${(s.prepaidUnits?.enabled || 0) - (s.consumedUnits || 0)}/${s.prepaidUnits?.enabled || 0}`)
      .join(", ");
    checks.push({
      name: "license_pool",
      status: totalAvailable > 0 ? "pass" : "fail",
      detail:
        totalAvailable > 0
          ? `${totalAvailable} seat(s) available total — ${summary}`
          : `No available seats. ${summary || "No SKUs found."}`,
      data: { totalAvailable, skus }
    });
  } else {
    checks.push({
      name: "license_pool",
      status: "fail",
      detail: `Could not read /subscribedSkus: ${(skusResult.reason as Error)?.message || String(skusResult.reason)}`
    });
  }

  // 3. Custom domain verified
  if (domainsResult.status === "fulfilled") {
    const domains = domainsResult.value.value || [];
    const target = domains.find((d) => d.id?.toLowerCase() === tenant.domain.toLowerCase());
    if (!target) {
      checks.push({
        name: "domain_verified",
        status: "fail",
        detail: `Domain ${tenant.domain} is not registered in Microsoft.`
      });
    } else if (!target.isVerified) {
      checks.push({
        name: "domain_verified",
        status: "fail",
        detail: `Domain ${tenant.domain} is registered but not verified.`,
        data: target
      });
    } else {
      checks.push({
        name: "domain_verified",
        status: target.isDefault ? "pass" : "warn",
        detail: target.isDefault
          ? `Verified and default.`
          : `Verified but not default (default is some other domain).`,
        data: target
      });
    }
  } else {
    checks.push({
      name: "domain_verified",
      status: "fail",
      detail: `Could not read /domains: ${(domainsResult.reason as Error)?.message || String(domainsResult.reason)}`
    });
  }

  // 4-5. Primary user state + license
  let primaryUser:
    | {
        id: string;
        userPrincipalName: string;
        usageLocation?: string;
        accountEnabled?: boolean;
        assignedLicenses?: Array<{ skuId: string }>;
      }
    | null = null;

  if (!primaryUpn) {
    checks.push({
      name: "primary_user_exists",
      status: "skip",
      detail: "No primary user UPN stored — tenant hasn't reached licensed_user phase."
    });
  } else if (primaryResult.status === "fulfilled") {
    primaryUser = primaryResult.value.value?.[0] || null;
    if (!primaryUser) {
      checks.push({
        name: "primary_user_exists",
        status: "fail",
        detail: `Primary user ${primaryUpn} not found in tenant.`
      });
    } else {
      checks.push({
        name: "primary_user_exists",
        status: "pass",
        detail: `${primaryUpn} exists (id=${primaryUser.id})`,
        data: primaryUser
      });
    }
  } else {
    checks.push({
      name: "primary_user_exists",
      status: "fail",
      detail: `Lookup failed: ${(primaryResult.reason as Error)?.message || String(primaryResult.reason)}`
    });
  }

  if (primaryUser) {
    checks.push({
      name: "primary_usage_location",
      status: primaryUser.usageLocation ? "pass" : "fail",
      detail: primaryUser.usageLocation
        ? `usageLocation = ${primaryUser.usageLocation}`
        : `No usageLocation set — Graph will silently refuse to license this user.`,
      data: { usageLocation: primaryUser.usageLocation }
    });

    const licenses = primaryUser.assignedLicenses || [];
    checks.push({
      name: "primary_has_license",
      status: licenses.length > 0 ? "pass" : "fail",
      detail:
        licenses.length > 0
          ? `${licenses.length} license(s): ${licenses.map((l) => l.skuId).join(", ")}`
          : "Primary user has no license assigned.",
      data: { assignedLicenses: licenses }
    });

    // 6. Exchange mailbox for primary
    try {
      const mailbox = await graphGet<{ archiveFolder?: string; language?: { locale?: string } }>(
        token,
        `/users/${primaryUser.id}/mailboxSettings`
      );
      checks.push({
        name: "primary_has_mailbox",
        status: "pass",
        detail: `Exchange mailbox exists for ${primaryUpn}.`,
        data: mailbox
      });
    } catch (error) {
      const status = (error as { status?: number }).status;
      checks.push({
        name: "primary_has_mailbox",
        status: status === 404 ? "fail" : "warn",
        detail:
          status === 404
            ? `No Exchange mailbox — delegation will fail. Usually means the license hasn't fully propagated, or wasn't assigned at all.`
            : `Could not read mailboxSettings: ${error instanceof Error ? error.message : String(error)}`
      });
    }
  }

  // 7. Stray licenses on other users
  if (allUsersResult.status === "fulfilled" && primaryUser) {
    const allUsers = allUsersResult.value.value || [];
    const others = allUsers.filter(
      (u) => u.id !== primaryUser!.id && Array.isArray(u.assignedLicenses) && u.assignedLicenses.length > 0
    );
    if (others.length === 0) {
      checks.push({
        name: "stray_licenses",
        status: "pass",
        detail: "No other users hold licenses (pool is dedicated to primary)."
      });
    } else {
      checks.push({
        name: "stray_licenses",
        status: "warn",
        detail: `${others.length} other user(s) hold a license: ${others
          .slice(0, 3)
          .map((u) => u.userPrincipalName)
          .join(", ")}${others.length > 3 ? ", ..." : ""}`,
        data: others.map((u) => ({ upn: u.userPrincipalName, skus: (u.assignedLicenses || []).map((l) => l.skuId) }))
      });
    }

    // 8. Mailbox drift — DB vs Graph
    try {
      const dbStatuses = tenant.mailboxStatuses ? (JSON.parse(tenant.mailboxStatuses) as Record<string, { created?: boolean }>) : {};
      const dbCreated = Object.entries(dbStatuses)
        .filter(([, s]) => s?.created === true)
        .map(([email]) => email.toLowerCase());
      // Check UPN, mail, and proxyAddresses — shared mailboxes may have a UPN
      // that differs from their primary SMTP (Exchange auto-suffixes the UPN
      // when the desired one collides with an existing object).
      const graphKnownEmails = new Set<string>();
      for (const u of allUsers) {
        if (u.userPrincipalName) graphKnownEmails.add(u.userPrincipalName.toLowerCase());
        if (u.mail) graphKnownEmails.add(u.mail.toLowerCase());
        for (const addr of u.proxyAddresses || []) {
          if (typeof addr !== "string") continue;
          const lower = addr.toLowerCase();
          graphKnownEmails.add(lower.startsWith("smtp:") ? lower.slice(5) : lower);
        }
      }
      const missingInGraph = dbCreated.filter((e) => !graphKnownEmails.has(e));
      if (dbCreated.length === 0) {
        checks.push({
          name: "mailbox_drift",
          status: "skip",
          detail: "No mailboxes recorded in DB yet."
        });
      } else if (missingInGraph.length === 0) {
        checks.push({
          name: "mailbox_drift",
          status: "pass",
          detail: `All ${dbCreated.length} mailboxes we think we created are present in Microsoft.`
        });
      } else {
        checks.push({
          name: "mailbox_drift",
          status: "warn",
          detail: `${missingInGraph.length}/${dbCreated.length} mailboxes present in DB are missing from Microsoft.`,
          data: { missingInGraph, totalInDb: dbCreated.length }
        });

        // When drift is detected, check whether the missing UPNs are sitting
        // in Azure AD's soft-delete recycle bin. If so, their UPNs are reserved
        // for 30 days and recreation will fail with a "conflicting object"
        // error. Hard-deleting from the recycle bin (/directory/deletedItems)
        // frees the UPN for reuse.
        try {
          const deleted = await graphGet<{
            value: Array<{ id: string; userPrincipalName?: string }>;
          }>(token, `/directory/deletedItems/microsoft.graph.user?$select=id,userPrincipalName&$top=999`);
          const deletedByUpn = new Map(
            (deleted.value || [])
              .filter((u) => u.userPrincipalName)
              .map((u) => [u.userPrincipalName!.trim().toLowerCase(), u.id])
          );
          const blocking = missingInGraph
            .map((email) => ({ email, deletedId: deletedByUpn.get(email) }))
            .filter((x) => Boolean(x.deletedId));
          if (blocking.length === 0) {
            checks.push({
              name: "deleted_users_blocking",
              status: "pass",
              detail: `None of the ${missingInGraph.length} missing mailboxes are in the deleted-users recycle bin. Drift isn't a soft-delete conflict.`
            });
          } else {
            checks.push({
              name: "deleted_users_blocking",
              status: "warn",
              detail: `${blocking.length}/${missingInGraph.length} missing mailboxes are soft-deleted in Azure AD. Their UPNs are reserved for 30 days — recreation will fail with "conflicting object" until they're hard-deleted from the recycle bin. Hit /api/tenant/{id}/purge-deleted-users to purge them, then /reset-mailboxes.`,
              data: { blocking }
            });
          }
        } catch (error) {
          checks.push({
            name: "deleted_users_blocking",
            status: "skip",
            detail: `Could not read /directory/deletedItems: ${error instanceof Error ? error.message : String(error)}`
          });
        }
      }
    } catch (error) {
      checks.push({
        name: "mailbox_drift",
        status: "skip",
        detail: `Could not compare mailbox state: ${error instanceof Error ? error.message : String(error)}`
      });
    }
  } else if (allUsersResult.status === "rejected") {
    checks.push({
      name: "stray_licenses",
      status: "skip",
      detail: `Could not enumerate users: ${(allUsersResult.reason as Error)?.message || String(allUsersResult.reason)}`
    });
  }

  // Optional: is the admin user still there?
  if (adminUpn) {
    const adminInGraph =
      allUsersResult.status === "fulfilled"
        ? (allUsersResult.value.value || []).find(
            (u) => normalizeEmail(u.userPrincipalName) === adminUpn
          )
        : null;
    checks.push({
      name: "admin_user",
      status: adminInGraph ? "pass" : "warn",
      detail: adminInGraph
        ? `admin user ${adminUpn} present${(adminInGraph.assignedLicenses || []).length > 0 ? " (holds a license)" : ""}`
        : `Admin user ${adminUpn} was not found in tenant.`,
      data: adminInGraph
    });
  }

  const overall = rollUp(checks);
  return {
    tenantDbId: tenant.id,
    tenantName: tenant.tenantName,
    domain: tenant.domain,
    organizationId: tenant.tenantId,
    overall,
    checks,
    suggestion: buildSuggestion(checks),
    timingMs: Date.now() - start,
    ranAt: new Date().toISOString()
  };
}
