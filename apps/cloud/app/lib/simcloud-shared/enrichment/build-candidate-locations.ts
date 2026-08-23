import type { MapCandidateLocation, MapOverlayLayer } from "../map-asset-enrichment";
import type { Bbox } from "../scenario-location";
import { clipBbox, expandBbox, featureBbox } from "./bbox-utils";

type GeoJsonFeature = {
  id?: string | number | null;
  geometry?: {
    type?: string;
    coordinates?: unknown;
    geometries?: Array<{ type?: string; coordinates?: unknown }>;
  } | null;
  properties?: Record<string, unknown> | null;
};

function getLayerFeatures(layer: MapOverlayLayer): GeoJsonFeature[] {
  const features = (layer.data as { features?: unknown }).features;
  return Array.isArray(features) ? (features as GeoJsonFeature[]) : [];
}

/**
 * Extract the outer ring of a Polygon (or first part of a MultiPolygon) as
 * an array of [lng, lat] pairs suitable for RegionPolygonSchema. Returns
 * null when the geometry isn't a polygon, when coordinates are malformed,
 * or when the ring degenerates (<3 distinct points). Inner holes are
 * dropped — RegionPolygon supports holes but the candidate-location
 * consumers we have today only use the outer ring; carrying holes would
 * inflate the snapshot for no current win.
 */
function outerRingFromGeometry(
  geom: GeoJsonFeature["geometry"],
): [number, number][] | null {
  if (!geom) return null;
  const coords = geom.coordinates;
  if (!Array.isArray(coords)) return null;

  let ring: unknown;
  if (geom.type === "Polygon") {
    ring = coords[0];
  } else if (geom.type === "MultiPolygon") {
    const firstPart = coords[0];
    if (!Array.isArray(firstPart)) return null;
    ring = (firstPart as unknown[])[0];
  } else {
    return null;
  }

  if (!Array.isArray(ring) || ring.length < 3) return null;
  const out: [number, number][] = [];
  for (const pt of ring) {
    if (!Array.isArray(pt) || pt.length < 2) continue;
    const lng = Number(pt[0]);
    const lat = Number(pt[1]);
    if (!Number.isFinite(lng) || !Number.isFinite(lat)) continue;
    out.push([lng, lat]);
  }
  return out.length >= 3 ? out : null;
}

/**
 * Extract a LineString's [lng, lat] vertices from a GeoJSON geometry. Returns
 * null when the geometry isn't a LineString, when coordinates are malformed,
 * or when the line degenerates (<2 distinct points). MultiLineString isn't
 * handled today — Overture sidewalks ship as plain LineStrings; the schema
 * could flip later but nothing on our side produces them yet.
 */
function lineStringFromGeometry(
  geom: GeoJsonFeature["geometry"],
): [number, number][] | null {
  if (!geom || geom.type !== "LineString") return null;
  const coords = geom.coordinates;
  if (!Array.isArray(coords) || coords.length < 2) return null;
  const out: [number, number][] = [];
  for (const pt of coords) {
    if (!Array.isArray(pt) || pt.length < 2) continue;
    const lng = Number(pt[0]);
    const lat = Number(pt[1]);
    if (!Number.isFinite(lng) || !Number.isFinite(lat)) continue;
    out.push([lng, lat]);
  }
  return out.length >= 2 ? out : null;
}

function buildCandidate(
  id: string,
  kind: MapCandidateLocation["kind"],
  label: string,
  reason: string,
  tags: string[],
  rawBbox: Bbox,
  mapBbox: Bbox,
  layerId: MapOverlayLayer["layer_id"],
  featureId: string,
  /** Optional outer ring; if provided AND the clipped BBOX is non-empty,
   *  the candidate ships as a Polygon region instead of BBOX. */
  outerRing: [number, number][] | null,
  /** Optional polyline; takes precedence over outerRing/bbox when set.
   *  Used by sidewalk_segment so the candidate carries the actual sidewalk
   *  centerline rather than a (potentially huge) bbox of a long line. */
  lineString: [number, number][] | null = null,
): MapCandidateLocation | null {
  const clipped = clipBbox(rawBbox, mapBbox);
  if (!clipped) return null;
  return {
    id,
    kind,
    label,
    reason,
    tags,
    evidence: [{ layer_id: layerId, feature_ids: [featureId] }],
    region: lineString != null
      ? { type: "LineString", coordinates: lineString }
      : outerRing != null
        ? { type: "Polygon", coordinates: [outerRing] }
        : { type: "BBOX", bbox: clipped },
  };
}

