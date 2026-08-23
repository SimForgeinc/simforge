import type { StreetFactsForFeature } from "./use-street-facts-index";

/**
 * Speed-limit overlays: label each driving lane with its posted limit, drawn as
 * a sign at the lane centerline. Two sources — the XODR-authored per-lane value
 * that rides the road-network GeoJSON (in-house), and the Overture posted limit
 * from the search-index sidecar. Both are co-visualizations; nothing here mutates
 * the data. Each feature also carries the lane's identity so a clicked sign can
 * be inspected.
 */

type GeoJsonGeometry = { type: string; coordinates: unknown };
type GeoJsonFeature = {
  type: "Feature";
  geometry: GeoJsonGeometry | null;
  properties: Record<string, unknown> | null;
};
export type GeoJsonFeatureCollection = {
  type: "FeatureCollection";
  features: GeoJsonFeature[];
};

export const EMPTY_SPEED_LIMIT_OVERLAY: GeoJsonFeatureCollection = {
  type: "FeatureCollection",
  features: [],
};

export type SpeedDisplayUnit = "mph" | "km/h";

// Countries that post speed limits in mph; everyone else is shown km/h. Missing
// / unknown country defaults to mph so US maps (the common case, and the prior
// behaviour) never get spuriously converted.
const MPH_COUNTRY_CODES = new Set([
  "US", "GB", "PR", "GU", "VI", "AS", "MP", "UM", "VG", "LR", "MM", "BS", "BZ",
  "AG", "DM", "GD", "KN", "LC", "VC", "FK", "KY", "WS",
]);

/** Display unit for a map, from its ISO country code (from place_context). */
export function displayUnitForCountry(countryCode: string | null | undefined): SpeedDisplayUnit {
  const cc = countryCode?.trim().toUpperCase();
  if (cc && !MPH_COUNTRY_CODES.has(cc)) return "km/h";
  return "mph";
}

/** Parse a speed string ("40mph", "30kph", "50 km/h") or number into value + native unit. */
export function parseSpeedLimit(raw: unknown): { value: number; unit: SpeedDisplayUnit } | undefined {
  if (typeof raw === "number") {
    return Number.isFinite(raw) && raw > 0 ? { value: Math.round(raw), unit: "mph" } : undefined;
  }
  if (typeof raw === "string") {
    const m = raw.match(/(\d+(?:\.\d+)?)/);
    if (!m) return undefined;
    const value = Math.round(Number(m[1]));
    if (value <= 0) return undefined;
    const unit: SpeedDisplayUnit = /k(m\/?)?ph|km\/h/i.test(raw) ? "km/h" : "mph";
    return { value, unit };
  }
  return undefined;
}

/** mph → km/h, rounded to the nearest 5 so standard limits (30/50…) round-trip cleanly. */
export function mphToKmh(mph: number): number {
  return Math.round((mph * 1.609344) / 5) * 5;
}

function laneProps(props: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (props.Id != null) out.lane_id = String(props.Id);
  if (props.LaneType != null) out.lane_type = String(props.LaneType);
  if (props.TravelDir != null) out.travel_dir = String(props.TravelDir);
  if (typeof props.__mapId === "number") out.__mapId = props.__mapId;
  return out;
}

/**
 * In-house speed overlay from the XODR-authored per-lane `SpeedLimit` that
 * already rides the road GeoJSON (e.g. "40mph"/"30kph" on `LaneType:"Driving"`
 * features). Native — not proximity-matched — so it never mis-attributes a
 * nearby road's limit, and it shows the map's native unit (km/h for Munich)
 * with no conversion. Keeps driving-lane LINE features with a value.
 */
export function buildXodrSpeedLimitOverlayGeoJSON(roadGeoJSON: unknown): GeoJsonFeatureCollection {
  const fc = roadGeoJSON as GeoJsonFeatureCollection | null;
  if (!fc || !Array.isArray(fc.features)) return EMPTY_SPEED_LIMIT_OVERLAY;

  const features: GeoJsonFeature[] = [];
  for (const feature of fc.features) {
    const geomType = feature.geometry?.type;
    if (geomType !== "LineString" && geomType !== "MultiLineString") continue;
    const props = feature.properties;
    if (!props || props.LaneType !== "Driving") continue;
    const parsed = parseSpeedLimit(props.SpeedLimit);
    if (!parsed) continue;
    features.push({
      type: "Feature",
      geometry: feature.geometry,
      properties: {
        ...laneProps(props),
        source: "xodr",
        speed: parsed.value,
        unit: parsed.unit,
      },
    });
  }
  return { type: "FeatureCollection", features };
}

/**
 * Overture overlay: join per-feature street facts onto the road GeoJSON. The
 * Overture value is stored mph; on metric maps we convert to km/h for display
 * (the native unit was lost at ingestion). Keeps driving-lane LINE features that
 * resolve to a posted limit.
 */
export function buildSpeedLimitOverlayGeoJSON(
  roadGeoJSON: unknown,
  streetFactsByFeatureId: Map<number, StreetFactsForFeature> | null,
  displayUnit: SpeedDisplayUnit = "mph",
): GeoJsonFeatureCollection {
  if (!streetFactsByFeatureId || streetFactsByFeatureId.size === 0) {
    return EMPTY_SPEED_LIMIT_OVERLAY;
  }
  const fc = roadGeoJSON as GeoJsonFeatureCollection | null;
  if (!fc || !Array.isArray(fc.features)) return EMPTY_SPEED_LIMIT_OVERLAY;

  const features: GeoJsonFeature[] = [];
  for (const feature of fc.features) {
    const geomType = feature.geometry?.type;
    if (geomType !== "LineString" && geomType !== "MultiLineString") continue;
    const props = feature.properties;
    const featureId = props?.__mapId;
    if (typeof featureId !== "number") continue;
    const facts = streetFactsByFeatureId.get(featureId);
    if (facts?.overtureSpeedLimitMph == null) continue;
    const mph = facts.overtureSpeedLimitMph;
    const speed = displayUnit === "km/h" ? mphToKmh(mph) : mph;
    features.push({
      type: "Feature",
      geometry: feature.geometry,
      properties: {
        ...laneProps(props ?? {}),
        source: "overture",
        speed,
        unit: displayUnit,
        street_name: facts.streetName,
      },
    });
  }
  return { type: "FeatureCollection", features };
}
