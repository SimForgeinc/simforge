/**
 * 2D geometry over xodr-local metres. Pure, allocation-light, no dependencies.
 */

/** A point in xodr-local metres (x east, y north). */
export interface Point2 {
  x: number;
  y: number;
}

/** Euclidean distance. */
export function dist(a: Point2, b: Point2): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

/** Squared distance (cheap comparisons). */
export function dist2(a: Point2, b: Point2): number {
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  return dx * dx + dy * dy;
}

/** Heading of `b - a` in radians, `atan2` convention (0 = +x, CCW positive). */
export function headingOf(a: Point2, b: Point2): number {
  return Math.atan2(b.y - a.y, b.x - a.x);
}

/** Wrap an angle into `(-PI, PI]`. */
export function wrapPi(a: number): number {
  let x = a;
  while (x <= -Math.PI) x += 2 * Math.PI;
  while (x > Math.PI) x -= 2 * Math.PI;
  return x;
}

/** Smallest absolute difference between two headings, radians in `[0, PI]`. */
export function angleBetween(a: number, b: number): number {
  return Math.abs(wrapPi(b - a));
}

/**
 * Convert an xodr-local heading (0 = east, CCW) to a compass bearing
 * (0 = north, clockwise), in degrees `[0, 360)`.
 */
export function headingToBearingDeg(headingRad: number): number {
  const deg = 90 - (headingRad * 180) / Math.PI;
  return ((deg % 360) + 360) % 360;
}

/** Bearing from `a` to `b`, degrees (0 = north, clockwise). */
export function bearingDegBetween(a: Point2, b: Point2): number {
  return headingToBearingDeg(headingOf(a, b));
}

/** Signed cross product `(b-a) x (c-a)`. Positive when `c` is left of `a→b`. */
export function cross(a: Point2, b: Point2, c: Point2): number {
  return (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
}

/** Result of projecting a point onto a segment. */
export interface Projection {
  /** Closest point on the segment. */
  point: Point2;
  /** Parameter along the segment in `[0, 1]`. */
  t: number;
  /** Distance from the query point to `point`. */
  distance: number;
  /** Signed lateral offset: positive when the query point is left of `a→b`. */
  side: number;
}

/** Project `p` onto segment `a→b`. */
export function projectOnSegment(p: Point2, a: Point2, b: Point2): Projection {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len2 = dx * dx + dy * dy;
  const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2));
  const point = { x: a.x + t * dx, y: a.y + t * dy };
  const distance = dist(p, point);
  const side = cross(a, b, p) >= 0 ? distance : -distance;
  return { point, t, distance, side };
}

/** Cumulative arc lengths along a polyline. `out[0] === 0`. */
export function cumulativeLengths(points: readonly Point2[]): number[] {
  const out = new Array<number>(points.length);
  out[0] = 0;
  for (let i = 1; i < points.length; i++) {
    const p = points[i] as Point2;
    const q = points[i - 1] as Point2;
    out[i] = (out[i - 1] as number) + Math.hypot(p.x - q.x, p.y - q.y);
  }
  return out;
}

/** Total length of a polyline. */
export function polylineLength(points: readonly Point2[]): number {
  if (points.length < 2) return 0;
  const c = cumulativeLengths(points);
  return c[c.length - 1] as number;
}

/** A pose sampled along a polyline. */
export interface PolylinePose {
  point: Point2;
  headingRad: number;
  /** Index of the segment the sample fell on. */
  segmentIndex: number;
}

/** Sample a polyline at arc length `s` (clamped to the polyline's extent). */
export function poseAtS(
  points: readonly Point2[],
  cum: readonly number[],
  s: number,
): PolylinePose {
  const n = points.length;
  if (n === 0) throw new Error('poseAtS: empty polyline');
  if (n === 1) {
    return { point: points[0] as Point2, headingRad: 0, segmentIndex: 0 };
  }
  const total = cum[cum.length - 1] as number;
  const target = Math.max(0, Math.min(total, s));
  // Binary search for the segment containing `target`.
  let lo = 0;
  let hi = n - 1;
  while (lo + 1 < hi) {
    const mid = (lo + hi) >> 1;
    if ((cum[mid] as number) <= target) lo = mid;
    else hi = mid;
  }
  const a = points[lo] as Point2;
  const b = points[lo + 1] as Point2;
  const segLen = (cum[lo + 1] as number) - (cum[lo] as number);
  const t = segLen === 0 ? 0 : (target - (cum[lo] as number)) / segLen;
  return {
    point: { x: a.x + t * (b.x - a.x), y: a.y + t * (b.y - a.y) },
    headingRad: headingOf(a, b),
    segmentIndex: lo,
  };
}

/** Where two segments cross. */
export interface SegmentIntersection {
  point: Point2;
  /** Parameter along `a1→a2` in `(0, 1)`. */
  tA: number;
  /** Parameter along `b1→b2` in `(0, 1)`. */
  tB: number;
}

/**
 * Proper intersection of two open segments.
 *
 * Endpoint touches are deliberately excluded (`EPS` bound on both parameters):
 * junction connecting lanes that merely *share* an endpoint — two movements
 * feeding the same exit lane — are a merge, not a crossing, and are classified
 * separately.
 */
export function segmentIntersection(
  a1: Point2,
  a2: Point2,
  b1: Point2,
  b2: Point2,
  eps = 1e-9,
): SegmentIntersection | null {
  const rx = a2.x - a1.x;
  const ry = a2.y - a1.y;
  const sx = b2.x - b1.x;
  const sy = b2.y - b1.y;
  const denom = rx * sy - ry * sx;
  if (Math.abs(denom) < eps) return null; // parallel or degenerate
  const qpx = b1.x - a1.x;
  const qpy = b1.y - a1.y;
  const tA = (qpx * sy - qpy * sx) / denom;
  const tB = (qpx * ry - qpy * rx) / denom;
  if (tA <= eps || tA >= 1 - eps) return null;
  if (tB <= eps || tB >= 1 - eps) return null;
  return { point: { x: a1.x + tA * rx, y: a1.y + tA * ry }, tA, tB };
}

/** Axis-aligned bounding box of a point set. */
export function bounds(points: readonly Point2[]): {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
} {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const p of points) {
    if (p.x < minX) minX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.x > maxX) maxX = p.x;
    if (p.y > maxY) maxY = p.y;
  }
  return { minX, minY, maxX, maxY };
}

/** Mean of a point set. Returns `{x: 0, y: 0}` for an empty set. */
export function centroid(points: readonly Point2[]): Point2 {
  if (points.length === 0) return { x: 0, y: 0 };
  let sx = 0;
  let sy = 0;
  for (const p of points) {
    sx += p.x;
    sy += p.y;
  }
  return { x: sx / points.length, y: sy / points.length };
}

/**
 * Great-circle-free metres-per-degree at a latitude. Adequate for the ≤3 km
 * map extents we deal with, and only ever used for coarse radius filters.
 */
export function metresPerDegree(lat: number): { perLng: number; perLat: number } {
  const rad = (lat * Math.PI) / 180;
  return { perLng: 111_320 * Math.cos(rad), perLat: 110_574 };
}
