/**
 * Which way an actor goes through a junction, and who is allowed to guess.
 *
 * ## The rule
 *
 * Every place that has to continue an actor past a branch — the browser
 * preview's corridor resolver, the route compiler, anything that walks lane
 * successors — answers the same question, and it has exactly one answer:
 *
 * 1. **An explicit route anchor.** The author drew where the car goes; nothing
 *    else gets a say. This is not resolved here — it is resolved by routing
 *    through the anchors — but it is first, and `junctionDirectionPolicy`
 *    reports it so a caller cannot skip it by accident.
 * 2. **A `turn_at_next_intersection` clip.** The author said "turn left at the
 *    next one" and did not say where; that direction governs the first branch
 *    and only the first.
 * 3. **Straight.** Which way a particular car should go is authoring intent and
 *    no part of the map can supply it, so for a car somebody placed the only
 *    honest default is to keep going. "Keep going" IS in the data: it is the
 *    branch whose heading changes least.
 *
 * The one exception is PROCEDURALLY GENERATED ambient traffic — the vehicles
 * `expandRandomTrafficActors` synthesizes inside a random-traffic region. Those
 * have no author to have an intention, and a lane full of them that all pick the
 * same exit collapses into single file, so they draw from `JUNCTION_TURN_WEIGHTS`.
 *
 * `role: "traffic"` is NOT that exception and was briefly used as if it were.
 * It is the DEFAULT role on the draft schema, so every hand-placed car that was
 * not promoted to ego carried it: cars the author had positioned by hand went on
 * taking weighted-random turns, which is the report the scoping was meant to fix
 * ("it turns right even though I just want it to go straight").
 *
 * ## Classifying a branch
 *
 * From geometry, because the runtime bundle's topology edges carry no turn
 * relation. `junctionTurnForBranch` measures the approach's heading against
 * where the candidate has GOT TO, and on real OpenDRIVE geometry that reproduces
 * the `TopologyGate.turnRelation` the map's own index stamps.
 *
 * The obvious cheaper measure — the approach's heading against the candidate's
 * FIRST TWO VERTICES — does not work at all. Lane centerlines are sampled at
 * about a metre, and a junction connector leaves the stop line pointing the same
 * way the approach did: measured on the Belmont Research Center map, five
 * connectors the map records as 56°–119° turns all read between -0.4° and 0.0°.
 * Every branch classified as straight, so the weights were uniform and
 * "straightest" was a coin toss decided by float dust.
 */

/** A branch, by what a driver taking it would call it. */
export type JunctionTurn = "straight" | "left" | "right" | "uturn";

/**
 * What a `turn_at_next_intersection` clip can ask for.
 *
 * `u_turn` spells the same branch `JunctionTurn` calls `uturn`. The two names
 * differ because one is the authored vocabulary (aligned with
 * `RunwayTurnIntent`, which is what a direction is passed to) and the other is
 * the map's own classification; `JUNCTION_TURN_FOR_AUTHORED_DIRECTION` is the
 * only place allowed to bridge them.
 */
export type AuthoredJunctionDirection = "left" | "right" | "straight" | "u_turn";

/** The map-side branch name for each authored direction. */
export const JUNCTION_TURN_FOR_AUTHORED_DIRECTION: Record<
  AuthoredJunctionDirection,
  JunctionTurn
> = { left: "left", right: "right", straight: "straight", u_turn: "uturn" };

/** Whether a raw string is a direction a turn clip may carry. */
export function isAuthoredJunctionDirection(
  value: string,
): value is AuthoredJunctionDirection {
  return value === "left" || value === "right" || value === "straight" || value === "u_turn";
}

/**
 * Canonical legacy primitive used only at compatibility/validation boundaries.
 *
 * `u_turn` is deliberately absent, and this is deliberately NOT keyed by the full
 * `AuthoredJunctionDirection` union: the legacy `timeline` channel never had a
 * u-turn primitive and Phase G deletes the channel outright, so a u-turn is
 * expressible only as a clip. Leaving the key out means a caller that tries to
 * route a u-turn through the legacy channel fails to compile, which is the signal
 * we want — widening the type to `string | undefined` would instead push an
 * `undefined` primitive id into a draft.
 */
export const TIMED_INSTRUCTION_PRIMITIVE_FOR_JUNCTION_DIRECTION = {
  left: "turn_left_at_next_intersection",
  right: "turn_right_at_next_intersection",
  straight: "go_straight_at_next_intersection",
} as const;

export type JunctionDirectionPolicy =
  /** The author routed this actor; follow the anchors, do not choose. */
  | { kind: "route_anchors" }
  /** The author asked for a turn at the next junction. */
  | { kind: "authored_turn"; direction: AuthoredJunctionDirection }
  /** Nobody said; keep going. */
  | { kind: "straight" }
  /** Generated ambient traffic: draw, so a lane of it disperses. */
  | { kind: "ambient_draw" };

