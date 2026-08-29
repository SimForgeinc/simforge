import { z } from "zod";
import {
  laneTravelIncreasesS,
  travelOrderedPolyline,
} from "@simforge-oss/maps/topology";
import {
  BehaviorClipEndSchema,
  BehaviorSignalStateSchema,
  BehaviorTriggerSchema,
  DEFAULT_BEHAVIOR_CLIP_END,
  DEFAULT_BEHAVIOR_TRIGGER,
  type BehaviorSignalRef,
  type BehaviorSignalState,
  type BehaviorTrigger,
} from "./scenario-behavior";

/**
 * TRAFFIC-SIGNAL AUTHORING, per intersection at MOVEMENT level (plan
 * 2026-07-24, section 4.3).
 *
 * The industry mental model (NEMA phases) reduced to what our map data
 * supports: a junction's signal heads are grouped into MOVEMENTS
 * (approach + turn), and state is authored on movements, never on individual
 * bulbs. A `JunctionSignalPlan` says what a junction does for the whole
 * scenario in one of four modes, and `draft.signal_plans` carries one plan per
 * authored junction.
 *
 * ## Movement identity — derived, not invented
 *
 * A movement is DERIVED from junction lane topology, so the same junction
 * yields the same movement ids for every author and every generator:
 *
 *     movement_id = "<approach_id>:<turn>"      e.g. "12.0.r:left"
 *     approach_id = "<road_id>.<section>.<side>"   side = l|r (lane-id sign)
 *
 * The approach is one road's lane group feeding the junction (all lanes of one
 * road section on one side of the reference line); the turn comes from the
 * junction gate's `turnRelation`. `deriveJunctionMovements` builds the table
 * from any gate list; `junctionGatesFromTopology` adapts a `MapTopologyIndex`.
 *
 * **Road ids renumber across UE5 map rebuilds** (the `world_anchor` doctrine).
 * The id is therefore a CACHE KEY, not the durable identity: every binding also
 * carries `approach_heading_deg` / `exit_heading_deg` and the resolved lane
 * rsls + signal ids, so a rebuilt map can be re-derived and re-matched by
 * geometry. Never treat a movement id as portable across map revisions.
 *
 * ## Resolution to concrete lights (what the worker does)
 *
 * `signal_ids` are OpenDRIVE `<signal>` ids — the key CARLA's
 * `world.get_traffic_light_from_opendrive_id()` takes, and the same key
 * `controlBindings` uses (`runtimeIds: ["opendrive:<id>"]`). When they are
 * present the worker resolves lights directly. When they are not (an
 * un-enriched map), the worker falls back to matching each light's
 * `get_affected_lane_waypoints()` against `approach_lane_rsls`. Both paths are
 * implemented in `services/carla-worker/carla_worker/signal_plans.py`.
 *
 * ## Building the movement table — the FOUR-step chain
 *
 * This module derives movements from lane topology, which knows nothing about
 * signals; the signal→approach join lives in `xodr-signal-controllers`. Callers
 * must run all four steps or per-turn authoring is silently lost:
 *
 * ```
 * junctionGatesFromTopology(index, junctionId)   // gates + headings
 *   -> attachSignalIdsToGates(gates, group)      // signal ids, approach-level
 *   -> deriveJunctionMovementTable(gates)        // movements + conflicts
 *   -> refineMovementSignalIds(bindings, group)  // per-turn heads, where they exist
 * ```
 *
 * The last step is not optional polish. OpenDRIVE puts a controlled signal on
 * the CONNECTING road, so an approach whose turns run on different connecting
 * roads genuinely has per-turn heads — verified on 16 approaches across 3 maps
 * in the reference corpus, including textbook protected lefts. Skip the
 * refinement and every turn off an approach inherits that approach's whole head
 * set, which makes "left red, through green" a `shared_signal_heads` warning
 * instead of a working plan.
 *
 * The refinement only ever narrows, and only on an exact `movement_id` match,
 * so a turn classified differently by the two derivations keeps the safe
 * approach-level union rather than binding to the wrong head.
 *
 * ## Conflicting greens are a WARNING, never a rejection
 *
 * Edge-case scenarios may deliberately want two crossing movements green at
 * once (that IS the scenario). Conflicts are computed geometrically
 * (`deriveMovementConflicts`) and surfaced through `detectSignalPlanWarnings`
 * into the plan's cached `warnings` field. The schema never rejects them.
 *
 * Conventions match `scenario-behavior.ts`: snake_case wire fields, units in
 * the field name, closed vocabularies `.strict()`.
 */

export const SIGNAL_PLAN_SCHEMA_VERSION = "simforge.junction-signal-plan.v1";

// ---------------------------------------------------------------------------
// Movement identity
// ---------------------------------------------------------------------------

/**
 * The four turn classes signals are authored on. OpenDRIVE has no turn label, so
 * these come from the junction gate's derived `turnRelation`; both U-turn
 * relations collapse to one authored movement (no map in the fleet signals
 * U-turns separately, and splitting them would double the panel's arrows).
 */
export const SIGNAL_TURNS = ["left", "right", "straight", "uturn"] as const;
export const SignalTurnSchema = z.enum(SIGNAL_TURNS);
export type SignalTurn = z.infer<typeof SignalTurnSchema>;

/** `TurnRelation` (map-topology) → authored turn class. */
export function signalTurnFromRelation(relation: string): SignalTurn | null {
  switch (relation.trim().toLowerCase()) {
    case "left":
      return "left";
    case "right":
      return "right";
    case "straight":
      return "straight";
    case "uturnleft":
    case "uturnright":
    case "uturn":
      return "uturn";
    default:
      return null;
  }
}

/** `"<road>:<section>:<lane>"` (the runtime lane key) → `"<road>.<section>.<side>"`. */
export function approachIdFromLaneRsl(rsl: string): string | null {
  const parts = rsl.trim().split(":");
  if (parts.length !== 3) return null;
  const [roadId, section, lane] = parts as [string, string, string];
  const laneId = Number(lane);
  if (!roadId || !section || !Number.isFinite(laneId) || laneId === 0) return null;
  return `${roadId}.${section}.${laneId < 0 ? "r" : "l"}`;
}

export function formatMovementId(approachId: string, turn: SignalTurn): string {
  return `${approachId}:${turn}`;
}

export function parseMovementId(
  movementId: string,
): { approach_id: string; turn: SignalTurn } | null {
  const index = movementId.lastIndexOf(":");
  if (index <= 0) return null;
  const approachId = movementId.slice(0, index).trim();
  const turn = SignalTurnSchema.safeParse(movementId.slice(index + 1).trim());
  if (!approachId || !turn.success) return null;
  return { approach_id: approachId, turn: turn.data };
}

