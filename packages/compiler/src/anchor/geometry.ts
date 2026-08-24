/**
 * Planar helpers over lane polylines.
 *
 * Everything here is 2-D on purpose: `topology-index` polylines carry `{x, y}`
 * only. Grade is therefore *not derivable* — see `IndexCapabilities.grade`,
 * and note that we fail a required `gradePct` clause loudly rather than
 * scoring it a silent 1.0.
 */

import type { Point2 } from './types/map-index.js';

export const TAU = Math.PI * 2;

export function dist(a: Point2, b: Point2): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

/** Cumulative arc length at each vertex; `[0] === 0`. */
export function cumulativeLengths(poly: readonly Point2[]): number[] {
  const out = new Array<number>(poly.length);
  out[0] = 0;
  for (let i = 1; i < poly.length; i += 1) {
    out[i] = (out[i - 1] as number) + dist(poly[i - 1] as Point2, poly[i] as Point2);
  }
  return out;
}

export function polylineLength(poly: readonly Point2[]): number {
  if (poly.length < 2) return 0;
  const c = cumulativeLengths(poly);
  return c[c.length - 1] as number;
}

/** Point at arc length `s`, clamped to the ends. */
export function pointAtS(poly: readonly Point2[], s: number): Point2 {
  if (poly.length === 0) return { x: 0, y: 0 };
  if (poly.length === 1) return poly[0] as Point2;
  const c = cumulativeLengths(poly);
  const total = c[c.length - 1] as number;
  const target = Math.min(Math.max(s, 0), total);
  for (let i = 1; i < poly.length; i += 1) {
    const prev = c[i - 1] as number;
    const cur = c[i] as number;
    if (target <= cur) {
      const seg = cur - prev;
      const t = seg <= 1e-9 ? 0 : (target - prev) / seg;
      const a = poly[i - 1] as Point2;
      const b = poly[i] as Point2;
      return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t };
    }
  }
  return poly[poly.length - 1] as Point2;
}

/** Tangent heading (radians, CCW from +x) at arc length `s`. */
export function headingAtS(poly: readonly Point2[], s: number): number {
  if (poly.length < 2) return 0;
  const c = cumulativeLengths(poly);
  const total = c[c.length - 1] as number;
  const target = Math.min(Math.max(s, 0), total);
  for (let i = 1; i < poly.length; i += 1) {
    if (target <= (c[i] as number) || i === poly.length - 1) {
      const a = poly[i - 1] as Point2;
      const b = poly[i] as Point2;
      return Math.atan2(b.y - a.y, b.x - a.x);
    }
  }
  return 0;
}

/** Signed angle difference in `(-pi, pi]`. */
export function angleDiff(a: number, b: number): number {
  let d = (a - b) % TAU;
  if (d > Math.PI) d -= TAU;
  if (d <= -Math.PI) d += TAU;
  return d;
}

export const toDeg = (rad: number): number => (rad * 180) / Math.PI;
export const toRad = (deg: number): number => (deg * Math.PI) / 180;

/**
 * Mean absolute heading change per 10 m, evaluated over a window centred on
 * `s`. This is the `curvatureDegPer10m` clause unit.
 */
export function curvatureDegPer10mAt(
  poly: readonly Point2[],
  s: number,
  windowM = 10,
): number {
  const total = polylineLength(poly);
  if (total < 1) return 0;
  const half = windowM / 2;
  const s0 = Math.max(0, Math.min(total - 1e-6, s - half));
  const s1 = Math.max(s0 + 1e-6, Math.min(total, s + half));
  const h0 = headingAtS(poly, s0);
  const h1 = headingAtS(poly, s1);
  const span = s1 - s0;
  return (Math.abs(toDeg(angleDiff(h1, h0))) * 10) / span;
}

