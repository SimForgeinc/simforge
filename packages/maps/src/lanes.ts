/**
 * Lane-surface polygon loading.
 *
 * `lane-polygons.geojson.gz` holds one `Polygon` per lane section side (1144
 * for Yale Street), in WGS84. Observed shape of the real data:
 *
 * - Every feature is a single-ring `Polygon` — **no holes, no MultiPolygons**
 *   in Yale Street. Both are still handled defensively.
 * - Rings are explicitly closed (last vertex == first) and 2D.
 * - **Winding is mixed**: 475 CCW / 669 CW in Yale Street, so it carries no
 *   meaning and must be normalised before triangulation.
 */

import type { CoordinateFrame } from './coordinate-frame.js';
import type { Feature, FeatureCollection } from './geojson.js';
import { loadGzipJson } from './gzip.js';

/** Properties carried on a lane-polygon feature. */
export interface LanePolygonProperties {
  feature_kind?: string;
  /** RoadRunner tags: `Type` is always `Lane`; `LaneType` is the OpenDRIVE lane type. */
  Type?: string;
  LaneType?: string;
  road_id?: string;
  section_id?: number;
  lane_id?: number;
  is_junction?: boolean;
  lane_guid?: string;
  [key: string]: unknown;
}

/** A lane surface, converted to scene space. */
export interface LanePolygon {
  /** `road:section:lane`, stable across loads. Falls back to the array index. */
  id: string;
  /** OpenDRIVE road id. */
  roadId: string;
  /** Lane-section index within the road. */
  sectionId: number;
  /** Signed OpenDRIVE lane id (negative = right of centreline). */
  laneId: number;
  /** OpenDRIVE lane type: `driving`, `shoulder`, `sidewalk`, ... */
  laneType: string;
  /** Whether the lane belongs to a junction. */
  isJunction: boolean;
  /**
   * Scene-space rings as flat `[x0, z0, x1, z1, ...]` pairs (the ground plane;
   * scene Y is supplied at build time by the overlay's height sampler).
   *
   * `rings[0]` is the outer contour, wound **counter-clockwise in (x, -z)** so
   * that triangles built from it face +Y. Remaining rings are holes, wound the
   * other way. The duplicate closing vertex is removed.
   *
   * `Float64Array` rather than `Float32Array`: scene coordinates are absolute
   * and run to ~2 km, and keeping full precision here means downstream
   * geometry, picking and snapping all agree to the millimetre.
   */
  rings: Float64Array[];
  /** Scene-space XZ bounds. */
  bounds: { minX: number; maxX: number; minZ: number; maxZ: number };
  /** Untouched GeoJSON properties. */
  properties: LanePolygonProperties;
}

/** Signed area of a flat `[x, z, ...]` ring in the (x, -z) plane. */
function signedArea(flat: Float64Array): number {
  let sum = 0;
  const n = flat.length / 2;
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    const xi = flat[i * 2] as number;
    const vi = -(flat[i * 2 + 1] as number);
    const xj = flat[j * 2] as number;
    const vj = -(flat[j * 2 + 1] as number);
    sum += xi * vj - xj * vi;
  }
  return sum / 2;
}

function reverseRing(flat: Float64Array): Float64Array {
  const n = flat.length / 2;
  const out = new Float64Array(flat.length);
  for (let i = 0; i < n; i++) {
    const src = (n - 1 - i) * 2;
    out[i * 2] = flat[src] as number;
    out[i * 2 + 1] = flat[src + 1] as number;
  }
  return out;
}

function ringToScene(ring: number[][], frame: CoordinateFrame): Float64Array | null {
  let n = ring.length;
  if (n >= 2) {
    const first = ring[0] as number[];
    const last = ring[n - 1] as number[];
    if (first[0] === last[0] && first[1] === last[1]) n -= 1; // drop closing vertex
  }
  if (n < 3) return null;
  const out = new Float64Array(n * 2);
  for (let i = 0; i < n; i++) {
    const p = ring[i] as number[];
    const [x, y, z] = frame.wgs84ToScene(p[0] as number, p[1] as number, 0);
    if (!Number.isFinite(x) || !Number.isFinite(z) || !Number.isFinite(y)) return null;
    out[i * 2] = x;
    out[i * 2 + 1] = z;
  }
  return out;
}

function polygonRings(coords: number[][][], frame: CoordinateFrame): Float64Array[] {
  const rings: Float64Array[] = [];
  for (let r = 0; r < coords.length; r++) {
    const flat = ringToScene(coords[r] as number[][], frame);
    if (!flat) continue;
    const area = signedArea(flat);
    if (Math.abs(area) < 1e-9) continue; // degenerate
    // Outer ring CCW in (x, -z); holes CW.
    const wantPositive = rings.length === 0;
    rings.push(area > 0 === wantPositive ? flat : reverseRing(flat));
  }
  return rings;
}

function boundsOf(rings: Float64Array[]): LanePolygon['bounds'] {
  let minX = Infinity;
  let maxX = -Infinity;
  let minZ = Infinity;
  let maxZ = -Infinity;
  for (const ring of rings) {
    for (let i = 0; i < ring.length; i += 2) {
      const x = ring[i] as number;
      const z = ring[i + 1] as number;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (z < minZ) minZ = z;
      if (z > maxZ) maxZ = z;
    }
  }
  return { minX, maxX, minZ, maxZ };
}

/**
 * Convert a parsed lane-polygon FeatureCollection into scene space.
 *
 * Features whose geometry is missing, non-polygonal or degenerate are skipped.
 * `MultiPolygon` members become one {@link LanePolygon} each, suffixed `#n`.
 */
export function lanePolygonsFromGeoJson(
  collection: FeatureCollection<LanePolygonProperties>,
  frame: CoordinateFrame,
): LanePolygon[] {
  const out: LanePolygon[] = [];
  const features = collection?.features ?? [];

  const push = (
    feature: Feature<LanePolygonProperties>,
    index: number,
    rings: Float64Array[],
    suffix = '',
  ): void => {
    if (rings.length === 0) return;
    const p = feature.properties ?? {};
    const roadId = String(p.road_id ?? '');
    const sectionId = Number(p.section_id ?? 0);
    const laneId = Number(p.lane_id ?? 0);
    const id = roadId ? `${roadId}:${sectionId}:${laneId}${suffix}` : `lane-${index}${suffix}`;
    out.push({
      id,
      roadId,
      sectionId,
      laneId,
      laneType: String(p.LaneType ?? 'unknown'),
      isJunction: p.is_junction === true,
      rings,
      bounds: boundsOf(rings),
      properties: p,
    });
  };

  for (let i = 0; i < features.length; i++) {
    const feature = features[i] as Feature<LanePolygonProperties>;
    const geom = feature?.geometry;
    if (!geom) continue;
    if (geom.type === 'Polygon') {
      push(feature, i, polygonRings(geom.coordinates as number[][][], frame));
    } else if (geom.type === 'MultiPolygon') {
      const polys = geom.coordinates as number[][][][];
      for (let k = 0; k < polys.length; k++) {
        push(feature, i, polygonRings(polys[k] as number[][][], frame), `#${k}`);
      }
    }
  }
  return out;
}

/**
 * Fetch and convert `lane-polygons.geojson(.gz)`.
 *
 * @param url Location of the (optionally gzipped) GeoJSON.
 * @param frame Coordinate frame for the map.
 */
export async function loadLanePolygons(
  url: string,
  frame: CoordinateFrame,
): Promise<LanePolygon[]> {
  const json = await loadGzipJson<FeatureCollection<LanePolygonProperties>>(url);
  return lanePolygonsFromGeoJson(json, frame);
}