/**
 * How generated ambient traffic splits at a branch, by movement.
 *
 * Roughly the split a low-volume urban intersection sees: most traffic runs
 * through, right beats left, and a U-turn is a rounding error rather than an
 * impossibility. Exact ratios are a per-junction property nothing in the bundle
 * carries, so this is a house default, not a measurement.
 */
export const JUNCTION_TURN_WEIGHTS: Record<JunctionTurn, number> = {
  straight: 0.6,
  right: 0.25,
  left: 0.14,
  uturn: 0.01,
};

/**
 * Below this heading change a branch counts as going straight through; above
 * `JUNCTION_UTURN_MIN_DEG` it has doubled back rather than turned.
 *
 * Both are the thresholds `map-topology/build-topology-index.ts::classifyTurn`
 * uses (0.349 rad and 2.356 rad), deliberately, so that a branch this module
 * calls a left turn is the same branch the map's own gate table calls one.
 */
export const JUNCTION_STRAIGHT_MAX_DEG = 20;
export const JUNCTION_UTURN_MIN_DEG = 135;

export interface JunctionVec2 {
  x: number;
  y: number;
}

/** Signed heading change in (-180, 180]. */
export function junctionHeadingDeltaDeg(fromDeg: number, toDeg: number): number {
  let delta = (toDeg - fromDeg) % 360;
  if (delta > 180) delta -= 360;
  if (delta <= -180) delta += 360;
  return delta;
}

/**
 * Which movement a heading change is.
 *
 * Sign convention: the runtime frame is `(x, -y_carla)`, which puts CARLA's LEFT
 * along runtime `+y`, and `atan2(dy, dx)` grows counter-clockwise. A POSITIVE
 * delta is therefore a left turn.
 */
export function classifyJunctionTurn(headingChangeDeg: number): JunctionTurn {
  const delta = junctionHeadingDeltaDeg(0, headingChangeDeg);
  const magnitude = Math.abs(delta);
  if (magnitude <= JUNCTION_STRAIGHT_MAX_DEG) return "straight";
  if (magnitude >= JUNCTION_UTURN_MIN_DEG) return "uturn";
  return delta > 0 ? "left" : "right";
}

function headingDeg(from: JunctionVec2, to: JunctionVec2): number | null {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  if (Math.hypot(dx, dy) < 1e-6) return null;
  return (Math.atan2(dy, dx) * 180) / Math.PI;
}

/**
 * How far a lane runs before its heading is taken as "where this branch goes".
 *
 * Junction connectors on real maps are 14-46 m (measured on Belmont), and one of
 * them has a 20 m straight run before the curve starts — so anything much
 * shorter than this reads that branch as going straight when the map calls it a
 * 90 degree left. Generous rather than tight: the cap exists only so that a
 * kilometre of gently curving highway beyond the junction cannot dominate the
 * reading, not to pick out a point on the connector.
 */
const BRANCH_HEADING_MAX_M = 80;

/** Heading of the segment `capM` along `points`, or of its last segment. */
function headingAlong(points: readonly JunctionVec2[], capM: number): number | null {
  let travelled = 0;
  for (let index = 1; index < points.length; index += 1) {
    travelled += Math.hypot(
      points[index]!.x - points[index - 1]!.x,
      points[index]!.y - points[index - 1]!.y,
    );
    if (travelled >= capM) return headingDeg(points[index - 1]!, points[index]!);
  }
  return points.length >= 2
    ? headingDeg(points[points.length - 2]!, points[points.length - 1]!)
    : null;
}

/**
 * The heading change a driver experiences taking `candidate` out of `travelled`.
 *
 * Measured from the approach's LAST segment to where the candidate has GOT TO,
 * not to where it starts. A connector leaves the stop line pointing the way the
 * approach did — on Belmont, five branches the map records as 56-119 degree
 * turns all read between -0.4 and 0.0 degrees on their first two vertices — so
 * the entry heading carries no information about the movement at all. Read to
 * the end, this reproduces `TopologyGate.headingChangeRad` on all five to within
 * 0.4 degrees.
 *
 * Both polylines are in TRAVEL order (the corridor graph reverses lanes driven
 * against `+s` when it builds its edges), so no lane-id sign flip is applied
 * here — the flip in `map-topology/build-topology-index.ts::laneTravelHeadingChange`
 * exists precisely because its input is stored in `+s` order and this one is not.
 */
