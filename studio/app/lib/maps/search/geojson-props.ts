/**
 * Shared GeoJSON property accessors. Both the search-index builder and the
 * runtime corpus need to pull the same handful of properties (JunctionID,
 * RoadID, RoadName, Length, …) off every GeoJSON feature, and the upstream
 * feature authors aren't consistent about case — `RoadID` vs `road_id` vs
 * `RoadId` all show up. Holding the alias lists + accessors here stops the
 * two sides from drifting when someone fixes a typo in one but not the
 * other.
 */

import { GEOJSON_FEATURE_ID_PROP } from "@/app/lib/maps/frontend/feature-inspection-types";

// ---------------------------------------------------------------------------
// Property-key alias lists
// ---------------------------------------------------------------------------

/** Identifier for a Junction feature, under any of the variants we've seen. */
export const JUNCTION_ID_KEYS = ["JunctionID", "junction_id", "id", "ID"] as const;
/** Identifier for the XODR road a Lane feature belongs to. */
export const ROAD_ID_KEYS = ["RoadID", "road_id", "RoadId"] as const;
/** Human-readable road name (falls back through label/name variants). */
export const ROAD_NAME_KEYS = ["RoadName", "road_name", "Name", "name"] as const;
/** Lane segment length in metres. */
export const LANE_LENGTH_KEYS = ["Length", "length"] as const;
/** Comma-separated list of road names connecting at a junction. */
export const CONNECTING_ROADS_KEYS = ["ConnectingRoads", "connecting_roads", "Roads"] as const;
/** Junction label (independent of the id). */
export const JUNCTION_NAME_KEYS = ["Name", "name", "JunctionName"] as const;
/** Generic "display name" property for overlay POI features. */
export const FEATURE_NAME_KEYS = ["name", "Name", "title", "label"] as const;
/** Address-ish property for overlay POI features. */
export const FEATURE_ADDRESS_KEYS = ["address", "full_address", "addr"] as const;
/** Subcategory / amenity property for overlay POI features. */
export const FEATURE_AMENITY_KEYS = ["amenity", "category", "subtype"] as const;
/** Identifier for an overlay POI feature (Overture / OSM / internal). */
export const OVERLAY_FEATURE_ID_KEYS = ["id", "feature_id", "ID", "Id", "overture_id"] as const;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface GeoJSONFeature {
  type?: string;
  geometry?: { type?: string; coordinates?: unknown } | null;
  properties?: Record<string, unknown> | null;
  id?: string | number | null;
}

export interface GeoJSONFeatureCollection {
  type?: string;
  features?: GeoJSONFeature[];
}

// ---------------------------------------------------------------------------
// Accessors
// ---------------------------------------------------------------------------

/**
 * Feature-collection guard. Returns the typed collection if the input is
 * an object with a `features` array; otherwise `null`. Used by callers that
 * accept `unknown` (e.g. parsed enrichment artifacts) and need to narrow
 * before iterating.
 */
export function asFeatureCollection(value: unknown): GeoJSONFeatureCollection | null {
  if (!value || typeof value !== "object") return null;
  const fc = value as GeoJSONFeatureCollection;
  if (!Array.isArray(fc.features)) return null;
  return fc;
}

/** Parse a GeoJSON feature collection out of a JSON string, or null on failure. */
export function parseFeatureCollection(
  geojsonText: string,
): GeoJSONFeatureCollection | null {
  try {
    return asFeatureCollection(JSON.parse(geojsonText));
  } catch {
    return null;
  }
}

/**
 * Numeric feature id (`__mapId`) when one is present in feature properties.
 * The source GeoJSON in S3 is treated as immutable post-ingest and does not
 * carry this property; the client adds it in memory at load time via
 * `normalizeGeoJSONWithFeatureIds`. Server-side code paths (e.g. the search-
 * index builder) use the feature's array index directly instead of this
 * accessor.
 */
export function featureMapId(feature: GeoJSONFeature): number | undefined {
  const v = feature.properties?.[GEOJSON_FEATURE_ID_PROP];
  return typeof v === "number" ? v : undefined;
}

/** First matching string-valued property across `keys`, trimmed. */
export function propString(
  props: Record<string, unknown> | null | undefined,
  keys: readonly string[],
): string | undefined {
  if (!props) return undefined;
  for (const key of keys) {
    const v = props[key];
    if (typeof v === "string" && v.trim()) return v.trim();
    if (typeof v === "number") return String(v);
  }
  return undefined;
}

/** First matching numeric (or numeric-looking string) property across `keys`. */
export function propNumber(
  props: Record<string, unknown> | null | undefined,
  keys: readonly string[],
): number | undefined {
  if (!props) return undefined;
  for (const key of keys) {
    const v = props[key];
    if (typeof v === "number" && Number.isFinite(v)) return v;
    if (typeof v === "string" && v.trim() && !Number.isNaN(Number(v))) {
      return Number(v);
    }
  }
  return undefined;
}

/**
 * Stable string id for an overlay POI feature. Prefers an explicit property
 * (under any of `OVERLAY_FEATURE_ID_KEYS`), falling back to the top-level
 * `feature.id` if GeoJSON 0.9 put the id there.
 */
export function overlayFeatureIdString(feature: GeoJSONFeature): string | undefined {
  const explicit = propString(feature.properties, OVERLAY_FEATURE_ID_KEYS);
  if (explicit) return explicit;
  const fid = feature.id;
  if (typeof fid === "string" || typeof fid === "number") return String(fid);
  return undefined;
}
