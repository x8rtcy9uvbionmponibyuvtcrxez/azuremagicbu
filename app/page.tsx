"use client";

import Link from "next/link";
import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { zodResolver } from "@hookform/resolvers/zod";
import Papa from "papaparse";
import { useDropzone } from "react-dropzone";
import { useForm } from "react-hook-form";
import { z } from "zod";

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Form, FormControl, FormDescription, FormField, FormItem, FormLabel, FormMessage } from "@/components/ui/form";
import { Input } from "@/components/ui/input";
import { Progress } from "@/components/ui/progress";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";
import { extractApiError, parseJsonResponse } from "@/lib/http-client";
import { normalizeForwardingUrl } from "@/lib/validation";

const nameRegex = /^[A-Za-z]+\s+[A-Za-z]+$/;
const tenantRegex = /^[A-Za-z0-9-]+$/;
const domainRegex = /^(?!-)(?:[A-Za-z0-9-]{1,63}\.)+[A-Za-z]{2,}$/;

const singleTenantSchema = z.object({
  tenantName: z.string().trim().min(1, "Tenant name is required").regex(tenantRegex, "Use letters, numbers, and hyphens only"),
  clientName: z.string().trim().min(1, "Client name is required"),
  domain: z.string().trim().toLowerCase().min(1, "Domain is required").regex(domainRegex, "Enter a valid domain"),
  forwardingUrl: z
    .string()
    .trim()
    .min(1, "Forwarding URL is required")
    .transform(normalizeForwardingUrl)
    .refine((value) => {
      try { new URL(value); return true; } catch { return false; }
    }, "Enter a valid URL"),
  adminEmail: z
    .string()
    .trim()
    .email("Enter a valid email")
    .refine((value) => value.toLowerCase().endsWith(".onmicrosoft.com"), "Admin email must end with .onmicrosoft.com"),
  adminPassword: z
    .string()
    .min(8, "Password must be at least 8 characters")
    .refine((value) => /[A-Z]/.test(value), "Add at least one uppercase letter")
    .refine((value) => /[a-z]/.test(value), "Add at least one lowercase letter")
    .refine((value) => /\d/.test(value), "Add at least one number")
    .refine((value) => /[^A-Za-z0-9]/.test(value), "Add at least one symbol"),
  inboxCount: z.number().int().min(10, "Minimum is 10").max(200, "Maximum is 200"),
  inboxNamesRaw: z.string().trim().min(1, "Provide at least two names")
});

type SingleTenantFormValues = z.infer<typeof singleTenantSchema>;

type BatchResponse = {
  batch: {
    id: string;
    totalCount: number;
  };
};

type BulkRow = {
  rowNumber: number;
  raw: Record<string, string>;
  parsed?: {
    tenantName: string;
    clientName: string;
    adminEmail: string;
    adminPassword: string;
    domain: string;
    forwardingUrl: string;
    inboxCount: number;
    inboxNames: string[];
  };
  errors: string[];
};

const csvHeaders = [
  "tenant_name",
  "client_name",
  "admin_email",
  "admin_password",
  "domain",
  "inbox_names",
  "forwarding_url",
  "inbox_count"
] as const;

function generateStrongPassword(): string {
  const length = 16;
  const uppercase = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";
  const lowercase = "abcdefghijklmnopqrstuvwxyz";
  const numbers = "0123456789";
  const special = "!@#$%^&*()";

  let password = "";

  for (let i = 0; i < 3; i++) {
    password += uppercase[Math.floor(Math.random() * uppercase.length)];
    password += lowercase[Math.floor(Math.random() * lowercase.length)];
    password += numbers[Math.floor(Math.random() * numbers.length)];
    password += special[Math.floor(Math.random() * special.length)];
  }

  const allChars = uppercase + lowercase + numbers + special;
  while (password.length < length) {
    password += allChars[Math.floor(Math.random() * allChars.length)];
  }

  return password
    .split("")
    .sort(() => Math.random() - 0.5)
    .join("");
}

function passwordScore(value: string): number {
  if (!value) return 0;
  let score = 0;
  if (value.length >= 8) score += 25;
  if (/[A-Z]/.test(value)) score += 20;
  if (/[a-z]/.test(value)) score += 20;
  if (/\d/.test(value)) score += 20;
  if (/[^A-Za-z0-9]/.test(value)) score += 15;
  return Math.min(score, 100);
}

function passwordStrengthLabel(score: number): "Weak" | "Medium" | "Strong" {
  if (score < 45) return "Weak";
  if (score < 80) return "Medium";
  return "Strong";
}

function parseInboxNames(value: string): string[] {
  return value
    .split(/\n|,/) // support either one-per-line or comma-separated
    .map((item) => item.trim())
    .filter(Boolean);
}

