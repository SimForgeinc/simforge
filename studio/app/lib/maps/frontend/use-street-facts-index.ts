"use client";

/**
 * Lazily fetch a map's search-index sidecar and invert its street objects'
 * `feature_refs` into a per-GeoJSON-feature lookup, so the feature inspector
 * can show street-level facts (resolved name, OSM road class, Overture posted
 * speed limit) when the user clicks a driving lane.
 *
 * `feature_refs.geojson_feature_id` is an index into the road-network
 * FeatureCollection — the same index the frontend stamps as `__mapId` — so
 * the clicked feature's payload id keys directly into this map. Refs are
 * capped (50/street) at build time, so very long roads may miss a few lanes;
 * the inspector just omits the block in that case.
 */
import { useEffect, useState } from "react";
import type { MapSearchIndex, MapSearchIndexStreetFacts } from "@simforge-oss/studio-shared";

export interface StreetFactsForFeature {
  streetName: string;
  roadClass?: string;
  /** Posted limit from Overture — third-party data, surfaced with provenance. */
  overtureSpeedLimitMph?: number;
  speedClass?: string;
  laneCount?: number;
}

/**
 * Returns the featureId→street-facts lookup, or null while loading / when the
 * map has no search-index artifact. Fetches at most once per mapAssetId and
 * only when `active` (a feature is selected).
 */
export function useStreetFactsByFeatureId(
  mapAssetId: string | undefined,
  active: boolean,
): Map<number, StreetFactsForFeature> | null {
  const [state, setState] = useState<{
    mapAssetId: string;
    index: Map<number, StreetFactsForFeature>;
  } | null>(null);

  useEffect(() => {
    if (!mapAssetId || !active) return;
    if (state?.mapAssetId === mapAssetId) return;
    let cancelled = false;

    fetch(`/api/map-assets/${mapAssetId}/search-index`)
      .then((r) => (r.ok ? (r.json() as Promise<MapSearchIndex>) : null))
      .then((sidecar) => {
        if (cancelled) return;
        const index = new Map<number, StreetFactsForFeature>();
        for (const obj of Object.values(sidecar?.objects ?? {})) {
          if (obj.kind !== "street") continue;
          const facts = obj.facts as MapSearchIndexStreetFacts;
          const entry: StreetFactsForFeature = {
            streetName: obj.name,
            ...(facts.road_class ? { roadClass: facts.road_class } : {}),
            ...(facts.overture_speed_limit_mph != null
              ? { overtureSpeedLimitMph: facts.overture_speed_limit_mph }
              : {}),
            ...(facts.speed_class ? { speedClass: facts.speed_class } : {}),
            ...(facts.lane_count != null ? { laneCount: facts.lane_count } : {}),
          };
          for (const ref of obj.feature_refs ?? []) {
            if (ref.role !== "driving_lane") continue;
            if (typeof ref.geojson_feature_id !== "number") continue;
            index.set(ref.geojson_feature_id, entry);
          }
        }
        setState({ mapAssetId, index });
      })
      .catch(() => {
        if (!cancelled) setState({ mapAssetId, index: new Map() });
      });

    return () => {
      cancelled = true;
    };
  }, [mapAssetId, active, state]);

  return state && state.mapAssetId === mapAssetId ? state.index : null;
}