/**
 * A movement id as written on a plan. Shape-checked only: a plan for an
 * un-enriched map may legitimately carry ids that no longer parse against the
 * current road numbering, and rejecting those would lock the author out of
 * their own draft.
 */
export const MovementIdSchema = z.string().trim().min(1);

// ---------------------------------------------------------------------------
// Movement bindings (the derived table, cached on the plan)
// ---------------------------------------------------------------------------

/**
 * One movement of one junction, with everything the worker needs to find its
 * lights and everything the panel needs to draw its arrow.
 *
 * The table is cached ON THE PLAN rather than re-derived at runtime because the
 * worker has no map-topology artifact: it has CARLA. Caching the derivation is
 * what lets movement authoring work without shipping the topology index to the
 * fleet.
 */
export const JunctionMovementBindingSchema = z.object({
  movement_id: MovementIdSchema,
  approach_id: z.string().trim().min(1),
  turn: SignalTurnSchema,
  /** Display label, e.g. `"NB left"`. Cosmetic — never used for resolution. */
  label: z.string().trim().min(1),
  /** Approach lanes feeding this movement (`"<road>:<section>:<lane>"`). */
  approach_lane_rsls: z.array(z.string().trim().min(1)).default([]),
  /** Lanes the movement leads to. Drawn by the panel; unused at runtime. */
  exit_lane_rsls: z.array(z.string().trim().min(1)).default([]),
  /** OpenDRIVE `<signal>` ids controlling this movement (primary resolution). */
  signal_ids: z.array(z.string().trim().min(1)).default([]),
  /** Direction of travel ENTERING the junction, degrees CCW from +x (CARLA basis). */
  approach_heading_deg: z.number().nullable().default(null),
  /** Direction of travel LEAVING the junction, same convention. */
  exit_heading_deg: z.number().nullable().default(null),
  /** Movement ids whose paths cross this one — the conflicting-green source. */
  conflicts_with: z.array(MovementIdSchema).default([]),
});
export type JunctionMovementBinding = z.infer<typeof JunctionMovementBindingSchema>;

// ---------------------------------------------------------------------------
// Derivation from junction lane topology
// ---------------------------------------------------------------------------

/** One junction `<connection>` lane-link, in whatever shape the caller has. */
export interface JunctionGateInput {
  approach_lane_rsl: string;
  /** `TurnRelation` (`"Left"`, `"UTurnRight"`, …) or an authored `SignalTurn`. */
  turn_relation: string;
  exit_lane_rsls?: readonly string[];
  /** Radians, direction of travel entering the junction (CARLA basis). */
  approach_heading_rad?: number | null;
  /** Radians, direction of travel leaving the junction. */
  exit_heading_rad?: number | null;
  /** OpenDRIVE signal ids known to control this gate's approach. */
  signal_ids?: readonly string[];
}

/** Structural view of `MapTopologyIndex` — kept structural so this module carries no dependency on it. */
interface TopologyLaneLike {
  rsl?: string;
  laneId?: number | null;
  polyline?: ReadonlyArray<{ x: number; y: number }>;
}
interface TopologyGateLike {
  junctionId?: string;
  turnRelation?: string;
  approachLaneRsl?: string;
  exitLaneRsls?: readonly string[];
}
export interface TopologyIndexLike {
  lanes?: Record<string, TopologyLaneLike>;
  gates?: readonly TopologyGateLike[];
  /**
   * `RuntimeBoundMapTopologyIndex.laneTravelIncreasesS` — CARLA's resolved
   * direction of travel per lane rsl, present on a BOUND index and absent on a
   * bare XODR parse. Structural, like the rest of this view, so a caller
   * holding a bound index simply passes it and the headings come out in travel
   * order; a caller holding only a parse falls back to the lane-sign
   * convention. See `map-topology/lane-travel.ts`.
   */
  laneTravelIncreasesS?: Record<string, boolean>;
}

/** The lane id encoded in a `"<road>:<section>:<lane>"` key. */
function laneIdFromRsl(rsl: string): number | null {
  const parts = rsl.trim().split(":");
  if (parts.length !== 3) return null;
  const laneId = Number(parts[2]);
  return Number.isFinite(laneId) ? laneId : null;
}

function headingOfSegment(
  from: { x: number; y: number } | undefined,
  to: { x: number; y: number } | undefined,
): number | null {
  if (!from || !to) return null;
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  if (!Number.isFinite(dx) || !Number.isFinite(dy) || (dx === 0 && dy === 0)) return null;
  return Math.atan2(dy, dx);
}

/**
 * A lane's polyline in the order it is DRIVEN.
 *
 * `TopologyLane.polyline` is stored in `+s` order, and on a real map roughly
 * half the lanes are driven AGAINST `+s` — so reading a bearing off the stored
 * order gives the reverse of the direction of travel for those lanes. The
 * answer comes from `index.laneTravelIncreasesS` when the caller holds a bound
 * index, and from the lane-sign convention (the single greppable fallback in
 * `lane-travel.ts`) when it does not.
 */
function travelOrderedLane(
  index: TopologyIndexLike,
  rsl: string,
): ReadonlyArray<{ x: number; y: number }> {
  const lane = index.lanes?.[rsl];
  const points = lane?.polyline ?? [];
  if (points.length < 2) return points;
  const laneId = lane?.laneId ?? laneIdFromRsl(rsl);
  return travelOrderedPolyline(
    points,
    laneTravelIncreasesS(index.laneTravelIncreasesS, rsl, laneId),
  );
}

/** Heading where the lane ENTERS the junction: its last segment IN TRAVEL ORDER. */
function laneEntryHeading(index: TopologyIndexLike, rsl: string): number | null {
  const points = travelOrderedLane(index, rsl);
  if (points.length < 2) return null;
  return headingOfSegment(points[points.length - 2], points[points.length - 1]);
}

/** Heading where the lane LEAVES the junction: its first segment IN TRAVEL ORDER. */
function laneExitHeading(index: TopologyIndexLike, rsl: string): number | null {
  const points = travelOrderedLane(index, rsl);
  if (points.length < 2) return null;
  return headingOfSegment(points[0], points[1]);
}

/**
 * Pull one junction's gates out of a map-topology index, with the headings read
 * off the lane polylines IN THE ORDER THEY ARE DRIVEN — the last approach
 * segment and the first exit segment are then exactly the two bearings the
 * movement geometry needs.
 *
 * The travel order is the whole subtlety. Polylines are stored `+s`-ascending
 * and a lane driven against `+s` is stored backwards, so reading the stored
 * order yields a bearing 180 degrees out. That is not a cosmetic error: it puts
 * the movement's approach leg on the far side of the junction circle, which
 * inverts `deriveMovementConflicts`, mislabels the compass direction, and
 * breaks the geometric re-match that carries authored plans across a map
 * rebuild. Every approach lane on a two-way cross street is affected, in one
 * direction only — which is exactly how it hid.
 *
 * Pass a `RuntimeBoundMapTopologyIndex` where you have one; its
 * `laneTravelIncreasesS` is CARLA's own answer.
 */
