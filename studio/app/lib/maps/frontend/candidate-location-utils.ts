/**
 * Pure utility functions for converting candidate locations to GeoJSON
 * geometries and computing their bounding boxes. Used by MapAssetsMap
 * for rendering candidate location overlays and fly-to animations.
 */

import type { CandidateLocation } from "@simcloud/shared";

/** Geometry shapes the candidate-highlight layers can render. The shared
 *  source carries both fill (polygons) and line (linestrings) sublayers, so
 *  the same FeatureCollection can mix shapes safely. */
export type CandidateHighlightGeometry =
  | { type: "Polygon"; coordinates: number[][][] }
  | { type: "LineString"; coordinates: number[][] };

/**
 * Convert a single candidate's `region` to a renderable GeoJSON geometry.
 * Polygon/BBOX/Point regions become polygons (Point → a small ~20m marker
 * square); LineString regions (sidewalk corridors) stay polylines, painted by
 * the shared candidate source's `line` sublayer.
 */
export function candidateRegionToGeometry(
  candidate: CandidateLocation,
): CandidateHighlightGeometry {
  const region = candidate.region;

  if (region.type === "Polygon") {
    return { type: "Polygon", coordinates: region.coordinates };
  }
  if (region.type === "LineString") {
    return { type: "LineString", coordinates: region.coordinates };
  }
  if (region.type === "BBOX") {
    const { min_lng, min_lat, max_lng, max_lat } = region.bbox;
    return {
      type: "Polygon",
      coordinates: [[
        [min_lng, min_lat], [max_lng, min_lat],
        [max_lng, max_lat], [min_lng, max_lat],
        [min_lng, min_lat],
      ]],
    };
  }
  // Point — create a small marker square (~20m)
  const [lng, lat] = region.coordinates;
  const d = 0.0001;
  return {
    type: "Polygon",
    coordinates: [[
      [lng - d, lat - d], [lng + d, lat - d],
      [lng + d, lat + d], [lng - d, lat + d],
      [lng - d, lat - d],
    ]],
  };
}

/**
 * Convert a candidate location's region to a GeoJSON FeatureCollection.
 * Polygon/BBOX/Point regions render as polygons; LineString regions (sidewalks)
 * render as polylines via the existing `selected-candidate-location-line`
 * layer. Returns null if the candidate is not found or inputs are empty.
 */
export function candidateLocationGeoJSON(locations: CandidateLocation[], candidateId: string | null) {
  if (!candidateId || locations.length === 0) return null;
  const candidate = locations.find((entry) => entry.id === candidateId);
  if (!candidate) return null;

  return {
    type: "FeatureCollection" as const,
    features: [{
      type: "Feature" as const,
      geometry: candidateRegionToGeometry(candidate),
      properties: { candidate_id: candidate.id },
    }],
  };
}

/**
 * Extract [sw, ne] bounding box from a candidate location's region.
 * Returns null if the candidate is not found or inputs are empty.
 */
export function candidateLocationBounds(locations: CandidateLocation[], candidateId: string | null) {
  if (!candidateId || locations.length === 0) return null;
  const candidate = locations.find((entry) => entry.id === candidateId);
  if (!candidate) return null;

  const region = candidate.region;
  if (region.type === "BBOX") {
    return [
      [region.bbox.min_lng, region.bbox.min_lat],
      [region.bbox.max_lng, region.bbox.max_lat],
    ] as [[number, number], [number, number]];
  }
  if (region.type === "Polygon") {
    let minLng = Infinity, minLat = Infinity, maxLng = -Infinity, maxLat = -Infinity;
    for (const ring of region.coordinates) {
      for (const [lng, lat] of ring) {
        if (lng < minLng) minLng = lng;
        if (lng > maxLng) maxLng = lng;
        if (lat < minLat) minLat = lat;
        if (lat > maxLat) maxLat = lat;
      }
    }
    return [[minLng, minLat], [maxLng, maxLat]] as [[number, number], [number, number]];
  }
  if (region.type === "LineString") {
    let minLng = Infinity, minLat = Infinity, maxLng = -Infinity, maxLat = -Infinity;
    for (const [lng, lat] of region.coordinates) {
      if (lng < minLng) minLng = lng;
      if (lng > maxLng) maxLng = lng;
      if (lat < minLat) minLat = lat;
      if (lat > maxLat) maxLat = lat;
    }
    return [[minLng, minLat], [maxLng, maxLat]] as [[number, number], [number, number]];
  }
  // Point
  const [lng, lat] = region.coordinates;
  const d = 0.001;
  return [[lng - d, lat - d], [lng + d, lat + d]] as [[number, number], [number, number]];
}

/**
 * Collect polygon features for many candidate ids at once so they can be
 * rendered in a single source (e.g. the "related" tier for spatial queries).
 * Returns null when there's nothing to draw so callers can skip the layer.
 */
export function candidateLocationsGeoJSONFor(
  locations: CandidateLocation[],
  candidateIds: readonly string[],
) {
  if (candidateIds.length === 0 || locations.length === 0) return null;
  const features: Array<{
    type: "Feature";
    geometry: CandidateHighlightGeometry;
    properties: Record<string, unknown>;
  }> = [];
  for (const id of candidateIds) {
    const single = candidateLocationGeoJSON(locations, id);
    if (!single) continue;
    for (const feature of single.features) features.push(feature);
  }
  if (features.length === 0) return null;
  return { type: "FeatureCollection" as const, features };
}