/** Nearest point on a polyline to `p`: arc length, distance, and side. */
export function projectPoint(
  poly: readonly Point2[],
  p: Point2,
): { s: number; distance: number; side: 1 | -1 } {
  let best = { s: 0, distance: Infinity, side: 1 as 1 | -1 };
  if (poly.length === 0) return best;
  if (poly.length === 1) {
    return { s: 0, distance: dist(poly[0] as Point2, p), side: 1 };
  }
  const c = cumulativeLengths(poly);
  for (let i = 1; i < poly.length; i += 1) {
    const a = poly[i - 1] as Point2;
    const b = poly[i] as Point2;
    const vx = b.x - a.x;
    const vy = b.y - a.y;
    const len2 = vx * vx + vy * vy;
    const t = len2 <= 1e-12 ? 0 : Math.min(1, Math.max(0, ((p.x - a.x) * vx + (p.y - a.y) * vy) / len2));
    const qx = a.x + vx * t;
    const qy = a.y + vy * t;
    const d = Math.hypot(p.x - qx, p.y - qy);
    if (d < best.distance) {
      const cross = vx * (p.y - a.y) - vy * (p.x - a.x);
      best = {
        s: (c[i - 1] as number) + t * Math.sqrt(len2),
        distance: d,
        // +1 = left of travel direction, -1 = right.
        side: cross >= 0 ? 1 : -1,
      };
    }
  }
  return best;
}

export interface PolylineCrossing {
  point: Point2;
  sOnA: number;
  sOnB: number;
  /** Absolute crossing angle in [0, 180]. */
  angleDeg: number;
}

/**
 * First proper intersection of two polylines (segment/segment, O(n·m)).
 *
 * ~500 gates per map with ~30-vertex connecting lanes: a few million float ops
 * per map, once, at catalog time. The research doc is explicit that this needs
 * no spatial index at our scale.
 */
export function polylineIntersection(
  a: readonly Point2[],
  b: readonly Point2[],
): PolylineCrossing | null {
  if (a.length < 2 || b.length < 2) return null;
  const ca = cumulativeLengths(a);
  const cb = cumulativeLengths(b);
  let best: PolylineCrossing | null = null;
  for (let i = 1; i < a.length; i += 1) {
    const p1 = a[i - 1] as Point2;
    const p2 = a[i] as Point2;
    const r = { x: p2.x - p1.x, y: p2.y - p1.y };
    for (let j = 1; j < b.length; j += 1) {
      const q1 = b[j - 1] as Point2;
      const q2 = b[j] as Point2;
      const s = { x: q2.x - q1.x, y: q2.y - q1.y };
      const denom = r.x * s.y - r.y * s.x;
      if (Math.abs(denom) < 1e-12) continue;
      const qp = { x: q1.x - p1.x, y: q1.y - p1.y };
      const t = (qp.x * s.y - qp.y * s.x) / denom;
      const u = (qp.x * r.y - qp.y * r.x) / denom;
      if (t < 0 || t > 1 || u < 0 || u > 1) continue;
      const point = { x: p1.x + r.x * t, y: p1.y + r.y * t };
      const sOnA = (ca[i - 1] as number) + t * Math.hypot(r.x, r.y);
      const sOnB = (cb[j - 1] as number) + u * Math.hypot(s.x, s.y);
      const angle = Math.abs(toDeg(angleDiff(Math.atan2(r.y, r.x), Math.atan2(s.y, s.x))));
      const candidate: PolylineCrossing = { point, sOnA, sOnB, angleDeg: angle };
      if (!best || candidate.sOnA < best.sOnA) best = candidate;
    }
  }
  return best;
}

/** Axis-aligned bounding box of a polyline, for cheap rejection. */
export function bbox(poly: readonly Point2[]): { minX: number; minY: number; maxX: number; maxY: number } {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const p of poly) {
    if (p.x < minX) minX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.x > maxX) maxX = p.x;
    if (p.y > maxY) maxY = p.y;
  }
  return { minX, minY, maxX, maxY };
}

export function bboxOverlaps(
  a: ReturnType<typeof bbox>,
  b: ReturnType<typeof bbox>,
  pad = 0,
): boolean {
  return (
    a.minX - pad <= b.maxX && b.minX - pad <= a.maxX && a.minY - pad <= b.maxY && b.minY - pad <= a.maxY
  );
}