export function junctionGatesFromTopology(
  index: TopologyIndexLike,
  junctionId: string,
): JunctionGateInput[] {
  const gates: JunctionGateInput[] = [];
  for (const gate of index.gates ?? []) {
    if (String(gate.junctionId ?? "") !== junctionId) continue;
    const approachLaneRsl = String(gate.approachLaneRsl ?? "").trim();
    if (!approachLaneRsl) continue;
    const exitLaneRsls = (gate.exitLaneRsls ?? []).map((rsl) => String(rsl).trim()).filter(Boolean);
    const exitHeadings = exitLaneRsls
      .map((rsl) => laneExitHeading(index, rsl))
      .filter((value): value is number => value != null);
    gates.push({
      approach_lane_rsl: approachLaneRsl,
      turn_relation: String(gate.turnRelation ?? ""),
      exit_lane_rsls: exitLaneRsls,
      approach_heading_rad: laneEntryHeading(index, approachLaneRsl),
      exit_heading_rad: exitHeadings.length > 0 ? circularMean(exitHeadings) : null,
    });
  }
  return gates;
}

/** Mean direction of a set of bearings (unit-vector mean — no wraparound bias). */
function circularMean(radians: readonly number[]): number | null {
  let x = 0;
  let y = 0;
  for (const value of radians) {
    if (!Number.isFinite(value)) continue;
    x += Math.cos(value);
    y += Math.sin(value);
  }
  if (x === 0 && y === 0) return null;
  return Math.atan2(y, x);
}

/**
 * Compass label for a direction of travel, in the CARLA basis the topology
 * polylines use: +x is East and +y is SOUTH (the runtime frame flips y; these
 * points do not). Labels name where traffic is GOING, the way traffic engineers
 * say "northbound left" — so a movement entering from the south leg is "NB".
 */
export function compassLabel(headingRad: number): "NB" | "EB" | "SB" | "WB" {
  const degrees = ((((Math.atan2(-Math.sin(headingRad), Math.cos(headingRad)) * 180) / Math.PI) % 360) + 360) % 360;
  if (degrees >= 45 && degrees < 135) return "NB";
  if (degrees >= 135 && degrees < 225) return "WB";
  if (degrees >= 225 && degrees < 315) return "SB";
  return "EB";
}

const TURN_LABELS: Record<SignalTurn, string> = {
  left: "left",
  right: "right",
  straight: "through",
  uturn: "U-turn",
};

/**
 * Group a junction's gates into movements: one movement per
 * (approach lane group, turn class). Deterministic — gates in any order yield
 * the same table, sorted by movement id.
 *
 * Conflicts are filled in by `deriveMovementConflicts`, which needs the whole
 * table, so this returns bindings with `conflicts_with: []` and the caller
 * applies conflicts (or `deriveJunctionMovementTable` does both).
 */
export function deriveJunctionMovements(
  gates: readonly JunctionGateInput[],
): JunctionMovementBinding[] {
  const grouped = new Map<
    string,
    {
      approachId: string;
      turn: SignalTurn;
      approachLaneRsls: Set<string>;
      exitLaneRsls: Set<string>;
      signalIds: Set<string>;
      approachHeadings: number[];
      exitHeadings: number[];
    }
  >();

  for (const gate of gates) {
    const approachLaneRsl = gate.approach_lane_rsl.trim();
    const approachId = approachIdFromLaneRsl(approachLaneRsl);
    const turn = signalTurnFromRelation(gate.turn_relation);
    if (!approachId || !turn) continue;
    const movementId = formatMovementId(approachId, turn);
    const entry = grouped.get(movementId) ?? {
      approachId,
      turn,
      approachLaneRsls: new Set<string>(),
      exitLaneRsls: new Set<string>(),
      signalIds: new Set<string>(),
      approachHeadings: [],
      exitHeadings: [],
    };
    entry.approachLaneRsls.add(approachLaneRsl);
    for (const rsl of gate.exit_lane_rsls ?? []) entry.exitLaneRsls.add(String(rsl).trim());
    for (const id of gate.signal_ids ?? []) entry.signalIds.add(String(id).trim());
    if (gate.approach_heading_rad != null && Number.isFinite(gate.approach_heading_rad)) {
      entry.approachHeadings.push(gate.approach_heading_rad);
    }
    if (gate.exit_heading_rad != null && Number.isFinite(gate.exit_heading_rad)) {
      entry.exitHeadings.push(gate.exit_heading_rad);
    }
    grouped.set(movementId, entry);
  }

  const bindings: JunctionMovementBinding[] = [];
  for (const [movementId, entry] of grouped) {
    const approachHeading = circularMean(entry.approachHeadings);
    const label = `${approachHeading == null ? entry.approachId : compassLabel(approachHeading)} ${TURN_LABELS[entry.turn]}`;
    const exitHeading = circularMean(entry.exitHeadings);
    bindings.push({
      movement_id: movementId,
      approach_id: entry.approachId,
      turn: entry.turn,
      label,
      approach_lane_rsls: [...entry.approachLaneRsls].filter(Boolean).sort(),
      exit_lane_rsls: [...entry.exitLaneRsls].filter(Boolean).sort(),
      signal_ids: [...entry.signalIds].filter(Boolean).sort(),
      approach_heading_deg: approachHeading == null ? null : toDegrees(approachHeading),
      exit_heading_deg: exitHeading == null ? null : toDegrees(exitHeading),
      conflicts_with: [],
    });
  }
  return bindings.sort((left, right) => left.movement_id.localeCompare(right.movement_id));
}

function toDegrees(radians: number): number {
  return Math.round(((radians * 180) / Math.PI) * 1e6) / 1e6;
}

/** CARLA-basis heading in degrees → math-basis heading in radians (+y north, CCW). */
function mathHeadingRad(degrees: number): number {
  return (-degrees * Math.PI) / 180;
}

function normalizeAngle(radians: number): number {
  const twoPi = Math.PI * 2;
  return ((radians % twoPi) + twoPi) % twoPi;
}

/**
 * Half-leg separation. Each junction leg carries an INBOUND half and an
 * OUTBOUND half; placing them a hair apart on the circle is what makes
 * "I exit north" and "I enter from the north" distinct endpoints. Must stay
 * well under half the angular gap between two legs — 0.01 rad is 0.57°, and the
 * tightest real junction leg spacing on these maps is tens of degrees.
 */
const HALF_LEG_SEPARATION_RAD = 0.01;

