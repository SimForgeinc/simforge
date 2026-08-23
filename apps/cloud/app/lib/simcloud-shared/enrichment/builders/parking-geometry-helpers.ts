/**
 * Pure geometry helpers shared across the parking-builder subsystem.
 *
 * All functions operate on plain [lng, lat] coordinate pairs (WGS-84) and have
 * no dependencies outside this file and standard math. Extracted from
 * parking-builder.ts to keep that file under 1,000 lines.
 */

import type { ParkingAccessPoint } from "../../map-intelligence";

export type LngLat = [number, number];

/** Perpendicular distance (meters) below which a driving lane counts as adjacent. */
export const ACCESS_POINT_PROXIMITY_M = 6;
/** Minimum separation (meters) between distinct access points. */
export const ACCESS_POINT_DEDUPE_M = 5;

// ── Ring utilities ─────────────────────────────────────────────────────────

/** Ensure the first vertex equals the last (closed ring). */
export function closeRing(ring: LngLat[]): LngLat[] {
  if (ring.length < 2) return ring;
  const first = ring[0]!;
  const last = ring[ring.length - 1]!;
  if (first[0] === last[0] && first[1] === last[1]) return ring;
  return [...ring, first];
}

/** Simple average of ring vertices — adequate for cluster center display. */
export function polygonCentroid(ring: LngLat[]): { lat: number; lng: number } {
  let sumLng = 0;
  let sumLat = 0;
  for (const [lng, lat] of ring) {
    sumLng += lng;
    sumLat += lat;
  }
  return { lat: sumLat / ring.length, lng: sumLng / ring.length };
}

/**
 * Approximate planar area of a WGS-84 ring in square metres. Projects each
 * vertex onto a local equirectangular plane anchored at the ring's mean
 * latitude, then applies the Shoelace formula. Accuracy is more than good
 * enough at parking-lot scale (≤ a few hundred metres on a side, ≪ 1 km²),
 * where the equirectangular approximation introduces well under 1% error.
 *
 * Direction-agnostic: returns absolute area, so the ring can be wound either
 * CW or CCW.
 */
export function polygonAreaM2(ring: LngLat[]): number {
  if (ring.length < 3) return 0;
  let sumLat = 0;
  for (const [, lat] of ring) sumLat += lat;
  const meanLat = sumLat / ring.length;
  const mPerDegLat = 111_320;
  const mPerDegLng = 111_320 * Math.max(Math.cos((meanLat * Math.PI) / 180), 0.2);
  let twoArea = 0;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [x1, y1] = ring[j]!;
    const [x2, y2] = ring[i]!;
    const px1 = x1 * mPerDegLng;
    const py1 = y1 * mPerDegLat;
    const px2 = x2 * mPerDegLng;
    const py2 = y2 * mPerDegLat;
    twoArea += px1 * py2 - px2 * py1;
  }
  return Math.abs(twoArea) / 2;
}

export function ringBbox(ring: LngLat[]): {
  minLng: number;
  minLat: number;
  maxLng: number;
  maxLat: number;
} {
  let minLng = Infinity;
  let minLat = Infinity;
  let maxLng = -Infinity;
  let maxLat = -Infinity;
  for (const [lng, lat] of ring) {
    if (lng < minLng) minLng = lng;
    if (lng > maxLng) maxLng = lng;
    if (lat < minLat) minLat = lat;
    if (lat > maxLat) maxLat = lat;
  }
  return { minLng, minLat, maxLng, maxLat };
}

/** Diagonal of a ring's bounding box in meters — a cheap proxy for the
 * along-curb length of a (roughly linear) street-parking row. */
export function ringSpanM(ring: LngLat[]): number {
  if (ring.length < 2) return 0;
  const b = ringBbox(ring);
  const meanLat = (b.minLat + b.maxLat) / 2;
  const mPerDegLat = 111_320;
  const mPerDegLng = 111_320 * Math.max(Math.cos((meanLat * Math.PI) / 180), 0.2);
  const dx = (b.maxLng - b.minLng) * mPerDegLng;
  const dy = (b.maxLat - b.minLat) * mPerDegLat;
  return Math.hypot(dx, dy);
}

/**
 * Vertex-to-vertex squared distance test against `thresholdDeg²`. Returns
 * true when any vertex of `ringA` is within threshold of any vertex of
 * `ringB`. Uses single-linkage in the union-find caller, so chains of
 * adjacent lots get merged transitively. Bbox prefilter avoids the inner
 * loop for far-apart polygons.
 */
