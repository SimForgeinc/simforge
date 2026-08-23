"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import type { ActorRenderer } from "@uniscenarios/editor-core";
import type { CityViewer } from "@uniscenarios/city-renderer";
import { indexedWorldHeightSampler } from "@uniscenarios/city-renderer";
import { resolveAmbientTrafficProfile } from "@uniscenarios/sim-engine";
import {
  DISABLED_SUMO_STATUS,
  type SumoTrafficStatus,
} from "@uniscenarios/ambient-traffic";
import type { UniScenarioMapDescriptorDto } from "@/app/lib/uniscenario/contracts";
import type { MapEntry } from "@/app/lib/uniscenario/maps";
import { useSumoTraffic } from "@/app/lib/uniscenario/ambient/useSumoTraffic";

// SUMO's gallery demand replenishes vehicles for one hour. Rotate shortly
// before that window closes so a gallery left open indefinitely never empties.
const GALLERY_TRAFFIC_LOOP_SECONDS = 3_500;
const GALLERY_TRAFFIC_TICK_MS = 100;
export const GALLERY_SUMO_MAX_ACTORS = 64;

/** Gallery-only browser traffic. It never creates a scenario or persists evidence. */
export function MapGallerySumoTraffic({
  enabled,
  map,
  viewer,
  actorRenderer,
  loadedMapVersionId,
  onStatusChange,
}: {
  enabled: boolean;
  map: UniScenarioMapDescriptorDto;
  viewer: CityViewer | null;
  actorRenderer: ActorRenderer | null;
  loadedMapVersionId: string | null;
  onStatusChange: (status: SumoTrafficStatus) => void;
}) {
  const [time, setTime] = useState(0);
  const [generation, setGeneration] = useState(0);
  const elapsedRef = useRef(0);
  const ready = loadedMapVersionId === map.mapVersionId;
  const runtimeMap = useMemo(() => gallerySumoMapEntry(map), [map]);
  const sampleHeight = useMemo(
    () => viewer && ready ? indexedWorldHeightSampler(viewer) : null,
    [ready, viewer],
  );
  const cameraFocus = useMemo(() => {
    if (!viewer || !ready) return null;
    const target = viewer.controls.getView().target;
    return { x: target[0], z: target[2] };
  }, [ready, viewer]);
  const profile = useMemo(
    () => resolveAmbientTrafficProfile({
      version: 1,
      preset: "city",
      seed: `map-gallery:${map.mapVersionId}:${generation}`,
      // The gallery should feel like a living city rather than a sparse
      // scenario preview. A cap above 50 leaves room for vehicles that have
      // already completed their routes while keeping the browser workload
      // bounded by the runtime's supported actor limit.
      maxActors: GALLERY_SUMO_MAX_ACTORS,
      densityVehiclesPerKm: 80,
    }),
    [generation, map.mapVersionId],
  );

  useEffect(() => {
    elapsedRef.current = 0;
    setTime(0);
    if (!enabled || !map.sumoNetworkSha256) return;
    let last = performance.now();
    const timer = window.setInterval(() => {
      const now = performance.now();
      const delta = Math.min(0.25, Math.max(0, (now - last) / 1_000));
      last = now;
      elapsedRef.current += delta;
      if (elapsedRef.current >= GALLERY_TRAFFIC_LOOP_SECONDS) {
        elapsedRef.current = 0;
        setGeneration((value) => value + 1);
      }
      setTime(elapsedRef.current);
    }, GALLERY_TRAFFIC_TICK_MS);
    return () => window.clearInterval(timer);
  }, [enabled, map.mapVersionId, map.sumoNetworkSha256]);

  const status = useSumoTraffic({
    enabled: enabled && Boolean(map.sumoNetworkSha256) && ready,
    map: runtimeMap,
    profile,
    renderer: actorRenderer,
    sampleHeight,
    mode: enabled ? "playing" : "authoring",
    time,
    externalActors: [],
    focus: cameraFocus,
    demandFocuses: cameraFocus ? [cameraFocus] : [],
    onFallback: () => undefined,
    acceleratedSignalCycles: false,
    allSignalsGreen: false,
  });

  useEffect(() => {
    onStatusChange(enabled ? status : DISABLED_SUMO_STATUS);
  }, [enabled, onStatusChange, status]);

  return null;
}

export function gallerySumoMapEntry(map: UniScenarioMapDescriptorDto): MapEntry {
  const root = map.browserAssetRootUrl.replace(/\/+$/, "");
  const asset = (path: string) => `${root}/${path}`;
  return {
    id: map.mapVersionId,
    mapVersionId: map.mapVersionId,
    sourceMapId: map.sourceMapId,
    label: map.label,
    locality: map.locality ?? "",
    browserAssetRootUrl: root,
    browserManifestUrl: map.browserManifestUrl,
    browserClosureSha256: map.browserClosureSha256,
    artifacts: map.artifacts,
    sumoNetworkSha256: map.sumoNetworkSha256,
    manifest: map.browserManifestUrl,
    xodr: asset("map.xodr"),
    lanePolygons: asset("lane-polygons.geojson.gz"),
    signals: asset("signals.geojson.gz"),
    topology: asset("topology-index.json.gz"),
    derivedTopology: asset("derived/topology-derived.json.gz"),
    locations: asset("derived/locations.json.gz"),
    sumoManifest: map.sumoNetworkSha256
      ? asset("derived/sumo/sumo-network-manifest.json")
      : null,
  };
}