/** Is `value` strictly inside the CCW arc from `from` to `to`? */
function insideArc(value: number, from: number, to: number): boolean {
  const span = normalizeAngle(to - from);
  const offset = normalizeAngle(value - from);
  return offset > 1e-9 && offset < span - 1e-9;
}

/**
 * Do two movements' paths cross inside the junction?
 *
 * Each movement is a CHORD of the junction circle: it enters at its approach
 * leg and leaves at its exit leg. Two chords cross exactly when their endpoints
 * interleave around the circle — the classic planar test, and it gets every
 * standard case right without any junction-shape assumptions:
 *
 * * two opposing throughs → nested, no conflict;
 * * crossing throughs → interleaved, conflict;
 * * opposing left vs through → interleaved, conflict (the permitted-left case);
 * * dual protected lefts → nested, no conflict;
 * * two movements off the same approach → shared endpoint, never a conflict.
 *
 * Movements that only share an EXIT are merges, not crossings; they are
 * reported separately by `deriveMovementConflicts` and are not conflicting
 * greens (a merge under two greens is ordinary traffic).
 */
function movementChord(binding: JunctionMovementBinding): { entry: number; exit: number } | null {
  if (binding.approach_heading_deg == null || binding.exit_heading_deg == null) return null;
  // Stored headings are CARLA basis (+y SOUTH), which is a mirrored circle. The
  // half-leg rule below is handed — for right-hand traffic the inbound half of a
  // leg sits counter-clockwise of the leg's bearing — so headings are converted
  // to a math basis (+y north, angles CCW) first. Mirroring the circle without
  // mirroring the rule would swap every conflict for its complement.
  const approach = mathHeadingRad(binding.approach_heading_deg);
  const exit = mathHeadingRad(binding.exit_heading_deg);
  return {
    // The approach LEG lies opposite the direction of travel entering it.
    entry: normalizeAngle(approach + Math.PI + HALF_LEG_SEPARATION_RAD),
    exit: normalizeAngle(exit - HALF_LEG_SEPARATION_RAD),
  };
}

export interface MovementConflict {
  movement_ids: [string, string];
  kind: "crossing" | "merge";
}

/**
 * Geometric conflict table for a junction's movements.
 *
 * An approximation, deliberately: it reads only the two bearings per movement,
 * which is all `MapTopologyIndex` guarantees. A map with a compiled semantic
 * graph has exact `conflictZones` and may overwrite `conflicts_with` directly;
 * anything downstream must treat `conflicts_with` as authoritative and this
 * function as the default way to fill it.
 */
export function deriveMovementConflicts(
  bindings: readonly JunctionMovementBinding[],
): MovementConflict[] {
  const conflicts: MovementConflict[] = [];
  for (let i = 0; i < bindings.length; i += 1) {
    for (let j = i + 1; j < bindings.length; j += 1) {
      const left = bindings[i]!;
      const right = bindings[j]!;
      if (left.approach_id === right.approach_id) continue; // diverging, never crossing
      const a = movementChord(left);
      const b = movementChord(right);
      if (!a || !b) continue;
      const pair: [string, string] = [left.movement_id, right.movement_id];
      if (Math.abs(normalizeAngle(a.exit - b.exit)) < HALF_LEG_SEPARATION_RAD) {
        conflicts.push({ movement_ids: pair, kind: "merge" });
        continue;
      }
      if (insideArc(b.entry, a.entry, a.exit) !== insideArc(b.exit, a.entry, a.exit)) {
        conflicts.push({ movement_ids: pair, kind: "crossing" });
      }
    }
  }
  return conflicts;
}

/** Derive the movement table AND its crossing conflicts in one call. */
export function deriveJunctionMovementTable(
  gates: readonly JunctionGateInput[],
): JunctionMovementBinding[] {
  const bindings = deriveJunctionMovements(gates);
  const crossings = new Map<string, Set<string>>();
  for (const conflict of deriveMovementConflicts(bindings)) {
    if (conflict.kind !== "crossing") continue;
    const [left, right] = conflict.movement_ids;
    crossings.set(left, (crossings.get(left) ?? new Set()).add(right));
    crossings.set(right, (crossings.get(right) ?? new Set()).add(left));
  }
  return bindings.map((binding) => ({
    ...binding,
    conflicts_with: [...(crossings.get(binding.movement_id) ?? new Set<string>())].sort(),
  }));
}

// ---------------------------------------------------------------------------
// Scene actions (the SCENE lane's vocabulary)
// ---------------------------------------------------------------------------

/**
 * Scene actions are a SEPARATE union from `BehaviorActionSchema`, not an
 * extension of it.
 *
 * The actor union is switched over exhaustively by the worker's action
 * validator, its handler table, its completion probes, the export writer and
 * the dock's action picker — all of which are about ONE actor's control
 * channels. A signal command has no owning actor and no vehicle control to
 * take, so grafting it on would add an unreachable branch (plus a "not legal
 * for actors" guard) to each of those switches. Separate unions keep both
 * closed and exhaustive.
 *
 * What IS shared is the scheduling: a scene clip carries the same
 * `BehaviorTrigger` and the same `BehaviorClipEnd` as an actor clip, so the
 * dock, the trigger builder and the worker's trigger evaluator treat both
 * identically. A scene clip is a clip that commands a junction instead of a car.
 */
export const SCENE_ACTION_KINDS = ["set_movement_state", "set_junction_state"] as const;
export const SceneActionKindSchema = z.enum(SCENE_ACTION_KINDS);
export type SceneActionKind = z.infer<typeof SceneActionKindSchema>;

/** Drive one movement to one state. OSC `TrafficSignalStateAction`. */
export const SetMovementStateActionSchema = z
  .object({
    kind: z.literal("set_movement_state"),
    /** Defaults to the plan that owns the clip; name another to coordinate a corridor. */
    junction_id: z.string().trim().min(1).optional(),
    movement_id: MovementIdSchema,
    state: BehaviorSignalStateSchema,
  })
  .strict();

/** Drive EVERY movement of a junction to one state — the all-red / all-flash case. */
export const SetJunctionStateActionSchema = z
  .object({
    kind: z.literal("set_junction_state"),
    junction_id: z.string().trim().min(1).optional(),
    state: BehaviorSignalStateSchema,
  })
  .strict();

export const SceneActionSchema = z.discriminatedUnion("kind", [
  SetMovementStateActionSchema,
  SetJunctionStateActionSchema,
]);
export type SceneAction = z.infer<typeof SceneActionSchema>;

/**
 * A SCENE-lane clip. Same shape as `BehaviorClip` minus `fidelity` (computed
 * per-plan, not per-clip, because the export unit is the junction's controller).
 *
 * Trigger actor refs must be EXPLICIT: `"self"` means the owning actor, and a
 * scene clip has none. `signalPlanIssues` rejects a `self` ref rather than
 * leaving it to evaluate false forever.
 */
