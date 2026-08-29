/**
 * Road proximity filter for enrichment features.
 *
 * Extracts a lightweight set of road network sample points from a RoadRunner
 * GeoJSON export, then filters POI-like features to those within a given
 * distance of any road. Prevents Overture features that fall inside the
 * axis-aligned bbox but far from actual roads (common with skewed maps).
 */

/**
 * Default maximum distance (metres) from any road for enrichment feature
 * filtering. 50 m is roughly "actually adjacent to drivable surface" — tight
 * enough to drop POIs a block away, loose enough to keep parking lots and
 * shops set back from the frontage by a driveway width.
 */
export const ROAD_PROXIMITY_THRESHOLD_M = 50;

const DEG2RAD = Math.PI / 180;
const M_PER_DEG_LAT = 111_320;

/** A sampled point on the road network in WGS-84. */
type RoadPoint = { lat: number; lng: number };

/**
 * Extract a sparse set of road network sample points from GeoJSON text.
 *
 * Collects coordinates from `Type=Lane` (LineString) and `Type=Junction`
 * (Polygon/MultiPolygon) features. Samples every Nth coordinate to keep
 * the point cloud small for fast distance checks.
 */
export function extractRoadNetworkPoints(geojsonText: string): RoadPoint[] {
  let root: unknown;
  try {
    root = JSON.parse(geojsonText) as unknown;
  } catch {
    return [];
  }

  const points: RoadPoint[] = [];

  function collectCoords(coords: unknown) {
    if (!Array.isArray(coords)) return;

    // Check if this is a coordinate pair [lng, lat, ...]
    if (coords.length >= 2 && typeof coords[0] === "number" && typeof coords[1] === "number") {
      points.push({ lng: coords[0] as number, lat: coords[1] as number });
      return;
    }

    // Otherwise recurse into nested arrays (rings, multi-geometries)
    for (const item of coords) {
      collectCoords(item);
    }
  }

  function visitFeature(feature: Record<string, unknown>) {
    const props = (feature.properties ?? {}) as Record<string, unknown>;
    const geom = feature.geometry as Record<string, unknown> | null | undefined;
    if (!geom) return;

    const featureType = String(props.Type ?? props.type ?? "");
    // Only collect from road network features (lanes, junctions, crosswalks)
    if (featureType !== "Lane" && featureType !== "Junction" && featureType !== "Crosswalk") return;

    collectCoords(geom.coordinates);
  }

  function walk(obj: unknown) {
    if (!obj || typeof obj !== "object") return;
    const o = obj as Record<string, unknown>;
    if (o.type === "Feature") { visitFeature(o); return; }
    if (o.type === "FeatureCollection" && Array.isArray(o.features)) {
      for (const f of o.features) walk(f);
    }
  }

  walk(root);
  return points;
}

/**
 * Approximate distance in metres between two WGS-84 points.
 */
function distanceM(a: RoadPoint, b: RoadPoint): number {
  const dLat = (b.lat - a.lat) * M_PER_DEG_LAT;
  const cosLat = Math.cos(((a.lat + b.lat) / 2) * DEG2RAD);
  const dLng = (b.lng - a.lng) * M_PER_DEG_LAT * cosLat;
  return Math.sqrt(dLat * dLat + dLng * dLng);
}

/**
 * Check if a point is within `maxDistanceM` of any road network point.
 *
 * Uses a fast degree-based pre-filter to skip obvious misses before
 * computing the more expensive metre-based distance.
 */
function isNearRoadNetwork(
  point: RoadPoint,
  roadPoints: RoadPoint[],
  maxDistanceM: number,
): boolean {
  // Pre-filter thresholds in degrees (~generous for fast rejection).
  // Latitude degrees are constant (~111km), but longitude degrees shrink
  // by cos(lat), so we need a wider lng threshold at higher latitudes.
  const degThresholdLat = maxDistanceM / M_PER_DEG_LAT * 1.5;
  const cosLat = Math.cos(point.lat * DEG2RAD);
  const degThresholdLng = cosLat > 0.01
    ? maxDistanceM / (M_PER_DEG_LAT * cosLat) * 1.5
    : 180; // near poles, skip lng pre-filter entirely

  for (const rp of roadPoints) {
    const dLat = Math.abs(point.lat - rp.lat);
    if (dLat > degThresholdLat) continue;
    const dLng = Math.abs(point.lng - rp.lng);
    if (dLng > degThresholdLng) continue;
    if (distanceM(point, rp) <= maxDistanceM) return true;
  }
  return false;
}

