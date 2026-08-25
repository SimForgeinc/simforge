"use client";

import * as DialogPrimitive from "@radix-ui/react-dialog";
import { useEffect, useState } from "react";
import type { MapAsset } from "@simforge/studio-shared";
import { MapDetailPageClient } from "@/app/dashboard/map-assets/[mapAssetId]/MapDetailPageClient";
import type { MapTemplateScenarioRow } from "@/app/lib/db/scenario-query-store";
import type { ScenarioSummary } from "@/app/lib/scenarios";

export function Map2DOverlay({
  asset,
  allAssets,
  onClose,
  onSwitchMap,
}: {
  asset: MapAsset;
  allAssets: MapAsset[];
  onClose: () => void;
  onSwitchMap: (mapAssetId: string) => void;
}) {
  const [supportingData, setSupportingData] = useState<{
    runs: ScenarioSummary[];
    templateScenarios: MapTemplateScenarioRow[];
  }>({ runs: [], templateScenarios: [] });

  useEffect(() => {
    const controller = new AbortController();
    void fetch(`/api/map-assets/${encodeURIComponent(asset.map_asset_id)}/workspace`, {
      signal: controller.signal,
    })
      .then(async (response) => {
        if (!response.ok) throw new Error("Map workspace data is unavailable.");
        return response.json() as Promise<{
          runs?: ScenarioSummary[];
          templateScenarios?: MapTemplateScenarioRow[];
        }>;
      })
      .then((payload) => {
        setSupportingData({
          runs: payload.runs ?? [],
          templateScenarios: payload.templateScenarios ?? [],
        });
      })
      .catch(() => {
        // The core 2D map remains useful when optional scenario data is unavailable.
      });
    return () => controller.abort();
  }, [asset.map_asset_id]);

  return (
    <DialogPrimitive.Root
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay className="fixed inset-0 z-40 bg-black/65 backdrop-blur-sm data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:animate-in data-[state=open]:fade-in-0" />
        <DialogPrimitive.Content
          className="fixed inset-x-3 bottom-3 top-[4.25rem] z-50 overflow-hidden border border-white/15 bg-background shadow-2xl outline-none data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=closed]:zoom-out-95 data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=open]:zoom-in-95 sm:inset-x-5 sm:bottom-5 lg:inset-x-8 lg:bottom-8"
          data-testid="map-gallery-2d-overlay"
        >
          <DialogPrimitive.Title className="sr-only">
            {asset.name} 2D map
          </DialogPrimitive.Title>
          <DialogPrimitive.Description className="sr-only">
            Explore road geometry, map layers, search results, and attributes for this map.
          </DialogPrimitive.Description>
          <MapDetailPageClient
            key={asset.map_asset_id}
            asset={asset}
            allAssets={allAssets}
            runs={supportingData.runs}
            initialTemplateScenarios={supportingData.templateScenarios}
            presentation="overlay"
            onClose={onClose}
            onSwitchMap={onSwitchMap}
          />
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}