/**
 * Builds candidate scenario locations from Overture overlay layers.
 * Pure function — shared between the Overture enrichment workflow and
 * any future workflow that supplies pre-built overlay layers.
 *
 * Emits one candidate per Overture feature; nearby duplicates are collapsed
 * downstream by `clusterLocations`, and confidence/min-confidence filtering
 * happens in `poolCandidates`. Search needs the full corpus per feature kind
 * — capping here would silently drop real bus stops, schools, etc. that
 * later filters could have used to satisfy a higher-criteria query.
 *
 * Buffer per kind:
 *   bus stops, schools, hospitals → 20 m  (40 m diameter)
 *   gas stations, parking lots    → 25 m  (50 m diameter)
 */
export function buildCandidateLocations(
  overlayLayers: MapOverlayLayer[],
  mapBbox: Bbox,
): MapCandidateLocation[] {
  const byId = Object.fromEntries(overlayLayers.map((l) => [l.layer_id, l]));
  const candidates: MapCandidateLocation[] = [];

  const emitFromLayer = (
    layerId: MapOverlayLayer["layer_id"],
    idPrefix: string,
    kind: MapCandidateLocation["kind"],
    bufferMeters: number,
    fallbackLabel: string,
    reason: string,
    tags: string[],
  ) => {
    const features = byId[layerId] ? getLayerFeatures(byId[layerId]!) : [];
    for (let i = 0; i < features.length; i++) {
      const f = features[i];
      if (!f) continue;
      const raw = expandBbox(featureBbox(f) ?? mapBbox, bufferMeters);
      // Label policy: prefer the Overture-provided `name` (e.g. "Marriott",
      // "Joe's Pizza"). The numbered fallback (`Hotel approach 1`) only
      // fires for unnamed features. Street-name enrichment must NOT override
      // the actual POI name — see `street-name-resolver.ts:NAMEABLE_KINDS`,
      // which deliberately excludes these POI kinds so their labels stay
      // anchored on the brand/business name. If you ever extend
      // NAMEABLE_KINDS to cover commercial POIs, the formatter must append
      // the street context after the original label, never replace it.
      // When the underlying feature has a polygon footprint (e.g., a POI
      // promoted to its enclosing building's geometry by the
      // apply-address-context pass, a parking lot polygon), ship the
      // candidate region as a Polygon. Downstream consumers — the
      // search index, scenario placement — get the actual shape rather
      // than a buffered AABB. Falls back to BBOX when the feature is a
      // point or when the polygon parse fails.
      const ring = outerRingFromGeometry(f.geometry);
      // Sidewalks (and any future linear-feature layer) carry a LineString
      // geometry on the overlay feature. Pull it through so the candidate's
      // region preserves the centerline instead of collapsing to a bbox.
      const line = lineStringFromGeometry(f.geometry);
      const c = buildCandidate(
        `${idPrefix}-${i + 1}`,
        kind,
        String(f.properties?.name ?? `${fallbackLabel} ${i + 1}`),
        reason,
        tags,
        raw,
        mapBbox,
        layerId,
        String(f.id ?? `${layerId}-${i}`),
        ring,
        line,
      );
      if (c) candidates.push(c);
    }
  };

  emitFromLayer(
    "bus_stops",
    "bus-stop",
    "bus_stop_corridor",
    20,
    "Bus stop corridor",
    "Bus stop and curbside dwell area suitable for transit interaction scenarios.",
    ["TRANSIT_BUS_STOP"],
  );
  emitFromLayer(
    "schools",
    "school",
    "school_frontage",
    20,
    "School frontage",
    "School-adjacent frontage or crossing zone likely to support pickup/dropoff and pedestrian scenarios.",
    ["SCHOOL_ZONE_BOUNDARY"],
  );
  emitFromLayer(
    "hospitals",
    "hospital",
    "hospital_approach",
    20,
    "Hospital approach",
    "Hospital approach zone for emergency vehicle preemption and priority signal scenarios.",
    ["HOSPITAL_APPROACH"],
  );
  emitFromLayer(
    "gas_stations",
    "gas-station",
    "gas_station_approach",
    25,
    "Gas station",
    "Gas station entry/exit zone with turning vehicles, low-speed conflicts, and pedestrian activity.",
    ["GAS_STATION_APPROACH"],
  );
  emitFromLayer(
    "parking_lots",
    "parking-lot",
    "parking_lot",
    25,
    "Parking lot",
    "Parking lot entry/exit zone with vehicles pulling in and out and pedestrian activity.",
    ["PARKING_LOT_APPROACH"],
  );

  // Commercial POIs — added in the PR-138 follow-up so search and Scenario
  // Insights pick up the 6 widened Overture categories. Buffers are tuned to
  // the typical interaction radius for each category:
  //   storefronts (retail, restaurant)              → 25 m
  //   medium-frontage drop-off zones (hotel, transit) → 30 m
  //   large parking aprons (shopping_mall)          → 50 m
  //   terminal approaches (airport)                 → 100 m
  emitFromLayer(
    "retail",
    "retail",
    "retail_frontage",
    25,
    "Retail frontage",
    "Retail storefront with curbside pickup, parking egress, and pedestrian activity along the frontage.",
    ["RETAIL_FRONTAGE"],
  );
  emitFromLayer(
    "restaurant",
    "restaurant",
    "restaurant_frontage",
    25,
    "Restaurant frontage",
    "Restaurant storefront with delivery vehicles, valet/short-term parking, and pedestrian crossings.",
    ["RESTAURANT_FRONTAGE"],
  );
  emitFromLayer(
    "hotel",
    "hotel",
    "hotel_approach",
    30,
    "Hotel approach",
    "Hotel entry zone with valet/drop-off activity, taxi staging, and rolling-luggage pedestrian flow.",
    ["HOTEL_APPROACH"],
  );
  emitFromLayer(
    "airport",
    "airport",
    "airport_approach",
    100,
    "Airport approach",
    "Airport terminal approach zone with passenger drop-off/pickup, shuttle traffic, and curb congestion.",
    ["AIRPORT_APPROACH"],
  );
  emitFromLayer(
    "shopping_mall",
    "shopping-mall",
    "shopping_mall_approach",
    50,
    "Shopping mall approach",
    "Shopping mall entry zone with high parking-lot ingress/egress, pedestrian crossings, and pickup activity.",
    ["SHOPPING_MALL_APPROACH"],
  );
  emitFromLayer(
    "transit_stop",
    "transit-stop",
    "transit_stop_corridor",
    30,
    "Transit stop corridor",
    "Larger transit hub (rail/light-rail/bus station) with multi-modal pickup, dwell traffic, and pedestrian density.",
    ["TRANSIT_STOP_CORRIDOR"],
  );

  // Overture footway/sidewalk segments. Each Overture LineString becomes one
  // candidate; the LLM agent uses these to place pedestrian spawn points.
  // 10 m buffer accounts for the lateral extent of the sidewalk + a small
  // tolerance for the line being a centerline approximation — tight enough
  // that adjacent street features don't get pulled into the candidate's
  // region. The clipped BBOX falls out of the standard path; sidewalks ship
  // as BBOX rather than Polygon because outerRingFromGeometry rejects
  // LineString.
  emitFromLayer(
    "sidewalks",
    "sidewalk",
    "sidewalk_segment",
    10,
    "Sidewalk segment",
    "Pedestrian-only corridor flanking a road. Suitable for spawning pedestrian actors and grounding VRU trajectory scenarios.",
    ["SIDEWALK_PEDESTRIAN_NETWORK"],
  );

  return candidates;
}
