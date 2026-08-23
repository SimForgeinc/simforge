"use client";

import { Skeleton } from "@/app/components/ui/skeleton";
import type { GalleryAssetSummary } from "@/app/lib/asset-gallery/contracts";
import { AssetCard } from "./AssetCard";

const GRID_CLASS =
  "grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 2xl:grid-cols-5";

/**
 * A catalog is a list of things, so the grid is a real list: assistive tech
 * gets the item count from the markup instead of inferring it from a run of
 * sibling buttons, and the visible count in the toolbar has something to agree
 * with.
 */
export function AssetGalleryGrid({
  assets,
  onSelect,
}: {
  assets: readonly GalleryAssetSummary[];
  onSelect: (asset: GalleryAssetSummary) => void;
}) {
  return (
    <ul className={GRID_CLASS}>
      {assets.map((asset) => (
        <li key={asset.catalogId}>
          <AssetCard asset={asset} onSelect={onSelect} />
        </li>
      ))}
    </ul>
  );
}

/**
 * Shown while a filter change is in flight and nothing is on screen yet.
 *
 * The tiles are shaped like real ones — square thumbnail, two text lines — so
 * the swap does not reflow the page, and the region is `aria-hidden` with a
 * live status beside it: a screen reader wants "loading assets" once, not nine
 * placeholder cards.
 */
export function AssetGalleryGridSkeleton({ count = 10 }: { count?: number }) {
  return (
    <>
      <p role="status" className="sr-only">
        Loading assets…
      </p>
      <div aria-hidden="true" className={GRID_CLASS}>
        {Array.from({ length: count }, (_, index) => (
          <div key={index} className="overflow-hidden rounded-lg border border-border bg-card">
            <Skeleton className="aspect-square rounded-none bg-muted/40" />
            <div className="flex flex-col gap-2.5 p-3.5">
              <div className="flex items-center justify-between gap-2">
                <Skeleton className="h-3.5 w-2/3" />
                <Skeleton className="h-3.5 w-12 rounded-full" />
              </div>
              <div className="flex items-center justify-between gap-2">
                <Skeleton className="h-3 w-24" />
                <Skeleton className="h-3 w-16" />
              </div>
            </div>
          </div>
        ))}
      </div>
    </>
  );
}
