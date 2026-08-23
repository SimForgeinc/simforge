/**
 * Tiny geo helpers for the occlusion module.
 *
 * Deliberately approximate — equirectangular distance and a flat
 * cross-track formula are accurate enough for "is the building within ~6m
 * of this road" decisions and avoid pulling in turf for the only six call
 * sites that need them.
 */

export type LatLng = { lat: number; lng: number };

const DEG2RAD = Math.PI / 180;
const M_PER_DEG_LAT = 111_320;

export function metersPerDegLng(lat: number): number {
  return 111_320 * Math.cos(lat * DEG2RAD);
}

/** Approximate planar distance in meters between two WGS-84 points. */
export function distanceMeters(a: LatLng, b: LatLng): number {
  const dy = (b.lat - a.lat) * M_PER_DEG_LAT;
  const dx = (b.lng - a.lng) * metersPerDegLng((a.lat + b.lat) / 2);
  return Math.sqrt(dx * dx + dy * dy);
}

/**
 * Perpendicular distance (m) from `pt` to the line segment p1→p2,
 * clamped at the segment endpoints. Useful for "how close is this
 * building to that road centerline?".
 *
 * Coordinates are accepted in [lng, lat] order (GeoJSON-native).
 */
export function distanceToSegmentMeters(
  pt: [number, number],
  p1: [number, number],
  p2: [number, number],
): number {
  const refLat = (p1[1] + p2[1] + pt[1]) / 3;
  const m_lng = metersPerDegLng(refLat);
  const ax = pt[0] * m_lng;
  const ay = pt[1] * M_PER_DEG_LAT;
  const bx = p1[0] * m_lng;
  const by = p1[1] * M_PER_DEG_LAT;
  const cx = p2[0] * m_lng;
  const cy = p2[1] * M_PER_DEG_LAT;
  const dx = cx - bx;
  const dy = cy - by;
  const len2 = dx * dx + dy * dy;
  if (len2 < 1e-9) {
    const ex = ax - bx;
    const ey = ay - by;
    return Math.sqrt(ex * ex + ey * ey);
  }
  let t = ((ax - bx) * dx + (ay - by) * dy) / len2;
  t = Math.max(0, Math.min(1, t));
  const px = bx + t * dx;
  const py = by + t * dy;
  return Math.sqrt((ax - px) ** 2 + (ay - py) ** 2);
}

/** Distance from `pt` to the closest segment of a polyline. */
export function distanceToPolylineMeters(
  pt: [number, number],
  line: [number, number][],
): number {
  if (line.length === 0) return Infinity;
  if (line.length === 1) {
    return distanceMeters(
      { lat: pt[1], lng: pt[0] },
      { lat: line[0]![1], lng: line[0]![0] },
    );
  }
  let best = Infinity;
  for (let i = 1; i < line.length; i++) {
    const d = distanceToSegmentMeters(pt, line[i - 1]!, line[i]!);
    if (d < best) best = d;
  }
  return best;
}
