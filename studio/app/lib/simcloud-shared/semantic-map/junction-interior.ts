import type { JunctionMovementVariant, SemanticMapPoint } from "./types";

/**
 * The junction INTERIOR of a movement variant — the part a car actually crosses.
 *
 * A variant's `polyline` deliberately spans approach corridor + connector + exit
 * corridor: the editor draws a movement in context, and the seam checks need
 * geometry on both sides of the junction. `entryStationM` and `exitStationM` say
 * where the junction itself begins and ends along it. Across the nine dev maps
 * 5426 of 5431 variants carry ~66 m of that context.
 *
 * Any walk that takes the WHOLE polyline as the junction drives that context a
 * SECOND time, and from the wrong end: the walk has already driven the approach
 * corridor to its end, and the variant polyline starts back at that corridor's
 * START. The car therefore jumps backwards, re-drives the approach, crosses the
 * junction, drives the exit — and then drives the exit again from the outgoing
 * corridor's own start. Rendered, that is a car doubling back on itself and
 * looping, which is exactly what it looked like: a keep-lane ego on Di Rosa
 * covered 655 m of path to displace 229 m, with a 179 degree reversal in the
 * middle of a straight road.
 *
 * This lives in its own module because there are two independent walkers over
 * the same graph — `deriveRunway` and `compileAutopilotRoute` — and the bug was
 * present in both. One of them being fixed while the other was not is how it
 * survived a round of testing: the offline measurements went clean while the
 * editor, which calls the other one, still drew the loop.
 */
export function junctionInterior(
  variant: JunctionMovementVariant,
): { points: SemanticMapPoint[]; lengthM: number } {
  const cached = interiorCache.get(variant);
  if (cached) return cached;
  const stations = cumulativeStations(variant.polyline);
  const total = stations[stations.length - 1] ?? 0;
  const from = Math.min(Math.max(variant.entryStationM, 0), total);
  const to = Math.min(Math.max(variant.exitStationM, from), total);
  const points: SemanticMapPoint[] = [pointAtStation(variant.polyline, stations, from)];
  for (let index = 0; index < variant.polyline.length; index += 1) {
    const station = stations[index]!;
    if (station > from && station < to) points.push(variant.polyline[index]!);
  }
  points.push(pointAtStation(variant.polyline, stations, to));
  // A variant whose stations leave no interior still has to hand back drawable
  // geometry; the whole polyline is wrong but two coincident points are worse.
  const interior =
    to - from > 1e-6
      ? { points, lengthM: to - from }
      : { points: [...variant.polyline], lengthM: total };
  interiorCache.set(variant, interior);
  return interior;
}

const interiorCache = new WeakMap<
  JunctionMovementVariant,
  { points: SemanticMapPoint[]; lengthM: number }
>();

function cumulativeStations(points: readonly SemanticMapPoint[]): number[] {
  const stations = new Array<number>(points.length);
  let total = 0;
  stations[0] = 0;
  for (let index = 1; index < points.length; index += 1) {
    const previous = points[index - 1]!;
    const current = points[index]!;
    total += Math.hypot(current.x - previous.x, current.y - previous.y);
    stations[index] = total;
  }
  return stations;
}

function pointAtStation(
  points: readonly SemanticMapPoint[],
  stations: readonly number[],
  target: number,
): SemanticMapPoint {
  const last = stations[stations.length - 1] ?? 0;
  if (target <= 0 || points.length === 1) return points[0]!;
  if (target >= last) return points[points.length - 1]!;
  let index = 1;
  while (index < stations.length && stations[index]! < target) index += 1;
  const before = points[index - 1]!;
  const after = points[index]!;
  const span = stations[index]! - stations[index - 1]!;
  const fraction = span > 0 ? (target - stations[index - 1]!) / span : 0;
  return {
    x: before.x + (after.x - before.x) * fraction,
    y: before.y + (after.y - before.y) * fraction,
    // Unknown elevation stays unknown rather than being invented from the one
    // neighbour that happens to have it.
    z:
      before.z === null || after.z === null
        ? null
        : before.z + (after.z - before.z) * fraction,
  };
}
