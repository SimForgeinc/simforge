/**
 * Reverse gear.
 *
 * ## Why gear is a `set` key and not a negative speed
 *
 * The authoring surface is seven verbs over five axes, one axis one owner.
 * Direction of travel is a *discrete state*, so it belongs on the `set` axis
 * (`state:motion.gear`) next to `rules.collisionAvoidance` and
 * `lights.reverse`. That placement buys three things for free:
 *
 * - it never fights `speed` for the longitudinal axis — `speed` still owns the
 *   magnitude, gear owns the sign, and neither preempts the other;
 * - it inherits triggers, conditions and `until`, so reversing is conditional,
 *   triggerable and bounded in duration like every other manoeuvre. A
 *   three-point turn is `speed(stop)` → `set(gear=reverse)` → `speed(…)` →
 *   `speed(stop)` → `set(gear=forward)` → `speed(…)`;
 * - it needs no eighth verb.
 *
 * A negative `speed` target was the obvious alternative and is wrong.
 * `speedMps` is a **magnitude** everywhere downstream — TTC, min-clearance,
 * required-decel, the ASAM exporters — and signing it would silently corrupt
 * all of them rather than failing loudly.
 *
 * ## The route invariant
 *
 * **The route is the path the body travels.** A reversing body traverses that
 * same path rear-first: `routeS` still advances, and the body heading is
 * `routeTangent + PI`. The heading is *never* flipped away from that, because
 * every oriented bounding box, clearance measurement and render reads
 * `headingRad` directly. Displacement along the body's own heading is therefore
 * negative while reversing, which is exactly how a reverse manoeuvre is
 * measured.
 */

/** The `set` key that selects the gear. */
export const MOTION_GEAR_KEY = 'motion.gear';

/**
 * The read-only companion key reporting the gear the gearbox actually engaged.
 *
 * A shift is a request, not an assignment (see `GEAR_ENGAGE_SPEED_MPS`), so the
 * two are separate: `motion.gear` is what the author asked for and
 * `motion.gearEngaged` is what happened. A request that never engages shows up
 * as a disagreement between them rather than as a silent no-op.
 */
export const MOTION_GEAR_ENGAGED_KEY = 'motion.gearEngaged';

/** Legal `motion.gear` values. */
export const MOTION_GEAR_VALUES = ['forward', 'reverse'] as const;
export type MotionGear = (typeof MOTION_GEAR_VALUES)[number];

/**
 * Hard ceiling on reverse speed, m/s (≈ 25 km/h).
 *
 * Not a comfort preference: a production passenger gearbox has one reverse
 * ratio and it runs out of engine speed around here. Authoring 60 km/h in
 * reverse is not a scenario, it is a mistake, and the engine governs it instead
 * of obeying it.
 */
export const REVERSE_MAX_SPEED_MPS = 6.94;

/**
 * Speed at or below which a gear change engages, m/s.
 *
 * A shift into reverse at road speed is not slow, it is impossible. Engaging it
 * anyway would teleport momentum, because the dynamic solver clamps
 * `direction * v < 0` straight to zero. The request is held until the body is
 * at rest instead, and the deferral is published as a trace event so it is
 * diagnosable rather than silent.
 */
export const GEAR_ENGAGE_SPEED_MPS = 0.3;

/**
 * How far a spawn heading may differ from `routeTangent + PI` before the engine
 * reports having corrected it, radians (≈ 5°).
 *
 * Heading is a *derived* quantity for a reversing body, so the engine always
 * takes the derived value; the tolerance only decides whether the disagreement
 * was large enough to be worth telling the author about.
 */
export const REVERSE_SPAWN_HEADING_TOL_RAD = 0.087;

/** Parse a `motion.gear` `set` value. Returns `null` for anything else. */
export function motionDirectionOfGear(value: boolean | number | string): 1 | -1 | null {
  if (value === 'forward') return 1;
  if (value === 'reverse') return -1;
  return null;
}

/** The gear name for a direction, for trace/state readback. */
export function gearOfMotionDirection(direction: 1 | -1): MotionGear {
  return direction === -1 ? 'reverse' : 'forward';
}

/**
 * Spawn-time gear.
 *
 * `motion:reverse` predates the `set` key and remains the way a role declares
 * that it *starts* in reverse (a car already backing out when the clip opens).
 * It is an initial condition only; the timeline is authoritative thereafter.
 */
export function initialMotionDirection(tags: readonly string[]): 1 | -1 {
  return tags.includes('motion:reverse') ? -1 : 1;
}

/**
 * Govern a commanded speed magnitude against the selected gear.
 *
 * Forward is unchanged; reverse is capped. Applied to every longitudinal target
 * the controllers produce, so an authored target, a cruise speed and a
 * following-model output are all governed the same way.
 */
export function governSpeedForGear(targetMps: number, motionDirection: 1 | -1): number {
  if (motionDirection !== -1) return targetMps;
  return Math.min(targetMps, REVERSE_MAX_SPEED_MPS);
}
