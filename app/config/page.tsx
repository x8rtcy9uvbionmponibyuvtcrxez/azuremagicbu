"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

type AppConfig = {
  graphClientId: string;
  graphClientSecret: string;
  graphTenantId: string;
  cloudflareApiToken: string;
  cloudflareAccountId: string;
};

type AlertState = {
  variant: "default" | "destructive";
  title: string;
  description: string;
} | null;

const STORAGE_KEY = "m365-automation-config";

const defaultConfig: AppConfig = {
  graphClientId: "",
  graphClientSecret: "",
  graphTenantId: "common",
  cloudflareApiToken: "",
  cloudflareAccountId: ""
};

export default function ConfigPage() {
  const [config, setConfig] = useState<AppConfig>(defaultConfig);
  const [status, setStatus] = useState<AlertState>(null);
  const [graphTesting, setGraphTesting] = useState(false);
  const [cloudflareTesting, setCloudflareTesting] = useState(false);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return;
    try {
      const parsed = JSON.parse(raw) as Partial<AppConfig>;
      setConfig({ ...defaultConfig, ...parsed });
    } catch {
      setStatus({
        variant: "destructive",
        title: "Config read failed",
        description: "Stored configuration is invalid JSON."
      });
    }
  }, []);

  const isGraphReady = useMemo(
    () => Boolean(config.graphClientId && config.graphClientSecret && config.graphTenantId),
    [config]
  );
  const isCloudflareReady = useMemo(() => Boolean(config.cloudflareApiToken), [config]);

  const saveConfig = () => {
    setSaving(true);
    localStorage.setItem(STORAGE_KEY, JSON.stringify(config));
    setStatus({
      variant: "default",
      title: "Saved",
      description: "Configuration saved to localStorage and ready for this browser."
    });
    setTimeout(() => setSaving(false), 200);
  };

  const updateField = (key: keyof AppConfig, value: string) => {
    setConfig((prev) => ({ ...prev, [key]: value }));
  };

  const testGraph = async () => {
    if (!isGraphReady) {
      setStatus({ variant: "destructive", title: "Missing Graph fields", description: "Fill client ID, secret, and tenant." });
      return;
    }

    setGraphTesting(true);
    setStatus(null);

    try {
      const response = await fetch("/api/config/test", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          provider: "graph",
          config: {
            clientId: config.graphClientId,
            clientSecret: config.graphClientSecret,
            tenantId: config.graphTenantId
          }
        })
      });
      const payload = (await response.json()) as { ok: boolean; message: string; details?: string };
      setStatus({
        variant: payload.ok ? "default" : "destructive",
        title: payload.ok ? "Graph connected" : "Graph test failed",
        description: payload.details ? `${payload.message}: ${payload.details}` : payload.message
      });
    } catch (error) {
      setStatus({
        variant: "destructive",
        title: "Graph test failed",
        description: error instanceof Error ? error.message : "Unknown error"
      });
    } finally {
      setGraphTesting(false);
    }
  };

  const testCloudflare = async () => {
    if (!isCloudflareReady) {
      setStatus({
        variant: "destructive",
        title: "Missing Cloudflare token",
        description: "Provide API token before testing."
      });
      return;
    }

    setCloudflareTesting(true);
    setStatus(null);

    try {
      const response = await fetch("/api/config/test", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          provider: "cloudflare",
          config: {
            apiToken: config.cloudflareApiToken,
            accountId: config.cloudflareAccountId
          }
        })
      });
      const payload = (await response.json()) as { ok: boolean; message: string; details?: string };
      setStatus({
        variant: payload.ok ? "default" : "destructive",
        title: payload.ok ? "Cloudflare connected" : "Cloudflare test failed",
        description: payload.details ? `${payload.message}: ${payload.details}` : payload.message
      });
    } catch (error) {
      setStatus({
        variant: "destructive",
        title: "Cloudflare test failed",
        description: error instanceof Error ? error.message : "Unknown error"
      });
    } finally {
      setCloudflareTesting(false);
    }
  };

  return (
    <main className="mx-auto min-h-screen w-full max-w-5xl p-6 md:p-10">
      <div className="mb-6 flex items-center justify-between gap-3">
        <div>
          <h1 className="text-3xl font-semibold tracking-tight">Configuration</h1>
          <p className="text-sm text-muted-foreground">Set Graph + Cloudflare credentials used by this browser session.</p>
        </div>
        <Button asChild variant="outline">
          <Link href="/">Back to Dashboard</Link>
        </Button>
      </div>

      {status ? (
        <Alert variant={status.variant} className="mb-6">
          <AlertTitle>{status.title}</AlertTitle>
          <AlertDescription>{status.description}</AlertDescription>
        </Alert>
      ) : null}

      <div className="grid gap-6 md:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>Microsoft Graph</CardTitle>
            <CardDescription>Client credentials flow for app-only access.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="graphClientId">Client ID</Label>
              <Input
                id="graphClientId"
                value={config.graphClientId}
                onChange={(event) => updateField("graphClientId", event.target.value)}
                placeholder="00000000-0000-0000-0000-000000000000"
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="graphClientSecret">Client Secret</Label>
              <Input
                id="graphClientSecret"
                type="password"
                value={config.graphClientSecret}
                onChange={(event) => updateField("graphClientSecret", event.target.value)}
                placeholder="Paste secret"
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="graphTenantId">Tenant ID</Label>
              <Input
                id="graphTenantId"
                value={config.graphTenantId}
                onChange={(event) => updateField("graphTenantId", event.target.value)}
                placeholder="common or tenant GUID"
              />
            </div>
            <Button type="button" variant="outline" onClick={testGraph} disabled={graphTesting || !isGraphReady}>
              {graphTesting ? "Testing Graph..." : "Test Graph Connection"}
            </Button>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Cloudflare</CardTitle>
            <CardDescription>Token used for zone and DNS operations.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="cloudflareApiToken">API Token</Label>
              <Input
                id="cloudflareApiToken"
                type="password"
                value={config.cloudflareApiToken}
                onChange={(event) => updateField("cloudflareApiToken", event.target.value)}
                placeholder="Cloudflare API token"
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="cloudflareAccountId">Account ID (optional)</Label>
              <Input
                id="cloudflareAccountId"
                value={config.cloudflareAccountId}
                onChange={(event) => updateField("cloudflareAccountId", event.target.value)}
                placeholder="Optional account scope"
              />
            </div>
            <Button type="button" variant="outline" onClick={testCloudflare} disabled={cloudflareTesting || !isCloudflareReady}>
              {cloudflareTesting ? "Testing Cloudflare..." : "Test Cloudflare Connection"}
            </Button>
          </CardContent>
        </Card>
      </div>

      <div className="mt-8 flex items-center gap-3">
        <Button type="button" onClick={saveConfig} disabled={saving}>
          {saving ? "Saving..." : "Save Configuration"}
        </Button>
        <p className="text-sm text-muted-foreground">Config auto-loads from localStorage on this browser.</p>
      </div>
    </main>
  );
}
