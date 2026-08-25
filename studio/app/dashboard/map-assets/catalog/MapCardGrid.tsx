"use client";

import type { MapAsset } from "@simforge/studio-shared";
import { MapCard } from "./MapCard";

interface MapCardGridProps {
  assets: MapAsset[];
}

export function MapCardGrid({ assets }: MapCardGridProps) {
  return (
    <div className="grid grid-cols-1 gap-4 p-4 md:grid-cols-2 xl:grid-cols-3">
      {assets.map((asset) => (
        <MapCard key={asset.map_asset_id} asset={asset} />
      ))}
    </div>
  );
}