export type RoadNetworkPoint = RoadPoint;

export type ProximityFilterTarget = {
  lat: number;
  lng: number;
};

/**
 * Filter a list of items by proximity to the road network.
 *
 * @param items       Items to filter
 * @param getCenter   Function to extract the lat/lng center from an item
 * @param roadPoints  Sampled road network points (from extractRoadNetworkPoints)
 * @param maxDistanceM  Maximum distance in metres from any road point (default 150m)
 */
export function filterByRoadProximity<T>(
  items: T[],
  getCenter: (item: T) => ProximityFilterTarget,
  roadPoints: RoadPoint[],
  maxDistanceM = ROAD_PROXIMITY_THRESHOLD_M,
): T[] {
  if (roadPoints.length === 0) return items; // no road data → keep all (fallback)
  return items.filter((item) => {
    const center = getCenter(item);
    return isNearRoadNetwork(center, roadPoints, maxDistanceM);
  });
}

/**
 * Multi-anchor variant: keep an item if ANY of its supplied anchor points
 * is within `maxDistanceM` of a road. Use when a single point doesn't
 * adequately represent the item's spatial extent — large building
 * footprints, big parking lots, etc., where the centroid can sit far
 * inside the polygon and fail the proximity check even though an edge
 * is right at the road. Pass [centroid, ...corners] or a sample of
 * polygon vertices.
 */
export function filterByRoadProximityMulti<T>(
  items: T[],
  getCenters: (item: T) => ProximityFilterTarget[],
  roadPoints: RoadPoint[],
  maxDistanceM = ROAD_PROXIMITY_THRESHOLD_M,
): T[] {
  if (roadPoints.length === 0) return items;
  return items.filter((item) => {
    const centers = getCenters(item);
    for (const c of centers) {
      if (isNearRoadNetwork(c, roadPoints, maxDistanceM)) return true;
    }
    return false;
  });
}

/** Axis-aligned bounding box in WGS-84. */
export type ProximityFilterBbox = {
  min_lat: number;
  min_lng: number;
  max_lat: number;
  max_lng: number;
};

/**
 * True iff at least one road point is within `maxDistanceM` of the bbox
 * rectangle. Exact for axis-aligned boxes — a road point inside the box
 * is distance 0; one outside is distance to the clamped projection
 * (closest edge or corner depending on the road point's quadrant).
 */
function isBboxNearRoadNetwork(
  bbox: ProximityFilterBbox,
  roadPoints: RoadPoint[],
  maxDistanceM: number,
): boolean {
  // Wider degree pre-filter than the point variant — the bbox can extend
  // up to its own width/height beyond the centroid in either axis, so
  // a tighter prefilter would reject road points that legitimately sit
  // close to a corner of the bbox.
  const bboxLatSpan = bbox.max_lat - bbox.min_lat;
  const bboxLngSpan = bbox.max_lng - bbox.min_lng;
  const centroidLat = (bbox.min_lat + bbox.max_lat) / 2;
  const cosLat = Math.cos(centroidLat * DEG2RAD);
  const degThresholdLat = maxDistanceM / M_PER_DEG_LAT * 1.5 + bboxLatSpan;
  const degThresholdLng = cosLat > 0.01
    ? maxDistanceM / (M_PER_DEG_LAT * cosLat) * 1.5 + bboxLngSpan
    : 180;

  for (const rp of roadPoints) {
    const dLat = Math.abs(rp.lat - centroidLat);
    if (dLat > degThresholdLat) continue;
    const dLng = Math.abs(rp.lng - (bbox.min_lng + bbox.max_lng) / 2);
    if (dLng > degThresholdLng) continue;

    // Clamp the road point to the rectangle and measure planar distance
    // to the clamped point. Inside the rect → distance 0 → kept.
    const clampedLat = Math.max(bbox.min_lat, Math.min(bbox.max_lat, rp.lat));
    const clampedLng = Math.max(bbox.min_lng, Math.min(bbox.max_lng, rp.lng));
    const cosAvg = Math.cos(((rp.lat + clampedLat) / 2) * DEG2RAD);
    const dLatM = (rp.lat - clampedLat) * M_PER_DEG_LAT;
    const dLngM = (rp.lng - clampedLng) * M_PER_DEG_LAT * cosAvg;
    if (Math.sqrt(dLatM * dLatM + dLngM * dLngM) <= maxDistanceM) return true;
  }
  return false;
}

