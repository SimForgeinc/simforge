"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import dynamic from "next/dynamic";
import { AlertTriangle, Box, Loader2 } from "lucide-react";
import type { MapAsset } from "@simforge-oss/studio-shared";
import type {
  CityViewer,
  ViewerMarker,
  ViewerOverlayState,
  ViewerPath,
  ViewerPoint3,
} from "@simforge-oss/viewer";
import type { SearchResultMarker } from "@/app/components/map-assets-map/layers/SearchResultMarkersLayer";

const CityViewDynamic = dynamic(
  () => import("@simforge-oss/viewer/react").then((module) => module.CityView),
  {
    ssr: false,
    loading: () => (
      <div className="flex h-full w-full items-center justify-center bg-background/50">
        <div className="flex h-16 w-16 items-center justify-center rounded-2xl border border-border bg-muted/50">
          <Box className="size-8 animate-pulse text-muted-foreground" />
        </div>
      </div>
    ),
  },
);

export interface DigitalTwinFocusTarget {
  position: ViewerPoint3;
  radius: number;
}

export interface ProximityArrow3D {
  id: string;
  points: ViewerPoint3[];
  highlight?: boolean;
}

export interface ActorTrajectory3D extends ViewerPath {}

export interface ActorSpawn3D {
  id: string;
  kind: "vehicle" | "walker" | "prop";
  color: string;
  yawRad: number | null;
  point: ViewerPoint3;
}

interface Props {
  asset: MapAsset;
  focusTarget?: DigitalTwinFocusTarget | null;
  resetViewNonce?: number;
  searchResultMarkers?: SearchResultMarker[];
  hoveredSearchResultId?: string | null;
  proximityArrows?: ProximityArrow3D[];
  actorTrajectories?: ActorTrajectory3D[];
  collisionMarker?: ViewerPoint3 | null;
  actorSpawns?: ActorSpawn3D[] | null;
}

/** The map-detail 3D surface, backed by the same packaged viewer as the editor. */
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
  const manifestUrl = `/api/map-assets/${asset.map_asset_id}/3d-asset/manifest.json`;
  const hasArtifact = asset.artifacts?.some(
    (artifact) => (artifact.artifact_type as string) === "3d_manifest",
  );
  const [has3D, setHas3D] = useState<boolean | null>(hasArtifact ? true : null);
  const [viewerError, setViewerError] = useState<string | null>(null);
  const viewerRef = useRef<CityViewer | null>(null);
  const [mapGeneration, setMapGeneration] = useState(0);
  const previousResetNonce = useRef(resetViewNonce);

  useEffect(() => {
    setHas3D(hasArtifact ? true : null);
    setViewerError(null);
  }, [asset.map_asset_id, hasArtifact]);

  useEffect(() => {
    if (hasArtifact || has3D === true) return;
    const controller = new AbortController();
    fetch(manifestUrl, { signal: controller.signal })
      .then((response) => {
        if (!controller.signal.aborted) setHas3D(response.ok);
        controller.abort();
      })
      .catch(() => {
        if (!controller.signal.aborted) setHas3D(false);
      });
    return () => controller.abort();
  }, [hasArtifact, has3D, manifestUrl]);

  const overlayState = useMemo<ViewerOverlayState>(() => {
    const pins = (searchResultMarkers ?? [])
      .filter((marker) => marker.scenePosition != null)
      .map((marker) => ({
        id: marker.id,
        position: marker.scenePosition!,
        highlighted: marker.id === hoveredSearchResultId,
      }));
    const paths: ViewerPath[] = [
      ...(proximityArrows ?? []).map((path) => ({
        ...path,
        highlighted: path.highlight,
        arrow: true,
      })),
      ...(actorTrajectories ?? []),
    ];
    const markers: ViewerMarker[] = [];
    if (focusTarget) {
      markers.push({ id: "location-focus", position: focusTarget.position, color: "#f97316" });
    }
    if (collisionMarker) {
      markers.push({ id: "collision", position: collisionMarker, color: "#ef4444", shape: "cross" });
    }
    for (const spawn of actorSpawns ?? []) {
      markers.push({
        id: `spawn:${spawn.id}`,
        position: spawn.point,
        color: spawn.color,
        shape: spawn.kind === "vehicle" ? "box" : spawn.kind === "walker" ? "capsule" : "sphere",
        yawRad: spawn.yawRad,
      });
    }
    return { pins, paths, markers };
  }, [
    actorSpawns,
    actorTrajectories,
    collisionMarker,
    focusTarget,
    hoveredSearchResultId,
    proximityArrows,
    searchResultMarkers,
  ]);

  useEffect(() => {
    const viewer = viewerRef.current;
    if (!viewer || mapGeneration === 0) return;
    if (focusTarget) viewer.focusOnLocation(focusTarget.position, focusTarget.radius);
    viewer.setOverlays(overlayState);
  }, [focusTarget, mapGeneration, overlayState]);

  useEffect(() => {
    const viewer = viewerRef.current;
    if (!viewer || resetViewNonce === undefined || resetViewNonce === previousResetNonce.current) return;
    previousResetNonce.current = resetViewNonce;
    viewer.resetCamera();
  }, [mapGeneration, resetViewNonce]);

  const onReady = useCallback((viewer: CityViewer) => {
    viewerRef.current = viewer;
  }, []);

  if (has3D === null) {
    return (
      <div className="flex h-full w-full items-center justify-center bg-background/50">
        <Loader2 className="size-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (!has3D) {
    return (
      <div className="flex h-full w-full flex-col items-center justify-center gap-4 bg-background/50">
        <div className="flex h-16 w-16 items-center justify-center rounded-2xl border border-border bg-muted/50">
          <Box className="size-8 text-muted-foreground" />
        </div>
        <div className="text-center">
          <p className="text-sm font-semibold text-foreground">Digital Twin Viewer</p>
          <p className="mt-1 max-w-xs text-xs text-muted-foreground">
            No 3D digital twin assets found for this map. Switch to Map mode to explore in 2D.
          </p>
        </div>
      </div>
    );
  }

  if (viewerError) {
    return (
      <div className="flex h-full w-full flex-col items-center justify-center gap-3 bg-background/50">
        <AlertTriangle className="size-7 text-destructive" />
        <p className="max-w-md text-center text-xs text-muted-foreground">{viewerError}</p>
      </div>
    );
  }

  return (
    <div className="absolute inset-0">
      <CityViewDynamic
        manifestUrl={manifestUrl}
        options={{ assetVariant: "auto", ktx2TranscoderPath: "/basis/" }}
        onReady={onReady}
        onMapLoaded={() => setMapGeneration((generation) => generation + 1)}
        onError={(error) => setViewerError(error instanceof Error ? error.message : String(error))}
        ariaLabel={`3D digital twin of ${asset.name}`}
        role="application"
        tabIndex={0}
        className="h-full w-full"
      />
    </div>
  );
}