export const SceneClipSchema = z.object({
  id: z.string().trim().min(1),
  label: z.string().optional(),
  enabled: z.boolean().default(true),
  trigger: BehaviorTriggerSchema.default(DEFAULT_BEHAVIOR_TRIGGER),
  end: BehaviorClipEndSchema.default(DEFAULT_BEHAVIOR_CLIP_END),
  action: SceneActionSchema,
});
export type SceneClip = z.infer<typeof SceneClipSchema>;

// ---------------------------------------------------------------------------
// The plan
// ---------------------------------------------------------------------------

export const SIGNAL_PLAN_MODES = ["map_default", "static", "program", "scripted"] as const;
export const SignalPlanModeSchema = z.enum(SIGNAL_PLAN_MODES);
export type SignalPlanMode = z.infer<typeof SignalPlanModeSchema>;

/** One interval of a fixed-time cycle. Movements it omits hold their previous colour. */
export const SignalPhaseIntervalSchema = z
  .object({
    duration_s: z.number().positive(),
    states: z.record(MovementIdSchema, BehaviorSignalStateSchema),
    label: z.string().optional(),
  })
  .strict();
export type SignalPhaseInterval = z.infer<typeof SignalPhaseIntervalSchema>;

/**
 * A fixed-time cycle. `offset_s` shifts the cycle's phase at t=0 — the standard
 * coordination knob, and what lets an author put the ego's approach anywhere in
 * the cycle without rewriting the durations.
 */
export const SignalPhaseProgramSchema = z
  .object({
    cycle: z.array(SignalPhaseIntervalSchema).min(1),
    offset_s: z.number().min(0).default(0),
  })
  .strict();
export type SignalPhaseProgram = z.infer<typeof SignalPhaseProgramSchema>;

export const SIGNAL_PLAN_WARNING_CODES = [
  "conflicting_green",
  "unresolvable_movement",
  "incomplete_phase",
  "shared_signal_heads",
] as const;
export const SignalPlanWarningCodeSchema = z.enum(SIGNAL_PLAN_WARNING_CODES);
export type SignalPlanWarningCode = z.infer<typeof SignalPlanWarningCodeSchema>;

/**
 * A non-blocking authoring note. Warnings are DATA, not errors: the plan
 * validates with any number of them, the panel shows them inline, and the
 * export manifest carries them. Conflicting greens in particular are authorable
 * on purpose (plan 4.3: "validated against `controlBindings` lane geometry and
 * flagged, not blocked — edge cases may *want* conflicting greens").
 */
export const SignalPlanWarningSchema = z
  .object({
    code: SignalPlanWarningCodeSchema,
    message: z.string().trim().min(1),
    movement_ids: z.array(MovementIdSchema).default([]),
    /** Index into `program.cycle`, when the warning belongs to one phase. */
    phase_index: z.number().int().min(0).optional(),
  })
  .strict();
export type SignalPlanWarning = z.infer<typeof SignalPlanWarningSchema>;

/**
 * One junction's signal authoring.
 *
 * Modes, and what the runtime does for each:
 *
 * * `map_default` — nothing. CARLA's own timers run and the ego-force-green /
 *   bounded-red-wait hacks stay in force for this junction. Zero cost, today's
 *   behavior.
 * * `static` — freeze the junction and hold `static` for the whole scenario.
 * * `program` — freeze the junction and run `program` from `offset_s`.
 * * `scripted` — freeze the junction, run a BASELINE (`program` if authored,
 *   else `static`, else the state captured at bind time), and let `scripted`
 *   clips override individual movements while they are active. A scripted clip
 *   that ends returns its movement to the baseline. This is what makes the
 *   dilemma-zone scenario authorable: a normal cycle, overridden to yellow when
 *   the ego reaches the stop line.
 */
export const JunctionSignalPlanSchema = z
  .object({
    schema_version: z.literal(SIGNAL_PLAN_SCHEMA_VERSION).default(SIGNAL_PLAN_SCHEMA_VERSION),
    junction_id: z.string().trim().min(1),
    mode: SignalPlanModeSchema.default("map_default"),
    /** The derived movement table (see the module header). */
    movements: z.array(JunctionMovementBindingSchema).default([]),
    static: z.record(MovementIdSchema, BehaviorSignalStateSchema).optional(),
    program: SignalPhaseProgramSchema.optional(),
    scripted: z.array(SceneClipSchema).optional(),
    /** Cached output of `detectSignalPlanWarnings`, for the panel and the manifest. */
    warnings: z.array(SignalPlanWarningSchema).optional(),
  })
  .superRefine((plan, ctx) => {
    for (const issue of signalPlanIssues(plan)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: issue.path, message: issue.message });
    }
  });
export type JunctionSignalPlan = z.infer<typeof JunctionSignalPlanSchema>;

export const SignalPlansSchema = z.array(JunctionSignalPlanSchema);

export function mapDefaultSignalPlan(junctionId: string): JunctionSignalPlan {
  return {
    schema_version: SIGNAL_PLAN_SCHEMA_VERSION,
    junction_id: junctionId,
    mode: "map_default",
    movements: [],
  };
}

// ---------------------------------------------------------------------------
// Validation (hard errors) and warnings (soft)
// ---------------------------------------------------------------------------

type PlanShape = {
  junction_id: string;
  mode: SignalPlanMode;
  movements: JunctionMovementBinding[];
  static?: Record<string, BehaviorSignalState>;
  program?: SignalPhaseProgram;
  scripted?: SceneClip[];
};

function triggerActorRefs(trigger: BehaviorTrigger): Array<"self" | { actor_id: string }> {
  const refs: Array<"self" | { actor_id: string }> = [];
  if ("actor" in trigger && trigger.actor !== undefined) refs.push(trigger.actor);
  if ("other" in trigger && trigger.other !== undefined) refs.push(trigger.other);
  return refs;
}

/**
 * Hard authoring errors — everything the schema rejects. Split out of the
 * refinement so the panel can show the same list without throwing.
 */
