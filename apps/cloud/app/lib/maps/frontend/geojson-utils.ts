import { GEOJSON_FEATURE_ID_PROP } from "./feature-inspection-types";
import { lngLatToLocalPoint, localPointToLngLat } from "@/app/lib/editor-map/coordinates";
import type { MapAsset } from "@simcloud/shared";

/**
 * Returns a GeoJSON FeatureCollection with each feature having __mapId for
 * map highlight/selection.
 *
 * The source GeoJSON in S3 is treated as immutable post-ingest, so this is
 * the canonical injection point for the numeric `__mapId` that Mapbox
 * `promoteId` and the highlight/selection layer key off. The value equals
 * the feature's array index — same identity contract as before, just
 * computed in memory at load time instead of stamped into the stored file.
 *
 * Idempotent: returns the input unchanged when every feature already has
 * the correct __mapId.
 */
export function normalizeGeoJSONWithFeatureIds(data: object): object {
  const d = data as { type?: string; features?: unknown[] };
  if (d.type !== "FeatureCollection" || !Array.isArray(d.features)) return data;
  let needsRewrite = false;
  for (let i = 0; i < d.features.length; i++) {
    const feature = d.features[i] as { properties?: Record<string, unknown> } | null | undefined;
    if (!feature || typeof feature !== "object") continue;
    if (feature.properties?.[GEOJSON_FEATURE_ID_PROP] !== i) {
      needsRewrite = true;
      break;
    }
  }
  if (!needsRewrite) return data;
  const features = d.features.map((f, i) => {
    const feature = f as { type?: string; properties?: Record<string, unknown>; geometry?: unknown };
    if (!feature || typeof feature !== "object") return f;
    return {
      ...feature,
      properties: { ...feature.properties, [GEOJSON_FEATURE_ID_PROP]: i },
    };
  });
  return { ...d, features };
}

function translateCoordinatePair(
  coordinate: unknown,
  asset: Pick<MapAsset, "map_coordinate_ref">,
  offsetMeters: { x: number; y: number },
) {
  if (
    !Array.isArray(coordinate) ||
    coordinate.length < 2 ||
    typeof coordinate[0] !== "number" ||
    typeof coordinate[1] !== "number"
  ) {
    return coordinate;
  }

  const local = lngLatToLocalPoint(coordinate[0], coordinate[1], asset);
  if (!local) return coordinate;
  const shifted = localPointToLngLat(
    {
      x: local.x + offsetMeters.x,
      y: local.y + offsetMeters.y,
    },
    asset,
  );
  if (!shifted) return coordinate;
  return [shifted[0], shifted[1], ...coordinate.slice(2)];
}

function translateCoordinates(
  coordinates: unknown,
  asset: Pick<MapAsset, "map_coordinate_ref">,
  offsetMeters: { x: number; y: number },
): unknown {
  if (!Array.isArray(coordinates)) return coordinates;

  if (
    coordinates.length >= 2 &&
    typeof coordinates[0] === "number" &&
    typeof coordinates[1] === "number"
  ) {
    return translateCoordinatePair(coordinates, asset, offsetMeters);
  }

  return coordinates.map((entry) =>
    translateCoordinates(entry, asset, offsetMeters),
  );
}

export function translateGeoJSONInLocalMeters(
  data: object | null | undefined,
  asset: Pick<MapAsset, "map_coordinate_ref">,
  offsetMeters: { x: number; y: number },
): object | null | undefined {
  if (!data) return data;
  if (
    Math.abs(offsetMeters.x) <= Number.EPSILON &&
    Math.abs(offsetMeters.y) <= Number.EPSILON
  ) {
    return data;
  }

  const featureCollection = data as {
    type?: string;
    features?: Array<{
      geometry?: { type?: string; coordinates?: unknown };
      properties?: Record<string, unknown>;
    }>;
  };

  if (
    featureCollection.type !== "FeatureCollection" ||
    !Array.isArray(featureCollection.features)
  ) {
    return data;
  }

  return {
    ...featureCollection,
    features: featureCollection.features.map((feature) => ({
      ...feature,
      geometry: feature.geometry
        ? {
            ...feature.geometry,
            coordinates: translateCoordinates(
              feature.geometry.coordinates,
              asset,
              offsetMeters,
            ),
          }
        : feature.geometry,
    })),
  };
}

const BRACED_UUID_RE = /^\{([\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12})\}$/i;

export interface FeatureIdIndex {
  /** Map from properties.Id GUID (braces stripped) → __mapId numeric index. */
  guidToMapId: Map<string, number>;
  /** Set of all known GUIDs (braces stripped) in the GeoJSON. */
  knownGuids: Set<string>;
}

/**
 * Build a lookup index from feature property GUIDs to their __mapId indices.
 * Scans the FeatureCollection once — O(n). Returns empty collections for non-FeatureCollection input.
 */
export function buildFeatureIdIndex(geojson: object | null): FeatureIdIndex {
  const guidToMapId = new Map<string, number>();
  const knownGuids = new Set<string>();

  if (!geojson) return { guidToMapId, knownGuids };

  const fc = geojson as { type?: string; features?: Array<{ properties?: Record<string, unknown> }> };
  if (fc.type !== "FeatureCollection" || !Array.isArray(fc.features)) return { guidToMapId, knownGuids };

  for (const feature of fc.features) {
    const props = feature.properties;
    if (!props) continue;

    const mapId = props[GEOJSON_FEATURE_ID_PROP];
    if (typeof mapId !== "number") continue;

    const rawId = props.Id ?? props.id;
    if (typeof rawId !== "string") continue;

    const match = BRACED_UUID_RE.exec(rawId);
    const guid = match ? match[1]! : rawId;

    guidToMapId.set(guid, mapId);
    knownGuids.add(guid);
  }

  return { guidToMapId, knownGuids };
}
