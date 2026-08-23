import type { TimedInstructionPrimitiveId } from "@simcloud/shared";
import type { RuntimeRoadSegment } from "@/app/lib/runtime/runtime-types";
import type { JunctionControl } from "./signals-source";

export const BATCH_SCENARIO_STRATEGIES = [
  "lane_keep",
  "lane_change_left",
  "lane_change_right",
  // Overtake variants: a lane change MOTIVATED by a slower lead ahead in the subject's
  // lane. Identical placement + pursuit S-curve as the bare lane changes (they share
  // all the lane-change geometry via laneChangeSide/isLaneChangeStrategy below); the
  // only addition is the slow lead the subject swings out to pass.
  "overtake_left",
  "overtake_right",
  "turn_left",
  "turn_right",
  "stop",
  // Infrastructure-triggered stops (dib 2026-07-14: "simple but powerful for VLMs/VLAs").
  // The subject is a REGULAR TM-driven traffic actor routed through a junction that carries
  // the named control; CARLA's TrafficManager already obeys signs/lights natively
  // (ignore_signs/lights = 0), so the stop is caused by the INFRASTRUCTURE, not a spawned
  // lead — no conflict actor, no timing loop. Direction through the junction (straight/
  // left/right) does not matter. The worker's stopOutcome detects the cause
  // (stop_sign / traffic_light / yield); scenes are validated by matching detected_cause
  // to the family's expected cause. Replicable at every junction with the element +
  // traffic/parking variations.
  "stop_at_stop_sign",
  "stop_at_yield_sign",
  "stop_at_traffic_light",
  // Uncontrolled junction: the subject stops/slows through an intersection with NO
  // control device — a first-class family (dib 2026-07-15). The scene is TAGGED by
  // whatever control the map's signals.geojson overlay shows on the approach road;
  // "uncontrolled" is a valid, common case, not a reject.
  "stop_at_uncontrolled",
  // Highway families (dib 2026-07-13: wire the highway locations into the emit
  // path). Detection is GEOMETRIC (>= 3 same-direction Driving lanes — the map
  // generator types every road "town", so road type/speed cannot be used).
  // Distinct strategy values (not a modifier) keep every existing family's
  // seeded stream byte-identical and let cells request highway-only waves.
  // lane_keep / lane_change_* reuse their base-family placement at highway
  // cruise speeds; exit/entry are ROUTE-FOLLOWER ramp scenarios (deterministic
  // pure-pursuit through the gore/merge — no TM fork randomness, which is what
  // forced the old monolith implementation's single-successor gore gate).
  "highway_lane_keep",
  "highway_lane_change_left",
  "highway_lane_change_right",
  "highway_exit",
  "highway_entry",
] as const;

export type BatchScenarioStrategy = (typeof BATCH_SCENARIO_STRATEGIES)[number];

/** Strategies generated when the caller does not pin a list — the same 6 core
 * families the dashboard batch dialog and lane_a_batch.py request. Overtake,
 * the stop-junction families, and the highway families are opt-in, so the
 * default mix stays byte-identical to the pre-expansion generator. */
export const BATCH_SCENARIO_DEFAULT_STRATEGIES = BATCH_SCENARIO_STRATEGIES.filter(
  (strategy) =>
    !strategy.startsWith("highway_") &&
    !strategy.startsWith("overtake_") &&
    !strategy.startsWith("stop_at_"),
);

/** The highway-only strategy values (geometric admission; see above). */
export const BATCH_HIGHWAY_SCENARIO_STRATEGIES = BATCH_SCENARIO_STRATEGIES.filter(
  (strategy) => strategy.startsWith("highway_"),
);

export function isHighwayStrategy(strategy: BatchScenarioStrategy): boolean {
  return strategy.startsWith("highway_");
}

/** lane_keep-like strategies: a route-follower cruising its corridor. */
export function isLaneKeepStrategy(strategy: BatchScenarioStrategy): boolean {
  return strategy === "lane_keep" || strategy === "highway_lane_keep";
}

/** Ramp strategies: subject routed through a gore/merge chain (routeVia). */
export function isRampStrategy(strategy: BatchScenarioStrategy): boolean {
  return strategy === "highway_exit" || strategy === "highway_entry";
}

