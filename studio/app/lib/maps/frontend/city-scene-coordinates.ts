/**
 * Coordinate conversion utilities for mapping WGS-84 candidate locations
 * to Three.js scene-frame coordinates.
 */

import type { CandidateLocation } from '@simforge-oss/studio-shared';
import { MapProjection } from '@simforge-oss/studio-shared';

const DEG2RAD = Math.PI / 180;
const METERS_PER_DEG = 111320;

/**
 * Sign applied to the euclidean Y when mapping to Three.js Z axis.
 * OpenDRIVE: x = east, y = north. Three.js (y-up): x = east, -z = north.
 * Flip to 1 if the tile pipeline does NOT negate north → z.
 */
const Z_SIGN = -1;

const MIN_ORBIT_RADIUS = 50;
const MAX_ORBIT_RADIUS = 500;
const DEFAULT_POINT_RADIUS = 100;

export interface FocusTarget {
  position: { x: number; y: number; z: number };
  radius: number;
}

/**
 * Convert a WGS-84 (lng, lat) point to scene-frame (x, y, z).
 *
 * Projects through proj4 (synthesized vanilla `+proj=tmerc` from the origin)
 * so the scene-frame placement of candidate locations agrees with the
 * projection used everywhere else in the app. The earlier inline
 * equirectangular formula (`(lng-lon0)*111320*cos(lat0)`,
 * `(lat-lat0)*111320`) was correct at the origin but accumulated
 * 0.13–0.27% systematic drift per metre away from it — visible in the 3D
 * viewer as candidate camera focus that drifted from the actual mesh
 * position at the map's edges.
 */
export function lonLatToScene(
  lng: number,
  lat: number,
  originLon: number,
  originLat: number,
  groundY: number,
): { x: number; y: number; z: number } {
  const proj = MapProjection.fromCoordinateRef({
    origin_lat: originLat,
    origin_lon: originLon,
  });
  if (!proj) return { x: 0, y: groundY, z: 0 };
  const { x, y } = proj.geoToLocal(lng, lat);
  // proj4 returns y-up east/north; OpenDRIVE/CARLA agrees. Three.js (y-up)
  // maps north onto -z (Z_SIGN = -1 for our tile pipeline).
  return { x, y: groundY, z: Z_SIGN * y };
}

/**
 * The exact inverse of `lonLatToScene` — scene-frame (x, z) back to WGS-84.
 *
 * Needed the moment the twin stopped being read-only: a pointer pick produces a
 * scene point, and every authoring path downstream (lane snapping, waypoint
 * append, the runtime payload) speaks lng/lat. Both directions go through the
 * SAME `MapProjection` and the same `Z_SIGN`, so a pick round-trips to the
 * pixel it was taken from rather than to a point 0.2% away — the drift the
 * forward function's comment records is exactly what an inverse written by hand
 * would have reintroduced.
 *
 * `y` is deliberately ignored: it is a height, and lng/lat is a ground position.
 */
export function sceneToLonLat(
  x: number,
  z: number,
  originLon: number,
  originLat: number,
): { lng: number; lat: number } | null {
  const proj = MapProjection.fromCoordinateRef({
    origin_lat: originLat,
    origin_lon: originLon,
  });
  if (!proj) return null;
  const { lon, lat } = proj.localToGeo(x, Z_SIGN * z);
  if (!Number.isFinite(lon) || !Number.isFinite(lat)) return null;
  return { lng: lon, lat };
}

/**
 * Compute the scene-frame extent (in meters) of a candidate location's region
 * to derive a sensible orbit radius.
 */
function regionExtentMeters(
  candidate: CandidateLocation,
  originLon: number,
  originLat: number,
): number {
  const region = candidate.region;
  const cosLat = Math.cos(originLat * DEG2RAD);

  if (region.type === 'BBOX') {
    const { min_lng, min_lat, max_lng, max_lat } = region.bbox;
    const dx = (max_lng - min_lng) * METERS_PER_DEG * cosLat;
    const dy = (max_lat - min_lat) * METERS_PER_DEG;
    return Math.sqrt(dx * dx + dy * dy);
  }

  if (region.type === 'Polygon') {
    const coords = region.coordinates[0];
    if (!coords || coords.length === 0) return DEFAULT_POINT_RADIUS;
    let minLng = Infinity, maxLng = -Infinity, minLat = Infinity, maxLat = -Infinity;
    for (const [lng, lat] of coords) {
      if (lng < minLng) minLng = lng;
      if (lng > maxLng) maxLng = lng;
      if (lat < minLat) minLat = lat;
      if (lat > maxLat) maxLat = lat;
    }
    const dx = (maxLng - minLng) * METERS_PER_DEG * cosLat;
    const dy = (maxLat - minLat) * METERS_PER_DEG;
    return Math.sqrt(dx * dx + dy * dy);
  }

  // Point region — use default
  return DEFAULT_POINT_RADIUS;
}

/**
 * Convert a CandidateLocation to a FocusTarget for the 3D viewer.
 *
 * @param candidate  The candidate location with WGS-84 center + region
 * @param originLat  Map coordinate reference origin latitude
 * @param originLon  Map coordinate reference origin longitude
 * @param groundY    Ground-level Y in scene coordinates (typically 0)
 */
export function candidateToFocusTarget(
  candidate: CandidateLocation,
  originLat: number,
  originLon: number,
  groundY: number,
): FocusTarget {
  const position = lonLatToScene(
    candidate.center.lng,
    candidate.center.lat,
    originLon,
    originLat,
    groundY,
  );

  const extent = regionExtentMeters(candidate, originLon, originLat);
  // Use extent as a rough guide — orbit at ~1.5x the region diagonal for good framing
  const radius = Math.max(MIN_ORBIT_RADIUS, Math.min(MAX_ORBIT_RADIUS, extent * 1.5));

  return { position, radius };
}
