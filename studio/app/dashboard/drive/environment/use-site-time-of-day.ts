"use client";

import { useEffect, useRef, useState } from "react";
import type { Environment, TimeOfDay } from "@simforge/scenario";
import type { CityViewer } from "@simforge/viewer";
import { CoordinateFrame } from "@simforge/maps/coordinate-frame";

import type { ScenarioAuthoringQuality } from "@/app/lib/scenario/contracts";
import { applyEditorSceneEnvironment } from "@/app/dashboard/scenario/editor/scene-environment";
import { SCENE_TIME_EXTENSION_KEY } from "@/app/dashboard/scenario/editor/scene-time";
import {
  lightingForSolarPosition,
  solarPosition,
  solarPositionMoved,
  type SolarPosition,
} from "./solar-position";

const LIVE_UPDATE_INTERVAL_MS = 30_000;

export interface SiteTimeOfDayState {
  readonly timeOfDay: TimeOfDay | null;
  readonly sunElevationDeg: number | null;
  /** Compass azimuth clockwise from geographic north. */
  readonly sunAzimuthDeg: number | null;
  readonly lat: number | null;
  readonly lon: number | null;
  readonly error: string | null;
}


export function useSiteTimeOfDay(args: {
  viewer: CityViewer | null;
  manifestUrl: string | null;
  at: Date | null;
  quality: ScenarioAuthoringQuality;
}): SiteTimeOfDayState {
  const { viewer, manifestUrl, at, quality } = args;
  const [site, setSite] = useState<{ lat: number; lon: number } | null>(null);
  const [positionState, setPositionState] = useState<{
    timeOfDay: TimeOfDay;
    position: SolarPosition;
  } | null>(null);
  const [assetError, setAssetError] = useState<string | null>(null);
  const [lightingError, setLightingError] = useState<string | null>(null);
  const appliedRef = useRef<{
    cleanup: () => void;
    position: SolarPosition;
  } | null>(null);

  useEffect(() => {
    setSite(null);
    setAssetError(null);
    setPositionState(null);
    if (!manifestUrl) return;

    const controller = new AbortController();
    void (async () => {
      try {
        const xodrUrl = manifestUrl.replace(/3d\/manifest\.json.*$/, "map.xodr");
        const [headerResponse, manifestResponse] = await Promise.all([
          fetch(xodrUrl, { signal: controller.signal }),
          fetch(manifestUrl, { signal: controller.signal }),
        ]);
        if (!headerResponse.ok) throw new Error(`map header request failed (${headerResponse.status})`);
        if (!manifestResponse.ok) throw new Error(`map manifest request failed (${manifestResponse.status})`);

        const frame = CoordinateFrame.fromMapAssets(
          await headerResponse.text(),
          await manifestResponse.json() as Parameters<typeof CoordinateFrame.fromMapAssets>[1],
        );
        const [lon, lat] = frame.sceneToWgs84([0, 0, 0]);
        if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
          throw new Error("map scene origin did not resolve to a WGS84 position");
        }
        if (!controller.signal.aborted) setSite({ lat, lon });
      } catch (error) {
        if (controller.signal.aborted) return;
        setAssetError(error instanceof Error ? error.message : String(error));
      }
    })();

    return () => controller.abort();
  }, [manifestUrl]);

  // The lighting resource outlives replay-clock updates. It is restored only
  // when its viewer/site/quality changes or the hook unmounts.
  useEffect(() => () => {
    appliedRef.current?.cleanup();
    appliedRef.current = null;
  }, [viewer, site?.lat, site?.lon, quality]);

  const atMillis = at?.getTime() ?? null;
  useEffect(() => {
    if (!site) return;

    const update = () => {
      try {
        const next = solarPosition(atMillis === null ? new Date() : new Date(atMillis), site.lat, site.lon);
        const lighting = lightingForSolarPosition(next);
        setPositionState({ timeOfDay: lighting.timeOfDay, position: next });
        setLightingError(null);

        if (!viewer || !solarPositionMoved(appliedRef.current?.position ?? null, next)) return;
        const environment: Environment = {
          weather: "clear",
          timeOfDay: lighting.timeOfDay,
          sunAzimuthDeg: lighting.sceneAzimuthDeg,
          sunElevationDeg: next.elevationDeg,
          surfacePatches: [],
          extensions: {
            [SCENE_TIME_EXTENSION_KEY]: { minutes: lighting.appearanceMinutes },
          },
        };
        appliedRef.current?.cleanup();
        appliedRef.current = {
          cleanup: applyEditorSceneEnvironment(viewer, environment, { quality }),
          position: next,
        };
      } catch (error) {
        setLightingError(error instanceof Error ? error.message : String(error));
      }
    };

    update();
    if (atMillis !== null) return;
    const timer = window.setInterval(update, LIVE_UPDATE_INTERVAL_MS);
    return () => window.clearInterval(timer);
  }, [viewer, site, atMillis, quality]);

  return {
    timeOfDay: positionState?.timeOfDay ?? null,
    sunElevationDeg: positionState?.position.elevationDeg ?? null,
    sunAzimuthDeg: positionState?.position.azimuthDeg ?? null,
    lat: site?.lat ?? null,
    lon: site?.lon ?? null,
    error: assetError ?? lightingError,
  };
}