export function signalPlanIssues(plan: PlanShape): Array<{ path: (string | number)[]; message: string }> {
  const issues: Array<{ path: (string | number)[]; message: string }> = [];
  const known = new Set(plan.movements.map((movement) => movement.movement_id));
  const checkMovement = (movementId: string, path: (string | number)[]) => {
    if (known.size > 0 && !known.has(movementId)) {
      issues.push({ path, message: `Unknown movement '${movementId}' for junction ${plan.junction_id}` });
    }
  };

  if (plan.mode === "static" && Object.keys(plan.static ?? {}).length === 0) {
    issues.push({ path: ["static"], message: "static mode needs at least one movement state" });
  }
  if (plan.mode === "program" && (plan.program?.cycle.length ?? 0) === 0) {
    issues.push({ path: ["program"], message: "program mode needs a cycle with at least one phase" });
  }
  if (plan.mode === "scripted" && (plan.scripted?.length ?? 0) === 0) {
    issues.push({ path: ["scripted"], message: "scripted mode needs at least one scene clip" });
  }

  for (const movementId of Object.keys(plan.static ?? {})) {
    checkMovement(movementId, ["static", movementId]);
  }
  for (const [index, phase] of (plan.program?.cycle ?? []).entries()) {
    if (Object.keys(phase.states).length === 0) {
      issues.push({ path: ["program", "cycle", index, "states"], message: "phase commands no movement" });
    }
    for (const movementId of Object.keys(phase.states)) {
      checkMovement(movementId, ["program", "cycle", index, "states", movementId]);
    }
  }

  const clipIds = new Set<string>();
  for (const [index, clip] of (plan.scripted ?? []).entries()) {
    if (clipIds.has(clip.id)) {
      issues.push({ path: ["scripted", index, "id"], message: `duplicate scene clip id '${clip.id}'` });
    }
    clipIds.add(clip.id);
    if (clip.action.kind === "set_movement_state") {
      checkMovement(clip.action.movement_id, ["scripted", index, "action", "movement_id"]);
    }
    for (const ref of triggerActorRefs(clip.trigger)) {
      if (ref === "self") {
        issues.push({
          path: ["scripted", index, "trigger"],
          message: "a scene clip has no owning actor — name the actor explicitly instead of 'self'",
        });
      }
    }
    if (clip.trigger.kind === "after_clip" && !clipIds.has(clip.trigger.clip_id)) {
      // Forward references are legal inside an actor program; inside a plan the
      // scene clips are the only chainable elements, so an id that never appears
      // is a typo. Checked against the whole list, not just the ids seen so far.
      const allIds = new Set((plan.scripted ?? []).map((entry) => entry.id));
      if (!allIds.has(clip.trigger.clip_id)) {
        issues.push({
          path: ["scripted", index, "trigger", "clip_id"],
          message: `scene clip chains after unknown clip '${clip.trigger.clip_id}'`,
        });
      }
    }
  }
  return issues;
}

/**
 * Soft warnings — conflicting greens above all. Computed from the plan alone
 * (its cached movement table carries `conflicts_with`), so the panel can run it
 * on every keystroke and the result caches onto `plan.warnings`.
 *
 * Scripted overrides are NOT analysed: what they produce depends on which
 * triggers fire, so a static conflict claim about them would be a guess. The
 * baseline they layer over (static / program) is analysed as usual.
 */
export function detectSignalPlanWarnings(plan: PlanShape): SignalPlanWarning[] {
  const warnings: SignalPlanWarning[] = [];
  const conflictsByMovement = new Map(
    plan.movements.map((movement) => [movement.movement_id, new Set(movement.conflicts_with)]),
  );

  /**
   * Movements that cannot be commanded independently: they resolve to the SAME
   * light head, so telling one red and the other green makes the second write
   * overwrite the first.
   *
   * This is the common case, not an edge case. OpenDRIVE puts a controlled
   * signal on the connecting road, which maps to (incoming road, lane link) —
   * an APPROACH, not a turn — so every movement off one approach inherits the
   * same head unless the map distinguishes a protected-arrow head by subtype.
   * A warning rather than an error: the plan still runs, it just cannot show
   * the two colours the author asked for.
   */
  const sharedHeads = (states: Record<string, BehaviorSignalState>): string[][] => {
    const byMovement = new Map(plan.movements.map((movement) => [movement.movement_id, movement]));
    const commanded = Object.entries(states).sort(([left], [right]) => left.localeCompare(right));
    const pairs: string[][] = [];
    for (let i = 0; i < commanded.length; i += 1) {
      for (let j = i + 1; j < commanded.length; j += 1) {
        const [leftId, leftState] = commanded[i]!;
        const [rightId, rightState] = commanded[j]!;
        if (leftState === rightState) continue;
        const leftHeads = byMovement.get(leftId)?.signal_ids ?? [];
        const rightHeads = new Set(byMovement.get(rightId)?.signal_ids ?? []);
        if (leftHeads.some((head) => rightHeads.has(head))) pairs.push([leftId, rightId]);
      }
    }
    return pairs;
  };

  const conflictingGreens = (states: Record<string, BehaviorSignalState>): string[][] => {
    const greens = Object.entries(states)
      .filter(([, state]) => state === "green")
      .map(([movementId]) => movementId)
      .sort();
    const pairs: string[][] = [];
    for (let i = 0; i < greens.length; i += 1) {
      for (let j = i + 1; j < greens.length; j += 1) {
        if (conflictsByMovement.get(greens[i]!)?.has(greens[j]!)) pairs.push([greens[i]!, greens[j]!]);
      }
    }
    return pairs;
  };

  if (plan.mode !== "map_default") {
    for (const movement of plan.movements) {
      if (movement.signal_ids.length === 0 && movement.approach_lane_rsls.length === 0) {
        warnings.push({
          code: "unresolvable_movement",
          message: `Movement ${movement.label} carries neither signal ids nor approach lanes — the worker cannot bind it to a light.`,
          movement_ids: [movement.movement_id],
        });
      }
    }
  }

  for (const pair of conflictingGreens(plan.static ?? {})) {
    warnings.push({
      code: "conflicting_green",
      message: `${pair[0]} and ${pair[1]} are green together and their paths cross.`,
      movement_ids: pair,
    });
  }
  for (const pair of sharedHeads(plan.static ?? {})) {
    warnings.push({
      code: "shared_signal_heads",
      message: `${pair[0]} and ${pair[1]} share a signal head, so they cannot show different colours.`,
      movement_ids: pair,
    });
  }

  const bound = plan.movements.map((movement) => movement.movement_id);
  for (const [index, phase] of (plan.program?.cycle ?? []).entries()) {
    for (const pair of conflictingGreens(phase.states)) {
      warnings.push({
        code: "conflicting_green",
        message: `Phase ${index + 1}: ${pair[0]} and ${pair[1]} are green together and their paths cross.`,
        movement_ids: pair,
        phase_index: index,
      });
    }
    for (const pair of sharedHeads(phase.states)) {
      warnings.push({
        code: "shared_signal_heads",
        message: `Phase ${index + 1}: ${pair[0]} and ${pair[1]} share a signal head, so they cannot show different colours.`,
        movement_ids: pair,
        phase_index: index,
      });
    }
    const missing = bound.filter((movementId) => phase.states[movementId] === undefined);
    if (missing.length > 0) {
      warnings.push({
        code: "incomplete_phase",
        message: `Phase ${index + 1} does not state ${missing.length} movement(s); they hold their previous colour.`,
        movement_ids: missing,
        phase_index: index,
      });
    }
  }
  return warnings;
}

