"use client";

import { useEffect, useState } from "react";
import type { UniScenarioMapEntry } from "@simforge/editor";
import type { CityViewer } from "@simforge/viewer";
import { playbackMapEntry } from "@/app/lib/uniscenario/maps";
import {
  loadMapOverlays,
  type MapOverlayHandle,
} from "@/app/lib/uniscenario/mapOverlays";

/**
 * Own the traffic-light visualization for one immutable map and viewer.
 *
 * Both the persistent datasets world and the standalone editor use this hook,
 * so traffic-light orbs have the same lifetime and behavior in either entry
 * point. Map identity is the only boundary that rebuilds the GPU resources.
 */
export function useMapSignalOverlays({
  viewer,
  map,
  ready,
  enabled = true,
}: {
  viewer: CityViewer | null;
  map: UniScenarioMapEntry | null;
  ready: boolean;
  enabled?: boolean;
}): MapOverlayHandle | null {
  const [overlays, setOverlays] = useState<MapOverlayHandle | null>(null);

  useEffect(() => {
    if (!enabled || !viewer || !map || !ready) return;
    const abort = new AbortController();
    const runtimeMap = playbackMapEntry(map);
    let handle: MapOverlayHandle | null = null;
    void loadMapOverlays(
      viewer,
      {
        xodr: runtimeMap.xodr,
        manifest: runtimeMap.manifest,
        lanePolygons: runtimeMap.lanePolygons,
        signals: runtimeMap.signals,
      },
      {
        signal: abort.signal,
        initialVisibility: { lanes: false, signals: false },
        initialSignalOrbs: { visible: true, depthMode: "xray" },
      },
    ).then((next) => {
      if (abort.signal.aborted) {
        next.dispose();
        return;
      }
      handle = next;
      setOverlays(next);
    }).catch((reason: unknown) => {
      if (
        abort.signal.aborted ||
        (reason as { name?: string } | null)?.name === "AbortError"
      ) return;
      console.error("[uniscenario-signals] failed to load traffic-light orbs", reason);
    });
    return () => {
      abort.abort();
      handle?.dispose();
      setOverlays((current) => current === handle ? null : current);
    };
  }, [enabled, map, ready, viewer]);

  return overlays;
}