/** The lateral side a lane-change-like strategy merges toward, or null if the
 * strategy is not a lane change. Overtake variants share the bare lane-change
 * geometry — one helper keeps candidate selection, placement, and target-lane
 * clearance from having to enumerate the four names everywhere. */
export function laneChangeSide(
  strategy: BatchScenarioStrategy,
): "left" | "right" | null {
  if (
    strategy === "lane_change_left" ||
    strategy === "overtake_left" ||
    strategy === "highway_lane_change_left"
  ) {
    return "left";
  }
  if (
    strategy === "lane_change_right" ||
    strategy === "overtake_right" ||
    strategy === "highway_lane_change_right"
  ) {
    return "right";
  }
  return null;
}

/** True for every lane-change-like strategy (bare change or overtake). */
export function isLaneChangeStrategy(strategy: BatchScenarioStrategy): boolean {
  return laneChangeSide(strategy) !== null;
}

/** True only for the overtake variants (a slow lead is spawned ahead). */
export function isOvertakeStrategy(strategy: BatchScenarioStrategy): boolean {
  return strategy === "overtake_left" || strategy === "overtake_right";
}

/** The infrastructure-triggered stop families: a TM subject routed through a signalized
 * junction. Distinct from `stop` (which stages a lead-vehicle cause) — here the control
 * device IS the cause and there is NO spawned conflict actor. */
export const STOP_JUNCTION_STRATEGIES = [
  "stop_at_stop_sign",
  "stop_at_yield_sign",
  "stop_at_traffic_light",
  "stop_at_uncontrolled",
] as const satisfies readonly BatchScenarioStrategy[];

export function isStopJunctionStrategy(strategy: BatchScenarioStrategy): boolean {
  return (STOP_JUNCTION_STRATEGIES as readonly string[]).includes(strategy);
}

/** The stop CAUSE the worker's stopOutcome should detect for a stop-junction family —
 * the expected-cause label used to validate the scene (detected_cause must match). */
export function stopJunctionExpectedCause(
  strategy: BatchScenarioStrategy,
): "stop_sign" | "traffic_light" | "yield" | null {
  switch (strategy) {
    case "stop_at_stop_sign":
      return "stop_sign";
    case "stop_at_traffic_light":
      return "traffic_light";
    case "stop_at_yield_sign":
      return "yield";
    default:
      return null;
  }
}

/** The signals.geojson control class a stop-junction family targets — the key used
 * to FILTER junction-approach candidates against the map's signals overlay
 * (`attributeControl`), so a family's scenes land only at junctions carrying that
 * control. Distinct from `stopJunctionExpectedCause` (the worker-side detected_cause,
 * which uses `yield`): the geojson attribution uses `yield_sign`, and `uncontrolled`
 * is a first-class target here with no worker cause. */
export function stopJunctionControl(strategy: BatchScenarioStrategy): JunctionControl | null {
  switch (strategy) {
    case "stop_at_stop_sign":
      return "stop_sign";
    case "stop_at_yield_sign":
      return "yield_sign";
    case "stop_at_traffic_light":
      return "traffic_light";
    case "stop_at_uncontrolled":
      return "uncontrolled";
    default:
      return null;
  }
}

export const BATCH_TRAFFIC_PROFILES = ["normal", "medium", "heavy"] as const;

export type BatchTrafficProfile = (typeof BATCH_TRAFFIC_PROFILES)[number];

/** Where the BACKGROUND (mid/far-field) ambient traffic comes from.
 *
 * "procedural" (default) — the existing seeded geometric fill: lanes around the
 *   subject are packed at a uniform headway band and driven by CARLA's Traffic
 *   Manager. Byte-identical to the pre-SUMO generator.
 *
 * "sumo" — the fill is replaced by vehicles lifted out of a WARMED-UP offline
 *   SUMO run (see docs/sumo-ambient-traffic.md), baked into the spec as
 *   ordinary `timed_path` / `schedule` actors. What this buys is the time
 *   structure a geometric fill cannot have: Poisson arrivals, queue formation
 *   and discharge, platoons, per-vehicle speed spread, and a distinct route per
 *   vehicle.
 *
 * Two things deliberately do NOT change under "sumo":
 *   - the NEAR-FIELD RING around the subject stays Traffic-Manager driven, so the
 *     vehicles most likely to interact with the subject keep CARLA-native
 *     closed-loop reaction (SUMO schedules are open loop);
 *   - PARKED / street dressing stays on its own placement code. SUMO models
 *     moving demand, not curb parking.
 */