export function junctionBranchHeadingChangeDeg(
  travelled: readonly JunctionVec2[],
  candidate: readonly JunctionVec2[],
): number | null {
  const approach =
    travelled.length >= 2
      ? headingDeg(travelled[travelled.length - 2]!, travelled[travelled.length - 1]!)
      : null;
  const leaving = headingAlong(candidate, BRANCH_HEADING_MAX_M);
  if (approach === null || leaving === null) return null;
  return junctionHeadingDeltaDeg(approach, leaving);
}

/** `junctionBranchHeadingChangeDeg`, classified. */
export function junctionTurnForBranch(
  travelled: readonly JunctionVec2[],
  candidate: readonly JunctionVec2[],
): JunctionTurn | null {
  const deltaDeg = junctionBranchHeadingChangeDeg(travelled, candidate);
  return deltaDeg === null ? null : classifyJunctionTurn(deltaDeg);
}

// ---------------------------------------------------------------------------
// The precedence
// ---------------------------------------------------------------------------

/** The draft fields the precedence reads. Structural, so a partial draft works. */
export interface JunctionDirectionActorRead {
  role?: string | null;
  /** Set only by `expandRandomTrafficActors`. See `junctionDirectionPolicy`. */
  ambient_generated?: boolean | null;
  route?: readonly unknown[] | null;
  behavior?: unknown;
  timeline?: readonly unknown[] | null;
  /**
   * A policy already resolved by an earlier caller, if any.
   *
   * The editor posts a REDUCED actor to the corridor endpoint — sending whole
   * behavior programs and sensor rigs over the wire on every edit is the cost
   * the reduction exists to avoid — so the fields this rule reads are not all
   * there by the time the server runs. Rather than widen the payload back out,
   * the client resolves the policy with this same function and sends the
   * two-word answer. Absent, it is computed from the draft as normal, so a
   * server-side caller holding a full draft needs to do nothing.
   */
  junction_direction?: unknown;
}

/** A previously resolved policy, if `value` is one. */
function parseResolvedPolicy(value: unknown): JunctionDirectionPolicy | null {
  const record = asRecord(value);
  const kind = String(record.kind ?? "");
  if (kind === "route_anchors" || kind === "straight" || kind === "ambient_draw") {
    return { kind } as JunctionDirectionPolicy;
  }
  if (kind === "authored_turn") {
    const direction = String(record.direction ?? "");
    if (isAuthoredJunctionDirection(direction)) {
      return { kind, direction };
    }
  }
  return null;
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

const LEGACY_TURN_ACTIONS: Record<string, AuthoredJunctionDirection> = {
  turn_left_at_next_intersection: "left",
  turn_right_at_next_intersection: "right",
  go_straight_at_next_intersection: "straight",
};

/**
 * The direction an authored `turn_at_next_intersection` asks for, or null.
 *
 * Reads the behavior program first and the legacy timeline second, which is the
 * same precedence `migrateActorDraftToBehaviorProgram` establishes: a draft that
 * has both is one mid-migration, and the program is the live half.
 */
export function authoredJunctionTurn(
  actor: JunctionDirectionActorRead,
): AuthoredJunctionDirection | null {
  for (const raw of asArray(asRecord(actor.behavior).clips)) {
    const clip = asRecord(raw);
    if (clip.enabled === false) continue;
    const action = asRecord(clip.action);
    if (String(action.kind ?? "").trim() !== "turn_at_next_intersection") continue;
    const direction = String(action.direction ?? "").trim();
    if (isAuthoredJunctionDirection(direction)) {
      return direction;
    }
  }
  for (const raw of asArray(actor.timeline)) {
    const clip = asRecord(raw);
    if (clip.enabled === false) continue;
    const direction = LEGACY_TURN_ACTIONS[String(clip.action ?? "").trim()];
    if (direction !== undefined) return direction;
  }
  return null;
}

/**
 * True only for a vehicle SYNTHESIZED inside a random-traffic region.
 *
 * The flag is stamped by `expandRandomTrafficActors` and by nothing else. It is
 * an explicit field rather than an inference from `role` or from the generated
 * id shape because both of those are true of things an author placed, and the
 * whole point of the distinction is that this one had no author.
 */
export function isGeneratedAmbientTraffic(actor: JunctionDirectionActorRead): boolean {
  return actor.ambient_generated === true;
}

/** The rule at the top of this file, as one function. */
export function junctionDirectionPolicy(
  actor: JunctionDirectionActorRead,
): JunctionDirectionPolicy {
  const resolved = parseResolvedPolicy(actor.junction_direction);
  if (resolved !== null) return resolved;
  if ((actor.route?.length ?? 0) > 0) return { kind: "route_anchors" };
  const direction = authoredJunctionTurn(actor);
  if (direction !== null) return { kind: "authored_turn", direction };
  if (isGeneratedAmbientTraffic(actor)) return { kind: "ambient_draw" };
  return { kind: "straight" };
}
