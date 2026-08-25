"use client";

import { useEffect, useState } from "react";
import dynamic from "next/dynamic";
import { Box, Loader2 } from "lucide-react";
import type { MapAsset } from "@simforge/studio-shared";
import type { FocusTarget } from "@/app/components/city-viewer/geo-utils";
import type {
  ProximityArrow3D,
  ActorTrajectory3D,
  ActorSpawn3D,
} from "@/app/components/city-viewer/CityViewer";
import type { SearchResultMarker } from "@/app/components/map-assets-map/layers/SearchResultMarkersLayer";

const CityViewerDynamic = dynamic(
  () => import("@/app/components/city-viewer/CityViewer").then((m) => m.CityViewer),
  {
    ssr: false,
    loading: () => (
      <div className="flex h-full w-full items-center justify-center bg-background/50">
        <div className="flex h-16 w-16 items-center justify-center rounded-2xl bg-muted/50 border border-border">
          <Box className="size-8 text-muted-foreground animate-pulse" />
        </div>
      </div>
    ),
  }
);

interface Props {
  asset: MapAsset;
  focusTarget?: FocusTarget | null;
  resetViewNonce?: number;
  searchResultMarkers?: SearchResultMarker[];
  hoveredSearchResultId?: string | null;
  proximityArrows?: ProximityArrow3D[];
  actorTrajectories?: ActorTrajectory3D[];
  /** Diagnostic collision-point marker (closest-approach between two
   *  actor trajectories). Scene-space coordinates; null to clear. */
  collisionMarker?: { x: number; y: number; z: number } | null;
  /** Per-actor spawn-pose markers — a colored box per vehicle, a capsule
   *  per walker — for the highlighted AI-proposed scenario. Scene-space;
   *  null/empty clears all markers. */
  actorSpawns?: ActorSpawn3D[] | null;
}

/**
 * Renders the 3D Digital Twin viewer if 3D assets are available for this map.
 * Detection: checks for a `3d_manifest` artifact record first, then falls back
 * to a HEAD request on the convention-based S3 path (no DB record needed).
 */
export function DigitalTwinViewerPanel({
  asset,
  focusTarget,
  resetViewNonce,
  searchResultMarkers,
  hoveredSearchResultId,
  proximityArrows,
  actorTrajectories,
  collisionMarker,
  actorSpawns,
}: Props) {
  const baseAssetsUrl = `/api/map-assets/${asset.map_asset_id}/3d-asset`;
  const manifestUrl = `${baseAssetsUrl}/manifest.json`;

  const hasArtifact = asset.artifacts?.some(
    (a) => (a.artifact_type as string) === "3d_manifest"
  );

  const [has3D, setHas3D] = useState<boolean | null>(hasArtifact ? true : null);

  // Reset has3D when the asset changes (client-side map switch) so stale
  // state from the previous map doesn't persist.
  useEffect(() => {
    setHas3D(hasArtifact ? true : null);
  }, [asset.map_asset_id, hasArtifact]);

  // If no artifact record, probe the convention-based S3 path.
  // Uses GET (not HEAD) because the API route only exports GET.
  // Aborts immediately after the status code arrives to avoid downloading the body.
  useEffect(() => {
    if (hasArtifact || has3D === true) return;

    const controller = new AbortController();
    fetch(manifestUrl, { signal: controller.signal }).then((res) => {
      if (!controller.signal.aborted) setHas3D(res.ok);
      controller.abort();
    }).catch(() => {
      if (!controller.signal.aborted) setHas3D(false);
    });
    return () => controller.abort();
  }, [hasArtifact, has3D, manifestUrl]);

  // Still probing
  if (has3D === null) {
    return (
      <div className="flex h-full w-full items-center justify-center bg-background/50">
        <Loader2 className="size-6 text-muted-foreground animate-spin" />
      </div>
    );
  }

  if (!has3D) {
    return (
      <div className="flex h-full w-full flex-col items-center justify-center gap-4 bg-background/50">
        <div className="flex h-16 w-16 items-center justify-center rounded-2xl bg-muted/50 border border-border">
          <Box className="size-8 text-muted-foreground" />
        </div>
        <div className="text-center">
          <p className="text-sm font-semibold text-foreground">Digital Twin Viewer</p>
          <p className="mt-1 text-xs text-muted-foreground max-w-xs">
            No 3D digital twin assets found for this map.
            Switch to Map mode to explore in 2D.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="absolute inset-0">
      <CityViewerDynamic
        manifestUrl={manifestUrl}
        baseAssetsUrl={baseAssetsUrl}
        focusTarget={focusTarget}
        resetViewNonce={resetViewNonce}
        searchResultMarkers={searchResultMarkers}
        hoveredSearchResultId={hoveredSearchResultId}
        proximityArrows={proximityArrows}
        actorTrajectories={actorTrajectories}
        collisionMarker={collisionMarker}
        actorSpawns={actorSpawns}
      />
    </div>
  );
}
