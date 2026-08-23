/**
 * Simplify a polygon ring using the Ramer-Douglas-Peucker algorithm.
 *
 * Reduces vertex count while preserving the overall shape. Useful for candidate
 * location regions where 100+ vertex junction polygons are unnecessarily detailed
 * for storage and display.
 *
 * @param ring    Closed ring of [lng, lat] coordinates (first == last)
 * @param maxVertices  Target maximum vertex count (excluding closing point).
 *                     The algorithm iteratively increases tolerance until the
 *                     vertex count is at or below this limit. Default: 32.
 * @returns Simplified ring (closed — first == last). Never fewer than 4 vertices
 *          (triangle + closing point) to remain a valid polygon.
 */
export function simplifyPolygon(
  ring: [number, number][],
  maxVertices = 32,
): [number, number][] {
  if (ring.length <= maxVertices + 1) return ring;

  // Strip closing point for simplification, re-add at the end
  const isClosed = ring.length >= 2 &&
    ring[0]![0] === ring[ring.length - 1]![0] &&
    ring[0]![1] === ring[ring.length - 1]![1];
  const open = isClosed ? ring.slice(0, -1) : ring;

  if (open.length <= maxVertices) {
    return isClosed ? [...open, open[0]!] : open;
  }

  // Binary search for the right epsilon that produces <= maxVertices
  let lo = 0;
  let hi = estimateMaxEpsilon(open);
  let best = open;

  for (let iter = 0; iter < 30; iter++) {
    const mid = (lo + hi) / 2;
    const simplified = rdp(open, mid);
    if (simplified.length <= maxVertices) {
      best = simplified;
      hi = mid;
    } else {
      lo = mid;
    }
    if (simplified.length === maxVertices) break;
  }

  // Ensure minimum 3 vertices (valid triangle)
  if (best.length < 3) best = open.slice(0, 3);

  return isClosed ? [...best, best[0]!] : best;
}

/**
 * Ramer-Douglas-Peucker line simplification.
 * Iterative implementation to avoid stack overflow on large inputs.
 */
function rdp(
  points: [number, number][],
  epsilon: number,
): [number, number][] {
  if (points.length <= 2) return [...points];

  const keep = new Uint8Array(points.length);
  keep[0] = 1;
  keep[points.length - 1] = 1;

  // Stack-based iterative approach
  const stack: [number, number][] = [[0, points.length - 1]];

  while (stack.length > 0) {
    const [start, end] = stack.pop()!;
    let maxDist = 0;
    let maxIdx = start;

    for (let i = start + 1; i < end; i++) {
      const d = perpendicularDistance(points[i]!, points[start]!, points[end]!);
      if (d > maxDist) {
        maxDist = d;
        maxIdx = i;
      }
    }

    if (maxDist > epsilon) {
      keep[maxIdx] = 1;
      if (maxIdx - start > 1) stack.push([start, maxIdx]);
      if (end - maxIdx > 1) stack.push([maxIdx, end]);
    }
  }

  const result: [number, number][] = [];
  for (let i = 0; i < points.length; i++) {
    if (keep[i]) result.push(points[i]!);
  }
  return result;
}

/** Perpendicular distance from point P to the line segment A→B, in coordinate units. */
function perpendicularDistance(
  P: [number, number],
  A: [number, number],
  B: [number, number],
): number {
  const dx = B[0] - A[0];
  const dy = B[1] - A[1];
  const lenSq = dx * dx + dy * dy;
  if (lenSq < 1e-20) {
    // A and B are the same point
    const ex = P[0] - A[0];
    const ey = P[1] - A[1];
    return Math.sqrt(ex * ex + ey * ey);
  }
  // Area of triangle ABP × 2 / length of AB
  const area2 = Math.abs(dx * (A[1] - P[1]) - (A[0] - P[0]) * dy);
  return area2 / Math.sqrt(lenSq);
}

/** Estimate an upper bound for epsilon based on the bounding box diagonal. */
function estimateMaxEpsilon(points: [number, number][]): number {
  let minX = Infinity, maxX = -Infinity;
  let minY = Infinity, maxY = -Infinity;
  for (const [x, y] of points) {
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
  }
  const dx = maxX - minX;
  const dy = maxY - minY;
  return Math.sqrt(dx * dx + dy * dy) / 2;
}
