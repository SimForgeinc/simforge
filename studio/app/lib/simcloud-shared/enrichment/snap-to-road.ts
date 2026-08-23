import type { RoadSegmentForMatching } from "./street-name-resolver";

/**
 * Shared core for "find the closest point on the road network to (lat,lng)".
 *
 * Used by:
 *   - address-road-access-extractor.ts → snaps every Aurora address row to
 *     a callable spawn point on a road.
 *   - apply-address-context.ts → stamps street name + access link onto
 *     every overlay feature (POIs, buildings) so the inspector and search
 *     index can read the street directly off feature.properties.
 *
 * Pre-parsing the segments once via `parseRoadSegments()` is the trick
 * that makes attaching context to N×K (features × segments) cheap — the
 * GeoJSON parse is otherwise the dominant cost.
 */

const DEG2RAD = Math.PI / 180;
const M_PER_DEG_LAT = 111_320;

export interface ParsedRoadSegment {
  source: RoadSegmentForMatching;
  /** Pre-parsed LineString coords as [lng, lat] pairs. Null when the source
   *  carried no geojson_geometry — callers fall back to the bbox snap. */
  coords: [number, number][] | null;
}

function parseLineStringCoords(geojsonGeometry: string): [number, number][] | null {
  try {
    const geom = JSON.parse(geojsonGeometry) as {
      type?: string;
      coordinates?: number[][];
    };
    if (geom.type !== "LineString" || !Array.isArray(geom.coordinates)) return null;
    return geom.coordinates as [number, number][];
  } catch {
    return null;
  }
}

export function parseRoadSegments(
  segments: RoadSegmentForMatching[],
): ParsedRoadSegment[] {
  return segments.map((source) => ({
    source,
    coords: source.geojson_geometry ? parseLineStringCoords(source.geojson_geometry) : null,
  }));
}

/**
 * Project P=(pLat,pLng) onto segment A→B in WGS-84, returning the snapped
 * lat/lng (clamped to endpoints) and the distance in metres. Local
 * flat-earth frame is accurate to <1 cm for typical road segments (<500 m).
 */
function projectPointOntoSegment(
  pLat: number, pLng: number,
  aLat: number, aLng: number,
  bLat: number, bLng: number,
): { lat: number; lng: number; distanceM: number } {
  const cosLat = Math.cos(((aLat + bLat + pLat) / 3) * DEG2RAD);
  const bx = (bLng - aLng) * M_PER_DEG_LAT * cosLat;
  const by = (bLat - aLat) * M_PER_DEG_LAT;
  const px = (pLng - aLng) * M_PER_DEG_LAT * cosLat;
  const py = (pLat - aLat) * M_PER_DEG_LAT;

  const lenSq = bx * bx + by * by;
  const t = lenSq === 0 ? 0 : Math.max(0, Math.min(1, (px * bx + py * by) / lenSq));

  const projX = t * bx;
  const projY = t * by;
  const ex = px - projX;
  const ey = py - projY;
  const distanceM = Math.sqrt(ex * ex + ey * ey);

  const snapLat = aLat + projY / M_PER_DEG_LAT;
  const snapLng = cosLat > 1e-9 ? aLng + projX / (M_PER_DEG_LAT * cosLat) : aLng;
  return { lat: snapLat, lng: snapLng, distanceM };
}

export interface SnapResult {
  /** Closest point on the chosen segment. */
  lat: number;
  lng: number;
  distanceM: number;
  /** Name of the chosen segment. */
  roadName: string;
}

export interface SnapOptions {
  /** Maximum search radius in metres. Snaps farther than this are dropped
   *  rather than returned — caller treats null as "no road in range". */
  maxDistanceM: number;
}

/**
 * Walk every parsed segment, project the query point onto it, return the
 * global minimum (or null when none falls inside the radius).
 *
 * The bbox prefilter makes this cheap even with 500+ segments: every
 * segment whose envelope is more than maxDistanceM (×1.5 safety) from
 * the query point in either axis is rejected on a coordinate compare.
 */
export function snapPointToNearestRoad(
  lat: number,
  lng: number,
  parsedSegments: ParsedRoadSegment[],
  options: SnapOptions,
): SnapResult | null {
  if (parsedSegments.length === 0) return null;
  const { maxDistanceM } = options;

  const cosLat = Math.cos(lat * DEG2RAD);
  const degThresholdLat = (maxDistanceM / M_PER_DEG_LAT) * 1.5;
  const degThresholdLng = cosLat > 0.01
    ? (maxDistanceM / (M_PER_DEG_LAT * cosLat)) * 1.5
    : 180;

  let bestDist = Infinity;
  let bestLat = 0;
  let bestLng = 0;
  let bestName: string | null = null;

  for (const { source: seg, coords } of parsedSegments) {
    if (seg.max_lat + degThresholdLat < lat) continue;
    if (seg.min_lat - degThresholdLat > lat) continue;
    if (seg.max_lng + degThresholdLng < lng) continue;
    if (seg.min_lng - degThresholdLng > lng) continue;

    if (coords && coords.length >= 2) {
      for (let i = 0; i < coords.length - 1; i++) {
        const [aLng, aLat] = coords[i]!;
        const [bLng, bLat] = coords[i + 1]!;
        const proj = projectPointOntoSegment(lat, lng, aLat, aLng, bLat, bLng);
        if (proj.distanceM < bestDist) {
          bestDist = proj.distanceM;
          bestLat = proj.lat;
          bestLng = proj.lng;
          bestName = seg.name;
        }
      }
    } else {
      // Bbox fallback: clamp to the rectangle, then planar distance.
      const clampedLat = Math.max(seg.min_lat, Math.min(seg.max_lat, lat));
      const clampedLng = Math.max(seg.min_lng, Math.min(seg.max_lng, lng));
      const cosAvg = Math.cos(((lat + clampedLat) / 2) * DEG2RAD);
      const dLat = (lat - clampedLat) * M_PER_DEG_LAT;
      const dLng = (lng - clampedLng) * M_PER_DEG_LAT * cosAvg;
      const dist = Math.sqrt(dLat * dLat + dLng * dLng);
      if (dist < bestDist) {
        bestDist = dist;
        bestLat = clampedLat;
        bestLng = clampedLng;
        bestName = seg.name;
      }
    }
  }

  if (bestName == null || bestDist > maxDistanceM) return null;
  return { lat: bestLat, lng: bestLng, distanceM: bestDist, roadName: bestName };
}