function validateInboxNames(names: string[]): string[] {
  const errors: string[] = [];
  if (names.length < 1) errors.push("At least 1 inbox name is required");
  names.forEach((name) => {
    if (!nameRegex.test(name)) {
      errors.push(`Invalid name format: ${name}`);
    }
  });
  return errors;
}

function escapeCsvValue(value: string): string {
  if (value.includes(",") || value.includes('"') || value.includes("\n")) {
    return `"${value.replace(/"/g, '""')}"`;
  }
  return value;
}

function toCsvContent(rows: Array<Record<string, string>>): string {
  const header = csvHeaders.join(",");
  const body = rows
    .map((row) => csvHeaders.map((column) => escapeCsvValue(row[column] ?? "")).join(","))
    .join("\n");
  return `${header}\n${body}`;
}

function validateBulkRow(row: Record<string, string>, rowNumber: number): BulkRow {
  const errors: string[] = [];
  const tenantName = (row.tenant_name ?? "").trim();
  const clientName = (row.client_name ?? "").trim() || tenantName;
  const adminEmail = (row.admin_email ?? "").trim().toLowerCase();
  const adminPassword = row.admin_password ?? "";
  const domain = (row.domain ?? "").trim().toLowerCase();
  const forwardingUrl = normalizeForwardingUrl(row.forwarding_url ?? "");
  const inboxCountRaw = (row.inbox_count ?? "").trim();
  const inboxNames = parseInboxNames(row.inbox_names ?? "");

  if (!tenantName || !tenantRegex.test(tenantName)) errors.push("tenant_name must be alphanumeric with hyphens");
  if (!clientName) errors.push("client_name is required");
  if (!adminEmail.endsWith(".onmicrosoft.com")) errors.push("admin_email must end with .onmicrosoft.com");
  if (adminPassword.length < 8) errors.push("admin_password must be at least 8 characters");
  if (!/[A-Z]/.test(adminPassword) || !/[a-z]/.test(adminPassword) || !/\d/.test(adminPassword) || !/[^A-Za-z0-9]/.test(adminPassword)) {
    errors.push("admin_password must include uppercase, lowercase, number, and symbol");
  }
  if (!domainRegex.test(domain)) errors.push("domain is invalid");
  try {
    new URL(forwardingUrl);
  } catch {
    errors.push("forwarding_url must be valid URL");
  }

  const inboxCount = Number.parseInt(inboxCountRaw || "99", 10);
  if (!Number.isInteger(inboxCount) || inboxCount < 10 || inboxCount > 200) errors.push("inbox_count must be between 10 and 200");

  errors.push(...validateInboxNames(inboxNames));

  return {
    rowNumber,
    raw: row,
    parsed:
      errors.length === 0
        ? {
            tenantName,
            clientName,
            adminEmail,
            adminPassword,
            domain,
            forwardingUrl,
            inboxCount,
            inboxNames
          }
        : undefined,
    errors
  };
}

// The workers-per-job knob is intentionally NOT part of the UI anymore —
// it's a backend concern. `lib/services/emailUploader.ts` resolves from the
// EMAIL_UPLOADER_DEFAULT_WORKERS env var (default 2, right-sized for the
// Railway Hobby 1GB RAM ceiling). Bumping to 5 is a single env-var change.
type UploaderConfigInput =
  | { enabled: false }
  | {
      enabled: true;
      esp: "instantly";
      instantlyEmail: string;
      instantlyPassword: string;
      instantlyV1Key: string;
      instantlyV2Key: string;
      instantlyWorkspace: string;
      instantlyApiVersion: "v1" | "v2";
    }
  | {
      enabled: true;
      esp: "smartlead";
      smartleadApiKey: string;
      smartleadLoginUrl: string;
    };

async function uploadCsvAndCreateBatch(
  csvContent: string,
  uploader: UploaderConfigInput = { enabled: false }
): Promise<BatchResponse> {
  const file = new File([csvContent], `tenants-${Date.now()}.csv`, { type: "text/csv" });
  const formData = new FormData();
  formData.append("file", file);

  if (uploader.enabled) {
    formData.append("uploader_enabled", "1");
    formData.append("uploader_esp", uploader.esp);
    if (uploader.esp === "instantly") {
      formData.append("instantly_email", uploader.instantlyEmail);
      formData.append("instantly_password", uploader.instantlyPassword);
      formData.append("instantly_v1_key", uploader.instantlyV1Key);
      formData.append("instantly_v2_key", uploader.instantlyV2Key);
      formData.append("instantly_workspace", uploader.instantlyWorkspace);
      formData.append("instantly_api_version", uploader.instantlyApiVersion);
    } else {
      formData.append("smartlead_api_key", uploader.smartleadApiKey);
      formData.append("smartlead_login_url", uploader.smartleadLoginUrl);
    }
  }

  const response = await fetch("/api/batches", {
    method: "POST",
    body: formData
  });

  const payload = await parseJsonResponse<BatchResponse & { error?: string; details?: unknown }>(response);

  if (!response.ok) {
    throw new Error(extractApiError(payload, "Batch upload failed"));
  }

  return payload as BatchResponse;
}