export const BATCH_TRAFFIC_SOURCES = ["procedural", "sumo"] as const;

export type BatchTrafficSource = (typeof BATCH_TRAFFIC_SOURCES)[number];

/** Street-parking density: how heavily the curb lanes around the subject are lined
 * with static (physics-frozen, non-autopilot) parked vehicles. "none" keeps the
 * scene byte-identical to the pre-parking generator. */
export const BATCH_PARKED_DENSITIES = ["none", "light", "moderate", "heavy"] as const;

export type BatchParkedDensity = (typeof BATCH_PARKED_DENSITIES)[number];

export type Candidate = {
  strategy: BatchScenarioStrategy;
  segment: RuntimeRoadSegment;
  hasKnownDrivableSuccessor: boolean;
  /** The segment's end is a junction entry line (a successor is
   * junction-internal). Junction-anchored stops draw from these first. */
  endsAtJunctionEntry?: boolean;
};

/** Stop scenarios are always CAUSED — never a free stop in the middle of the
 * road. Seeded mix (~50/30/20):
 * - junction_proceed: stop at the junction entry line, hold through the label
 *   window, then proceed through the junction (right turn preferred).
 * - queue_at_junction: a lead vehicle rests at the entry line; the subject queues
 *   2-5m behind its rear, then both resume after the window.
 * - lead_brake: a mid-block lead brakes to a stop; the subject stops behind it
 *   for the rest of the clip. */
export type StopVariant =
  | "junction_proceed"
  | "queue_at_junction"
  | "lead_brake"
  | "vru_yield"
  | "stop_sign";

export type ScenarioVariation = {
  spawnFraction: number;
  speedKph: number;
  /** The road's FREE-FLOW speed, before any dense-traffic congestion factor is
   * applied to `speedKph`. Ambient traffic scales its own congested speed off
   * this (not off the subject's already-slowed speed, which would double-discount).
   * Absent = uncongested, so free-flow == speedKph. */
  freeFlowSpeedKph?: number;
  instructionDelaySeconds: number;
  /** Turn strategies: target seconds from spawn to the junction entry, so the
   * turn itself lands inside the PAI label window. */
  approachTimeSeconds: number | null;
  /** Stop strategy: seeded causal variant (~50% junction_proceed /
   * ~30% queue_at_junction / ~20% lead_brake). Pools that cannot host the
   * drawn variant fall back junction_proceed -> queue_at_junction ->
   * lead_brake deterministically — never to a free, uncaused stop. */
  stopVariant?: StopVariant;
  /** Stop strategy: meters short of the junction entry line where the
   * line-anchored vehicle (subject in junction_proceed, lead in queue_at_junction)
   * comes to rest (2-6m, like a real stop-line stop). */
  stopMarginMeters?: number | null;
  /** queue_at_junction: bumper-to-bumper gap (2-5m) between the lead's rear
   * and the resting subject. */
  stopQueueGapMeters?: number | null;
  /** queue_at_junction / lead_brake: seconds the lead's stop instruction
   * precedes the subject's (1.2-1.8s) so the cause is visible before the effect. */
  stopLeadDeltaSeconds?: number | null;
  /** junction_proceed: seconds when the subject proceeds through the junction
   * (12.0-13.5s — strictly after the 11.5s label-window end and after brake
   * completion at <=9.5s + ~2s of settled rest). */
  stopResumeAtSeconds?: number | null;
  /** queue_at_junction: seconds when the lead pulls away (12.0-12.5s); the
   * subject follows via set_speed STOP_QUEUE_EGO_RESUME_LAG_S later. */
  stopLeadResumeAtSeconds?: number | null;
  /** lead_brake: bumper gap (3-6m) between lead rear and subject front once both
   * are at rest. */
  stopRestGapMeters?: number | null;
  /** lead_brake hold/resume mix: when true the lead stays stopped to clip end (the
   * subject HOLDS → valid_stop); when false the lead pulls away (the subject RESUMES →
   * valid_resume). Resume is the default; a minority HOLD for dataset variety. */
  stopLeadHolds?: boolean;
};

