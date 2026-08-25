/**
 * A divert tail: the one place a car gets drawn geometry, authored RELATIVE.
 *
 * ## Why relative, and why it is the whole point
 *
 * `plans/2026-07-29-one-motion-model.md` §2.3. A scenario transfers across maps
 * when everything in it re-binds: lane placements re-bind semantically, and
 * interaction clips ("turn left at the next junction", "stop when you reach the
 * crosswalk") re-bind because they name situations rather than coordinates. An
 * absolute polyline re-binds to nothing — `{x: 626.8, y: 1812.1}` is one build of
 * one map, and on any other map it is a point in a field.
 *
 * A tail authored as *metres forward and lateral from the car's own pose at the
 * moment the clip fires* transfers unchanged, because a swerve is a swerve
 * wherever the car happens to be. That is the entire reason drawn geometry is
 * allowed to survive at all: not as a route, as a departure from one.
 *
 * ## Why there is a cap
 *
 * "A tail of a few tens of metres, which is the design saying paths are for
 * departures, not for routes." The cap is not a performance bound or a safety
 * margin — it is the design statement, made enforceable. Without it, `divert_path`
 * is just the freeform vehicle path again with a different name, and the corpus
 * would drift back to hand-drawn routes one long tail at a time.
 *
 * `DIVERT_TAIL_MAX_M` is measured along the tail, from the trigger pose through
 * every vertex, because that is the distance the car actually drives off-graph. A
 * bound on the straight-line displacement instead would let an author draw a
 * 200 m switchback that ends 30 m away.
 *
 * ## Why resolution lives here
 *
 * The preview engine and the CARLA worker both resolve the tail at trigger time,
 * from the same pose. If they each did their own trigonometry they would agree
 * until they didn't, and the disagreement would show up as a car swerving the
 * wrong way in a render nobody re-previewed. `resolveDivertTail` is the one rule;
 * `_resolve_divert_tail` in `behavior_program.py` is its port, held to it by a
 * parity test over shared fixtures.
 */

/** How far a car may drive off-graph on one tail, measured along the path. */
export const DIVERT_TAIL_MAX_M = 60;

/**
 * One tail vertex, in the actor's frame at trigger time.
 *
 * `forward_m` runs along the car's heading, `lateral_m` to its LEFT — the same
 * handedness as `lane_offset`, so "positive is left" means one thing across the
 * vocabulary rather than two.
 */
export type DivertTailPoint = {
  forward_m: number;
  lateral_m: number;
  /** Controls the segment from the previous vertex to this one. */
  speed_kph?: number | null;
  /** Controls the segment from the previous vertex to this one. */
  direction?: "forward" | "reverse";
};

export type DivertTriggerPose = {
  x: number;
  y: number;
  z?: number | null;
  /** Degrees, `atan2(dy, dx)` convention — counter-clockwise positive. */
  yawDeg: number;
};

export type ResolvedDivertPoint = {
  x: number;
  y: number;
  z: number;
  speed_kph?: number | null;
  direction?: "forward" | "reverse";
};

/**
 * Length of a tail, along the path, starting from the trigger pose.
 *
 * The first leg is measured from the pose itself (i.e. from `{0, 0}`), because a
 * tail whose first vertex is 500 m ahead has driven 500 m off-graph even though
 * its vertices are close together.
 */
export function divertTailLengthM(tail: readonly DivertTailPoint[]): number {
  let total = 0;
  let previousForward = 0;
  let previousLateral = 0;
  for (const point of tail) {
    total += Math.hypot(point.forward_m - previousForward, point.lateral_m - previousLateral);
    previousForward = point.forward_m;
    previousLateral = point.lateral_m;
  }
  return total;
}

/**
 * Put a relative tail into world coordinates, given the pose at trigger time.
 *
 * `z` is carried from the pose rather than interpolated: the tail is authored on a
 * 2D drag over the map, so it has no opinion about elevation, and inventing one
 * would put a car under a bridge deck it was drawn beside.
 */
export function resolveDivertTail(
  tail: readonly DivertTailPoint[],
  pose: DivertTriggerPose,
): ResolvedDivertPoint[] {
  const yawRad = (pose.yawDeg * Math.PI) / 180;
  const cos = Math.cos(yawRad);
  const sin = Math.sin(yawRad);
  const z = pose.z ?? 0;
  return tail.map((point) => ({
    // Forward along the heading; lateral 90° to the LEFT of it, which in this
    // counter-clockwise-positive frame is (-sin, +cos).
    x: pose.x + point.forward_m * cos - point.lateral_m * sin,
    y: pose.y + point.forward_m * sin + point.lateral_m * cos,
    z,
    ...(point.speed_kph === undefined ? {} : { speed_kph: point.speed_kph }),
    ...(point.direction === undefined ? {} : { direction: point.direction }),
  }));
}

/**
 * Express an absolute polyline as a tail relative to a pose — the migration
 * direction.
 *
 * Exact inverse of `resolveDivertTail`, so a corpus actor's drawn path can be
 * converted without an author re-drawing it, and the conversion can be checked by
 * round-tripping rather than by eye.
 */
export function divertTailFromAbsolute(
  points: ReadonlyArray<{ x: number; y: number; speed_kph?: number | null; direction?: "forward" | "reverse" }>,
  pose: DivertTriggerPose,
): DivertTailPoint[] {
  const yawRad = (pose.yawDeg * Math.PI) / 180;
  const cos = Math.cos(yawRad);
  const sin = Math.sin(yawRad);
  return points.map((point) => {
    const dx = point.x - pose.x;
    const dy = point.y - pose.y;
    return {
      forward_m: dx * cos + dy * sin,
      lateral_m: -dx * sin + dy * cos,
      ...(point.speed_kph === undefined ? {} : { speed_kph: point.speed_kph }),
      ...(point.direction === undefined ? {} : { direction: point.direction }),
    };
  });
}
