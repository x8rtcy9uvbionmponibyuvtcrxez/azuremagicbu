import { z } from "zod";

const tenantNameRegex = /^[A-Za-z0-9-]+$/;
const inboxNameRegex = /^[A-Za-z]+\s+[A-Za-z]+$/;
const domainRegex = /^(?!-)(?:[A-Za-z0-9-]{1,63}\.)+[A-Za-z]{2,}$/;

const passwordChecks = [
  {
    test: (value: string) => /[A-Z]/.test(value),
    message: "must contain at least one uppercase letter"
  },
  {
    test: (value: string) => /[a-z]/.test(value),
    message: "must contain at least one lowercase letter"
  },
  {
    test: (value: string) => /[0-9]/.test(value),
    message: "must contain at least one digit"
  },
  {
    test: (value: string) => /[^A-Za-z0-9]/.test(value),
    message: "must contain at least one special character"
  }
];

export const tenantCsvRowSchema = z
  .object({
    tenant_name: z
      .string()
      .trim()
      .min(1, "tenant_name is required")
      .regex(tenantNameRegex, {
        message: "tenant_name may contain only letters, numbers, and hyphens"
      }),
    client_name: z.string().trim().optional().default(""),
    admin_email: z
      .string()
      .trim()
      .min(1, "admin_email is required")
      .email("admin_email must be a valid email")
      .refine((value) => value.toLowerCase().endsWith(".onmicrosoft.com"), {
        message: "admin_email must end with .onmicrosoft.com"
      }),
    admin_password: z
      .string()
      .min(8, "admin_password must be at least 8 characters long")
      .superRefine((value, ctx) => {
        for (const check of passwordChecks) {
          if (!check.test(value)) {
            ctx.addIssue({
              code: z.ZodIssueCode.custom,
              message: `admin_password ${check.message}`
            });
          }
        }
      }),
    domain: z
      .string()
      .trim()
      .toLowerCase()
      .regex(domainRegex, { message: "domain must be a valid domain" }),
    inbox_names: z
      .string()
      .trim()
      .min(1, "inbox_names is required"),
    forwarding_url: z
      .string()
      .trim()
      .url("forwarding_url must be a valid URL")
      .refine((value) => value.startsWith("https://"), {
        message: "forwarding_url must start with https://"
      }),
    inbox_count: z
      .string()
      .trim()
      .transform((value) => {
        const fallback = 99;
        if (!value) return fallback;
        const numeric = Number.parseInt(value, 10);
        if (Number.isNaN(numeric)) {
          throw new Error("inbox_count must be a number");
        }
        return numeric;
      })
      .pipe(z.number().int().min(10).max(200))
  })
  .transform((value) => ({
    ...value,
    inbox_names: value.inbox_names
      .split(",")
      .map((entry) => entry.trim())
      .filter(Boolean)
  }))
  .superRefine((value, ctx) => {
    if (value.inbox_names.length < 1) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Provide at least one inbox persona",
        path: ["inbox_names"]
      });
    }

    for (const name of value.inbox_names) {
      if (!inboxNameRegex.test(name)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `Invalid persona name: ${name}`,
          path: ["inbox_names"]
        });
      }
    }
  });

export type TenantCsvRow = z.infer<typeof tenantCsvRowSchema> & {
  inbox_names: string[];
};

export type ParsedTenantRecord = {
  tenantName: string;
  clientName: string;
  adminEmail: string;
  adminPassword: string;
  domain: string;
  inboxNames: string[];
  forwardingUrl: string;
  inboxCount: number;
};

export function mapTenantCsvRow(row: Record<string, string>): ParsedTenantRecord {
  const parsed = tenantCsvRowSchema.parse(row);
  return {
    tenantName: parsed.tenant_name,
    clientName: parsed.client_name || parsed.tenant_name,
    adminEmail: parsed.admin_email,
    adminPassword: parsed.admin_password,
    domain: parsed.domain,
    inboxNames: parsed.inbox_names,
    forwardingUrl: parsed.forwarding_url,
    inboxCount: parsed.inbox_count
  };
}
