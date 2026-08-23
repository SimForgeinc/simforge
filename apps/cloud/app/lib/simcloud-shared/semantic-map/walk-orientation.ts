import type { SemanticMapPoint } from "./types";

/**
 * The order to visit a corridor's vertices so the car keeps moving FORWARD.
 *
 * A walk assumes a corridor's stored polyline starts where the previous leg
 * ended. Usually it does. When it does not — the corridor is stored against the
 * direction the walk arrives from — visiting it in stored order teleports the
 * car to the far end and drives it back through itself. Measured on Di Rosa: a
 * route stepped 5.9 m north along `40:3:-1` and then 5.9 m straight back south
 * along `40:4:-4` to the same point, a clean 180 degree reversal in the middle
 * of an otherwise straight run.
 *
 * `runwayPolyline` already solved this for DRAWING with `orientToJoin`; the
 * walks that produce the anchors never did, so the drawn line and the driven
 * line disagreed.
 *
 * Indices are returned rather than reordered points because each vertex's lane
 * binding (`runtimeBindingAtCorridorStation`) is keyed by its station along the
 * corridor's OWN axis. That is a property of the vertex, not of the direction it
 * is visited in, so it has to stay attached to the original index.
 */
export function corridorWalkIndices(
  lastPoint: SemanticMapPoint | null,
  polyline: readonly SemanticMapPoint[],
  sliceFrom: number,
): number[] {
  const forward: number[] = [];
  for (let index = sliceFrom; index < polyline.length; index += 1) forward.push(index);
  if (!lastPoint || forward.length < 2) return forward;
  const first = polyline[forward[0]!]!;
  const last = polyline[forward[forward.length - 1]!]!;
  const toFirst = Math.hypot(first.x - lastPoint.x, first.y - lastPoint.y);
  const toLast = Math.hypot(last.x - lastPoint.x, last.y - lastPoint.y);
  // Only a CLEAR disagreement flips the walk. A corridor whose two ends are
  // nearly equidistant from the join is a loop or a very short stub, and
  // guessing at one of those is how a fix becomes the next bug.
  return toLast < toFirst - 1e-6 ? [...forward].reverse() : forward;
}