/**
 * Bbox-aware variant: keep an item if its axis-aligned bounding box is
 * within `maxDistanceM` of any road point. Cheaper and more accurate than
 * sampling discrete anchor points for large polygonal items (buildings,
 * parking lots) — a 100 m × 100 m mall whose centroid is 80 m from the
 * road but whose north edge is right at it gets kept.
 *
 * Note: AABB-based, so for diagonally-oriented or concave polygons the
 * bbox can overshoot the actual footprint and produce a small number of
 * false positives. We accept that — keeping a slightly-too-far building
 * is much less costly than dropping a major landmark.
 */
export function filterByRoadProximityBbox<T>(
  items: T[],
  getBbox: (item: T) => ProximityFilterBbox,
  roadPoints: RoadPoint[],
  maxDistanceM = ROAD_PROXIMITY_THRESHOLD_M,
): T[] {
  if (roadPoints.length === 0) return items;
  return items.filter((item) => isBboxNearRoadNetwork(getBbox(item), roadPoints, maxDistanceM));
}

// ── Enrichment snapshot filtering ──────────────────────────────────────────

import type { MapAssetEnrichmentSnapshot, MapOverlayLayer } from "../map-asset-enrichment";
import { deriveEnrichmentTags } from "./derive-enrichment-tags";
import { buildCandidateLocations } from "./build-candidate-locations";
import type { Bbox } from "@simforge-oss/scenario/contracts";

type GeoJsonFeature = {
  geometry?: { coordinates?: unknown } | null;
  properties?: Record<string, unknown> | null;
  [key: string]: unknown;
};

function featureCenter(f: GeoJsonFeature): ProximityFilterTarget | undefined {
  const bbox = f.properties?.bbox as { min_lat?: number; min_lng?: number; max_lat?: number; max_lng?: number } | undefined;
  if (bbox && typeof bbox.min_lat === "number" && typeof bbox.max_lat === "number") {
    return {
      lat: (bbox.min_lat + bbox.max_lat) / 2,
      lng: ((bbox.min_lng ?? 0) + (bbox.max_lng ?? 0)) / 2,
    };
  }
  const geom = f.geometry;
  if (!geom?.coordinates) return undefined;
  const coords = geom.coordinates as number[];
  if (coords.length >= 2 && typeof coords[0] === "number") {
    return { lng: coords[0], lat: coords[1]! };
  }
  return undefined;
}

/**
 * Filter an entire enrichment snapshot by road proximity.
 *
 * Filters both the overlay layer features AND re-derives candidate locations
 * and tags from the filtered features. This ensures the Add Map flow and
 * re-enrich flow produce identical results.
 */
export function filterEnrichmentSnapshotByRoadProximity(
  snapshot: MapAssetEnrichmentSnapshot,
  roadPoints: RoadPoint[],
  mapBbox: Bbox,
  maxDistanceM = ROAD_PROXIMITY_THRESHOLD_M,
): MapAssetEnrichmentSnapshot {
  if (roadPoints.length === 0) return snapshot;

  // Filter overlay layer features
  const filteredLayers: MapOverlayLayer[] = snapshot.overlay_payload.layers.map((layer) => {
    const data = layer.data as { type: string; features?: GeoJsonFeature[] };
    if (!data.features) return layer;

    const filtered = data.features.filter((f) => {
      const center = featureCenter(f);
      if (!center) return true; // keep features we can't locate
      return isNearRoadNetwork(center, roadPoints, maxDistanceM);
    });

    return {
      ...layer,
      feature_count: filtered.length,
      data: { ...data, features: filtered },
    };
  });

  // Re-derive tags and candidates from filtered layers
  const featureCounts: Record<string, number> = Object.fromEntries(
    filteredLayers.map((l) => [l.layer_id, l.feature_count]),
  );
  const derivedTags = deriveEnrichmentTags(featureCounts);
  const candidateLocations = buildCandidateLocations(filteredLayers, mapBbox);

  return {
    ...snapshot,
    summary: {
      ...snapshot.summary,
      feature_counts: featureCounts,
      derived_tags: derivedTags,
      candidate_location_count: candidateLocations.length,
    },
    overlay_payload: {
      ...snapshot.overlay_payload,
      layers: filteredLayers,
    },
    candidate_locations: candidateLocations,
  };
}
