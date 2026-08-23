import type { Bbox } from "./bbox-utils";

export type Ring = [number, number][]; // [lng, lat]
export type PolygonRings = Ring[]; // outer ring first, holes follow

/**
 * Standard ray-casting test for a point against a single linear ring. Cast
 * a horizontal ray east from the point and count edge crossings. Boundary
 * cases are deliberately treated as "outside" — for indexing, we'd rather
 * miss a point on the wall than double-assign it.
 */
function pointInRing(lng: number, lat: number, ring: Ring): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i]!;
    const [xj, yj] = ring[j]!;
    const intersects = yi > lat !== yj > lat && lng < ((xj - xi) * (lat - yi)) / (yj - yi) + xi;
    if (intersects) inside = !inside;
  }
  return inside;
}

export function pointInPolygon(lng: number, lat: number, rings: PolygonRings): boolean {
  if (rings.length === 0) return false;
  if (!pointInRing(lng, lat, rings[0]!)) return false;
  // Inside outer ring — check holes.
  for (let i = 1; i < rings.length; i++) {
    if (pointInRing(lng, lat, rings[i]!)) return false;
  }
  return true;
}

/**
 * Inclusive bbox containment, used as a cheap pre-test before the full
 * ring scan. Most addresses won't sit inside any candidate building's
 * bbox, so this prefilter skips ~95 % of point-in-polygon work.
 */
export function pointInBbox(lng: number, lat: number, bbox: Bbox): boolean {
  return (
    lng >= bbox.min_lng && lng <= bbox.max_lng && lat >= bbox.min_lat && lat <= bbox.max_lat
  );
}

type GeoJsonPolygon = { type: "Polygon"; coordinates: number[][][] };
type GeoJsonMultiPolygon = { type: "MultiPolygon"; coordinates: number[][][][] };

/**
 * Parse an Overture-projected GeoJSON polygon string into ring sets we can
 * test against. MultiPolygons return one ring set per part. Returns null
 * on parse failure or unexpected shape — callers fall back to "no
 * containment" for that building.
 */
export function parsePolygonRings(geomJson: string | null | undefined): PolygonRings[] | null {
  if (typeof geomJson !== "string" || geomJson.length === 0) return null;
  let parsed: GeoJsonPolygon | GeoJsonMultiPolygon;
  try {
    parsed = JSON.parse(geomJson) as GeoJsonPolygon | GeoJsonMultiPolygon;
  } catch {
    return null;
  }
  if (parsed?.type === "Polygon" && Array.isArray(parsed.coordinates)) {
    return [parsed.coordinates as Ring[]];
  }
  if (parsed?.type === "MultiPolygon" && Array.isArray(parsed.coordinates)) {
    return parsed.coordinates.map((rings) => rings as Ring[]);
  }
  return null;
}
