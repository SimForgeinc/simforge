/**
 * Small deterministic geometry helpers.
 *
 * Everything here operates in the **xodr-local** frame: `x` east, `y` north,
 * metres, headings measured CCW from `+x`. See `src/frames.ts` for the
 * scene-frame boundary.
 */

/** A 2-D point in xodr-local metres. */
export interface Vec2 {
  readonly x: number;
  readonly y: number;
}

export const TWO_PI = Math.PI * 2;

export function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

export function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

export function dist(a: Vec2, b: Vec2): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

export function dist2(a: Vec2, b: Vec2): number {
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  return dx * dx + dy * dy;
}

/** Wrap an angle into `(-PI, PI]`. */
export function normalizeAngle(a: number): number {
  let v = a % TWO_PI;
  if (v <= -Math.PI) v += TWO_PI;
  if (v > Math.PI) v -= TWO_PI;
  return v;
}

/** Shortest signed delta from `from` to `to`, in `(-PI, PI]`. */
export function angleDelta(from: number, to: number): number {
  return normalizeAngle(to - from);
}

/** Interpolate between two headings the short way round. */
export function lerpAngle(a: number, b: number, t: number): number {
  return normalizeAngle(a + angleDelta(a, b) * t);
}

/**
 * Round to a fixed number of decimals with a deterministic tie rule.
 *
 * Used only for trace serialisation, never inside the integrator: quantising
 * the output keeps the gzipped trace small and keeps byte-comparison stable
 * across platforms that may differ in the last ULP of `Math.hypot` et al.
 */
export function quantize(v: number, decimals: number): number {
  if (!Number.isFinite(v)) return 0;
  const f = 10 ** decimals;
  // `Math.round` on a negative half rounds toward +Infinity; force symmetry so
  // mirrored scenarios quantise identically.
  const scaled = v * f;
  const r = scaled < 0 ? -Math.round(-scaled) : Math.round(scaled);
  // `+ 0` normalises `-0` to `0` so JSON.stringify never emits `-0`.
  return r / f + 0;
}

/** An oriented bounding box in the ground plane. */
export interface Obb {
  /** Centre in xodr-local metres. */
  readonly center: Vec2;
  /** Full length along the heading axis, metres. */
  readonly lengthM: number;
  /** Full width across the heading axis, metres. */
  readonly widthM: number;
  /** Heading in radians, CCW from `+x`. */
  readonly headingRad: number;
}

/** The four corners of an OBB, counter-clockwise from front-left. */
export function obbCorners(obb: Obb): [Vec2, Vec2, Vec2, Vec2] {
  const c = Math.cos(obb.headingRad);
  const s = Math.sin(obb.headingRad);
  const hl = obb.lengthM / 2;
  const hw = obb.widthM / 2;
  const fx = c * hl;
  const fy = s * hl;
  const lx = -s * hw;
  const ly = c * hw;
  return [
    { x: obb.center.x + fx + lx, y: obb.center.y + fy + ly },
    { x: obb.center.x - fx + lx, y: obb.center.y - fy + ly },
    { x: obb.center.x - fx - lx, y: obb.center.y - fy - ly },
    { x: obb.center.x + fx - lx, y: obb.center.y + fy - ly },
  ];
}

function projectExtent(points: readonly Vec2[], ax: number, ay: number): [number, number] {
  let lo = Infinity;
  let hi = -Infinity;
  for (const p of points) {
    const v = p.x * ax + p.y * ay;
    if (v < lo) lo = v;
    if (v > hi) hi = v;
  }
  return [lo, hi];
}

/** Separating-axis test. `true` when the two boxes overlap (touching counts). */
export function obbOverlap(a: Obb, b: Obb): boolean {
  const ca = obbCorners(a);
  const cb = obbCorners(b);
  const axes: Array<[number, number]> = [
    [Math.cos(a.headingRad), Math.sin(a.headingRad)],
    [-Math.sin(a.headingRad), Math.cos(a.headingRad)],
    [Math.cos(b.headingRad), Math.sin(b.headingRad)],
    [-Math.sin(b.headingRad), Math.cos(b.headingRad)],
  ];
  for (const [ax, ay] of axes) {
    const [alo, ahi] = projectExtent(ca, ax, ay);
    const [blo, bhi] = projectExtent(cb, ax, ay);
    if (ahi < blo || bhi < alo) return false;
  }
  return true;
}

/** Exact minimum surface separation between two ground-plane OBBs. */
export function obbSeparation(a: Obb, b: Obb): number {
  if (obbOverlap(a, b)) return 0;
  const ac = obbCorners(a);
  const bc = obbCorners(b);
  let best2 = Infinity;
  for (const p of ac) for (let i = 0; i < 4; i++) best2 = Math.min(best2, pointSegment(p, bc[i]!, bc[(i + 1) % 4]!).d2);
  for (const p of bc) for (let i = 0; i < 4; i++) best2 = Math.min(best2, pointSegment(p, ac[i]!, ac[(i + 1) % 4]!).d2);
  return Math.sqrt(best2);
}

/** Squared distance from a point to a segment, plus the clamped parameter. */
export function pointSegment(p: Vec2, a: Vec2, b: Vec2): { t: number; d2: number; closest: Vec2 } {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len2 = dx * dx + dy * dy;
  const t = len2 <= 0 ? 0 : clamp(((p.x - a.x) * dx + (p.y - a.y) * dy) / len2, 0, 1);
  const closest = { x: a.x + dx * t, y: a.y + dy * t };
  return { t, d2: dist2(p, closest), closest };
}

/** Segment/segment intersection parameter along `p→p2`, or `null`. */
export function segmentIntersection(p: Vec2, p2: Vec2, q: Vec2, q2: Vec2): number | null {
  const rx = p2.x - p.x;
  const ry = p2.y - p.y;
  const sx = q2.x - q.x;
  const sy = q2.y - q.y;
  const denom = rx * sy - ry * sx;
  if (Math.abs(denom) < 1e-12) return null;
  const qpx = q.x - p.x;
  const qpy = q.y - p.y;
  const t = (qpx * sy - qpy * sx) / denom;
  const u = (qpx * ry - qpy * rx) / denom;
  if (t < 0 || t > 1 || u < 0 || u > 1) return null;
  return t;
}

/** Point-in-polygon by ray casting; boundary membership is unspecified. */
export function pointInPolygon(p: Vec2, poly: readonly Vec2[]): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i]!;
    const b = poly[j]!;
    if (a.y > p.y !== b.y > p.y) {
      const xAt = ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x;
      if (p.x < xAt) inside = !inside;
    }
  }
  return inside;
}
