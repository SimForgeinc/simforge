"use client";

import dynamic from "next/dynamic";
import { AlertTriangle, Check, Clipboard, Loader2, Pencil, Trash2 } from "lucide-react";
import { useEffect, useState } from "react";
import { CarlaCompatibilityPill } from "@/app/components/CarlaCompatibilityPill";
import { Button } from "@/app/components/ui/button";
import { Input } from "@/app/components/ui/input";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/app/components/ui/sheet";
import type { GalleryAssetSummary } from "@/app/lib/asset-gallery/contracts";
import { GALLERY_UPLOAD_CARLA_COMPATIBILITY } from "./gallery-filters";

/**
 * Loaded on demand, and the one place in this page where that is warranted: the
 * preview pulls three.js and a GLB loader, which is most of the route's weight
 * and is only ever needed once a visitor opens a specific asset.
 */
const AssetModelPreview = dynamic(() => import("./AssetModelPreview"), {
  ssr: false,
  loading: () => (
    <div className="grid h-72 place-items-center rounded-xl border border-border bg-card text-xs text-muted-foreground">
      Loading preview…
    </div>
  ),
});

/**
 * How many scenarios place this model.
 *
 * The count is an informative warning shown at the instant someone presses
 * Delete, never a gate: a lookup that fails or never answers must not strand a
 * moderator in front of a button that will not fire, so `unknown` still allows
 * the removal — it just does so without the number.
 */
type UsageState =
  | { phase: "loading" }
  | { phase: "known"; scenarioCount: number }
  | { phase: "unknown" };

