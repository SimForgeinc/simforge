"use client";

import { ArrowUpRight, Sparkles, User } from "lucide-react";
import { CarlaCompatibilityPill } from "@/app/components/CarlaCompatibilityPill";
import { Badge } from "@/app/components/ui/badge";
import type { GalleryAssetSummary } from "@/app/lib/asset-gallery/contracts";
import { GALLERY_UPLOAD_CARLA_COMPATIBILITY } from "./gallery-filters";

/**
 * One tile in the public catalog.
 *
 * The whole tile is the button rather than a link: opening an asset raises a
 * drawer over the grid instead of navigating, so there is no URL to put in an
 * anchor and a link would lie about where Enter goes. Its accessible name comes
 * from the text it already renders — title, class, author, triangle count — so
 * the thumbnail stays `alt=""` instead of repeating the title to a screen
 * reader that is about to hear it anyway.
 */
export function AssetCard({
  asset,
  onSelect,
}: {
  asset: GalleryAssetSummary;
  onSelect: (asset: GalleryAssetSummary) => void;
}) {
  return (
    <button
      type="button"
      onClick={() => onSelect(asset)}
      className="group flex w-full flex-col overflow-hidden rounded-lg border border-border bg-card text-left transition-[transform,border-color,box-shadow] duration-200 hover:-translate-y-0.5 hover:border-border/80 hover:shadow-lg hover:shadow-black/30 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
    >
      <div className="relative aspect-square overflow-hidden bg-[radial-gradient(circle_at_50%_42%,hsl(var(--muted))_0%,hsl(var(--card))_70%)]">
        {/* eslint-disable-next-line @next/next/no-img-element -- short-lived presigned S3 thumbnail; next/image cannot cache a rotating signature */}
        <img
          src={asset.thumbnailUrl}
          alt=""
          loading="lazy"
          decoding="async"
          className="h-full w-full object-contain transition-transform duration-300 group-hover:scale-[1.03]"
        />
        <div className="absolute left-2 top-2">
          <CarlaCompatibilityPill compatibility={GALLERY_UPLOAD_CARLA_COMPATIBILITY} size="sm" />
        </div>
        {asset.animated ? (
          <Badge
            variant="secondary"
            className="absolute right-2 top-2 h-5 gap-1 border-primary/25 bg-background/80 px-1.5 py-0 text-[10px] text-primary"
          >
            <Sparkles aria-hidden="true" className="size-3 animate-pulse" />
            Animated
          </Badge>
        ) : null}
        {/* Hover affordance rather than a permanent "open" chip: the grid is
            scanned, and 24 identical call-to-actions add noise to every scan.
            Hidden from the tree so it does not prefix the tile's accessible
            name — the button role already says the tile is activatable. */}
        <div
          aria-hidden="true"
          className="pointer-events-none absolute inset-x-0 bottom-0 flex items-center justify-end gap-1 bg-gradient-to-t from-black/70 to-transparent px-3 pb-2 pt-8 text-xs font-medium text-primary opacity-0 transition-opacity duration-200 group-hover:opacity-100 group-focus-visible:opacity-100"
        >
          View details
          <ArrowUpRight aria-hidden="true" className="size-3.5" />
        </div>
      </div>

      <div className="flex flex-1 flex-col gap-2 p-3.5">
        <div className="flex items-start justify-between gap-2">
          <h3 className="min-w-0 truncate text-sm font-semibold leading-snug transition-colors group-hover:text-primary">
            {asset.title}
          </h3>
          <span className="shrink-0 rounded-full border border-border px-2 py-0.5 text-[10px] capitalize text-muted-foreground">
            {asset.actorClass.replaceAll("_", " ")}
          </span>
        </div>
        <div className="mt-auto flex items-center justify-between gap-2 text-xs text-muted-foreground">
          <span className="inline-flex min-w-0 items-center gap-1.5">
            <User aria-hidden="true" className="size-3 shrink-0" />
            <span className="truncate">{asset.createdByName ?? "SimForge user"}</span>
          </span>
          <span className="shrink-0 font-mono tabular-nums">
            {asset.triangleCount.toLocaleString()} tris
          </span>
        </div>
      </div>
    </button>
  );
}
