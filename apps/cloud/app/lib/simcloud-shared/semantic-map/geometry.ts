import type { SemanticMapPoint } from "./types";

export function quantize(value: number, precision = 1e-6): number {
  const rounded = Math.round(value / precision) * precision;
  return Object.is(rounded, -0) ? 0 : rounded;
}

export function quantizePoint(point: SemanticMapPoint): SemanticMapPoint {
  return {
    x: quantize(point.x, 0.001),
    y: quantize(point.y, 0.001),
    z: point.z == null ? null : quantize(point.z, 0.001),
  };
}

export function distance2d(left: SemanticMapPoint, right: SemanticMapPoint): number {
  return Math.hypot(left.x - right.x, left.y - right.y);
}

export function distance3dOr2d(left: SemanticMapPoint, right: SemanticMapPoint): number {
  const planar = distance2d(left, right);
  return left.z == null || right.z == null
    ? planar
    : Math.hypot(planar, left.z - right.z);
}

export function elevationDelta(
  left: SemanticMapPoint,
  right: SemanticMapPoint,
): number | null {
  return left.z == null || right.z == null ? null : Math.abs(left.z - right.z);
}

export function polylineLength(points: readonly SemanticMapPoint[]): number {
  let total = 0;
  for (let index = 1; index < points.length; index += 1) {
    total += distance3dOr2d(points[index - 1]!, points[index]!);
  }
  return total;
}

export function headingAtStart(points: readonly SemanticMapPoint[]): number {
  const left = points[0]!;
  const right = points[1]!;
  return Math.atan2(right.y - left.y, right.x - left.x);
}

export function headingAtEnd(points: readonly SemanticMapPoint[]): number {
  const left = points[points.length - 2]!;
  const right = points[points.length - 1]!;
  return Math.atan2(right.y - left.y, right.x - left.x);
}

/** The vertex closest to `stationM` along `points`, by arc length. */
export function vertexIndexAtStation(
  points: readonly SemanticMapPoint[],
  stationM: number,
): number {
  let station = 0;
  let best = 0;
  let bestGap = Math.abs(stationM);
  for (let index = 1; index < points.length; index += 1) {
    station += distance3dOr2d(points[index - 1]!, points[index]!);
    const gap = Math.abs(station - stationM);
    if (gap < bestGap) {
      bestGap = gap;
      best = index;
    }
  }
  return best;
}

/**
 * Heading of the edge arriving at `stationM` (`"before"`) or leaving it
 * (`"after"`).
 *
 * Stations are read at the seams a composed path already recorded, so this
 * answers "which way was it pointing as it entered the junction, and as it
 * left" without the composed path's own start and end curvature getting mixed
 * in. Clamped at both ends, so a station on the first or last edge answers with
 * that edge.
 */
export function headingAtStation(
  points: readonly SemanticMapPoint[],
  stationM: number,
  side: "before" | "after",
): number {
  const vertex = vertexIndexAtStation(points, stationM);
  const from = side === "before"
    ? Math.max(0, Math.min(points.length - 2, vertex - 1))
    : Math.max(0, Math.min(points.length - 2, vertex));
  const left = points[from]!;
  const right = points[from + 1]!;
  return Math.atan2(right.y - left.y, right.x - left.x);
}

export function normalizeAngle(angle: number): number {
  let normalized = angle;
  while (normalized > Math.PI) normalized -= Math.PI * 2;
  while (normalized < -Math.PI) normalized += Math.PI * 2;
  return normalized;
}

export function angleDelta(left: number, right: number): number {
  return Math.abs(normalizeAngle(left - right));
}

