"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import type { MapAsset } from "@simforge/studio-shared";
import MapAssetsMapDynamic from "@/app/components/map-assets-map/MapAssetsMapDynamic";
import { cn } from "@/app/lib/utils";
import { getCardStats, getMapCapabilities, humanizeTag, rankDominantTags } from "./map-card-data";
import { CapabilityHints, CardStatsRow } from "./map-card-display";

interface MapCatalogMapViewProps {
  assets: MapAsset[];
}

// The map-view rail is narrow (320px), so show a tighter stat/tag set than the
// grid card while keeping the same capability hints and dominance ordering.
const MAX_RAIL_STATS = 5;
const MAX_RAIL_TAGS = 2;

export function MapCatalogMapView({ assets }: MapCatalogMapViewProps) {
  const router = useRouter();
  const [hoveredId, setHoveredId] = useState<string | null>(null);

  return (
    <div className="flex h-full min-h-0">
      {/* Left: compact list */}
      <div className="w-80 shrink-0 border-r border-border overflow-y-auto">
        {assets.length === 0 ? (
          <p className="px-4 py-8 text-xs text-muted-foreground text-center">No maps found.</p>
        ) : (
          assets.map((asset) => {
            const stats = getCardStats(asset).slice(0, MAX_RAIL_STATS);
            const caps = getMapCapabilities(asset);
            const rankedTags = rankDominantTags(asset);
            const tags = rankedTags.slice(0, MAX_RAIL_TAGS);
            const remainingTags = rankedTags.length - MAX_RAIL_TAGS;
            const placeContext = asset.place_context;
            const locationStr = placeContext
              ? [placeContext.city, placeContext.state, placeContext.country_code?.toUpperCase()]
                  .filter(Boolean)
                  .join(", ")
              : null;

            return (
              <Link
                key={asset.map_asset_id}
                href={`/dashboard/map-assets/${asset.map_asset_id}`}
                className={cn(
                  "block border-b border-border px-4 py-3 transition-colors hover:bg-muted/50",
                  hoveredId === asset.map_asset_id && "bg-muted/30",
                )}
                onMouseEnter={() => setHoveredId(asset.map_asset_id)}
                onMouseLeave={() => setHoveredId(null)}
              >
                <p className="text-sm font-medium truncate">{asset.name}</p>
                {locationStr && (
                  <p className="text-xs text-muted-foreground truncate mt-0.5">{locationStr}</p>
                )}
                <div className="mt-1.5">
                  <CapabilityHints caps={caps} size="sm" />
                </div>
                <div className="mt-1.5">
                  <CardStatsRow stats={stats} size="sm" />
                </div>
                {tags.length > 0 && (
                  <div className="flex flex-wrap gap-1 mt-1.5">
                    {tags.map((tagId) => (
                      <span
                        key={tagId}
                        className="inline-flex items-center rounded-full bg-primary/10 px-2 py-0.5 text-[9px] font-medium text-primary border border-primary/20"
                      >
                        {humanizeTag(tagId)}
                      </span>
                    ))}
                    {remainingTags > 0 && (
                      <span className="inline-flex items-center rounded-full bg-muted/50 px-2 py-0.5 text-[9px] text-muted-foreground">
                        +{remainingTags}
                      </span>
                    )}
                  </div>
                )}
              </Link>
            );
          })
        )}
      </div>

      {/* Right: MapLibre in catalog/cluster mode */}
      <div className="flex-1 relative">
        <div className="absolute inset-0">
          <MapAssetsMapDynamic
            assets={assets}
            selectedAssetId={null}
            onSelectAsset={(id) => {
              if (id) router.push(`/dashboard/map-assets/${id}`);
            }}
          />
        </div>
      </div>
    </div>
  );
}