export function ringsWithinThresholdDeg(
  ringA: LngLat[],
  ringB: LngLat[],
  bboxA: { minLng: number; minLat: number; maxLng: number; maxLat: number },
  bboxB: { minLng: number; minLat: number; maxLng: number; maxLat: number },
  thresholdDeg: number,
): boolean {
  // Bbox prefilter: if the (expanded) bboxes don't overlap, no vertex pair
  // can be within threshold either.
  if (
    bboxA.maxLng + thresholdDeg < bboxB.minLng ||
    bboxA.minLng > bboxB.maxLng + thresholdDeg ||
    bboxA.maxLat + thresholdDeg < bboxB.minLat ||
    bboxA.minLat > bboxB.maxLat + thresholdDeg
  ) {
    return false;
  }
  const t2 = thresholdDeg * thresholdDeg;
  for (const [aLng, aLat] of ringA) {
    for (const [bLng, bLat] of ringB) {
      const dLng = aLng - bLng;
      const dLat = aLat - bLat;
      if (dLng * dLng + dLat * dLat <= t2) return true;
    }
  }
  return false;
}

// ── Point-in-polygon ───────────────────────────────────────────────────────

/** Ray-casting point-in-polygon. Polygon ring may be open or closed. */
export function pointInPolygon(point: LngLat, ring: LngLat[]): boolean {
  if (ring.length < 3) return false;
  const [px, py] = point;
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i]!;
    const [xj, yj] = ring[j]!;
    const intersects =
      yi > py !== yj > py &&
      px < ((xj - xi) * (py - yi)) / (yj - yi || 1e-12) + xi;
    if (intersects) inside = !inside;
  }
  return inside;
}

// ── Segment projection & bearing ──────────────────────────────────────────

export function projectPointOnSegment(
  p: LngLat,
  a: LngLat,
  b: LngLat,
  mPerDegLat: number,
  mPerDegLng: number,
): { dist: number; proj: LngLat; tFrac: number } {
  const pxM = (p[0] - a[0]) * mPerDegLng;
  const pyM = (p[1] - a[1]) * mPerDegLat;
  const bxM = (b[0] - a[0]) * mPerDegLng;
  const byM = (b[1] - a[1]) * mPerDegLat;
  const len2 = bxM * bxM + byM * byM;
  if (len2 < 1e-9) {
    const dx = p[0] - a[0];
    const dy = p[1] - a[1];
    return {
      dist: Math.sqrt(
        (dx * mPerDegLng) ** 2 + (dy * mPerDegLat) ** 2,
      ),
      proj: a,
      tFrac: 0,
    };
  }
  const tRaw = (pxM * bxM + pyM * byM) / len2;
  const t = Math.max(0, Math.min(1, tRaw));
  const projLng = a[0] + t * (b[0] - a[0]);
  const projLat = a[1] + t * (b[1] - a[1]);
  const dxM = (p[0] - projLng) * mPerDegLng;
  const dyM = (p[1] - projLat) * mPerDegLat;
  return {
    dist: Math.sqrt(dxM * dxM + dyM * dyM),
    proj: [projLng, projLat],
    tFrac: t,
  };
}

export function segmentBearingDeg(a: LngLat, b: LngLat): number {
  const dLng = b[0] - a[0];
  const dLat = b[1] - a[1];
  // Bearing: 0 = north, 90 = east, measured clockwise.
  const rad = Math.atan2(dLng, dLat);
  let deg = (rad * 180) / Math.PI;
  if (deg < 0) deg += 360;
  return Math.round(deg);
}

// ── GeoJSON polygon helpers ────────────────────────────────────────────────

export function computePolygonCentroid(
  coords: unknown,
  geomType: string,
): { lat: number; lng: number } | undefined {
  const points: number[][] = [];

  if (geomType === "Polygon" && Array.isArray(coords)) {
    const outerRing = (coords as number[][][])[0];
    if (outerRing) points.push(...outerRing);
  } else if (geomType === "MultiPolygon" && Array.isArray(coords)) {
    for (const polygon of coords as number[][][][]) {
      const outerRing = polygon?.[0];
      if (outerRing) points.push(...outerRing);
    }
  }

  if (points.length === 0) return undefined;

  let sumLng = 0, sumLat = 0;
  for (const pt of points) {
    sumLng += pt[0] ?? 0;
    sumLat += pt[1] ?? 0;
  }
  return { lat: sumLat / points.length, lng: sumLng / points.length };
}

export function firstPolygonRing(coords: unknown, geomType: string): LngLat[] | undefined {
  if (geomType === "Polygon" && Array.isArray(coords)) {
    const ring = (coords as number[][][])[0];
    return ring ? ring.map((c) => [c[0]!, c[1]!] as LngLat) : undefined;
  }
  if (geomType === "MultiPolygon" && Array.isArray(coords)) {
    const polygon = (coords as number[][][][])[0];
    const ring = polygon?.[0];
    return ring ? ring.map((c) => [c[0]!, c[1]!] as LngLat) : undefined;
  }
  return undefined;
}