/** Resolved plan for one caused-stop scenario: when the subject brakes, whether
 * and how it proceeds afterwards, and the lead vehicle (if the cause is a
 * lead) with its own spawn + timed instructions. All times are 0.1s-quantized
 * and all positions derive from the anchored-stop kinematics. */
export type StopScenarioPlan = {
  variant: StopVariant;
  /** How the SUBJECT comes to rest:
   *  - "forced": a timed `stop` primitive halts the subject at subjectStopAtSeconds
   *    (legacy; fights the TM → uncaused/full-brake stops).
   *  - "tm_follow": NO forced stop — the subject is a route-follower and stops NATURALLY
   *    behind the instantiated cause (a stopped lead / a crossing VRU) via its
   *    obstacle-aware kinematic car-following. Cause-first (2026-06-24), smooth decel.
   *  - "stop_line": a route-follower with NO obstacle to follow — the WORKER eases it to
   *    a controlled stop at the nearest STOP LINE ahead on its route (the loaded maps
   *    expose `StopLine` landmarks; real-world you stop at the line, sign or not). The
   *    subject spec carries `stop_at_stop_line: true`; the route (not the TM) gives the
   *    smooth decel + no junction divergence. */
  subjectStopMode?: "forced" | "tm_follow" | "stop_line";
  subjectStopAtSeconds: number;
  subjectResume: {
    atSeconds: number;
    primitiveId: TimedInstructionPrimitiveId;
    speedKph: number;
  } | null;
  lead: {
    spawnSegment: RuntimeRoadSegment;
    spawnFraction: number;
    speedKph: number;
    stopAtSeconds: number;
    resume: {
      atSeconds: number;
      primitiveId: TimedInstructionPrimitiveId;
      speedKph: number;
    } | null;
  } | null;
  /** vru_yield: a pedestrian crossing the subject's lane ahead. The subject is a worker
   * route-follower whose obstacle-stop already brakes for walkers in its corridor,
   * so it eases to a halt for the ped and resumes once the ped clears the corridor.
   * The ped walks a timed_path: hold at the curb, then cross at `speedKph`. */
  vru: {
    /** z = the subject lane's centerline elevation at the crossing — lets the worker
     * resolve the walker onto the SAME layer as the subject on stacked-geometry maps
     * (else the ped snaps to an upper defect layer and floats — issue: airborne ped). */
    spawnPoint: { x: number; y: number; z: number };
    crossEndPoint: { x: number; y: number; z: number };
    holdSeconds: number;
    crossSeconds: number;
    speedKph: number;
  } | null;
};

export type PlacedVariation = {
  variation: ScenarioVariation;
  /** Spawn anchor segment — for turns this is usually UPSTREAM of the
   * junction-approach candidate so the approach distance fits. */
  spawnSegment: RuntimeRoadSegment;
  /** Stop strategy only: the causal stop plan (variant, resume rows, lead). */
  stopPlan?: StopScenarioPlan | null;
  /** highway_exit / highway_entry only: the resolved gore/merge chain the
   * subject's route must pass through, with the ramp-vs-cruise speed split. The
   * emitted subject is a route-follower along spawnSegment → chain → onward, so
   * the branch choice is deterministic (no TM fork randomness). */
  highwayRoute?: {
    chain: RuntimeRoadSegment[];
    /** Speed (km/h) on the spawn segment and chain hops BEFORE the switch. */
    preSpeedKph: number;
    /** Speed from chain[switchAtChainIndex] onward (and the post-chain walk). */
    postSpeedKph: number;
    switchAtChainIndex: number;
  } | null;
};

/** Diagnostic hook for placement studies (e.g. the real-map stop variant
 * probe): receives one stable reason string per rejected constraint. Unused
 * in production paths, so it costs nothing there. */
export type StopPlacementRejectLogger = (reason: string) => void;

export type ForbiddenFractionZones = Map<string, Array<{ start: number; end: number }>>;