export default function HomePage() {
  const router = useRouter();
  const testModeEnabled = process.env.NEXT_PUBLIC_TEST_MODE === "true";
  const [singleStatus, setSingleStatus] = useState<{ variant: "default" | "destructive"; title: string; detail: string } | null>(null);
  const [bulkStatus, setBulkStatus] = useState<{ variant: "default" | "destructive"; title: string; detail: string } | null>(null);
  const [singleSubmitting, setSingleSubmitting] = useState(false);
  const [singleValidated, setSingleValidated] = useState(false);
  const [showPassword, setShowPassword] = useState(false);
  const [bulkRows, setBulkRows] = useState<BulkRow[]>([]);
  const [bulkFileName, setBulkFileName] = useState<string | null>(null);
  const [bulkSubmitting, setBulkSubmitting] = useState(false);

  // Uploader config — shown at the bottom of the bulk upload tab so the
  // user configures Azure provisioning + ESP upload in a single form. The
  // ESP picker itself is the enable switch: "none" means skip ESP, anything
  // else means upload to that ESP. No separate checkbox; fields are visible
  // from page load so the user can fill them WHILE dropping the CSV.
  const [uploaderEsp, setUploaderEsp] = useState<"none" | "instantly" | "smartlead">("instantly");
  const [showUploaderSecrets, setShowUploaderSecrets] = useState(false);
  // Instantly-specific
  const [instEmail, setInstEmail] = useState("");
  const [instPassword, setInstPassword] = useState("");
  const [instV1Key, setInstV1Key] = useState("");
  const [instV2Key, setInstV2Key] = useState("");
  const [instWorkspace, setInstWorkspace] = useState("");
  const [instApiVersion, setInstApiVersion] = useState<"v1" | "v2">("v1");
  // Smartlead-specific
  const [slApiKey, setSlApiKey] = useState("");
  const [slLoginUrl, setSlLoginUrl] = useState("");

  const form = useForm<SingleTenantFormValues>({
    resolver: zodResolver(singleTenantSchema),
    mode: "onChange",
    defaultValues: {
      tenantName: "",
      clientName: "",
      domain: "",
      forwardingUrl: "",
      adminEmail: "",
      adminPassword: "",
      inboxCount: 99,
      inboxNamesRaw: ""
    }
  });

  const watchedPassword = form.watch("adminPassword");
  const passwordProgress = passwordScore(watchedPassword);
  const strengthLabel = passwordStrengthLabel(passwordProgress);

  const validBulkRows = useMemo(() => bulkRows.filter((row) => row.errors.length === 0), [bulkRows]);
  const invalidBulkRows = useMemo(() => bulkRows.filter((row) => row.errors.length > 0), [bulkRows]);

  const onSingleValidate = async () => {
    setSingleStatus(null);
    const isValid = await form.trigger();

    const names = parseInboxNames(form.getValues("inboxNamesRaw"));
    const nameErrors = validateInboxNames(names);
    if (nameErrors.length > 0) {
      form.setError("inboxNamesRaw", { message: nameErrors.join("; ") });
    }

    if (isValid && nameErrors.length === 0) {
      setSingleValidated(true);
      setSingleStatus({ variant: "default", title: "Form validated", detail: "All fields look ready for setup." });
    } else {
      setSingleValidated(false);
      setSingleStatus({ variant: "destructive", title: "Validation failed", detail: "Fix the highlighted fields before setup." });
    }
  };

  const onSingleSubmit = form.handleSubmit(async (values) => {
    const inboxNames = parseInboxNames(values.inboxNamesRaw);
    const nameErrors = validateInboxNames(inboxNames);

    if (nameErrors.length > 0) {
      form.setError("inboxNamesRaw", { message: nameErrors.join("; ") });
      setSingleStatus({ variant: "destructive", title: "Validation failed", detail: "Inbox names must be First Last format." });
      return;
    }

    if (!singleValidated) {
      setSingleStatus({
        variant: "destructive",
        title: "Validate first",
        detail: "Run Validate Form before starting setup."
      });
      return;
    }

    setSingleSubmitting(true);
    setSingleStatus(null);

    try {
      const csvContent = toCsvContent([
        {
          tenant_name: values.tenantName.trim(),
          client_name: values.clientName.trim(),
          admin_email: values.adminEmail.trim().toLowerCase(),
          admin_password: values.adminPassword,
          domain: values.domain.trim().toLowerCase(),
          inbox_names: inboxNames.join(","),
          forwarding_url: normalizeForwardingUrl(values.forwardingUrl),
          inbox_count: String(values.inboxCount)
        }
      ]);

      const result = await uploadCsvAndCreateBatch(csvContent);
      router.push(`/batch/${result.batch.id}`);
    } catch (error) {
      setSingleStatus({
        variant: "destructive",
        title: "Setup failed",
        detail: error instanceof Error ? error.message : "Unexpected error"
      });
    } finally {
      setSingleSubmitting(false);
    }
  });

  const onGeneratePassword = () => {
    const password = generateStrongPassword();
    form.setValue("adminPassword", password, { shouldValidate: true, shouldDirty: true });
    setShowPassword(true);
    setSingleValidated(false);
  };

  const onDrop = (files: File[]) => {
    const file = files[0];
    if (!file) return;

    setBulkStatus(null);
    setBulkFileName(file.name);

    Papa.parse<Record<string, string>>(file, {
      header: true,
      skipEmptyLines: true,
      complete: (results) => {
        if (results.errors.length > 0) {
          setBulkStatus({
            variant: "destructive",
            title: "CSV parse error",
            detail: results.errors.map((item) => item.message).join("; ")
          });
          return;
        }

        const rows = results.data.map((row, index) => validateBulkRow(row, index + 2));
        setBulkRows(rows);
      }
    });
  };

  const { getRootProps, getInputProps, isDragActive } = useDropzone({
    onDrop,
    accept: { "text/csv": [".csv"] },
    multiple: false
  });

  const buildUploaderConfig = (): UploaderConfigInput | { error: string } => {
    // "none" = provision only, skip ESP upload. This is how users opt out of
    // auto-upload now (the separate enabled checkbox got removed so there's
    // only ever one toggle to reason about).
    if (uploaderEsp === "none") return { enabled: false };

    if (uploaderEsp === "instantly") {
      if (!instEmail.trim() || !instPassword) {
        return { error: "Instantly login email and password are required" };
      }
      if (!instV1Key.trim() && !instV2Key.trim()) {
        return { error: "At least one Instantly API key (v1 or v2) is required" };
      }
      if (instApiVersion === "v2" && !instV2Key.trim()) {
        return { error: "Selected API version is v2 — enter the v2 API key" };
      }
      return {
        enabled: true,
        esp: "instantly",
        instantlyEmail: instEmail.trim(),
        instantlyPassword: instPassword,
        instantlyV1Key: instV1Key.trim(),
        instantlyV2Key: instV2Key.trim(),
        instantlyWorkspace: instWorkspace.trim(),
        instantlyApiVersion: instApiVersion
      };
    }

    if (!slApiKey.trim()) return { error: "Smartlead API key is required" };
    if (!slLoginUrl.trim()) return { error: "Smartlead Microsoft OAuth login URL is required" };
    return {
      enabled: true,
      esp: "smartlead",
      smartleadApiKey: slApiKey.trim(),
      smartleadLoginUrl: slLoginUrl.trim()
    };
  };

  const processValidTenants = async () => {
    if (validBulkRows.length === 0) {
      setBulkStatus({ variant: "destructive", title: "No valid rows", detail: "Upload a CSV with at least one valid tenant." });
      return;
    }

    const uploaderResult = buildUploaderConfig();
    if ("error" in uploaderResult) {
      setBulkStatus({ variant: "destructive", title: "Uploader config incomplete", detail: uploaderResult.error });
      return;
    }

    setBulkSubmitting(true);
    setBulkStatus(null);

    try {
      const csvContent = toCsvContent(
        validBulkRows.map((row) => ({
          tenant_name: row.parsed?.tenantName ?? "",
          client_name: row.parsed?.clientName ?? "",
          admin_email: row.parsed?.adminEmail ?? "",
          admin_password: row.parsed?.adminPassword ?? "",
          domain: row.parsed?.domain ?? "",
          inbox_names: row.parsed?.inboxNames.join(",") ?? "",
          forwarding_url: row.parsed?.forwardingUrl ?? "",
          inbox_count: String(row.parsed?.inboxCount ?? "")
        }))
      );

      const result = await uploadCsvAndCreateBatch(csvContent, uploaderResult);
      router.push(`/batch/${result.batch.id}`);
    } catch (error) {
      setBulkStatus({ variant: "destructive", title: "Processing failed", detail: error instanceof Error ? error.message : "Unexpected error" });
    } finally {
      setBulkSubmitting(false);
    }
  };

  const downloadExampleCsv = () => {
    const csvContent = toCsvContent([
      {
        tenant_name: "TN-001",
        client_name: "Acme Corp",
        admin_email: "admin@tenant001.onmicrosoft.com",
        admin_password: "StrongP@ssw0rd!",
        domain: "example.com",
        inbox_names: "John Smith,Jane Doe,Bob Wilson",
        forwarding_url: "https://clientwebsite.com",
        inbox_count: "99"
      }
    ]);

    const blob = new Blob([csvContent], { type: "text/csv" });
    const link = document.createElement("a");
    link.href = URL.createObjectURL(blob);
    link.download = "tenant_template.csv";
    link.click();
    URL.revokeObjectURL(link.href);
  };

  return (
    <main className="min-h-screen bg-[radial-gradient(circle_at_top_left,#f3f8ff,transparent_30%),radial-gradient(circle_at_bottom_right,#ffeeda,transparent_35%)] p-4 md:p-8">
      <section className="mx-auto max-w-6xl">
        <div className="mb-6 flex items-start justify-between gap-3">
          <div>
            <h1 className="text-3xl font-semibold tracking-tight">M365 Tenant Automation</h1>
            <p className="mt-1 text-sm text-muted-foreground">Run one tenant quickly or process large CSV batches in one flow.</p>
          </div>
          <div className="flex items-center gap-2">
            <Button asChild variant="outline">
              <Link href="/services">Services</Link>
            </Button>
            <Button asChild variant="outline">
              <Link href="/esp-upload">ESP Upload</Link>
            </Button>
            <Button asChild variant="outline">
              <Link href="/history">History</Link>
            </Button>
            <Button asChild variant="outline">
              <Link href="/config">Config</Link>
            </Button>
          </div>
        </div>

        {testModeEnabled ? (
          <Alert className="mb-4">
            <AlertTitle>🧪 Test Mode Enabled</AlertTitle>
            <AlertDescription>Using simulated API calls. No real Cloudflare or Microsoft changes will be made.</AlertDescription>
          </Alert>
        ) : null}

        <Tabs defaultValue="single" className="w-full">
          <TabsList>
            <TabsTrigger value="single">Single Tenant</TabsTrigger>
            <TabsTrigger value="bulk">Bulk CSV Upload</TabsTrigger>
          </TabsList>

          <TabsContent value="single">
            <Card>
              <CardHeader>
                <CardTitle>Setup Single Tenant</CardTitle>
                <CardDescription>Fill one tenant manually and send it through the same batch API used for bulk mode.</CardDescription>
              </CardHeader>
              <CardContent>
                {singleStatus ? (
                  <Alert variant={singleStatus.variant} className="mb-6">
                    <AlertTitle>{singleStatus.title}</AlertTitle>
                    <AlertDescription>{singleStatus.detail}</AlertDescription>
                  </Alert>
                ) : null}

                <Form {...form}>
                  <form className="space-y-7" onSubmit={onSingleSubmit}>
                    <div className="space-y-4 rounded-lg border p-4">
                      <h3 className="font-medium">Tenant Details</h3>
                      <FormField
                        control={form.control}
                        name="tenantName"
                        render={({ field }) => (
                          <FormItem>
                            <FormLabel>Tenant Name</FormLabel>
                            <FormControl>
                              <Input placeholder="TN-001" {...field} onChange={(event) => {
                                field.onChange(event);
                                setSingleValidated(false);
                              }} />
                            </FormControl>
                            <FormDescription>Example: TN-001, client-acme-1</FormDescription>
                            <FormMessage />
                          </FormItem>
                        )}
                      />

                      <FormField
                        control={form.control}
                        name="clientName"
                        render={({ field }) => (
                          <FormItem>
                            <FormLabel>Client Name</FormLabel>
                            <FormControl>
                              <Input placeholder="Acme Corp" {...field} onChange={(event) => {
                                field.onChange(event);
                                setSingleValidated(false);
                              }} />
                            </FormControl>
                            <FormDescription>Used for tracking which client owns this tenant.</FormDescription>
                            <FormMessage />
                          </FormItem>
                        )}
                      />

                      <FormField
                        control={form.control}
                        name="domain"
                        render={({ field }) => (
                          <FormItem>
                            <FormLabel>Domain</FormLabel>
                            <FormControl>
                              <Input placeholder="example.com" {...field} onChange={(event) => {
                                field.onChange(event);
                                setSingleValidated(false);
                              }} />
                            </FormControl>
                            <FormDescription>Domain only, no protocol or path.</FormDescription>
                            <FormMessage />
                          </FormItem>
                        )}
                      />

                      <FormField
                        control={form.control}
                        name="forwardingUrl"
                        render={({ field }) => (
                          <FormItem>
                            <FormLabel>Forwarding URL</FormLabel>
                            <FormControl>
                              <Input placeholder="clientwebsite.com" {...field} onChange={(event) => {
                                field.onChange(event);
                                setSingleValidated(false);
                              }} />
                            </FormControl>
                            <FormDescription>Protocol is optional — we&apos;ll prepend https:// automatically.</FormDescription>
                            <FormMessage />
                          </FormItem>
                        )}
                      />
                    </div>

                    <div className="space-y-4 rounded-lg border p-4">
                      <h3 className="font-medium">Microsoft 365 Admin</h3>
                      <FormField
                        control={form.control}
                        name="adminEmail"
                        render={({ field }) => (
                          <FormItem>
                            <FormLabel>Admin Email</FormLabel>
                            <FormControl>
                              <Input placeholder="admin@tenant001.onmicrosoft.com" {...field} onChange={(event) => {
                                field.onChange(event);
                                setSingleValidated(false);
                              }} />
                            </FormControl>
                            <FormDescription>Must end with .onmicrosoft.com</FormDescription>
                            <FormMessage />
                          </FormItem>
                        )}
                      />

                      <FormField
                        control={form.control}
                        name="adminPassword"
                        render={({ field }) => (
                          <FormItem>
                            <FormLabel>Admin Password</FormLabel>
                            <FormControl>
                              <div className="flex gap-2">
                                <Input
                                  type={showPassword ? "text" : "password"}
                                  placeholder="Enter or generate a strong password"
                                  {...field}
                                  onChange={(event) => {
                                    field.onChange(event);
                                    setSingleValidated(false);
                                  }}
                                />
                                <Button type="button" variant="outline" onClick={() => setShowPassword((value) => !value)}>
                                  {showPassword ? "Hide" : "Show"}
                                </Button>
                                <Button type="button" variant="outline" onClick={onGeneratePassword}>
                                  Generate
                                </Button>
                              </div>
                            </FormControl>
                            <div className="space-y-1">
                              <div className="flex items-center justify-between text-xs text-muted-foreground">
                                <span>Password Strength</span>
                                <span>{strengthLabel}</span>
                              </div>
                              <Progress value={passwordProgress} />
                            </div>
                            <FormDescription>Min 8 chars with upper/lower/number/symbol.</FormDescription>
                            <FormMessage />
                          </FormItem>
                        )}
                      />
                    </div>

                    <div className="space-y-4 rounded-lg border p-4">
                      <h3 className="font-medium">Inbox Configuration</h3>
                      <FormField
                        control={form.control}
                        name="inboxCount"
                        render={({ field }) => (
                          <FormItem>
                            <FormLabel>Number of Mailboxes</FormLabel>
                            <FormControl>
                              <Input
                                type="number"
                                min={10}
                                max={200}
                                value={field.value}
                                onChange={(event) => {
                                  field.onChange(Number(event.target.value));
                                  setSingleValidated(false);
                                }}
                              />
                            </FormControl>
                            <FormDescription>Allowed range: 10-200.</FormDescription>
                            <FormMessage />
                          </FormItem>
                        )}
                      />

                      <FormField
                        control={form.control}
                        name="inboxNamesRaw"
                        render={({ field }) => (
                          <FormItem>
                            <FormLabel>Inbox Names (First Last, one per line)</FormLabel>
                            <FormControl>
                              <Textarea
                                placeholder={"John Smith\nJane Doe\nBob Wilson"}
                                rows={8}
                                {...field}
                                onChange={(event) => {
                                  field.onChange(event);
                                  setSingleValidated(false);
                                }}
                              />
                            </FormControl>
                            <FormDescription>Minimum one name, formatted as FirstName LastName.</FormDescription>
                            <FormMessage />
                          </FormItem>
                        )}
                      />
                    </div>

                    <div className="flex flex-wrap items-center gap-3">
                      <Button type="button" variant="outline" onClick={onSingleValidate}>
                        Validate Form
                      </Button>
                      <Button type="submit" disabled={!singleValidated || singleSubmitting}>
                        {singleSubmitting ? "Setting up..." : "Setup Tenant"}
                      </Button>
                      <Badge variant={singleValidated ? "secondary" : "outline"}>
                        Status: {singleValidated ? "Ready to setup" : "Awaiting validation"}
                      </Badge>
                    </div>
                  </form>
                </Form>
              </CardContent>
            </Card>
          </TabsContent>

          <TabsContent value="bulk">
            <Card>
              <CardHeader>
                <CardTitle>Bulk Upload Tenants via CSV</CardTitle>
                <CardDescription>Upload once, preview validation results, and process only valid rows.</CardDescription>
              </CardHeader>
              <CardContent className="space-y-6">
                {bulkStatus ? (
                  <Alert variant={bulkStatus.variant}>
                    <AlertTitle>{bulkStatus.title}</AlertTitle>
                    <AlertDescription>{bulkStatus.detail}</AlertDescription>
                  </Alert>
                ) : null}

                <div className="space-y-3">
                  <h3 className="text-sm font-medium">Step 1: Upload CSV File</h3>
                  <div
                    {...getRootProps()}
                    className={`cursor-pointer rounded-lg border border-dashed p-8 text-center transition ${
                      isDragActive ? "border-primary bg-primary/5" : "border-input"
                    }`}
                  >
                    <input {...getInputProps()} />
                    <p className="text-sm font-medium">Drag and drop CSV here, or click to browse</p>
                    <p className="mt-2 text-xs text-muted-foreground">Required: tenant_name, client_name, admin_email, admin_password, domain, inbox_names, forwarding_url, inbox_count</p>
                    {bulkFileName ? <p className="mt-2 text-xs">Loaded: {bulkFileName}</p> : null}
                  </div>
                  <Button type="button" variant="outline" onClick={downloadExampleCsv}>
                    Download Example CSV
                  </Button>
                </div>

                <div className="space-y-3">
                  <h3 className="text-sm font-medium">Step 2: Preview & Validate</h3>
                  {bulkRows.length === 0 ? (
                    <p className="text-sm text-muted-foreground">No CSV parsed yet.</p>
                  ) : (
                    <div className="overflow-x-auto rounded-lg border">
                      <table className="min-w-full text-sm">
                        <thead className="bg-muted/60 text-left">
                          <tr>
                            <th className="px-3 py-2">Row</th>
                            <th className="px-3 py-2">Tenant</th>
                            <th className="px-3 py-2">Client</th>
                            <th className="px-3 py-2">Domain</th>
                            <th className="px-3 py-2">Inboxes</th>
                            <th className="px-3 py-2">Status</th>
                          </tr>
                        </thead>
                        <tbody>
                          {bulkRows.map((row) => (
                            <tr key={`${row.rowNumber}-${row.raw.tenant_name ?? ""}`} className="border-t">
                              <td className="px-3 py-2">{row.rowNumber}</td>
                              <td className="px-3 py-2">{row.raw.tenant_name || "-"}</td>
                              <td className="px-3 py-2">{row.raw.client_name || row.raw.tenant_name || "-"}</td>
                              <td className="px-3 py-2">{row.raw.domain || "-"}</td>
                              <td className="px-3 py-2">{row.raw.inbox_count || "99"}</td>
                              <td className="px-3 py-2">
                                {row.errors.length === 0 ? (
                                  <Badge variant="secondary">Valid</Badge>
                                ) : (
                                  <div className="space-y-1">
                                    <Badge variant="destructive">Error</Badge>
                                    <p className="max-w-md text-xs text-destructive">{row.errors.join("; ")}</p>
                                  </div>
                                )}
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  )}

                  <p className="text-sm text-muted-foreground">Summary: {validBulkRows.length} valid, {invalidBulkRows.length} error</p>
                </div>

                {/* Step 3: ESP Auto-Upload. The picker itself drives whether ESP
                    is on — select "None" to provision only, or pick an ESP to
                    reveal its credential fields. Fields render immediately so
                    the user can fill creds WHILE dropping the CSV (one motion,
                    not a two-step flow).

                    Worker count is deliberately NOT in the UI. It's a backend
                    concern (EMAIL_UPLOADER_DEFAULT_WORKERS env var, default 2 —
                    right-sized for Railway Hobby's 1GB RAM ceiling, since each
                    worker = one Chromium ≈ 400MB). */}
                <div className="space-y-3 rounded-lg border p-4">
                  <div>
                    <h3 className="text-sm font-medium">Step 3: ESP Auto-Upload</h3>
                    <p className="mt-1 text-xs text-muted-foreground">
                      As each tenant finishes provisioning, its mailboxes are auto-uploaded into the selected ESP via Microsoft OAuth. Pick &quot;None&quot; to just provision.
                    </p>
                  </div>

                  <label className="grid gap-1 text-sm md:max-w-xs">
                    <span className="font-medium">ESP</span>
                    <select
                      className="rounded border bg-background px-3 py-2 text-sm"
                      value={uploaderEsp}
                      onChange={(e) => {
                        const v = e.target.value;
                        setUploaderEsp(v === "none" ? "none" : v === "smartlead" ? "smartlead" : "instantly");
                      }}
                    >
                      <option value="none">None (provision only)</option>
                      <option value="instantly">Instantly</option>
                      <option value="smartlead">Smartlead</option>
                    </select>
                  </label>

                  {uploaderEsp !== "none" && (
                    <div className="space-y-4">
                      {uploaderEsp === "instantly" ? (
                        <div className="grid gap-4 md:grid-cols-2">
                          <label className="grid gap-1 text-sm md:col-span-2">
                            <span className="font-medium">Instantly Login Email</span>
                            <Input
                              type="email"
                              value={instEmail}
                              onChange={(e) => setInstEmail(e.target.value)}
                              placeholder="team@example.com"
                            />
                          </label>
                          <label className="grid gap-1 text-sm md:col-span-2">
                            <span className="font-medium">Instantly Login Password</span>
                            <div className="flex gap-2">
                              <Input
                                type={showUploaderSecrets ? "text" : "password"}
                                value={instPassword}
                                onChange={(e) => setInstPassword(e.target.value)}
                              />
                              <Button type="button" variant="outline" onClick={() => setShowUploaderSecrets((v) => !v)}>
                                {showUploaderSecrets ? "Hide" : "Show"}
                              </Button>
                            </div>
                          </label>
                          <label className="grid gap-1 text-sm">
                            <span className="font-medium">API Version</span>
                            <select
                              className="rounded border bg-background px-3 py-2 text-sm"
                              value={instApiVersion}
                              onChange={(e) => setInstApiVersion(e.target.value === "v2" ? "v2" : "v1")}
                            >
                              <option value="v1">v1</option>
                              <option value="v2">v2</option>
                            </select>
                          </label>
                          <label className="grid gap-1 text-sm">
                            <span className="font-medium">Workspace (leave blank for single)</span>
                            <Input
                              value={instWorkspace}
                              onChange={(e) => setInstWorkspace(e.target.value)}
                              placeholder="Inbox Nav"
                            />
                          </label>
                          <label className="grid gap-1 text-sm">
                            <span className="font-medium">API Key (v1)</span>
                            <Input
                              type={showUploaderSecrets ? "text" : "password"}
                              value={instV1Key}
                              onChange={(e) => setInstV1Key(e.target.value)}
                            />
                          </label>
                          <label className="grid gap-1 text-sm">
                            <span className="font-medium">API Key (v2)</span>
                            <Input
                              type={showUploaderSecrets ? "text" : "password"}
                              value={instV2Key}
                              onChange={(e) => setInstV2Key(e.target.value)}
                              placeholder={instApiVersion === "v2" ? "required" : "optional"}
                            />
                          </label>
                        </div>
                      ) : (
                        <div className="grid gap-4 md:grid-cols-2">
                          <label className="grid gap-1 text-sm md:col-span-2">
                            <span className="font-medium">Smartlead API Key</span>
                            <Input
                              type={showUploaderSecrets ? "text" : "password"}
                              value={slApiKey}
                              onChange={(e) => setSlApiKey(e.target.value)}
                            />
                          </label>
                          <label className="grid gap-1 text-sm md:col-span-2">
                            <span className="font-medium">Microsoft OAuth Login URL</span>
                            <Input
                              type="url"
                              value={slLoginUrl}
                              onChange={(e) => setSlLoginUrl(e.target.value)}
                              placeholder="https://login.microsoftonline.com/..."
                            />
                          </label>
                        </div>
                      )}

                      <p className="text-xs text-muted-foreground">
                        Credentials are encrypted at rest and only used for this batch. Upload progress for each tenant will appear on the batch progress page.
                      </p>
                    </div>
                  )}
                </div>

                <div className="flex flex-wrap items-center gap-3">
                  <Button type="button" variant="outline" onClick={() => {
                    setBulkRows([]);
                    setBulkFileName(null);
                    setBulkStatus(null);
                  }}>
                    Back
                  </Button>
                  <Button
                    type="button"
                    variant="outline"
                    onClick={() => {
                      if (invalidBulkRows.length === 0) {
                        setBulkStatus({ variant: "default", title: "No errors found", detail: "All rows are valid." });
                      } else {
                        setBulkStatus({
                          variant: "destructive",
                          title: "Fix CSV errors",
                          detail: invalidBulkRows.map((row) => `Row ${row.rowNumber}: ${row.errors.join(", ")}`).join(" | ")
                        });
                      }
                    }}
                  >
                    Fix Errors
                  </Button>
                  <Button type="button" onClick={processValidTenants} disabled={bulkSubmitting || validBulkRows.length === 0}>
                    {bulkSubmitting ? "Processing..." : "Process Valid Tenants"}
                  </Button>
                </div>
              </CardContent>
            </Card>
          </TabsContent>
        </Tabs>
      </section>
    </main>
  );
}
