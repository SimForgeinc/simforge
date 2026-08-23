type Point3 = { x: number; y: number; z: number | null };

type PolylineProjection = {
  segment: number;
  fraction: number;
  distanceM: number;
  point: Point3;
};

function projectOntoPolyline(
  points: readonly Point3[],
  target: { x: number; y: number },
  preferLast: boolean,
  minimumSegment = 0,
): PolylineProjection {
  let best: PolylineProjection | null = null;
  for (let segment = minimumSegment; segment + 1 < points.length; segment += 1) {
    const from = points[segment]!;
    const to = points[segment + 1]!;
    const dx = to.x - from.x;
    const dy = to.y - from.y;
    const lengthSq = dx * dx + dy * dy;
    const raw =
      lengthSq <= 1e-18
        ? 0
        : ((target.x - from.x) * dx + (target.y - from.y) * dy) / lengthSq;
    const fraction = Math.max(0, Math.min(1, raw));
    const x = from.x + fraction * dx;
    const y = from.y + fraction * dy;
    const distanceM = Math.hypot(target.x - x, target.y - y);
    const z =
      from.z === null || to.z === null
        ? from.z ?? to.z
        : from.z + fraction * (to.z - from.z);
    const candidate = { segment, fraction, distanceM, point: { x, y, z } };
    const better =
      best === null ||
      distanceM < best.distanceM - 1e-9 ||
      (preferLast && Math.abs(distanceM - best.distanceM) <= 1e-9);
    if (better) best = candidate;
  }
  return best!;
}

/**
 * Keep the directed interval between two anchors on a dense polyline.
 *
 * The first projection wins for the start and the last for the end. A route
 * that legitimately loops through the same position therefore retains the lap
 * rather than collapsing to the shortest pair of coincident projections.
 */
export function cropPolylineToAnchors(
  points: readonly Point3[],
  start: { x: number; y: number },
  end: { x: number; y: number },
): Point3[] {
  const first = projectOntoPolyline(points, start, false);
  const last = projectOntoPolyline(points, end, true, first.segment);
  const cropped = [first.point];
  for (let index = first.segment + 1; index <= last.segment; index += 1) {
    const point = points[index]!;
    const previous = cropped[cropped.length - 1]!;
    if (Math.hypot(point.x - previous.x, point.y - previous.y) > 0.001) {
      cropped.push(point);
    }
  }
  const previous = cropped[cropped.length - 1]!;
  if (Math.hypot(last.point.x - previous.x, last.point.y - previous.y) > 0.001) {
    cropped.push(last.point);
  } else {
    cropped[cropped.length - 1] = last.point;
  }
  return cropped;
}