export function AssetDetailDrawer({
  asset,
  onClose,
  onDeleted,
  onRenamed,
}: {
  asset: GalleryAssetSummary | null;
  onClose: () => void;
  onDeleted: (assetId: string) => void;
  onRenamed: (asset: GalleryAssetSummary) => void;
}) {
  const [copied, setCopied] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [renaming, setRenaming] = useState(false);
  /** `null` while not renaming, so an empty draft stays distinct from closed. */
  const [renameDraft, setRenameDraft] = useState<string | null>(null);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [usage, setUsage] = useState<UsageState>({ phase: "loading" });
  const [error, setError] = useState<string | null>(null);

  const assetId = asset?.assetId ?? null;

  // A drawer showing a different asset must not inherit the previous one's
  // armed confirmation or half-typed rename.
  useEffect(() => {
    setConfirmingDelete(false);
    setRenameDraft(null);
    setError(null);
  }, [assetId]);

  useEffect(() => {
    if (!confirmingDelete || !assetId) return;
    const abort = new AbortController();
    setUsage({ phase: "loading" });
    void fetch(`/api/asset-gallery/${assetId}/usage`, { cache: "no-store", signal: abort.signal })
      .then(async (response) => {
        if (!response.ok) throw new Error(`Usage lookup failed (${response.status}).`);
        return (await response.json()) as { scenarioCount?: unknown };
      })
      .then((body) => {
        setUsage(
          typeof body.scenarioCount === "number"
            ? { phase: "known", scenarioCount: body.scenarioCount }
            : { phase: "unknown" },
        );
      })
      .catch(() => {
        if (!abort.signal.aborted) setUsage({ phase: "unknown" });
      });
    return () => abort.abort();
  }, [confirmingDelete, assetId]);

  const copyCatalogId = async () => {
    if (!asset) return;
    await navigator.clipboard.writeText(asset.catalogId);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1800);
  };

  const deleteAsset = async () => {
    if (!asset) return;
    setDeleting(true);
    setError(null);
    try {
      const response = await fetch(`/api/asset-gallery/${asset.assetId}`, { method: "DELETE" });
      if (!response.ok) {
        const body = (await response.json().catch(() => null)) as { error?: { message?: string } } | null;
        throw new Error(body?.error?.message ?? "The asset could not be deleted.");
      }
      onDeleted(asset.assetId);
      onClose();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "The asset could not be deleted.");
    } finally {
      setDeleting(false);
    }
  };

  /**
   * Rename in place. The catalog id is deliberately untouched, so every scenario
   * already bound to this asset keeps working - the name is presentation.
   */
  const renameAsset = async () => {
    const next = renameDraft?.trim();
    if (!asset || !next || next === asset.title) {
      setRenameDraft(null);
      return;
    }
    setRenaming(true);
    setError(null);
    try {
      const response = await fetch(`/api/asset-gallery/${asset.assetId}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ title: next }),
      });
      if (!response.ok) throw new Error("The asset could not be renamed.");
      const body = (await response.json()) as { asset: GalleryAssetSummary };
      onRenamed(body.asset);
      setRenameDraft(null);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "The asset could not be renamed.");
    } finally {
      setRenaming(false);
    }
  };

  return (
    <Sheet open={asset !== null} onOpenChange={(open) => { if (!open) onClose(); }}>
      <SheetContent className="w-full overflow-y-auto border-border bg-background sm:max-w-xl">
        {asset ? (
          <div className="space-y-6">
            <SheetHeader>
              <SheetTitle className="pr-8 text-2xl">{asset.title}</SheetTitle>
              <SheetDescription>
                Uploaded by {asset.createdByName ?? "SimForge user"} ·{" "}
                {new Date(asset.createdAt).toLocaleDateString()} · version {asset.version}
              </SheetDescription>
            </SheetHeader>

            <AssetModelPreview catalogId={asset.catalogId} />

            <div className="grid grid-cols-2 gap-3 text-sm">
              <div className="rounded-lg border border-border bg-muted/30 p-3">
                <p className="text-[10px] uppercase tracking-wider text-muted-foreground">Class</p>
                <p className="mt-1 capitalize">{asset.actorClass.replaceAll("_", " ")}</p>
              </div>
              <div className="rounded-lg border border-border bg-muted/30 p-3">
                <p className="text-[10px] uppercase tracking-wider text-muted-foreground">Triangles</p>
                <p className="mt-1 tabular-nums">{asset.triangleCount.toLocaleString()}</p>
              </div>
              <div className="rounded-lg border border-border bg-muted/30 p-3">
                <p className="text-[10px] uppercase tracking-wider text-muted-foreground">Dimensions</p>
                <p className="mt-1 tabular-nums">
                  {asset.dims.l.toFixed(2)} × {asset.dims.w.toFixed(2)} × {asset.dims.h.toFixed(2)} m
                </p>
              </div>
              <div className="rounded-lg border border-border bg-muted/30 p-3">
                <p className="text-[10px] uppercase tracking-wider text-muted-foreground">Source</p>
                <p className="mt-1 uppercase">
                  {asset.sourceFormat} · {(asset.byteLength / 1_048_576).toFixed(1)} MB
                </p>
              </div>
              <div className="col-span-2 rounded-lg border border-border bg-muted/30 p-3">
                <p className="text-[10px] uppercase tracking-wider text-muted-foreground">CARLA</p>
                <div className="mt-1.5 flex flex-col items-start gap-2">
                  <CarlaCompatibilityPill compatibility={GALLERY_UPLOAD_CARLA_COMPATIBILITY} size="sm" />
                  <p className="text-xs leading-5 text-muted-foreground">
                    Runs in browser preview and browser-recorded renders, but not CARLA renders because it has no runtime blueprint.
                  </p>
                </div>
              </div>
            </div>

            {asset.description ? (
              <p className="text-sm leading-6 text-foreground/80">{asset.description}</p>
            ) : null}

            {asset.tags.length > 0 ? (
              <div className="flex flex-wrap gap-1.5">
                {asset.tags.map((tag) => (
                  <span key={tag} className="rounded-full border border-border px-2.5 py-1 text-xs text-muted-foreground">
                    {tag}
                  </span>
                ))}
              </div>
            ) : null}

            <section aria-labelledby="asset-clips-heading">
              <h3 id="asset-clips-heading" className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                Animation clips
              </h3>
              {asset.clips.length > 0 ? (
                <ul className="mt-2 space-y-1 rounded-lg border border-border p-3 text-sm">
                  {asset.clips.map((clip) => (
                    <li key={clip} className="flex justify-between gap-3">
                      <span className="truncate">{clip}</span>
                      <span className="text-xs text-muted-foreground">
                        {clip === asset.idleClip ? "Idle" : clip === asset.locomotionClip ? "Locomotion" : ""}
                      </span>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="mt-2 text-sm text-muted-foreground">No animation clips</p>
              )}
            </section>

            <div className="space-y-3">
              <p className="break-all rounded-lg bg-muted/40 px-3 py-2 font-mono text-xs text-muted-foreground">
                {asset.catalogId}
              </p>

              {renameDraft !== null ? (
                <form
                  className="flex flex-wrap items-center gap-2"
                  onSubmit={(event) => {
                    event.preventDefault();
                    void renameAsset();
                  }}
                >
                  <Input
                    aria-label="Asset title"
                    autoFocus
                    maxLength={120}
                    value={renameDraft}
                    onChange={(event) => setRenameDraft(event.target.value)}
                    className="h-9 min-w-0 flex-1"
                  />
                  <Button type="submit" size="sm" className="h-9" disabled={renaming || renameDraft.trim() === ""}>
                    {renaming ? <Loader2 aria-hidden="true" className="animate-spin" /> : null}
                    {renaming ? "Saving…" : "Save title"}
                  </Button>
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    className="h-9"
                    disabled={renaming}
                    onClick={() => setRenameDraft(null)}
                  >
                    Cancel
                  </Button>
                </form>
              ) : confirmingDelete ? (
                <div
                  role="group"
                  aria-labelledby="asset-delete-heading"
                  className="rounded-lg border border-destructive/50 bg-destructive/10 p-3"
                >
                  <p id="asset-delete-heading" className="text-sm font-semibold">
                    Remove “{asset.title}” from the public gallery?
                  </p>

                  {usage.phase === "loading" ? (
                    <p className="mt-2 inline-flex items-center gap-1.5 text-xs text-muted-foreground">
                      <Loader2 aria-hidden="true" className="size-3 animate-spin" />
                      Checking which scenarios use it…
                    </p>
                  ) : usage.phase === "known" && usage.scenarioCount > 0 ? (
                    <p className="mt-2 inline-flex items-center gap-2 rounded-md border border-primary/40 bg-primary/10 px-2.5 py-1.5 text-sm font-semibold text-primary">
                      <AlertTriangle aria-hidden="true" className="size-4" />
                      Used by {usage.scenarioCount} {usage.scenarioCount === 1 ? "scenario" : "scenarios"}
                    </p>
                  ) : usage.phase === "known" ? (
                    <p className="mt-2 text-xs text-muted-foreground">No scenario places this model.</p>
                  ) : (
                    <p className="mt-2 text-xs text-muted-foreground">
                      Scenario usage could not be checked, so remove this one with care.
                    </p>
                  )}

                  <p className="mt-2 text-xs leading-5 text-muted-foreground">
                    The gallery is community-moderated: anyone signed in can remove an asset, and the removal is
                    recorded against your account.
                  </p>

                  <div className="mt-3 flex flex-wrap gap-2">
                    <Button type="button" size="sm" variant="destructive" disabled={deleting} onClick={() => void deleteAsset()}>
                      {deleting ? <Loader2 aria-hidden="true" className="animate-spin" /> : <Trash2 aria-hidden="true" />}
                      {deleting ? "Removing…" : "Remove asset"}
                    </Button>
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      disabled={deleting}
                      onClick={() => setConfirmingDelete(false)}
                    >
                      Keep it
                    </Button>
                  </div>
                </div>
              ) : (
                <div className="flex flex-wrap gap-2">
                  <Button type="button" size="sm" variant="outline" onClick={() => void copyCatalogId()}>
                    {copied ? <Check aria-hidden="true" /> : <Clipboard aria-hidden="true" />}
                    {copied ? "Copied" : "Copy catalog ID"}
                  </Button>
                  {/* Renaming is owner-only on purpose. Removal is destructive but
                      soft and attributed, so open moderation carries it; rewriting
                      another author's label leaves no such trace, and the API
                      refuses it regardless. */}
                  {asset.ownedByViewer ? (
                    <Button type="button" size="sm" variant="outline" onClick={() => setRenameDraft(asset.title)}>
                      <Pencil aria-hidden="true" /> Rename
                    </Button>
                  ) : null}
                  <Button type="button" size="sm" variant="destructive" onClick={() => setConfirmingDelete(true)}>
                    <Trash2 aria-hidden="true" /> Delete
                  </Button>
                </div>
              )}

              {error ? (
                <p role="alert" className="text-sm text-red-300">
                  {error}
                </p>
              ) : null}
            </div>
          </div>
        ) : null}
      </SheetContent>
    </Sheet>
  );
}