/** The plan with its `warnings` recomputed — what the editor stores on every edit. */
export function withSignalPlanWarnings<T extends PlanShape>(plan: T): T & { warnings: SignalPlanWarning[] } {
  return { ...plan, warnings: detectSignalPlanWarnings(plan) };
}

// ---------------------------------------------------------------------------
// Cycle math (shared with the worker executor — keep the two in lockstep)
// ---------------------------------------------------------------------------

/** Conventional starting timings for a synthesized cycle. Authors edit them. */
export const DEFAULT_PHASE_GREEN_S = 20;
export const DEFAULT_PHASE_YELLOW_S = 3;
export const DEFAULT_PHASE_ALL_RED_S = 1;

/**
 * Partition movements into sets that can hold green together.
 *
 * Greedy colouring of the `conflicts_with` graph in Welsh-Powell order (highest
 * conflict degree first, ties broken by movement id), so the result is
 * deterministic and every group is conflict-free by construction. This is the
 * partition `synthesizeSignalProgram` phases and the one the timeline view
 * paints, which is the point of having it in one place: a group-level paint can
 * never produce a `conflicting_green`, because the group came from the same
 * graph `detectSignalPlanWarnings` checks against.
 *
 * `unionSharedHeads` additionally merges any two groups holding movements that
 * resolve to the same OpenDRIVE signal head. Two movements on one head cannot
 * show different colours — the runtime echo is `signal_plan_shared_head_conflict`
 * and the authoring warning is `shared_signal_heads` — so an authoring surface
 * that paints whole groups wants them fused, which makes the unrunnable state
 * unauthorable. It is OFF by default because a cycle synthesizer wants the raw
 * conflict partition: fusing there would hand two approaches one phase and turn
 * a four-way into a standing green.
 *
 * A merged group can, in principle, contain two movements that conflict with
 * each other (they share a head AND their paths cross). That is a map defect —
 * a head that controls crossing paths — and fusing is still the right answer:
 * they will be commanded the same colour whatever the plan says.
 */
export function deriveConflictFreeGroups(
  movements: readonly JunctionMovementBinding[],
  options: { unionSharedHeads?: boolean } = {},
): string[][] {
  if (movements.length === 0) return [];
  const conflicts = new Map(
    movements.map((movement) => [movement.movement_id, new Set(movement.conflicts_with)]),
  );
  const ordered = [...movements].sort(
    (left, right) =>
      (conflicts.get(right.movement_id)?.size ?? 0) - (conflicts.get(left.movement_id)?.size ?? 0) ||
      left.movement_id.localeCompare(right.movement_id),
  );

  const groups: string[][] = [];
  for (const movement of ordered) {
    const conflicting = conflicts.get(movement.movement_id) ?? new Set<string>();
    const target = groups.find((group) => !group.some((member) => conflicting.has(member)));
    if (target) target.push(movement.movement_id);
    else groups.push([movement.movement_id]);
  }
  for (const group of groups) group.sort();
  if (!options.unionSharedHeads) return groups;

  const headsByMovement = new Map(
    movements.map((movement) => [movement.movement_id, movement.signal_ids]),
  );
  const merged: string[][] = [];
  for (const group of groups) {
    const heads = new Set(group.flatMap((id) => headsByMovement.get(id) ?? []));
    const target = merged.find((candidate) =>
      candidate.some((id) => (headsByMovement.get(id) ?? []).some((head) => heads.has(head))),
    );
    if (target) target.push(...group);
    else merged.push([...group]);
  }
  for (const group of merged) group.sort();
  return merged;
}

/**
 * A sensible default cycle for a junction, synthesized from its movement
 * geometry — what the intersection panel offers when an author switches a
 * junction to `program` mode and has nothing to start from.
 *
 * Movements are partitioned into conflict-free groups by greedy colouring of
 * the `conflicts_with` graph (Welsh-Powell order: highest conflict degree
 * first, ties broken by movement id, so the result is deterministic). Each
 * group gets green → yellow → all-red, in group order. On a standard 4-way this
 * produces the NS-then-EW cycle you would draw by hand, and right turns — which
 * conflict with nothing, only merge — sit in the first group and stay green,
 * which is the real-world permitted-right behaviour.
 *
 * This is the plan's stated fallback for maps whose upstream phase data is
 * thinner than `signal_phase_count` suggests (risk 2). It is also why the panel
 * must not invent its own split: a partition that disagrees with
 * `deriveMovementConflicts` would make the default program warn against itself.
 *
 * Returns null when there are no movements to phase.
 */
export function synthesizeSignalProgram(
  movements: readonly JunctionMovementBinding[],
  options: { green_s?: number; yellow_s?: number; all_red_s?: number } = {},
): SignalPhaseProgram | null {
  if (movements.length === 0) return null;
  const greenS = options.green_s ?? DEFAULT_PHASE_GREEN_S;
  const yellowS = options.yellow_s ?? DEFAULT_PHASE_YELLOW_S;
  const allRedS = options.all_red_s ?? DEFAULT_PHASE_ALL_RED_S;

  const groups = deriveConflictFreeGroups(movements);

  const allRed = Object.fromEntries(
    movements.map((movement) => [movement.movement_id, "red" as BehaviorSignalState]),
  );
  const withGroup = (group: string[], state: BehaviorSignalState) => ({
    ...allRed,
    ...Object.fromEntries(group.map((movementId) => [movementId, state])),
  });

  // One group means nothing at this junction conflicts, so there is nothing to
  // alternate: a standing green is the honest synthesis, not a cycle that goes
  // red for a second for no reason.
  if (groups.length === 1) {
    return { cycle: [{ duration_s: greenS, states: withGroup(groups[0]!, "green") }], offset_s: 0 };
  }

  const cycle: SignalPhaseInterval[] = [];
  for (const [index, group] of groups.entries()) {
    const label = `Phase ${index + 1}`;
    cycle.push({ duration_s: greenS, states: withGroup(group, "green"), label });
    cycle.push({ duration_s: yellowS, states: withGroup(group, "yellow"), label: `${label} yellow` });
    cycle.push({ duration_s: allRedS, states: { ...allRed }, label: `${label} all-red` });
  }
  return { cycle, offset_s: 0 };
}

export function signalProgramCycleDurationS(program: SignalPhaseProgram): number {
  return program.cycle.reduce((total, phase) => total + phase.duration_s, 0);
}

/**
 * Which phase is running at `t`, and how far into it we are.
 *
 * `offset_s` shifts the cycle FORWARD: an offset of 5 s means the scenario
 * starts 5 s into the cycle. Wraparound is modulo the total duration, so a
 * scenario longer than one cycle repeats it, and a negative `t` (never
 * authored, but cheap to be safe about) lands in the same place a positive one
 * would.
 */
