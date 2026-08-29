"use client";

import { useEffect, useState } from "react";
import { CoordinateFrame } from "@simforge-oss/maps/coordinate-frame";
import { loadSignals, type SignalFeature } from "@simforge-oss/maps/signals";
import type { PoleCameraRig } from "@simforge-oss/maps/camera-rig";

/**
 * Resolves the pole-mounted camera rigs for the world Drive is showing.
 *
 * A rig binds camera channels to a `SignalFeature` id — a traffic-light pole in
 * the map — so the twin view is posed from surveyed map geometry instead of
 * hand-tuned per-site constants. Rig definitions carry the stream URLs and are
 * supplied at runtime (query string, env, or a product service): a map bundle is
 * content-addressed and must never contain endpoints or credentials.
 *
 * Everything here degrades to "no rigs" rather than inventing poses. A rig whose
 * pole id is absent from the map is reported by the grid, never snapped to a
 * neighbouring pole.
 */
export interface PoleCameraSources {
  readonly rigs: readonly PoleCameraRig[];
  readonly features: readonly SignalFeature[];
  readonly error: string | null;
  readonly loading: boolean;
}

const EMPTY_RIGS: readonly PoleCameraRig[] = [];
const EMPTY_FEATURES: readonly SignalFeature[] = [];

/** Sibling paths inside a browser map bundle, relative to `3d/manifest.json`. */
function bundleSibling(manifestUrl: string, name: string): string {
  return manifestUrl.replace(/3d\/manifest\.json.*$/, name);
}

function readParam(name: string): string | null {
  if (typeof window === "undefined") return null;
  return new URLSearchParams(window.location.search).get(name);
}

export function usePoleCameras(manifestUrl: string | null): PoleCameraSources {
  const [state, setState] = useState<PoleCameraSources>({
    rigs: EMPTY_RIGS,
    features: EMPTY_FEATURES,
    error: null,
    loading: false,
  });

  useEffect(() => {
    if (!manifestUrl) return;
    const rigsUrl = readParam("rigs") ?? process.env.NEXT_PUBLIC_DRIVE_CAMERA_RIGS_URL ?? null;
    if (!rigsUrl) return;

    let cancelled = false;
    setState({ rigs: EMPTY_RIGS, features: EMPTY_FEATURES, error: null, loading: true });

    void (async () => {
      try {
        const signalsUrl = readParam("signals") ?? bundleSibling(manifestUrl, "signals.geojson.gz");
        const xodrUrl = readParam("xodr") ?? bundleSibling(manifestUrl, "map.xodr");

        const [rigsResponse, headerResponse, manifestResponse] = await Promise.all([
          fetch(rigsUrl),
          fetch(xodrUrl),
          fetch(manifestUrl),
        ]);
        if (!rigsResponse.ok) throw new Error(`camera rig request failed (${rigsResponse.status})`);
        if (!headerResponse.ok) throw new Error(`map header request failed (${headerResponse.status})`);
        if (!manifestResponse.ok) throw new Error(`map manifest request failed (${manifestResponse.status})`);

        const rigsPayload = await rigsResponse.json() as { rigs?: PoleCameraRig[] } | PoleCameraRig[];
        const rigs = Array.isArray(rigsPayload) ? rigsPayload : rigsPayload.rigs ?? [];
        const frame = CoordinateFrame.fromMapAssets(
          await headerResponse.text(),
          await manifestResponse.json() as Parameters<typeof CoordinateFrame.fromMapAssets>[1],
        );
        const features = await loadSignals(signalsUrl, frame);
        if (cancelled) return;
        setState({ rigs, features, error: null, loading: false });
      } catch (error) {
        if (cancelled) return;
        setState({
          rigs: EMPTY_RIGS,
          features: EMPTY_FEATURES,
          error: error instanceof Error ? error.message : String(error),
          loading: false,
        });
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [manifestUrl]);

  return state;
}
