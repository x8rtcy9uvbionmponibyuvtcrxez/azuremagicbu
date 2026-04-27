/**
 * /services — landing page for the Services tab. Shows 4 cards (one per
 * auxiliary op): Apply Photos, Rename Users, Remove Users, Swap Users.
 * Clicking a card routes to /services/{op} for the wizard, except photo
 * which opens a tenant picker dialog and redirects to /batch/{id} (the
 * existing photo UI).
 */

"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { Camera, Edit3, Trash2, Repeat, ArrowRight } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

type Tenant = {
  id: string;
  tenantName: string;
  domain: string;
  status: string;
};

const SERVICES = [
  {
    op: "photo",
    title: "Apply Profile Photos",
    description:
      "Upload photos per persona and apply them to all matching mailboxes via Microsoft Graph. Visible in Outlook and across the M365 ecosystem (Gmail-side avatar requires BIMI separately).",
    icon: Camera,
    color: "bg-violet-100 text-violet-900",
    note: "Opens the per-tenant photo UI",
  },
  {
    op: "rename",
    title: "Rename Users",
    description:
      "Bulk-update display names. Change M365 displayName, delete + re-OAuth in Instantly so cold-email recipients see the new name. Smartlead-side label remains as-is.",
    icon: Edit3,
    color: "bg-blue-100 text-blue-900",
    note: "Heavy: ~30 sec/row (Selenium re-OAuth)",
  },
  {
    op: "remove",
    title: "Remove Users",
    description:
      "Delete a list of users from M365 (frees license), Instantly, and Smartlead. Default-on for all three; per-ESP skip checkboxes available before execute.",
    icon: Trash2,
    color: "bg-rose-100 text-rose-900",
    note: "Destructive — preview confirms before write",
  },
  {
    op: "swap",
    title: "Swap Users",
    description:
      "Replace user A with user B. Deletes A everywhere, creates B in M365 with same display name, OAuths B into ESPs. Use to rotate burned mailboxes.",
    icon: Repeat,
    color: "bg-amber-100 text-amber-900",
    note: "Heaviest op — combines remove + create + re-OAuth",
  },
] as const;

export default function ServicesPage() {
  const [tenants, setTenants] = useState<Tenant[]>([]);
  const [photoOpen, setPhotoOpen] = useState(false);

  useEffect(() => {
    void fetch("/api/services/tenants")
      .then((r) => r.json())
      .then((d) => setTenants(d.tenants || []));
  }, []);

  return (
    <div className="container mx-auto max-w-5xl px-4 py-8">
      <div className="mb-8">
        <h1 className="text-3xl font-bold">Services</h1>
        <p className="mt-2 text-muted-foreground">
          One-off auxiliary operations on existing tenants. Each service runs against
          the tenant you pick, takes a CSV, shows a preview, and applies after you
          confirm. Operations are logged in the audit table for review and retry.
        </p>
      </div>

      <div className="grid gap-4 md:grid-cols-2">
        {SERVICES.map((s) => {
          const Icon = s.icon;
          if (s.op === "photo") {
            return (
              <Card
                key={s.op}
                className="cursor-pointer transition-shadow hover:shadow-md"
                onClick={() => setPhotoOpen(true)}
              >
                <CardHeader>
                  <div className="flex items-center gap-3">
                    <div className={`rounded-lg p-2 ${s.color}`}>
                      <Icon className="h-5 w-5" />
                    </div>
                    <CardTitle className="text-lg">{s.title}</CardTitle>
                  </div>
                </CardHeader>
                <CardContent>
                  <CardDescription className="leading-relaxed">{s.description}</CardDescription>
                  <p className="mt-3 text-xs italic text-muted-foreground">{s.note}</p>
                </CardContent>
              </Card>
            );
          }
          return (
            <Link key={s.op} href={`/services/${s.op}`}>
              <Card className="cursor-pointer transition-shadow hover:shadow-md">
                <CardHeader>
                  <div className="flex items-center gap-3">
                    <div className={`rounded-lg p-2 ${s.color}`}>
                      <Icon className="h-5 w-5" />
                    </div>
                    <CardTitle className="text-lg">{s.title}</CardTitle>
                  </div>
                </CardHeader>
                <CardContent>
                  <CardDescription className="leading-relaxed">{s.description}</CardDescription>
                  <p className="mt-3 flex items-center text-xs italic text-muted-foreground">
                    {s.note}
                    <ArrowRight className="ml-auto h-4 w-4 not-italic text-foreground" />
                  </p>
                </CardContent>
              </Card>
            </Link>
          );
        })}
      </div>

      {/* Photo tenant-picker dialog */}
      {photoOpen ? (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
          onClick={() => setPhotoOpen(false)}
        >
          <div
            className="w-full max-w-md rounded-lg border bg-card p-6 shadow-xl"
            onClick={(e) => e.stopPropagation()}
          >
            <h2 className="mb-2 text-lg font-semibold">Apply Profile Photos</h2>
            <p className="mb-4 text-sm text-muted-foreground">
              Pick a tenant to open its photo upload UI.
            </p>
            <div className="max-h-80 space-y-1 overflow-y-auto">
              {tenants.length === 0 ? (
                <p className="text-sm text-muted-foreground">No tenants available.</p>
              ) : (
                tenants.map((t) => (
                  <Link
                    key={t.id}
                    href={`/batch/${(t as { batch?: { id?: string } }).batch?.id || ""}#tenant-${t.id}`}
                    className="flex items-center justify-between rounded border px-3 py-2 hover:bg-muted"
                  >
                    <div>
                      <div className="text-sm font-medium">{t.tenantName}</div>
                      <div className="text-xs text-muted-foreground">{t.domain}</div>
                    </div>
                    <ArrowRight className="h-4 w-4 text-muted-foreground" />
                  </Link>
                ))
              )}
            </div>
            <div className="mt-4 flex justify-end">
              <Button variant="outline" size="sm" onClick={() => setPhotoOpen(false)}>
                Cancel
              </Button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