// ── Access-point detection ─────────────────────────────────────────────────

export type DrivingLane = {
  roadId: string;
  laneId: string;
  coordinates: LngLat[];
};

export function dedupeAccessPoints(points: ParkingAccessPoint[]): ParkingAccessPoint[] {
  if (points.length <= 1) return points;
  const refLat = points[0]!.lat;
  const mPerDegLat = 111_320;
  const mPerDegLng = 111_320 * Math.max(Math.cos((refLat * Math.PI) / 180), 0.2);
  const dedupeDeg2 =
    (ACCESS_POINT_DEDUPE_M / mPerDegLat) ** 2 +
    (ACCESS_POINT_DEDUPE_M / mPerDegLng) ** 2;
  const out: ParkingAccessPoint[] = [];
  for (const p of points) {
    const dup = out.some((q) => {
      const dLat = q.lat - p.lat;
      const dLng = q.lng - p.lng;
      return dLat * dLat + dLng * dLng < dedupeDeg2;
    });
    if (!dup) out.push(p);
  }
  return out;
}

export function computeAccessPoints(
  boundaryRing: LngLat[],
  drivingLanes: DrivingLane[],
): ParkingAccessPoint[] {
  if (drivingLanes.length === 0 || boundaryRing.length < 2) return [];

  const refLat = boundaryRing[0]![1];
  const mPerDegLat = 111_320;
  const mPerDegLng = 111_320 * Math.max(Math.cos((refLat * Math.PI) / 180), 0.2);

  // Scan each driving-lane segment; for each one, find the closest boundary
  // vertex and if the perpendicular distance is small, record an access point.
  const found: ParkingAccessPoint[] = [];

  for (const lane of drivingLanes) {
    for (let i = 1; i < lane.coordinates.length; i++) {
      const [ax, ay] = lane.coordinates[i - 1]!;
      const [bx, by] = lane.coordinates[i]!;

      // Find the ring vertex whose perpendicular distance to this segment is smallest.
      let best: { dist: number; proj: LngLat; tFrac: number } | null = null;
      for (const [px, py] of boundaryRing) {
        const proj = projectPointOnSegment([px, py], [ax, ay], [bx, by], mPerDegLat, mPerDegLng);
        if (!best || proj.dist < best.dist) best = proj;
      }
      if (!best) continue;
      if (best.dist > ACCESS_POINT_PROXIMITY_M) continue;

      const bearingDeg = segmentBearingDeg([ax, ay], [bx, by]);
      const candidate: ParkingAccessPoint = {
        lat: best.proj[1],
        lng: best.proj[0],
        roadId: lane.roadId || undefined,
        bearingDeg,
      };

      const dedupeDeg2 =
        (ACCESS_POINT_DEDUPE_M / mPerDegLat) ** 2 +
        (ACCESS_POINT_DEDUPE_M / mPerDegLng) ** 2;
      const isDuplicate = found.some((ap) => {
        const dlat = ap.lat - candidate.lat;
        const dlng = ap.lng - candidate.lng;
        return dlat * dlat + dlng * dlng < dedupeDeg2;
      });
      if (!isDuplicate) found.push(candidate);
    }
  }

  return found;
}

/**
 * Nearest driving-lane perpendicular distance (meters) to a point, plus a
 * stable grouping key for that lane. The key mirrors the street-parking
 * extractor: prefer the lane's RoadID, falling back to `lane:<laneId>` when
 * RoadID is absent (RoadRunner GeoJSON often omits it — Di Rosa's 720 driving
 * lanes carry none), so on-street stalls get grouped per road / per lane and
 * never bridge an intersection.
 */
export function nearestDrivingLaneDistM(
  centroid: { lat: number; lng: number },
  drivingLanes: DrivingLane[],
): { distM: number; laneKey: string } {
  const mPerDegLat = 111_320;
  const mPerDegLng = 111_320 * Math.max(Math.cos((centroid.lat * Math.PI) / 180), 0.2);
  const p: LngLat = [centroid.lng, centroid.lat];
  let best = { distM: Infinity, laneKey: "lane:unknown" };
  for (const lane of drivingLanes) {
    for (let i = 1; i < lane.coordinates.length; i++) {
      const proj = projectPointOnSegment(
        p,
        lane.coordinates[i - 1]!,
        lane.coordinates[i]!,
        mPerDegLat,
        mPerDegLng,
      );
      if (proj.dist < best.distM) {
        best = { distM: proj.dist, laneKey: lane.roadId || `lane:${lane.laneId}` };
      }
    }
  }
  return best;
}