export function signalPhaseAt(
  program: SignalPhaseProgram,
  t: number,
): { index: number; phase: SignalPhaseInterval; elapsed_s: number } {
  const total = signalProgramCycleDurationS(program);
  const position = total > 0 ? (((t + program.offset_s) % total) + total) % total : 0;
  let cursor = 0;
  for (const [index, phase] of program.cycle.entries()) {
    if (position < cursor + phase.duration_s || index === program.cycle.length - 1) {
      return { index, phase, elapsed_s: position - cursor };
    }
    cursor += phase.duration_s;
  }
  return { index: 0, phase: program.cycle[0]!, elapsed_s: 0 };
}

/**
 * The colour a program commands for one movement at `t`.
 *
 * A phase that does not name the movement leaves it alone, so resolution walks
 * BACKWARD from the current phase to the most recent one that named it — the
 * same rule the worker's executor applies. `null` means no phase in the cycle
 * ever names this movement.
 */
export function movementStateAt(
  program: SignalPhaseProgram,
  movementId: string,
  t: number,
): BehaviorSignalState | null {
  const { index } = signalPhaseAt(program, t);
  const count = program.cycle.length;
  for (let step = 0; step < count; step += 1) {
    const phase = program.cycle[(((index - step) % count) + count) % count]!;
    const state = phase.states[movementId];
    if (state !== undefined) return state;
  }
  return null;
}

// ---------------------------------------------------------------------------
// `BehaviorSignalRef` reconciliation
// ---------------------------------------------------------------------------

/**
 * Resolve a `signal_state` trigger's reference against the draft's plans.
 *
 * `BehaviorSignalRef` (declared in `scenario-behavior.ts`, where the trigger
 * union needed it before this module existed) is `{junction_id, movement_id?,
 * signal_id?}`, and its `movement_id` is exactly a `MovementId` from here —
 * that is the whole reconciliation. The three cases:
 *
 * * `movement_id` names a movement of a plan → resolved, the trigger reads that
 *   movement's commanded colour;
 * * `signal_id` names one bulb → resolved, the trigger reads that light;
 * * neither → the junction as a whole, which reads as the colour of its first
 *   movement (or of any of its lights under `map_default`).
 *
 * A junction with NO plan is not an error: it is `map_default`, and the worker
 * reads its live CARLA lights. Only a ref naming a movement that its own plan
 * does not have is unresolvable.
 */
export function resolveBehaviorSignalRef(
  ref: BehaviorSignalRef,
  plans: readonly JunctionSignalPlan[],
): { plan: JunctionSignalPlan | null; movement: JunctionMovementBinding | null; resolved: boolean } {
  const plan = plans.find((entry) => entry.junction_id === ref.junction_id) ?? null;
  if (!ref.movement_id) return { plan, movement: null, resolved: true };
  const movement = plan?.movements.find((entry) => entry.movement_id === ref.movement_id) ?? null;
  // Unknown movement is only decidable when the plan HAS a movement table.
  const resolved = movement != null || plan == null || plan.movements.length === 0;
  return { plan, movement, resolved };
}

// ---------------------------------------------------------------------------
// Signal events (worker → editor, additive on `behavior_events`)
// ---------------------------------------------------------------------------

/**
 * The reserved `actor_id` scene-lane events carry. The dock draws one lane per
 * actor plus a SCENE lane (plan 4.1); this is that lane's id, so a signal
 * transition sorts and renders through the same `behavior_events` pipe as every
 * actor event.
 */
export const BEHAVIOR_SCENE_ACTOR_ID = "scene";

/** A junction movement changed colour. */
export const BEHAVIOR_EVENT_SIGNAL_STATE_CHANGED = "signal_state_changed";

/**
 * Additive extension of `BehaviorEventSchema`: same required fields (so the
 * existing reader keeps every signal event) plus the signal payload. Not
 * `.strict()`, for the reason the base schema is not: it comes off a worker
 * artifact.
 *
 * `clip_id` on a transition NOT driven by a scripted clip is the synthetic
 * channel id `signal:<junction>:<movement>` — the channel the executor
 * commands, which is what the dock's SCENE lane groups by.
 */
export const SignalStateChangedEventSchema = z.object({
  actor_id: z.string().trim().min(1),
  clip_id: z.string().trim().min(1),
  kind: z.literal(BEHAVIOR_EVENT_SIGNAL_STATE_CHANGED),
  t: z.number().min(0),
  junction_id: z.string().trim().min(1),
  movement_id: MovementIdSchema.optional(),
  state: BehaviorSignalStateSchema,
});
export type SignalStateChangedEvent = z.infer<typeof SignalStateChangedEventSchema>;

export function signalChannelId(junctionId: string, movementId: string): string {
  return `signal:${junctionId}:${movementId}`;
}

/** Read the signal transitions out of an artifact's `behavior_events` array. */
export function readSignalStateEvents(input: unknown): SignalStateChangedEvent[] {
  if (!input || typeof input !== "object" || Array.isArray(input)) return [];
  const raw = (input as Record<string, unknown>).behavior_events;
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((entry) => {
    const parsed = SignalStateChangedEventSchema.safeParse(entry);
    return parsed.success ? [parsed.data] : [];
  });
}

/** Colour bands per movement, for the dock's SCENE lane. */
export function signalBandsFromEvents(
  events: readonly SignalStateChangedEvent[],
  durationS: number,
): Array<{ junction_id: string; movement_id: string; state: BehaviorSignalState; start_s: number; end_s: number }> {
  const byMovement = new Map<string, SignalStateChangedEvent[]>();
  for (const event of events) {
    if (!event.movement_id) continue;
    const key = `${event.junction_id} ${event.movement_id}`;
    byMovement.set(key, [...(byMovement.get(key) ?? []), event]);
  }
  const bands: Array<{
    junction_id: string;
    movement_id: string;
    state: BehaviorSignalState;
    start_s: number;
    end_s: number;
  }> = [];
  for (const entries of byMovement.values()) {
    const ordered = [...entries].sort((left, right) => left.t - right.t);
    for (const [index, event] of ordered.entries()) {
      const end = ordered[index + 1]?.t ?? durationS;
      if (end <= event.t) continue;
      bands.push({
        junction_id: event.junction_id,
        movement_id: event.movement_id!,
        state: event.state,
        start_s: event.t,
        end_s: end,
      });
    }
  }
  return bands.sort(
    (left, right) =>
      left.junction_id.localeCompare(right.junction_id) ||
      left.movement_id.localeCompare(right.movement_id) ||
      left.start_s - right.start_s,
  );
}
