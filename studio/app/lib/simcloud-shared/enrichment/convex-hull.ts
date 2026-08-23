/**
 * Andrew's monotone chain convex hull. Pure 2-D, no external deps.
 *
 * Input is an array of `[x, y]` (or `[lng, lat]`) tuples; output is the
 * outer ring of the hull as a closed list (last point equals first).
 * Time complexity is O(n log n), dominated by the lexicographic sort.
 *
 * Behaviour on degenerate inputs:
 *   - 0 or 1 points → returns the input unchanged (no closure).
 *   - >2 collinear points → collapses to the two extremes.
 *
 * Strictly-on-edge points are excluded (cross product == 0 → pop), which
 * keeps the ring minimal and avoids spurious vertices when the input has
 * many co-linear samples (common for road centerlines).
 */
export type LngLat = [number, number];

export function convexHull(points: ReadonlyArray<LngLat>): LngLat[] {
  if (points.length <= 1) return points.slice() as LngLat[];

  const pts = [...points].sort((a, b) => a[0] - b[0] || a[1] - b[1]);

  const cross = (o: LngLat, a: LngLat, b: LngLat) =>
    (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);

  const lower: LngLat[] = [];
  for (const p of pts) {
    while (lower.length >= 2 && cross(lower[lower.length - 2]!, lower[lower.length - 1]!, p) <= 0) {
      lower.pop();
    }
    lower.push(p);
  }

  const upper: LngLat[] = [];
  for (let i = pts.length - 1; i >= 0; i--) {
    const p = pts[i]!;
    while (upper.length >= 2 && cross(upper[upper.length - 2]!, upper[upper.length - 1]!, p) <= 0) {
      upper.pop();
    }
    upper.push(p);
  }

  // Drop the last element of each chain to avoid duplicating the join points.
  lower.pop();
  upper.pop();

  const hull = [...lower, ...upper];
  if (hull.length === 0) return [];
  hull.push(hull[0]!);
  return hull;
}