/**
 * `source`, reversed if its far end joins `anchor` better than its near end.
 *
 * A lane's stored polyline runs in `+s` order and half a real map's lanes are
 * driven the other way (`lane-travel.ts`), so a composed path can be handed a
 * segment back to front. `appendPolyline`'s averaging join was written for two
 * lanes meeting with centimetres of survey noise between them, and it would
 * treat a REVERSAL as noise: splice the midpoint of the gap, then walk `source`
 * backwards toward where it started, reading as a smooth polyline all the way.
 *
 * Exposed rather than kept private so a caller that must ALSO reason about the
 * join — the gate-path seam evaluation — judges the same polyline that will be
 * composed. Two copies of this decision is how the composed geometry and the
 * seam verdict came to disagree.
 *
 * Worth little on the corpus maps as they stand: it is 4 of 51 failing gate
 * seams (8 maps, 2026-07-29), the rest being genuine. It is cheap insurance
 * against the case it describes rather than a fix for a measured fault — that
 * was the crawl truncation in `runtime-lane-geometry.ts`.
 *
 * "Materially" closer is deliberately a factor rather than an absolute: a
 * genuinely tiny segment can have both ends within noise of the join, and
 * flipping it either way is harmless.
 */
export function orientToJoin<T extends SemanticMapPoint>(
  anchor: SemanticMapPoint,
  source: readonly T[],
): T[] {
  if (source.length < 2) return [...source];
  const nearGap = distance3dOr2d(anchor, source[0]!);
  const farGap = distance3dOr2d(anchor, source[source.length - 1]!);
  return farGap < nearGap * 0.5 ? [...source].reverse() : [...source];
}

export function appendPolyline(
  target: SemanticMapPoint[],
  source: readonly SemanticMapPoint[],
): void {
  if (source.length === 0) return;
  if (target.length === 0) {
    target.push(...source.map(quantizePoint));
    return;
  }
  const targetLast = target[target.length - 1]!;
  // Half the near gap, so a marginal difference never flips a segment that is
  // already the right way round.
  const oriented = orientToJoin(targetLast, source);
  const sourceFirst = oriented[0]!;
  if (distance3dOr2d(targetLast, sourceFirst) <= 0.001) {
    target.push(...oriented.slice(1).map(quantizePoint));
    return;
  }
  const joined = quantizePoint({
    x: (targetLast.x + sourceFirst.x) / 2,
    y: (targetLast.y + sourceFirst.y) / 2,
    z:
      targetLast.z == null || sourceFirst.z == null
        ? targetLast.z ?? sourceFirst.z
        : (targetLast.z + sourceFirst.z) / 2,
  });
  target[target.length - 1] = joined;
  target.push(...oriented.slice(1).map(quantizePoint));
}

export type SegmentIntersection = {
  point: SemanticMapPoint;
  leftT: number;
  rightT: number;
  angleRad: number;
};

export function segmentIntersection(
  a: SemanticMapPoint,
  b: SemanticMapPoint,
  c: SemanticMapPoint,
  d: SemanticMapPoint,
): SegmentIntersection | null {
  const rX = b.x - a.x;
  const rY = b.y - a.y;
  const sX = d.x - c.x;
  const sY = d.y - c.y;
  const denominator = rX * sY - rY * sX;
  if (Math.abs(denominator) < 1e-9) return null;
  const qX = c.x - a.x;
  const qY = c.y - a.y;
  const leftT = (qX * sY - qY * sX) / denominator;
  const rightT = (qX * rY - qY * rX) / denominator;
  if (leftT < 0 || leftT > 1 || rightT < 0 || rightT > 1) return null;
  const leftZ = a.z == null || b.z == null ? null : a.z + leftT * (b.z - a.z);
  const rightZ = c.z == null || d.z == null ? null : c.z + rightT * (d.z - c.z);
  const z = leftZ == null || rightZ == null ? null : (leftZ + rightZ) / 2;
  const rawAngle = angleDelta(Math.atan2(rY, rX), Math.atan2(sY, sX));
  return {
    point: quantizePoint({ x: a.x + leftT * rX, y: a.y + leftT * rY, z }),
    leftT,
    rightT,
    angleRad: Math.min(rawAngle, Math.PI - rawAngle),
  };
}

export function pointAtMean(points: readonly SemanticMapPoint[]): SemanticMapPoint {
  const withZ = points.filter((point) => point.z != null);
  return quantizePoint({
    x: points.reduce((sum, point) => sum + point.x, 0) / points.length,
    y: points.reduce((sum, point) => sum + point.y, 0) / points.length,
    z:
      withZ.length === points.length
        ? withZ.reduce((sum, point) => sum + point.z!, 0) / withZ.length
        : null,
  });
}
