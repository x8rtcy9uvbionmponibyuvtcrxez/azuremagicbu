/**
 * Profile Photos panel for a single tenant. Mounted inside the tenant card
 * on /batch/[id]. Self-contained: fetches its own persona list, handles
 * upload + apply, displays state.
 *
 * Behaviour notes:
 *   • Personas auto-extract during batch creation, but the panel falls back
 *     to POST /api/tenant/{id}/personas if the list is empty (handles old
 *     tenants provisioned before the photo pipeline shipped).
 *   • Auto-apply fires from worker Phase 4.5 once all personas have photos.
 *     The "Apply Photos" button here is the manual trigger / retry path.
 *   • Photo bytes never round-trip through React state — the <img> tag
 *     references the streaming endpoint directly.
 */

"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";

type Persona = {
  id: string;
  personaName: string;
  photoMime: string | null;
  photoSize: number | null;
  photoApplied: boolean;
  applyError: string | null;
  appliedAt: string | null;
  hasPhoto: boolean;
};

type ApplyResult = {
  applied: number;
  failed: number;
  skipped: number;
  perMailbox: Record<string, { state: "applied" | "failed" | "skipped"; reason?: string }>;
};

export function TenantProfilePhotos({ tenantId }: { tenantId: string }) {
  const [personas, setPersonas] = useState<Persona[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [uploadBusy, setUploadBusy] = useState<Record<string, boolean>>({});
  const [applyBusy, setApplyBusy] = useState(false);
  const [applyResult, setApplyResult] = useState<ApplyResult | null>(null);
  const fileInputs = useRef<Record<string, HTMLInputElement | null>>({});

  const reload = useCallback(async () => {
    try {
      const res = await fetch(`/api/tenant/${tenantId}/personas`, { cache: "no-store" });
      const data = await res.json();
      setPersonas(data.personas || []);
      // If empty, try the extract endpoint once — covers old tenants.
      if ((data.personas || []).length === 0) {
        await fetch(`/api/tenant/${tenantId}/personas`, { method: "POST" });
        const retry = await fetch(`/api/tenant/${tenantId}/personas`, { cache: "no-store" });
        const retryData = await retry.json();
        setPersonas(retryData.personas || []);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, [tenantId]);

  useEffect(() => {
    void reload();
  }, [reload]);

  async function handleUpload(persona: Persona, file: File) {
    setUploadBusy((prev) => ({ ...prev, [persona.id]: true }));
    setError(null);
    try {
      const fd = new FormData();
      fd.append("file", file);
      const res = await fetch(`/api/tenant/${tenantId}/personas/${persona.id}/photo`, {
        method: "POST",
        body: fd
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error || `Upload failed (${res.status})`);
      } else {
        await reload();
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setUploadBusy((prev) => ({ ...prev, [persona.id]: false }));
    }
  }

  async function handleClear(persona: Persona) {
    if (!confirm(`Remove photo for "${persona.personaName}"?`)) return;
    setUploadBusy((prev) => ({ ...prev, [persona.id]: true }));
    setError(null);
    try {
      const res = await fetch(`/api/tenant/${tenantId}/personas/${persona.id}/photo`, {
        method: "DELETE"
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        setError(data.error || `Delete failed (${res.status})`);
      } else {
        await reload();
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setUploadBusy((prev) => ({ ...prev, [persona.id]: false }));
    }
  }

  async function handleApply() {
    setApplyBusy(true);
    setError(null);
    setApplyResult(null);
    try {
      const res = await fetch(`/api/tenant/${tenantId}/apply-photos`, { method: "POST" });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error || `Apply failed (${res.status})`);
      } else {
        setApplyResult({
          applied: data.applied,
          failed: data.failed,
          skipped: data.skipped,
          perMailbox: data.perMailbox
        });
        await reload();
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setApplyBusy(false);
    }
  }

  if (loading) {
    return (
      <div className="rounded-lg border bg-muted/30 p-4 text-sm text-muted-foreground">
        Loading profile photos…
      </div>
    );
  }
  if (personas.length === 0) {
    return (
      <div className="rounded-lg border bg-muted/30 p-4 text-sm text-muted-foreground">
        No personas yet. Personas auto-extract from inboxNames after batch creation.
      </div>
    );
  }

  const allHavePhotos = personas.every((p) => p.hasPhoto);
  const someHavePhotos = personas.some((p) => p.hasPhoto);

  return (
    <div className="rounded-lg border bg-card p-4">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <span className="text-sm font-medium">Profile Photos</span>
          <span className="text-xs text-muted-foreground">
            ({personas.filter((p) => p.hasPhoto).length}/{personas.length} uploaded)
          </span>
        </div>
        <Button
          size="sm"
          variant={allHavePhotos ? "default" : "outline"}
          disabled={!someHavePhotos || applyBusy}
          onClick={() => void handleApply()}
        >
          {applyBusy ? "Applying…" : "Apply Photos"}
        </Button>
      </div>

      {error ? (
        <div className="mb-3 rounded-md border border-rose-200 bg-rose-50 px-3 py-2 text-xs text-rose-800">
          {error}
        </div>
      ) : null}

      {applyResult ? (
        <div className="mb-3 rounded-md border border-emerald-200 bg-emerald-50 px-3 py-2 text-xs text-emerald-800">
          Applied {applyResult.applied} • failed {applyResult.failed} • skipped {applyResult.skipped}
        </div>
      ) : null}

      <div className="space-y-2">
        {personas.map((persona) => {
          const busy = uploadBusy[persona.id];
          return (
            <div
              key={persona.id}
              className="flex flex-wrap items-center gap-3 rounded-md border bg-background p-2"
            >
              <div className="h-12 w-12 shrink-0 overflow-hidden rounded-full border bg-muted">
                {persona.hasPhoto ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img
                    src={`/api/personas/${persona.id}/photo?t=${persona.appliedAt || persona.id}`}
                    alt={persona.personaName}
                    className="h-full w-full object-cover"
                  />
                ) : (
                  <div className="flex h-full w-full items-center justify-center text-xs text-muted-foreground">
                    ?
                  </div>
                )}
              </div>
              <div className="min-w-0 flex-1">
                <div className="truncate text-sm font-medium">{persona.personaName}</div>
                <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                  {persona.hasPhoto ? (
                    <>
                      <span>{Math.round((persona.photoSize || 0) / 1024)} KB</span>
                      <span>{(persona.photoMime || "").replace("image/", "")}</span>
                      {persona.photoApplied ? (
                        <Badge className="bg-emerald-100 text-emerald-800 hover:bg-emerald-100">
                          applied
                        </Badge>
                      ) : (
                        <Badge variant="outline">pending</Badge>
                      )}
                      {persona.applyError ? (
                        <span className="text-rose-700" title={persona.applyError}>
                          last error
                        </span>
                      ) : null}
                    </>
                  ) : (
                    <span>no photo uploaded</span>
                  )}
                </div>
              </div>
              <div className="flex items-center gap-2">
                <input
                  ref={(el) => {
                    fileInputs.current[persona.id] = el;
                  }}
                  type="file"
                  accept="image/jpeg,image/png"
                  className="hidden"
                  onChange={(e) => {
                    const f = e.target.files?.[0];
                    if (f) void handleUpload(persona, f);
                    e.currentTarget.value = "";
                  }}
                />
                <Button
                  size="sm"
                  variant="outline"
                  disabled={busy}
                  onClick={() => fileInputs.current[persona.id]?.click()}
                >
                  {busy ? "…" : persona.hasPhoto ? "Replace" : "Upload"}
                </Button>
                {persona.hasPhoto ? (
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={busy}
                    onClick={() => void handleClear(persona)}
                  >
                    Clear
                  </Button>
                ) : null}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
