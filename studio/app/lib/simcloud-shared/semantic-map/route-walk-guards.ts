import { distance3dOr2d, orientToJoin, polylineLength } from "./geometry";
import type { SemanticMapPoint } from "./types";

const MIN_UNAUTHORED_PROGRESS_RATIO = 0.1;

function firstSegmentHeading(points: readonly SemanticMapPoint[]): number | null {
  for (let index = 1; index < points.length; index += 1) {
    const from = points[index - 1]!;
    const to = points[index]!;
    if (Math.hypot(to.x - from.x, to.y - from.y) > 0.1) {
      return Math.atan2(to.y - from.y, to.x - from.x);
    }
  }
  return null;
}

function lastSegmentHeading(points: readonly SemanticMapPoint[]): number | null {
  for (let index = points.length - 1; index > 0; index -= 1) {
    const from = points[index - 1]!;
    const to = points[index]!;
    if (Math.hypot(to.x - from.x, to.y - from.y) > 0.1) {
      return Math.atan2(to.y - from.y, to.x - from.x);
    }
  }
  return null;
}

function absoluteHeadingDelta(left: number, right: number): number {
  let delta = right - left;
  while (delta > Math.PI) delta -= 2 * Math.PI;
  while (delta < -Math.PI) delta += 2 * Math.PI;
  return Math.abs(delta);
}

/**
 * Whether appending `source` continues the path instead of teleporting it.
 *
 * The graph builder stamps the seam limits it used into the artifact. Reusing
 * those measured limits here closes a hole in old/prebuilt graphs: ten of 3469
 * corridor starts on the 2026-07-31 nine-map corpus named a semantic successor
 * 19.7–128.9 m away, or joined a nearby lane with a 166–180° heading change.
 * Trusting the id alone made the actor jump or reverse; stopping is the only
 * honest outcome when the geometry contradicts the edge.
 */
export function joinsWalk(
  walked: readonly { point: SemanticMapPoint }[],
  source: readonly SemanticMapPoint[],
  maximumGapM: number,
  maximumHeadingDeltaRad: number,
  mayReverse: boolean,
): boolean {
  if (walked.length === 0 || source.length < 2) return source.length >= 2;
  const priorPoints = walked.map((entry) => entry.point);
  const prior = priorPoints[priorPoints.length - 1]!;
  const oriented = mayReverse ? orientToJoin(prior, source) : [...source];
  if (distance3dOr2d(prior, oriented[0]!) > maximumGapM) return false;
  const incoming = lastSegmentHeading(priorPoints);
  const outgoing = firstSegmentHeading(oriented);
  return (
    incoming === null ||
    outgoing === null ||
    absoluteHeadingDelta(incoming, outgoing) <= maximumHeadingDeltaRad
  );
}

/**
 * Remove an artifact-only terminal detour when the preceding point is the real seam.
 *
 * Some prebuilt graphs contain XODR tail points that turn 82–90° away from the
 * CARLA crawl before a direct successor; the unextended runtime endpoint itself
 * joins that successor within millimetres. Walking the synthetic tail put ten
 * anchors outside their runtime lanes on the 2026-07-31 corpus. This guard is
 * deliberately narrow: it trims only an over-limit terminal heading change and
 * only when doing so restores a geometrically valid direct continuation.
 */
export function trimTerminalDetour(
  points: readonly SemanticMapPoint[],
  successorPolylines: readonly (readonly SemanticMapPoint[])[],
  maximumGapM: number,
  maximumHeadingDeltaRad: number,
): SemanticMapPoint[] {
  const original = [...points];
  let candidate = original;
  const canJoin = (prior: readonly SemanticMapPoint[]): boolean =>
    successorPolylines.some((successor) =>
      joinsWalk(
        prior.map((point) => ({ point })),
        successor,
        maximumGapM,
        maximumHeadingDeltaRad,
        true,
      ),
    );
  if (successorPolylines.length === 0 || canJoin(candidate)) return candidate;

  while (candidate.length > 2) {
    const prefix = candidate.slice(0, -1);
    const incoming = lastSegmentHeading(prefix);
    const tail = lastSegmentHeading(candidate.slice(-2));
    if (
      incoming === null ||
      tail === null ||
      absoluteHeadingDelta(incoming, tail) <= maximumHeadingDeltaRad
    ) {
      return original;
    }
    if (canJoin(prefix)) return prefix;
    candidate = prefix;
  }
  return original;
}

/**
 * Reject an unauthored branch that mostly cancels travel already completed.
 *
 * Weighted routing can choose a perfectly connected lap around an urban block
 * without repeating a corridor. On the nine-map 500 m corpus, 127 routes ended
 * with under 10% net displacement despite having no authored turn. That is not
 * a useful interpretation of "drive" for a placed actor. Authored turns bypass
 * this guard; their geometry is an explicit request, even when it comes back.
 */
export function maintainsUnauthoredProgress(
  walked: readonly { point: SemanticMapPoint }[],
  travelledM: number,
  additions: readonly (readonly SemanticMapPoint[])[],
): boolean {
  if (walked.length === 0 || additions.length === 0) return true;
  let addedM = 0;
  let endpoint = walked[walked.length - 1]!.point;
  for (const addition of additions) {
    if (addition.length === 0) continue;
    addedM += polylineLength(addition);
    endpoint = addition[addition.length - 1]!;
  }
  const pathM = travelledM + addedM;
  if (pathM <= 50) return true;
  return (
    distance3dOr2d(walked[0]!.point, endpoint) / pathM >=
    MIN_UNAUTHORED_PROGRESS_RATIO
  );
}
