/**
 * Deterministic turn-across-crosswalk pedestrian planner (topology-gated).
 *
 * The `left_turn_ped_crosswalk` / `right_turn_ped_crosswalk` families: the subject
 * TURNS left/right at a junction while a pedestrian crosses the DESTINATION-leg
 * crosswalk — the crosswalk on the leg the subject is turning INTO. The subject must
 * yield/brake mid-turn and let the pedestrian pass (avoidance = the VLA-priority
 * variant; the collision variant completes the canonical cell).
 *
 * This is a COMPOSITION of two things that already exist — not a new primitive:
 *   - Turn geometry: `buildGatePolyline` builds the subject's approach → connecting →
 *     EXIT chain for a Left/Right gate, and `buildPlannedActorFromTopology`
 *     back-walks the run-up + fills `postConflictWaypoints` (the exit-lane
 *     centerline past the conflict) so the subject completes the turn into the exit
 *     lane. The draft assembler then drives the collision variant with the
 *     CARLA-native turn primitive and the avoided variant as the reactive
 *     arc-follower (`plannedCollisionToDraftActors`, subjectReactive) — the SAME
 *     wiring the shipping turn families use.
 *   - Pedestrian crossing: `resolveCrossingLine` resolves a real curb-to-curb
 *     crossing (crosswalk → sidewalk → road edge) through the conflict point, and
 *     the walker's curb-hold is solved so it reaches the conflict when the subject
 *     does — IDENTICAL to `pedestrian_crossing` (planPedestrianCrossingForSite).
 *
 * The ONLY geometric difference from `pedestrian_crossing` is WHERE the conflict
 * sits: `pedestrian_crossing` puts it on the APPROACH lane (subject drives Straight
 * through), here it sits a few metres INTO the EXIT lane (the destination-leg
 * crosswalk), and the subject turns to reach it. So the subject route is the full turn
 * gate chain ending at the exit-leg conflict, and the crossing axis is
 * perpendicular to the EXIT lane.
 *
 * DRIVEWAY destinations (dib US crosswalk-turn CoT review 2026-07-22): when the
 * exit leg is a short/dead-end stub (a driveway / parking apron / alley mouth —
 * < DRIVEWAY_MAX_RUN_M of drivable run past the junction), there is no
 * "destination-leg crosswalk" to walk — the leg ends at a garage door/wall. The
 * intended scene is the ped walking the MAIN road's sidewalk ACROSS the
 * driveway MOUTH, perpendicular to the subject's entry, with the subject stopping at
 * the mouth and proceeding in once clear. For those sites the crossing line is
 * forced onto the mouth axis (both endpoints ON the perpendicular through the
 * conflict point, clamped to walkable extents) so the walk parallels the main
 * road and never extends down the driveway into the parcel.
 *
 * DRIVEWAY FIX 1 (dib 2026-07-23 US avoidance review — leftped-1774-7:
 * "pedestrians need to be on the actual SIDEWALK and need to walk across the
 * driveway to the OTHER sidewalk — in this scene they are walking in the right
 * direction but they are closer to the house and hence get stuck at the end of
 * the maneuver"): the mouth axis runs through the conflict point, which sits
 * EXIT_SETBACK_M *inside* the driveway — i.e. HOUSE-ward of the frontage
 * sidewalk that actually crosses the mouth. The walk therefore ended on the
 * lawn/apron and the walker wedged. `resolveDrivewaySidewalkCrossing` now
 * prefers the real sidewalk polyline that STRADDLES the driveway centerline
 * near the mouth: both endpoints are walked ALONG that polyline (so they sit ON
 * the sidewalk, on opposite sides of the driveway), and the conflict is
 * RE-ANCHORED onto the point where the sidewalk crosses the subject's driveway path
 * — the subject stops where a driver really stops, at the sidewalk. The axis-clamp
 * treatment above stays as the fallback for stubs with no mapped sidewalk.
 *
 * DRIVEWAY FIX 2 (same review — leftped-1774-7 "the subject needs to not collide
 * with the building/garage after they enter the driveway and come to a complete
 * stop", rightped-1759-15 "must stop once it's situated in the driveway and not
 * try to go past it", rightped-11170-4 "subject drives into a fence at the end"):
 * a driveway/park destination now carries a TERMINAL STOP — the post-conflict
 * tail is truncated to leave DRIVEWAY_STOP_CLEARANCE_M of drivable run between
 * the subject and the end of the leg (the garage/fence), and `PlannedActor.
 * terminalStop` marks the plan as ENDING there so the draft appends a
 * stationary hold and `extendActorPathsBeyondConflict` never lays a run-out
 * tail past it.
 *
 * Pure math on topology data — no server I/O.
 */
import {
  walkerSpeedMps,
  type WalkerGait,
  type WalkerProfile,
} from "@/app/lib/llm/scenario-generation/walker-profile";
import type { MapTopologyIndex, TopologyGate, TopologyLane, Vec2 } from "@simforge/studio-shared";
import type {
  PlannedActor,
  PlannedCollision,
  PlannedWalker,
} from "@/app/lib/llm/scenario-generation/collision-route-planner";
import {
  arcPositionOnChain,
  buildGatePolyline,
  buildPlannedActorFromTopology,
  polylineEntryHeading,
  polylineLength,
  walkPredecessorsBackward,
} from "./gate-subject-route";
import {
  closestOnPolyline,
  resolveCrossingLine,
  type ProjectedCrosswalk,
  type ProjectedSidewalk,
} from "./pedestrian-crossing-geometry";

// ── Constants ────────────────────────────────────────────────────────────────

/** Lane types a motorised subject may travel on (approach / connecting / exit). */
const DRIVING_LANE_TYPES = new Set(["driving", "bidirectional"]);

/** Walker pace, m/s — matches `pedestrian-crossing-topology-planner`
 *  (WALKER_SPEED_MPS) so the two families' walkers behave identically. */
/** Adult default — see pedestrian-crossing-topology-planner for why a child
 *  profile must re-solve rather than inherit this. */

/** Curb-holds shorter than this are dropped (a degenerate two-vertices-at-t=0
 *  stub confuses the trajectory follower). Mirrors the ped planner's MIN_HOLD_S. */
const MIN_HOLD_S = 0.1;

/** Half-width of the fixed-fallback crossing (m) when no real curb resolves.
 *  Mirrors the ped planner's HALF_WIDTH_M. */
const HALF_WIDTH_M = 4;

// ── Kinematic runway budget (dib 2026-07-24 yield pass) ──────────────────────
// A slow turn covers less ground than the cruise-sized run-up assumes, so it
// needs a SHORTER runway: spawn the subject closer to the junction so the turn — and
// the pedestrian-yield aftermath — happen EARLY enough to finish inside the eval
// clip. See `planTurnPedCrosswalkForSite` for the budget.

/** Eval clip length, sim seconds. The WHOLE maneuver (subject run-up + the slowed
 *  turn through the junction + the ped-yield aftermath) must fit inside it. The
 *  real path passes `clipLenS` from batch-collision-generator's DRAFT_DURATION_S
 *  (the single source of truth); this fallback mirrors that value so the pure
 *  planner is usable standalone (tests). */
const DEFAULT_CLIP_LEN_S = 20;

/** Speed (m/s) the WORKER clamps the subject to over the connecting + exit arc of
 *  the junction (services/carla-worker turn-entry clamp — TURN_ENTRY_SPEED_MPS,
 *  commits 40bcee6a3 / 234fe527a). The planner sizes the run-up assuming the subject
 *  CRUISES the whole route, so its real time to the exit-leg conflict is later
 *  than the planned run-up by the slowdown this clamp imposes. Kept in sync with
 *  the worker const by hand (this module must not import worker code). */
const TURN_ENTRY_SPEED_MPS = 5.0;

/** Comfort deceleration (m/s^2) the subject eases through from cruise down to the
 *  turn-entry clamp speed — the curvature-retiming comfort envelope (~2.0
 *  m/s^2; see batch-collision-generator's TURN_APPROACH_SPEED_CAP_KPH note).
 *  Used only to price the decel ramp into the runway reserve. */
const TURN_ENTRY_DECEL_MPS2 = 2.0;

/** Seconds of visible subject RESUME reserved after the walker clears the subject's
 *  path, so the yield (brake → hold → pull away) actually reads on camera.
 *  Added on top of the walker's crossing duration to form the aftermath
 *  reserve. */
const RESUME_VISIBLE_S = 4;

/** Slack (s) between the end of the modelled maneuver and the clip boundary. */
const CLIP_BUDGET_MARGIN_S = 1;

/** P-3 (rightped-849-1, dib 2026-07-27): minimum metres of REAL approach the
 *  subject route must contain UPSTREAM of the junction. The run-up is measured back
 *  from the EXIT-leg conflict THROUGH the junction, so when the approach lane
 *  is a sliver and the connecting lane is long (Yale gate 849:2: approach
 *  0.4 m, junction connector 55.4 m), a time-sized run-up landed the spawn
 *  INSIDE the connector — PAST the turn arc — and the authored "turn" came out
 *  a straight tail (net heading 0° over 109 waypoints, the reviewed scene).
 *  Enforcing spawn-on-the-approach (or its predecessors) keeps the full turn
 *  arc in the route; the run-up time grows to match when the through-junction
 *  arc alone exceeds the time-sized distance. */
const MIN_APPROACH_RUNUP_M = 8;

/** How far INTO the destination (exit) leg to place the conflict point — the
 *  destination-leg crosswalk sits just past the junction mouth on the exit road.
 *  `resolveCrossingLine` then snaps the actual crossing to any real crosswalk
 *  within CROSSWALK_NEAR_M; this only anchors the conflict onto the subject's exit
 *  path so the walker crosses THROUGH it. Clamped to a fraction of the exit-lane
 *  length so a short exit stub still lands the conflict on the lane. */
const EXIT_SETBACK_M = 4;
const EXIT_SETBACK_MAX_FRACTION = 0.6;

/** An exit leg shorter than this can't host a destination-leg crossing. */
const MIN_EXIT_LEN_M = 3;

/** Destination legs with less total drivable FOOTPRINT than this forward of the
 *  junction (exit lane + forward driving successors, walked THROUGH any junction
 *  connector to the dead-end) are DRIVEWAY-like: a short/dead-end stub
 *  (driveway, parking apron, alley mouth), not a street the ped could cross
 *  further down — the leg ends at a garage door / wall. Unlike the earlier
 *  classifier this does NOT read a junction-touch as proof of a through street:
 *  a driveway whose short throat feeds an apron/turnaround modelled as a
 *  junction still has a small footprint and stays a driveway (see
 *  `exitDrivableRunM` / `isDrivewayExit` for the leftped-1774-7 false-negative
 *  this fixes). A real through leg blows past this cap because its connectors
 *  are long and/or feed onward roads. */
const DRIVEWAY_MAX_RUN_M = 25;

/** A driveway / parking-apron THROAT is a short stub — its own polyline length,
 *  measured before any successor. Own length alone can't separate a driveway
 *  from a short through-street exit SECTION (Belmont's shortest street exit is
 *  7.4 m), so this only gates the width signal below; the footprint signal
 *  (`DRIVEWAY_MAX_RUN_M`) is the primary classifier. */
const DRIVEWAY_STUB_MAX_M = 6;

/** Exit lanes at or below this width read as a driveway / parking-apron throat
 *  rather than a through carriageway (a US residential driveway is ~2.5–3.5 m; a
 *  through lane ~3.5 m+). Consulted only when the topology carries a width
 *  (real maps always do; synthetic/serialised fixtures may omit it — there the
 *  footprint signal decides alone). This is the physical discriminator for the
 *  genuinely-ambiguous "short throat that feeds a junction" tie, where the
 *  footprint of a large lot could otherwise exceed the cap. */
const DRIVEWAY_MAX_WIDTH_M = 3.5;

/** Turn-entry speed (m/s) the worker clamps a DRIVEWAY turn-in to — lower than
 *  the through-junction TURN_ENTRY_SPEED_MPS because a driveway turn is SHARPER
 *  (dib 2026-07-24 review #2, leftped-1774-7 / rightped-1362-0: the shared
 *  5.0 m/s clamp still overshoots into the driveway). Authored onto the subject spec
 *  for driveway sites (planned-to-draft `applyTerminalStop`) and read by the
 *  worker's per-actor turn clamp (`_arm_turn_speed_clamp`, `turn_entry_speed_mps`).
 *  Kept in sync with the worker's `_TURN_CLAMP_MIN_SPEED_MPS` floor by hand. */
export const DRIVEWAY_TURN_ENTRY_SPEED_MPS = 3.0;

/** Accept the shared resolver's crossing for a driveway exit only when it
 *  actually runs across the MOUTH: |cos| between the crossing direction and
 *  the mouth axis (perpendicular to the driveway). The resolver's
 *  sidewalk-line / POI tiers cross spawn→P, which for a conflict INSIDE a
 *  driveway runs ALONG the driveway toward the parcel — the dib US review
 *  failure (peds marching into the garage wall). */
const DRIVEWAY_AXIS_ALIGN_MIN = 0.7;

/** Clamp band (m) for each half-extent of the driveway-mouth crossing. Both
 *  endpoints stay ON the mouth axis, so the walk parallels the main road and
 *  never extends down the driveway into the parcel/building. */
const DRIVEWAY_CROSS_HALF_MIN_M = 1.5;
const DRIVEWAY_CROSS_HALF_MAX_M = 8;

/** A mapped sidewalk within this distance of a probe endpoint snaps the
 *  mouth crossing's half-extent onto the real walkable line. */
const DRIVEWAY_SIDEWALK_SNAP_M = 6;

// ── Driveway Fix 1: sidewalk-to-sidewalk mouth crossing ──────────────────────

/** A sidewalk qualifies as THE mouth crossing when it straddles the driveway
 *  centerline within this band of the (setback) conflict point, measured ALONG
 *  the driveway axis. Wider than EXIT_SETBACK_M in both directions: the
 *  frontage sidewalk normally sits between the junction and the conflict
 *  (negative depth), but an apron modelled a few metres in reads positive. */
const DRIVEWAY_MOUTH_BAND_M = 10;

/** Target half-extent (m) walked ALONG the sidewalk from the crossing point —
 *  wide enough to clear a typical 3-6 m residential driveway, so the ped
 *  genuinely finishes on the OTHER sidewalk. Clamped by the polyline's real
 *  extent, and by the depth-drift guard below. */
const DRIVEWAY_WALK_HALF_M = 4;

/** How far the walk may drift along the DRIVEWAY axis while following the
 *  sidewalk away from the crossing. Beyond this the "sidewalk" is turning up a
 *  front path toward the house — stop the walk short instead of marching the
 *  ped at the building (the leftped-1774-7 wedge). */
const DRIVEWAY_WALK_DEPTH_DRIFT_M = 2.5;

/** Sampling step (m) for the along-sidewalk walk. Deterministic by
 *  construction; 0.25 m is well under the guards it feeds. */
const DRIVEWAY_WALK_STEP_M = 0.25;

/** The sidewalk crossing point must project onto the exit-lane centerline
 *  within this lateral distance (it is built on the straight centerline
 *  extension through the conflict, so a strongly curved stub can diverge) and
 *  the re-anchored conflict must land within this distance of it. */
const DRIVEWAY_REANCHOR_MAX_LATERAL_M = 2.5;
const DRIVEWAY_REANCHOR_MAX_SHIFT_M = 2;

/** Never re-anchor the conflict exactly onto the exit link's start joint (a
 *  zero-length chain slice); keep it at least this far into the leg. */
const DRIVEWAY_MOUTH_MIN_INSET_M = 0.5;

// ── Driveway Fix 2: terminal stop inside the driveway ────────────────────────

/** Drivable run (m) left between the subject's terminal stop and the END of the
 *  destination leg — the garage door / fence / barrier the leg dies at. The
 *  authored point is the vehicle CENTER and an mkz is ~5 m long, so ~2.5 m of
 *  this is the front overhang and the rest is real clearance. */
const DRIVEWAY_STOP_CLEARANCE_M = 4;

/** …but the subject must also be genuinely SITUATED in the driveway. When the leg
 *  is too short to give both, the subject stops at the mouth (at the conflict)
 *  rather than nosing in with no clearance. */
const DRIVEWAY_MIN_PULL_IN_M = 2;

/** Seconds of stationary hold authored at a terminal stop so the pursuit halts
 *  parked (the validated parking-probe pattern — see `parking-spot-planner`). */
const TERMINAL_HOLD_S = 5;

/** Fix E (dib 2026-07-23 review — leftped-1162-3): a STREET-exit crossing
 *  resolved from the spawn→P tiers (sidewalk line / POI) can run OBLIQUELY
 *  through the conflict point — the ped ambles diagonally through the junction
 *  instead of crossing the subject's path at ~90° in front of the vehicle. Accept
 *  the resolved line only while its direction stays within this skew of the
 *  perpendicular crossing axis; beyond it, clamp both endpoints onto the axis
 *  (the driveway-mouth machinery applied to a street). Mapped lines within the
 *  tolerance — every crosswalk-tier result in particular — keep their exact
 *  geometry. */
const STREET_CROSS_MAX_SKEW_DEG = 30;
const STREET_CROSS_ALIGN_MIN = Math.cos((STREET_CROSS_MAX_SKEW_DEG * Math.PI) / 180);

/** P6 v1 — curbside PARK ENDING (dib US review 2026-07-22: "subject pulling into a
 *  parking spot after the maneuver would help with a lot of scenarios" —
 *  rightped-1420-2, 1577-11, leftped-553-0; also shortens the post-maneuver
 *  runway a clip needs, which matters on short junction-dense blocks). When an
 *  annotated Parking lane runs alongside the exit leg, the subject's post-conflict
 *  tail is rerouted to pull into the nearest curbside spot and END there
 *  (parallel park); the pursuit halts naturally at path end. Applies to street
 *  exits only — a driveway exit is already its own "pull in and stop". */
const PARK_MIN_AFTER_M = 10; // spot must be past the turn (subject established on the exit lane)
const PARK_MAX_AFTER_M = 40; // …but within the clip's reach
const PARK_MIN_LATERAL_M = 1.5; // genuinely OFF the driving centerline…
const PARK_MAX_LATERAL_M = 6; // …but adjacent to this exit lane, not another road
const PARK_TAIL_BACKOFF_M = 2; // keep exit-centerline points up to spot-arc minus this

// ── Public types ─────────────────────────────────────────────────────────────

export type TurnDirection = "Left" | "Right";

export interface TurnPedCrosswalkSite {
  gate: TopologyGate;
  turn: TurnDirection;
  /** rsl of the destination (exit) lane the subject turns onto — the crosswalk
   *  crosses this leg. Used by the crossing-line resolver's road-edge fallback so
   *  the far curb comes from the EXIT road, not the approach road. */
  exitLaneRsl: string;
  /** World point on the exit-lane centerline where the subject's turn path crosses
   *  the destination crosswalk (runtime meters). */
  conflictPoint: Vec2;
  /** Arc length from the gate chain start (approach start) to `conflictPoint`. */
  conflictArc: number;
  /** Perpendicular crossing axis (radians) — perpendicular to the EXIT-lane
   *  travel heading at the conflict point. */
  crossingAxisRad: number;
  /** Upstream run-up room (m): approach-lane length + backward predecessor walk. */
  roomM: number;
  /** Junction id (for constraint filtering + diversity anchoring). */
  junctionId: string;
  /** True when the destination leg is an ENTRANCE TURN-IN (< DRIVEWAY_MAX_RUN_M
   *  of drivable run past the junction — a short/dead-end throat). The crossing
   *  is then routed ACROSS the entrance mouth (along the main road's sidewalk),
   *  never down the leg toward the parcel. Field name kept for compatibility;
   *  the honest category name is "entrance turn-in" (operator 2026-07-28: true
   *  residential driveways are not modeled in the current XODRs). */
  drivewayExit: boolean;
  /** The entrance subtype label: "lot" (parking beyond the throat) or "apron"
   *  (parking-free dead-end stub). Null for street exits. */
  entranceKind: EntranceTurnInKind | null;
}

/**
 * Where the subject's authored plan ENDS, when it ends in a deliberate stop rather
 * than a run-out (Fix 2).
 *   - `curbside`: P6 parallel-park ending on a street exit — the subject pulls into
 *     an annotated Parking-lane spot alongside the exit leg.
 *   - `driveway`: the destination IS the stop — the subject pulls into the driveway
 *     / bay and holds, `clearanceM` of drivable run short of the leg's end.
 */
export interface TurnPedParkEnding {
  spot: Vec2;
  alongExitM: number;
  kind: "curbside" | "driveway";
  /** Drivable run (m) left between the stop point and the far obstacle (end of
   *  the destination leg / the abeam parking spot's backoff). */
  clearanceM: number;
}

export interface TurnPedCrosswalkResult {
  collision: PlannedCollision;
  walker: PlannedWalker;
  /** Where the subject finishes the maneuver STOPPED: the P6 curbside spot on a
   *  street exit, or the terminal stop inside a driveway destination (Fix 2).
   *  Null when a street exit has no annotated Parking lane in reach. The
   *  geometry is already baked into the subject's post-conflict tail +
   *  `PlannedActor.terminalStop`; this surfaces it for provenance + CoT. */
  parkEnding: TurnPedParkEnding | null;
}

export interface SelectTurnPedCrosswalkArgs {
  topology: MapTopologyIndex;
  turn: TurnDirection;
  /** Subject speed used to size the minimum required upstream run-up room. */
  subjectSpeedKph: number;
  /** Minimum acceptable seconds of approach run-up (collision-window minimum). */
  minTimeS: number;
  /**
   * ENTRANCE-TURN-IN-focused emit knob (the category the operator originally
   * asked for as "driveway": subject turns into a lot/apron entrance across the
   * crossing ped). When true, the selector returns ONLY entrance sites, so a
   * dedicated emit cell produces a consistent set. Default/false keeps the
   * full mixed street + entrance set. Ranking is unchanged — this is a hard
   * filter, not a re-order.
   */
  entranceOnly?: boolean;
  /** @deprecated alias of `entranceOnly` (the category's old name). */
  drivewayOnly?: boolean;
  /** Optional evidence channels for the entrance LABELER (parking bays/lots →
   *  kind "lot" vs "apron"). Absent → every entrance labels "apron". */
  drivewaySignals?: DrivewayClassificationSignals;
}

export interface PlanTurnPedCrosswalkArgs {
  /** Conflict-walker stature; `child` uses the slower child gait (CPNCO). */
  walkerProfile?: WalkerProfile;
  /** Conflict-walker gait; `run` re-solves the crossing off the catalogue run
   *  speed (Euro NCAP CPNCO-50 wording). Default walk. */
  walkerGait?: WalkerGait;
  topology: MapTopologyIndex;
  subjectSpeedKph: number;
  /** Ideal seconds of approach run-up (upper bound on the floated arrival). */
  idealTimeS: number;
  /** Minimum acceptable seconds of run-up (lower bound). */
  minTimeS: number;
  /** Eval clip length in sim seconds — the kinematic runway cap sizes the subject's
   *  run-up so the slowed turn + the pedestrian-yield aftermath finish inside
   *  it. The generator passes DRAFT_DURATION_S (the single source of truth);
   *  omitted → DEFAULT_CLIP_LEN_S. */
  clipLenS?: number;
  crosswalks?: ProjectedCrosswalk[];
  sidewalks?: ProjectedSidewalk[];
  poiPoints?: Vec2[];
  /** Annotated Parking lanes (runtime-meter polylines) — enables the P6 curbside
   *  park ending when one runs along the exit leg. Structural subset of
   *  ParkingLaneRef so the generator can pass its list straight through. */
  parkingLanes?: ReadonlyArray<{ points: ReadonlyArray<Vec2> }>;
}

// ── Site selection ─────────────────────────────────────────────────────────────

/**
 * Enumerate viable turn-across-crosswalk sites for one turn direction: every
 * `Left` (or `Right`) gate whose approach/connecting/exit chain resolves, that
 * has a real destination (exit) leg, and enough upstream room for the subject run-up.
 * The conflict is anchored a few metres into the exit leg (the destination-leg
 * crosswalk) and the crossing axis is perpendicular to the exit-lane heading.
 *
 * Guards mirror `selectPedestrianCrossingSite` (lane guard, polyline guard, room
 * guard) but for a TURN gate + an EXIT-leg conflict.
 */
export function selectTurnPedCrosswalkSites(
  a: SelectTurnPedCrosswalkArgs,
): { sites: TurnPedCrosswalkSite[] } {
  const { topology, turn, subjectSpeedKph, minTimeS, drivewaySignals } = a;
  const entranceOnly = a.entranceOnly ?? a.drivewayOnly ?? false;
  const minRoomM = (subjectSpeedKph * minTimeS) / 3.6;
  const sites: TurnPedCrosswalkSite[] = [];

  for (const gate of topology.gates) {
    if (gate.turnRelation !== turn) continue;

    // Lane guard: the approach + connecting lanes must be motorised. (The exit
    // lane's drivability is enforced inside buildGatePolyline, which skips
    // biking/sidewalk exits.)
    const approach = topology.lanes[gate.approachLaneRsl];
    const connecting = topology.lanes[gate.connectingLaneRsl];
    if (!approach || !connecting) continue;
    if (
      !DRIVING_LANE_TYPES.has(approach.laneType) ||
      !DRIVING_LANE_TYPES.has(connecting.laneType)
    ) {
      continue;
    }

    // Polyline guard + require the destination exit leg (chain[2]).
    const built = buildGatePolyline(topology, gate);
    if (!built || built.chain.length < 3) continue;
    const approachLink = built.chain[0]!;
    const connLink = built.chain[1]!;
    const exitLink = built.chain[built.chain.length - 1]!;
    const approachLen = polylineLength(approachLink.oriented);
    const connLen = polylineLength(connLink.oriented);
    const exitLen = polylineLength(exitLink.oriented);
    if (exitLen < MIN_EXIT_LEN_M) continue;

    // Conflict a few metres into the exit leg (the destination-leg crosswalk).
    const conflictArc =
      approachLen + connLen + Math.min(EXIT_SETBACK_M, exitLen * EXIT_SETBACK_MAX_FRACTION);
    const pos = arcPositionOnChain(built.chain, conflictArc);
    if (!pos) continue;
    const crossingAxisRad = pos.yawRad + Math.PI / 2;

    // Room guard: approach length + backward predecessor walk (the subject run-up).
    const approachStart = approachLink.oriented[0];
    if (!approachStart) continue;
    const approachEntryHdg =
      approachLink.oriented.length >= 2 ? polylineEntryHeading(approachLink.oriented) : null;
    const { totalLen: walkLen } = walkPredecessorsBackward(
      topology,
      gate.approachLaneRsl,
      approachStart,
      approachEntryHdg,
      minRoomM,
    );
    const roomM = approachLen + walkLen;
    if (roomM < minRoomM) continue;

    const entranceClass = classifyEntranceExit(topology, exitLink.rsl, drivewaySignals);
    const drivewayExit = entranceClass.entrance;
    // Driveway-focused emit: skip non-driveway sites entirely (dib 2026-07-24 —
    // "ped collision avoidance at driveway: separate category").
    if (entranceOnly && !drivewayExit) continue;

    sites.push({
      gate,
      turn,
      exitLaneRsl: exitLink.rsl,
      conflictPoint: { x: pos.point.x, y: pos.point.y },
      conflictArc,
      crossingAxisRad,
      roomM,
      junctionId: gate.junctionId,
      drivewayExit,
      entranceKind: entranceClass.kind,
    });
  }

  return { sites };
}

// ── Driveway destinations ──────────────────────────────────────────────────────

/**
 * Total drivable FOOTPRINT (m) forward of the junction along the destination
 * leg: the exit lane's own length plus every forward driving successor, walked
 * THROUGH any junction-internal connector, accumulating until a dead-end or the
 * `DRIVEWAY_MAX_RUN_M` cap.
 *
 * The fix (dib 2026-07-24, leftped-1774-7): the previous version returned the
 * cap the moment the walk reached a junction-internal successor — reading a
 * junction-touch as proof of a through street. But a real driveway whose short
 * throat feeds an apron / turnaround MODELLED AS A JUNCTION has exactly that
 * signature, so it was misclassified as a street and none of the driveway
 * machinery fired (peds off the sidewalk, subject overshoot, subject into the garage).
 * Walking THROUGH the junction and measuring the actual extent instead: a
 * driveway's footprint stays small (it dead-ends at the garage / parcel) while
 * a real through leg blows past the cap (long connectors and/or onward roads).
 * A dead-end stops the walk, so a plain driveway measures just its own metres.
 * The `visited` set + the cap bound the walk on looping road networks.
 */
/** The exit-leg walk with its terminus: total drivable metres forward of the
 *  junction (capped at DRIVEWAY_MAX_RUN_M) plus the DEAD-END point the walk
 *  stopped at — the far end of the last lane it consumed (where the driveway
 *  dies at the garage / where a lot's aisles begin). */
function exitDrivableRun(
  topology: MapTopologyIndex,
  exitRsl: string,
): { totalM: number; deadEnd: Vec2 | null } {
  let total = 0;
  const visited = new Set<string>();
  let currentRsl: string | undefined = exitRsl;
  let deadEnd: Vec2 | null = null;
  let prevEnd: Vec2 | null = null;
  while (currentRsl && total < DRIVEWAY_MAX_RUN_M) {
    if (visited.has(currentRsl)) break;
    visited.add(currentRsl);
    const lane: TopologyLane | undefined = topology.lanes[currentRsl];
    if (!lane || lane.polyline.length < 2) break;
    total += polylineLength(lane.polyline);
    // The lane's FAR endpoint (away from where the walk entered it).
    const a = lane.polyline[0]!;
    const b = lane.polyline[lane.polyline.length - 1]!;
    const far: Vec2 = prevEnd
      ? Math.hypot(a.x - prevEnd.x, a.y - prevEnd.y) > Math.hypot(b.x - prevEnd.x, b.y - prevEnd.y)
        ? a
        : b
      : b;
    deadEnd = { x: far.x, y: far.y };
    prevEnd = deadEnd;
    currentRsl = lane.successors.find((rsl: string) => {
      if (visited.has(rsl)) return false;
      const succ = topology.lanes[rsl];
      if (!succ || succ.polyline.length < 2) return false;
      // Match buildGatePolyline's convention: an absent/empty laneType
      // (synthetic fixtures) counts as drivable; real topology lanes always
      // carry the XODR type. Junction-internal connectors are driving lanes and
      // are walked through — the whole point of the fix.
      const laneType = (succ.laneType || "").toLowerCase();
      return !laneType || DRIVING_LANE_TYPES.has(laneType);
    });
  }
  return { totalM: total, deadEnd };
}

/** A TWO-WAY exit road whose combined DRIVING carriageway exceeds this reads as
 *  a multi-lane street trim, never a driveway throat. Census on the real maps
 *  (2026-07-27, drivewayOnly zero-yield): genuine two-way throats measure
 *  4.7–7.2 m of total driving width (one modest lane each way — you drive into
 *  a driveway AND back out, so maps legitimately model throats two-way); the
 *  one street-trim false positive (Belmont 1770, a map-edge 4-lane cut)
 *  measures 13.3 m. Lanes without an authored width count as a nominal lane. */
const DRIVEWAY_TWO_WAY_CARRIAGEWAY_MAX_M = 8;
const NOMINAL_LANE_WIDTH_M = 3.5;

// ── ENTRANCE TURN-IN classification signals (operator re-scope 2026-07-28) ───
// Operator finding: TRUE residential driveways do not exist as drivable lane
// stubs in the current XODRs at all (and the Overture "driveway" labels on
// these maps are not residential either — the semantic channel is a confirmed
// dead end). What the maps DO model are lot/apron ENTRANCES — short throats
// off a street. The category is therefore named honestly: "entrance turn-in",
// with parking evidence as a LABELER (not a rejector):
//   - entrance whose dead-end feeds ParkingSpace bays / a curated lot polygon
//     → kind "lot" (a parking-lot entrance — a VALID scene: subject turns in past
//     the crossing ped, e.g. the reviewed yale rightped-803);
//   - tiny dead-end stub with no parking beyond → kind "apron".

/** Parking evidence within this distance of the exit's DEAD-END labels the
 *  entrance a LOT entrance. Census: lot entrances measure 2.8–13.6 m bay
 *  distance; parking-free aprons measure 131–220 m. */
const ENTRANCE_LOT_BAY_NEAR_M = 25;

/** The entrance subtype: a parking-lot entrance vs a parking-free apron. */
export type EntranceTurnInKind = "lot" | "apron";

export interface DrivewayClassificationSignals {
  /** RoadRunner ParkingSpace bay centroids (runtime meters). */
  parkingSpacePoints?: ReadonlyArray<Vec2>;
  /** Curated combined parking-lot polygons (regions.parkingLots). */
  parkingLots?: ReadonlyArray<{ polygon: ReadonlyArray<Vec2> }>;
}

/** Distance from a point to a polygon ring (0 when inside). */
function distToRing(p: Vec2, ring: ReadonlyArray<Vec2>): number {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const a = ring[i]!;
    const b = ring[j]!;
    if (
      a.y > p.y !== b.y > p.y &&
      p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y || 1e-12) + a.x
    ) {
      inside = !inside;
    }
  }
  if (inside) return 0;
  let best = Infinity;
  for (let i = 0; i < ring.length; i++) {
    const a = ring[i]!;
    const b = ring[(i + 1) % ring.length]!;
    const vx = b.x - a.x;
    const vy = b.y - a.y;
    const l2 = vx * vx + vy * vy;
    const t = l2 > 1e-12 ? Math.max(0, Math.min(1, ((p.x - a.x) * vx + (p.y - a.y) * vy) / l2)) : 0;
    best = Math.min(best, Math.hypot(a.x + vx * t - p.x, a.y + vy * t - p.y));
  }
  return best;
}

/** PARKING evidence at the stub's dead-end: RoadRunner bays or a curated lot
 *  polygon within ENTRANCE_LOT_BAY_NEAR_M — labels the entrance a LOT entrance
 *  (parking beyond the throat). */
function stubFeedsParking(
  deadEnd: Vec2 | null,
  signals: DrivewayClassificationSignals | undefined,
): boolean {
  if (!deadEnd || !signals) return false;
  for (const bay of signals.parkingSpacePoints ?? []) {
    if (Math.hypot(bay.x - deadEnd.x, bay.y - deadEnd.y) <= ENTRANCE_LOT_BAY_NEAR_M) {
      return true;
    }
  }
  for (const lot of signals.parkingLots ?? []) {
    if (lot.polygon.length >= 3 && distToRing(deadEnd, lot.polygon) <= ENTRANCE_LOT_BAY_NEAR_M) {
      return true;
    }
  }
  return false;
}

/** Total DRIVING-lane width (m) across the exit lane's road, both directions. */
function exitRoadDrivingCarriagewayM(
  topology: MapTopologyIndex,
  exitLane: TopologyLane,
): number {
  let total = 0;
  for (const other of Object.values(topology.lanes)) {
    if (other.roadId === exitLane.roadId && other.laneType === "driving") {
      total += other.representativeWidthM ?? NOMINAL_LANE_WIDTH_M;
    }
  }
  return total;
}

/**
 * Classify the destination (exit) leg as an ENTRANCE TURN-IN vs a through
 * street, and — when it is an entrance — LABEL its subtype.
 *
 * Category naming (operator re-scope 2026-07-28): true residential driveways
 * do not exist as drivable stubs in the current XODRs, so what this machinery
 * actually finds are lot/apron ENTRANCES — both VALID scene classes. Parking
 * evidence is a LABELER, not a rejector: kind "lot" (parking beyond the
 * throat, e.g. the reviewed yale rightped-803 small lot) vs "apron" (tiny
 * dead-end stub, no parking).
 *
 * ENTRANCE geometry (unchanged from the driveway classifier):
 *  - PRIMARY signal (dib 2026-07-24, leftped-1774-7): the leg's total drivable
 *    FOOTPRINT forward of the junction (walked THROUGH any junction connector
 *    to the dead-end) is short. A through street's footprint exceeds the cap.
 *  - SUPPLEMENTARY: a short NARROW stub feeding a LARGE lot (footprint over
 *    the cap) reads as a throat by physical dimension.
 *  - ONCOMING-LANE scoping (C-2 refined 2026-07-27): entrances are legitimately
 *    modeled two-way (in and back out) — vetoed only when the road reads as a
 *    street (the width/stub tier unconditionally; the footprint tier when the
 *    combined carriageway exceeds the multi-lane street-trim signature).
 */
function classifyEntranceExit(
  topology: MapTopologyIndex,
  exitRsl: string,
  signals?: DrivewayClassificationSignals,
): { entrance: boolean; kind: EntranceTurnInKind | null } {
  const exitLane = topology.lanes[exitRsl];
  const twoWay =
    exitLane != null && exitRoadHasOncomingDrivingLane(topology, exitLane);
  const run = exitDrivableRun(topology, exitRsl);
  const entrance = ((): boolean => {
    if (run.totalM < DRIVEWAY_MAX_RUN_M) {
      if (!twoWay) return true;
      return (
        exitLane != null &&
        exitRoadDrivingCarriagewayM(topology, exitLane) <=
          DRIVEWAY_TWO_WAY_CARRIAGEWAY_MAX_M
      );
    }
    if (!exitLane || twoWay) return false;
    const widthM = exitLane.representativeWidthM;
    if (widthM != null && widthM <= DRIVEWAY_MAX_WIDTH_M) {
      return polylineLength(exitLane.polyline) < DRIVEWAY_STUB_MAX_M;
    }
    return false;
  })();
  if (!entrance) return { entrance: false, kind: null };
  return {
    entrance: true,
    kind: stubFeedsParking(run.deadEnd, signals) ? "lot" : "apron",
  };
}

function exitRoadHasOncomingDrivingLane(
  topology: MapTopologyIndex,
  exitLane: TopologyLane,
): boolean {
  for (const other of Object.values(topology.lanes)) {
    if (
      other.roadId === exitLane.roadId &&
      other.laneType === "driving" &&
      Math.sign(other.laneId) !== Math.sign(exitLane.laneId)
    ) {
      return true;
    }
  }
  return false;
}

interface MouthCrossing {
  start: Vec2;
  end: Vec2;
  source: string;
  /**
   * Fix 1: the point ON the walk that must coincide with the subject's conflict —
   * where the mapped sidewalk crosses the driveway centerline. Present only for
   * the sidewalk-to-sidewalk tier, whose endpoints follow the (possibly curved)
   * sidewalk and so are NOT collinear with the conflict point. The planner
   * re-anchors the conflict onto it and authors it as an explicit via waypoint,
   * so the meet-at-conflict solve stays exact. Absent for the axis-clamped
   * tiers, whose endpoints are collinear through the conflict by construction.
   */
  viaPoint?: Vec2;
}

/** |cos| between the from→to direction and the axis unit `u` (1 = on the
 *  crossing axis, 0 = fully along the road). Degenerate lines → 0. */
function axisAlignment(u: Vec2, from: Vec2, to: Vec2): number {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const len = Math.hypot(dx, dy);
  return len > 1e-6 ? Math.abs((dx * u.x + dy * u.y) / len) : 0;
}

/**
 * Fix E: clamp an OBLIQUE street-exit crossing onto the perpendicular axis
 * through the conflict point — the driveway-mouth treatment applied to a
 * street. Each resolved endpoint is projected onto the axis (killing its
 * along-road component), its half-extent clamped into the walkable band, and
 * snapped onto the mapped sidewalk where one runs near that side's axis point.
 * The endpoints are forced onto OPPOSITE sides of the subject's path so the walk
 * still crosses THROUGH the conflict point (the meet-at-P timing solver is
 * unchanged — the clamped start stays collinear with start→P→end).
 */
function clampStreetCrossingOntoAxis(
  site: TurnPedCrosswalkSite,
  a: PlanTurnPedCrosswalkArgs,
  resolved: { spawn: Vec2; far: Vec2 },
): { start: Vec2; end: Vec2 } {
  const P = site.conflictPoint;
  const u: Vec2 = { x: Math.cos(site.crossingAxisRad), y: Math.sin(site.crossingAxisRad) };
  const tSpawn = (resolved.spawn.x - P.x) * u.x + (resolved.spawn.y - P.y) * u.y;
  const tFar = (resolved.far.x - P.x) * u.x + (resolved.far.y - P.y) * u.y;
  const spawnSign: 1 | -1 = Math.abs(tSpawn) < 1e-6 ? -1 : tSpawn > 0 ? 1 : -1;
  let farSign: 1 | -1 = Math.abs(tFar) < 1e-6 ? 1 : tFar > 0 ? 1 : -1;
  if (farSign === spawnSign) farSign = spawnSign > 0 ? -1 : 1; // must CROSS the path

  const endpoint = (t: number, sign: 1 | -1): Vec2 => {
    const clampMag = (m: number): number =>
      Math.min(DRIVEWAY_CROSS_HALF_MAX_M, Math.max(DRIVEWAY_CROSS_HALF_MIN_M, m));
    // Street floor = HALF_WIDTH_M (the fixed-fallback half-span), NOT the
    // driveway-mouth minimum: an almost-parallel resolved line projects to a
    // tiny |t|, and a 1.5 m endpoint sits ON the exit carriageway — the road
    // snap then rejects the whole site (observed: the belmont 1433
    // driveway-entrance sites vanished from the batch). The sidewalk snap
    // below may still pull the extent inward onto the real curb line.
    const baseMag = Math.min(DRIVEWAY_CROSS_HALF_MAX_M, Math.max(HALF_WIDTH_M, Math.abs(t)));
    // Snap the half-extent onto the real walkable line where the sidewalk is
    // mapped near this side's axis point (nearest sidewalk wins).
    const probe: Vec2 = { x: P.x + u.x * sign * baseMag, y: P.y + u.y * sign * baseMag };
    let best: { dist: number; mag: number } | null = null;
    for (const sw of a.sidewalks ?? []) {
      const near = closestOnPolyline(sw.polyline, probe);
      if (!near || near.dist > DRIVEWAY_SIDEWALK_SNAP_M) continue;
      const tSw = (near.point.x - P.x) * u.x + (near.point.y - P.y) * u.y;
      if ((sign > 0) !== (tSw > 0)) continue;
      if (!best || near.dist < best.dist) {
        best = { dist: near.dist, mag: clampMag(Math.abs(tSw)) };
      }
    }
    const mag = best ? clampMag(best.mag) : baseMag;
    return { x: P.x + u.x * sign * mag, y: P.y + u.y * sign * mag };
  };
  return { start: endpoint(tSpawn, spawnSign), end: endpoint(tFar, farSign) };
}

/**
 * Walk `maxArcM` along `poly` from the point (segIdx, tWithin), in vertex order
 * (`dir = 1`) or against it (`dir = -1`), stopping early at the last sample the
 * `accept` guard still allows. Returns the farthest accepted point, or null when
 * even the first sample fails. Sampling is a fixed step, so the result is
 * deterministic.
 */
function walkAlongPolylineFrom(
  poly: ReadonlyArray<Vec2>,
  segIdx: number,
  tWithin: number,
  dir: 1 | -1,
  maxArcM: number,
  accept: (p: Vec2) => boolean,
): Vec2 | null {
  const a0 = poly[segIdx];
  const b0 = poly[segIdx + 1];
  if (!a0 || !b0) return null;
  let prev: Vec2 = {
    x: a0.x + (b0.x - a0.x) * tWithin,
    y: a0.y + (b0.y - a0.y) * tWithin,
  };
  const verts: Vec2[] = [];
  if (dir === 1) {
    for (let i = segIdx + 1; i < poly.length; i++) verts.push(poly[i]!);
  } else {
    for (let i = segIdx; i >= 0; i--) verts.push(poly[i]!);
  }
  let arc = 0;
  let best: Vec2 | null = null;
  for (const v of verts) {
    const segLen = Math.hypot(v.x - prev.x, v.y - prev.y);
    if (segLen < 1e-9) continue;
    const usable = Math.min(segLen, maxArcM - arc);
    const steps = Math.max(1, Math.ceil(usable / DRIVEWAY_WALK_STEP_M));
    for (let s = 1; s <= steps; s++) {
      const f = ((usable * s) / steps) / segLen;
      const p: Vec2 = { x: prev.x + (v.x - prev.x) * f, y: prev.y + (v.y - prev.y) * f };
      if (!accept(p)) return best;
      best = p;
    }
    arc += usable;
    if (arc >= maxArcM - 1e-9) return best;
    prev = v;
  }
  return best;
}

/**
 * Fix 1 — the SIDEWALK-to-SIDEWALK driveway-mouth crossing.
 *
 * Find the mapped sidewalk polyline that actually STRADDLES the driveway
 * centerline near the mouth, take the point where it crosses that centerline,
 * and walk both endpoints ALONG the polyline from there. So:
 *   - both endpoints sit ON the real sidewalk (not on a house-ward offset of
 *     the mouth axis through the setback conflict point — the leftped-1774-7
 *     "closer to the house … get stuck at the end of the maneuver" defect),
 *   - they land on OPPOSITE sides of the driveway, so the walk is genuinely
 *     "across the driveway to the other sidewalk", and
 *   - the walk never dives toward the building: the depth-drift guard stops it
 *     the moment the mapped line turns up a front path.
 * The crossing point is returned so the caller re-anchors the subject's conflict
 * onto the sidewalk — the subject then stops where a driver really stops.
 *
 * Returns null when no mapped sidewalk qualifies (the axis-clamped mouth
 * crossing below remains the fallback).
 */
function resolveDrivewaySidewalkCrossing(
  site: TurnPedCrosswalkSite,
  sidewalks: ReadonlyArray<ProjectedSidewalk> | undefined,
): MouthCrossing | null {
  if (!sidewalks || sidewalks.length === 0) return null;
  const P = site.conflictPoint;
  // Mouth axis (across the driveway) and the driveway travel axis (into the
  // parcel) — the crossing axis is the exit heading rotated +90°.
  const u: Vec2 = { x: Math.cos(site.crossingAxisRad), y: Math.sin(site.crossingAxisRad) };
  const d: Vec2 = { x: u.y, y: -u.x };
  const lat = (p: Vec2): number => (p.x - P.x) * u.x + (p.y - P.y) * u.y;
  const depth = (p: Vec2): number => (p.x - P.x) * d.x + (p.y - P.y) * d.y;

  let best: { poly: ReadonlyArray<Vec2>; segIdx: number; t: number; cross: Vec2; score: number } | null =
    null;
  for (const sw of sidewalks) {
    const poly = sw.polyline;
    for (let i = 0; i + 1 < poly.length; i++) {
      const a = poly[i]!;
      const b = poly[i + 1]!;
      const la = lat(a);
      const lb = lat(b);
      // Must cross the driveway centerline within this segment.
      if (la === lb || (la > 0) === (lb > 0)) continue;
      const t = la / (la - lb);
      const cross: Vec2 = { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t };
      const h = depth(cross);
      if (Math.abs(h) > DRIVEWAY_MOUTH_BAND_M) continue; // not at the MOUTH
      const segLen = Math.hypot(b.x - a.x, b.y - a.y);
      if (segLen < 1e-6) continue;
      // …and must run ACROSS the mouth here, not along the driveway.
      const align = Math.abs(((b.x - a.x) * u.x + (b.y - a.y) * u.y) / segLen);
      if (align < DRIVEWAY_AXIS_ALIGN_MIN) continue;
      // Nearest-to-the-mouth wins (deterministic; a second frontage sidewalk
      // further down the parcel never steals the crossing).
      if (!best || Math.abs(h) < best.score) {
        best = { poly, segIdx: i, t, cross, score: Math.abs(h) };
      }
    }
  }
  if (!best) return null;

  const crossDepth = depth(best.cross);
  const onSidewalk = (p: Vec2): boolean =>
    Math.abs(depth(p) - crossDepth) <= DRIVEWAY_WALK_DEPTH_DRIFT_M;
  const back = walkAlongPolylineFrom(
    best.poly,
    best.segIdx,
    best.t,
    -1,
    DRIVEWAY_WALK_HALF_M,
    onSidewalk,
  );
  const fwd = walkAlongPolylineFrom(
    best.poly,
    best.segIdx,
    best.t,
    1,
    DRIVEWAY_WALK_HALF_M,
    onSidewalk,
  );
  if (!back || !fwd) return null;
  // Both endpoints must clear the subject's driveway path, on OPPOSITE sides of it
  // (otherwise the "crossing" never crosses).
  const latBack = lat(back);
  const latFwd = lat(fwd);
  if (Math.abs(latBack) < DRIVEWAY_CROSS_HALF_MIN_M) return null;
  if (Math.abs(latFwd) < DRIVEWAY_CROSS_HALF_MIN_M) return null;
  if ((latBack > 0) === (latFwd > 0)) return null;
  // Deterministic ordering: the negative-side endpoint spawns (matches the
  // axis-clamped tiers' `orient()` default).
  const start = latBack < 0 ? back : fwd;
  const end = latBack < 0 ? fwd : back;
  return { start, end, source: "driveway_sidewalk", viaPoint: best.cross };
}

/**
 * Fix 1 — re-anchor the conflict onto the point where the mouth sidewalk
 * crosses the subject's driveway path, so the subject stops AT the sidewalk (where a
 * driver really stops) instead of a fixed EXIT_SETBACK_M inside the parcel.
 * Returns a site clone with the conflict point / arc / crossing axis moved onto
 * the exit-lane centerline at that station, or null when the crossing doesn't
 * project cleanly onto the leg (strongly curved stub, or a crossing so far
 * outside the leg that the clamp would drag the ped off the sidewalk).
 */
function reanchorConflictOntoMouth(
  site: TurnPedCrosswalkSite,
  chain: ReadonlyArray<{ rsl: string; oriented: Vec2[] }>,
  crossPoint: Vec2,
): TurnPedCrosswalkSite | null {
  const exitLink = chain[chain.length - 1];
  if (!exitLink) return null;
  const proj = projectOntoPolyline(exitLink.oriented, crossPoint);
  if (!proj || proj.lateralM > DRIVEWAY_REANCHOR_MAX_LATERAL_M) return null;
  let arcBefore = 0;
  for (let i = 0; i < chain.length - 1; i++) {
    arcBefore += polylineLength(chain[i]!.oriented);
  }
  const exitLen = polylineLength(exitLink.oriented);
  const maxWithin = Math.max(DRIVEWAY_MOUTH_MIN_INSET_M, exitLen - DRIVEWAY_MOUTH_MIN_INSET_M);
  const within = Math.min(Math.max(proj.arcM, DRIVEWAY_MOUTH_MIN_INSET_M), maxWithin);
  const newArc = arcBefore + within;
  const pos = arcPositionOnChain(chain, newArc);
  if (!pos) return null;
  if (Math.hypot(pos.point.x - crossPoint.x, pos.point.y - crossPoint.y) > DRIVEWAY_REANCHOR_MAX_SHIFT_M) {
    return null;
  }
  return {
    ...site,
    conflictPoint: { x: pos.point.x, y: pos.point.y },
    conflictArc: newArc,
    crossingAxisRad: pos.yawRad + Math.PI / 2,
  };
}

/**
 * Crossing line for a DRIVEWAY-like destination: the ped walks the MAIN road's
 * sidewalk ACROSS the driveway mouth — perpendicular to the driveway axis —
 * never down the driveway toward the garage/parcel (dib US crosswalk-turn CoT
 * review 2026-07-22: leftped-1433-6/7, rightped-1321-10, rightped-1433-5 and
 * rightped-1774-13 marched the conflict peds into the garage wall, and
 * rightped-1321-12's ped kept pushing against it instead of stopping).
 *
 * Both endpoints sit ON the mouth axis through the conflict point, so:
 *   - the crossing stays collinear through P (the meet-at-P timing solver is
 *     unchanged), and
 *   - neither endpoint can acquire an along-driveway component — the crossing
 *     polyline ENDS at a reachable curb-side point, never inside the parcel.
 */
function resolveDrivewayMouthCrossing(
  site: TurnPedCrosswalkSite,
  a: PlanTurnPedCrosswalkArgs,
): MouthCrossing {
  const P = site.conflictPoint;
  const u: Vec2 = { x: Math.cos(site.crossingAxisRad), y: Math.sin(site.crossingAxisRad) };

  // The shared resolver's crosswalk / topology-lane / road-edge tiers already
  // place both curbs ALONG the crossing axis — accept those (clamped onto the
  // axis). Its sidewalk-line / POI tiers cross spawn→P instead, which for a
  // driveway conflict runs ALONG the driveway; reject anything misaligned with
  // the mouth and rebuild on the axis below.
  const resolved = resolveCrossingLine({
    topology: a.topology,
    conflictPoint: P,
    approachLaneRsl: site.exitLaneRsl,
    crossingAxisRad: site.crossingAxisRad,
    crosswalks: a.crosswalks,
    sidewalks: a.sidewalks,
    poiPoints: a.poiPoints,
  });
  if (resolved) {
    if (axisAlignment(u, resolved.spawn, resolved.far) >= DRIVEWAY_AXIS_ALIGN_MIN) {
      // Project each endpoint onto the mouth axis (killing any into-the-parcel
      // component) and clamp its half-extent to a plausible walkable span.
      const onAxis = (p: Vec2, fallbackSign: 1 | -1): Vec2 => {
        const t = (p.x - P.x) * u.x + (p.y - P.y) * u.y;
        const sign = Math.abs(t) < 1e-6 ? fallbackSign : t > 0 ? 1 : -1;
        const mag = Math.min(
          DRIVEWAY_CROSS_HALF_MAX_M,
          Math.max(DRIVEWAY_CROSS_HALF_MIN_M, Math.abs(t)),
        );
        return { x: P.x + u.x * sign * mag, y: P.y + u.y * sign * mag };
      };
      return {
        start: onAxis(resolved.spawn, -1),
        end: onAxis(resolved.far, 1),
        source: `${resolved.source}_mouth`,
      };
    }
  }

  // Axis-aligned crossing about the mouth. When the main road's sidewalk is
  // mapped near an endpoint probe, snap that half-extent onto the real walkable
  // line; otherwise stay symmetric at HALF_WIDTH_M.
  const halfExtent = (side: 1 | -1): number => {
    const probe: Vec2 = {
      x: P.x + u.x * side * HALF_WIDTH_M,
      y: P.y + u.y * side * HALF_WIDTH_M,
    };
    let best: number | null = null;
    for (const sw of a.sidewalks ?? []) {
      const near = closestOnPolyline(sw.polyline, probe);
      if (!near || near.dist > DRIVEWAY_SIDEWALK_SNAP_M) continue;
      const t = (near.point.x - P.x) * u.x + (near.point.y - P.y) * u.y;
      if ((side > 0) !== (t > 0)) continue;
      const mag = Math.min(
        DRIVEWAY_CROSS_HALF_MAX_M,
        Math.max(DRIVEWAY_CROSS_HALF_MIN_M, Math.abs(t)),
      );
      // Prefer the extent nearest the default span (deterministic; keeps a
      // parallel sidewalk far down the block from dragging the endpoint out).
      if (best === null || Math.abs(mag - HALF_WIDTH_M) < Math.abs(best - HALF_WIDTH_M)) {
        best = mag;
      }
    }
    return best ?? HALF_WIDTH_M;
  };
  const negM = halfExtent(-1);
  const posM = halfExtent(1);
  return {
    start: { x: P.x - u.x * negM, y: P.y - u.y * negM },
    end: { x: P.x + u.x * posM, y: P.y + u.y * posM },
    source: "driveway_mouth",
  };
}

// ── Per-site planning ──────────────────────────────────────────────────────────

/**
 * Build a deterministic turn-across-crosswalk plan for ONE selected site.
 *
 * Routes the subject through the turn gate ending at the exit-leg conflict (the run-up
 * time floats in `[minTimeS, idealTimeS]` on the available room, at full speed),
 * then synthesises a perpendicular walker crossing the DESTINATION leg, timed so
 * it reaches the conflict point at the subject's ETA. Returns null when the subject route
 * can't be back-walked.
 */
/** Arc-length projection of a point onto a polyline: (arc_m, lateral_m). */
function projectOntoPolyline(
  polyline: ReadonlyArray<Vec2>,
  p: Vec2,
): { arcM: number; lateralM: number } | null {
  let best: { arcM: number; lateralM: number } | null = null;
  let cum = 0;
  for (let i = 0; i < polyline.length - 1; i++) {
    const a = polyline[i]!;
    const b = polyline[i + 1]!;
    const vx = b.x - a.x;
    const vy = b.y - a.y;
    const len = Math.hypot(vx, vy);
    if (len < 1e-6) continue;
    const t = Math.max(0, Math.min(1, ((p.x - a.x) * vx + (p.y - a.y) * vy) / (len * len)));
    const qx = a.x + vx * t;
    const qy = a.y + vy * t;
    const d = Math.hypot(p.x - qx, p.y - qy);
    if (!best || d < best.lateralM) best = { arcM: cum + len * t, lateralM: d };
    cum += len;
  }
  return best;
}

/**
 * P6 v1: find a curbside parking spot along the exit leg and reroute the subject's
 * post-conflict tail to pull in and END there. Returns the rebuilt subject (tail
 * truncated at the spot's abeam arc + the spot appended) and the spot, or null
 * when no parking lane offers a point in the accept band.
 */
function resolveCurbsideParkEnding(
  subject: PlannedActor,
  site: TurnPedCrosswalkSite,
  parkingLanes: ReadonlyArray<{ points: ReadonlyArray<Vec2> }>,
): { subject: PlannedActor; spot: Vec2; alongExitM: number } | null {
  const tail = subject.postConflictWaypoints;
  if (!tail || tail.length < 1) return null;
  // Exit reference polyline: conflict point + the authored exit-lane tail.
  const exitLine: Vec2[] = [site.conflictPoint, ...tail];
  let bestSpot: { spot: Vec2; arcM: number } | null = null;
  for (const lane of parkingLanes) {
    for (const p of lane.points) {
      const proj = projectOntoPolyline(exitLine, p);
      if (!proj) continue;
      if (proj.arcM < PARK_MIN_AFTER_M || proj.arcM > PARK_MAX_AFTER_M) continue;
      if (proj.lateralM < PARK_MIN_LATERAL_M || proj.lateralM > PARK_MAX_LATERAL_M) continue;
      if (!bestSpot || proj.arcM < bestSpot.arcM) bestSpot = { spot: { x: p.x, y: p.y }, arcM: proj.arcM };
    }
  }
  if (!bestSpot) return null;
  // Truncate the exit tail just short of the spot's abeam arc, then pull in.
  const kept: Vec2[] = [];
  let cum = 0;
  for (let i = 1; i < exitLine.length; i++) {
    cum += Math.hypot(exitLine[i]!.x - exitLine[i - 1]!.x, exitLine[i]!.y - exitLine[i - 1]!.y);
    if (cum > bestSpot.arcM - PARK_TAIL_BACKOFF_M) break;
    kept.push(exitLine[i]!);
  }
  kept.push(bestSpot.spot);
  return {
    subject: {
      ...subject,
      postConflictWaypoints: kept,
      // Fix 2: the plan ENDS parked. Without this the draft's run-out
      // extension laid 40 m of lane past the bay and the subject drove back out of
      // the lot into whatever was ahead (dib 2026-07-23, rightped-11170-4:
      // "subject drives into a fence at the end — if it just stopped in the parking
      // lot it would've been 4-5 star").
      terminalStop: {
        point: { x: bestSpot.spot.x, y: bestSpot.spot.y },
        holdS: TERMINAL_HOLD_S,
        clearanceM: PARK_TAIL_BACKOFF_M,
        reason: "curbside_park",
      },
    },
    spot: bestSpot.spot,
    alongExitM: bestSpot.arcM,
  };
}

/**
 * Fix 2 — the DRIVEWAY ending: the subject pulls into the driveway/bay and STOPS
 * there, clear of whatever the leg dies at.
 *
 * The gate chain's exit link runs to the physical end of the destination leg —
 * for a driveway that is the garage door / fence / barrier. Left alone, the
 * avoided subject drove the whole tail and then the draft's run-out extension added
 * ~40 m more (dib 2026-07-23: leftped-1774-7 "must not collide with the
 * building/garage after they enter the driveway", rightped-1759-15 "must stop
 * once it's situated in the driveway and not try to go past it").
 *
 * So: truncate the tail to leave DRIVEWAY_STOP_CLEARANCE_M of drivable run
 * between the stop point and the leg's end, and mark the plan as TERMINATING
 * there. When the leg is too short to give both clearance and a real pull-in,
 * the subject stops at the mouth (the conflict) rather than nosing in with none.
 * Always returns an ending for a driveway site — "keep driving" is never right.
 */
function resolveDrivewayStopEnding(
  subject: PlannedActor,
  site: TurnPedCrosswalkSite,
): { subject: PlannedActor; spot: Vec2; alongExitM: number; clearanceM: number } {
  const stopAtMouth = (clearanceM: number) => ({
    subject: {
      ...subject,
      postConflictWaypoints: undefined,
      terminalStop: {
        point: { x: site.conflictPoint.x, y: site.conflictPoint.y },
        holdS: TERMINAL_HOLD_S,
        clearanceM,
        reason: "driveway" as const,
      },
    },
    spot: { x: site.conflictPoint.x, y: site.conflictPoint.y },
    alongExitM: 0,
    clearanceM,
  });

  const tail = subject.postConflictWaypoints;
  if (!tail || tail.length < 2) return stopAtMouth(0);
  const tailLenM = polylineLength(tail);
  const stopArcM = tailLenM - DRIVEWAY_STOP_CLEARANCE_M;
  if (stopArcM < DRIVEWAY_MIN_PULL_IN_M) return stopAtMouth(tailLenM);

  // Truncate the tail at `stopArcM` (the tail's first point IS the conflict, so
  // the kept polyline still starts there and stays appendable).
  const kept: Vec2[] = [{ x: tail[0]!.x, y: tail[0]!.y }];
  let cum = 0;
  let spot: Vec2 = { x: tail[0]!.x, y: tail[0]!.y };
  for (let i = 1; i < tail.length; i++) {
    const a = tail[i - 1]!;
    const b = tail[i]!;
    const segLen = Math.hypot(b.x - a.x, b.y - a.y);
    if (segLen < 1e-9) continue;
    if (cum + segLen >= stopArcM) {
      const f = (stopArcM - cum) / segLen;
      spot = { x: a.x + (b.x - a.x) * f, y: a.y + (b.y - a.y) * f };
      break;
    }
    cum += segLen;
    kept.push({ x: b.x, y: b.y });
    spot = { x: b.x, y: b.y };
  }
  const last = kept[kept.length - 1]!;
  if (Math.hypot(last.x - spot.x, last.y - spot.y) > 1e-6) kept.push(spot);
  return {
    subject: {
      ...subject,
      postConflictWaypoints: kept.length >= 2 ? kept : undefined,
      terminalStop: {
        point: { x: spot.x, y: spot.y },
        holdS: TERMINAL_HOLD_S,
        clearanceM: DRIVEWAY_STOP_CLEARANCE_M,
        reason: "driveway",
      },
    },
    spot,
    alongExitM: stopArcM,
    clearanceM: DRIVEWAY_STOP_CLEARANCE_M,
  };
}


export function planTurnPedCrosswalkForSite(
  inputSite: TurnPedCrosswalkSite,
  a: PlanTurnPedCrosswalkArgs,
): TurnPedCrosswalkResult | null {
  const { topology, subjectSpeedKph, idealTimeS, minTimeS } = a;

  // ONE crossing speed for the whole solve, from stature AND gait. Hoisted so
  // the clip-budget reserve, the curb hold, the crossing duration and the via
  // chamfer can never disagree about how fast the walker is moving — mixing a
  // walking reserve with a running hold is the inherit-half-the-solve bug that
  // walker-profile.ts exists to prevent.
  const crossSpeedMps = walkerSpeedMps(a.walkerProfile, a.walkerGait);

  const built = buildGatePolyline(topology, inputSite.gate);
  if (!built || built.chain.length < 3) return null;

  // Fix 1 (driveway sidewalk crossing): when a real sidewalk straddles the
  // driveway centerline at the mouth, the ped walks THAT line sidewalk-to-
  // sidewalk and the conflict RE-ANCHORS onto where it crosses the subject's path —
  // the subject stops at the sidewalk instead of EXIT_SETBACK_M inside the parcel,
  // and the walk ends on the far sidewalk instead of on the lawn by the house.
  let site = inputSite;
  let drivewaySidewalk: MouthCrossing | null = null;
  if (site.drivewayExit) {
    const candidate = resolveDrivewaySidewalkCrossing(site, a.sidewalks);
    if (candidate?.viaPoint) {
      const reanchored = reanchorConflictOntoMouth(site, built.chain, candidate.viaPoint);
      if (reanchored) {
        site = reanchored;
        // Author the walk THROUGH the re-anchored conflict (which sits within
        // DRIVEWAY_REANCHOR_MAX_SHIFT_M of the sidewalk crossing, on the subject's
        // path) so the meet-at-conflict solve below stays exact.
        drivewaySidewalk = { ...candidate, viaPoint: site.conflictPoint };
      }
    }
  }

  // ── Walker crossing GEOMETRY (resolved BEFORE the run-up is sized) ─────────
  // WHERE the walker crosses depends only on the (possibly re-anchored) site +
  // region data, never on the subject, so the kinematic runway cap below can price
  // the crossing's duration into its aftermath reserve. The subject-dependent TIMING
  // (curb hold + waypoint times) is solved further down, once the subject's achieved
  // ETA is known.
  let start: Vec2;
  let end: Vec2;
  let crossingSource: string;
  /** Fix 1: an explicit mid-walk point the ped must pass through (the sidewalk
   *  tier's endpoints follow the mapped line and are NOT collinear with the
   *  conflict). Null for the collinear tiers, which keep their exact geometry
   *  and timing. */
  let viaPoint: Vec2 | null = null;
  if (site.drivewayExit) {
    // Driveway-like destination: the ped walks the MAIN road's sidewalk across
    // the driveway MOUTH — perpendicular to the subject's entry — never down the
    // driveway toward the garage/parcel. The subject meets the crossing at the
    // mouth on its turn path, stops for the ped, then pulls in and stops.
    const mouth = drivewaySidewalk ?? resolveDrivewayMouthCrossing(site, a);
    start = mouth.start;
    end = mouth.end;
    crossingSource = mouth.source;
    viaPoint = mouth.viaPoint ?? null;
  } else {
    // Street destination: resolve a curb-to-curb line from real map data
    // (crosswalk → sidewalk → road edge) on the EXIT lane; fall back to the
    // fixed perpendicular only when topology is too sparse.
    const resolved = resolveCrossingLine({
      topology,
      conflictPoint: site.conflictPoint,
      // The crossing straddles the EXIT (destination) leg, so the road-edge
      // fallback must use the exit road's sibling lanes, not the approach road's.
      approachLaneRsl: site.exitLaneRsl,
      crossingAxisRad: site.crossingAxisRad,
      crosswalks: a.crosswalks,
      sidewalks: a.sidewalks,
      poiPoints: a.poiPoints,
    });
    if (resolved) {
      const u: Vec2 = {
        x: Math.cos(site.crossingAxisRad),
        y: Math.sin(site.crossingAxisRad),
      };
      if (axisAlignment(u, resolved.spawn, resolved.far) >= STREET_CROSS_ALIGN_MIN) {
        start = resolved.spawn;
        end = resolved.far;
        crossingSource = resolved.source;
      } else {
        // Fix E: the resolved line runs obliquely through the conflict (the
        // spawn→P sidewalk/POI tiers follow the mapped geometry, which can
        // amble diagonally through the junction — leftped-1162-3). Clamp it
        // onto the perpendicular axis so the ped crosses the subject's path at
        // ~90° in front of the vehicle.
        const clamped = clampStreetCrossingOntoAxis(site, a, resolved);
        start = clamped.start;
        end = clamped.end;
        crossingSource = `${resolved.source}_perp`;
      }
    } else {
      const ux = Math.cos(site.crossingAxisRad);
      const uy = Math.sin(site.crossingAxisRad);
      start = {
        x: site.conflictPoint.x - ux * HALF_WIDTH_M,
        y: site.conflictPoint.y - uy * HALF_WIDTH_M,
      };
      end = {
        x: site.conflictPoint.x + ux * HALF_WIDTH_M,
        y: site.conflictPoint.y + uy * HALF_WIDTH_M,
      };
      crossingSource = "fixed_fallback";
    }
  }

  // The walk is `start → (via) → end`. With no via it is the straight line
  // through the conflict every other tier produces; with one, the pre-conflict
  // leg is measured along the sidewalk instead of as a chord.
  const via =
    viaPoint &&
    Math.hypot(viaPoint.x - start.x, viaPoint.y - start.y) > 0.05 &&
    Math.hypot(viaPoint.x - end.x, viaPoint.y - end.y) > 0.05
      ? viaPoint
      : null;
  const preConflictM = via
    ? Math.hypot(via.x - start.x, via.y - start.y)
    : Math.hypot(start.x - site.conflictPoint.x, start.y - site.conflictPoint.y);
  const crossLenM = via
    ? preConflictM + Math.hypot(end.x - via.x, end.y - via.y)
    : Math.hypot(end.x - start.x, end.y - start.y);

  // ── KINEMATIC RUNWAY cap (dib 2026-07-24 yield pass) ───────────────────────
  // The run-up is sized assuming the subject CRUISES the whole route, but the worker
  // clamps it to TURN_ENTRY_SPEED_MPS through the connecting + exit arc, so it
  // reaches the exit-leg conflict LATER than the planned run-up — and then the
  // ped-yield aftermath (walker clears + subject holds + resumes) runs off the end
  // of the clip (24/50 turn-not-executed rejects on the fixed-v2 render were
  // "still turning when the 20 s clip ended"). dib's fix: a slower turn covers
  // less ground, so it needs a SHORTER runway — spawn the subject closer so the turn
  // happens EARLIER and the aftermath fits. Cap the run-up with a clip budget:
  //   feasibleTimeS <= clipLen − aftermathReserve − turnSlowdownPenalty − margin
  const speedMps = subjectSpeedKph / 3.6;
  const clipLenS = a.clipLenS ?? DEFAULT_CLIP_LEN_S;

  // Extra time the worker's entry clamp adds over the planned cruise run-up:
  //   (1) the STEADY clamp through the connecting + exit-to-conflict arc, plus
  //   (2) the DECEL RAMP easing from cruise down to the clamp speed on approach
  //       (extra time to cover the ramp vs at cruise = Δv²/(2·a·v₀)).
  // arcThroughJunctionM = connecting leg + the exit distance to the conflict
  // (= site.conflictArc − approachLen); both terms vanish once the subject already
  // travels at/below the clamp speed (the Math.max(0, …) / ternary guards).
  const approachLen = polylineLength(built.chain[0]!.oriented);
  const connLen = polylineLength(built.chain[1]!.oriented);
  const exitToConflictM = Math.max(0, site.conflictArc - approachLen - connLen);
  const arcThroughJunctionM = connLen + exitToConflictM;
  const steadyClampPenaltyS = Math.max(
    0,
    arcThroughJunctionM * (1 / TURN_ENTRY_SPEED_MPS - 1 / speedMps),
  );
  const decelRampS =
    speedMps > TURN_ENTRY_SPEED_MPS
      ? (speedMps - TURN_ENTRY_SPEED_MPS) ** 2 / (2 * TURN_ENTRY_DECEL_MPS2 * speedMps)
      : 0;
  const turnSlowdownPenaltyS = steadyClampPenaltyS + decelRampS;

  // Aftermath that must fit AFTER the subject reaches the conflict: the walker
  // finishing its crossing clear of the subject's path (full crossing duration —
  // conservative; the pre-conflict half doubles as hold slack) plus a few
  // seconds of visible subject resume.
  const aftermathReserveS = crossLenM / crossSpeedMps + RESUME_VISIBLE_S;
  const clipCapTimeS =
    clipLenS - aftermathReserveS - turnSlowdownPenaltyS - CLIP_BUDGET_MARGIN_S;

  // Existing policy: float the run-up in [minTimeS, idealTimeS] on the available
  // room, at full speed. NEW: cap it by the clip budget so the turn + aftermath
  // fit — never below minTimeS, and never above what the room already afforded.
  // When the cap would force below minTimeS the site is simply too tight for the
  // clip: keep it at minTimeS (best effort, flagged) rather than crash or drop.
  const roomTimeS = site.roomM / speedMps;
  const floatedTimeS = Math.min(idealTimeS, Math.max(minTimeS, roomTimeS));
  let feasibleTimeS = Math.max(minTimeS, Math.min(floatedTimeS, clipCapTimeS));
  const clipBudgetTooTight = clipCapTimeS < minTimeS;
  const runwayCappedByClip = !clipBudgetTooTight && clipCapTimeS < floatedTimeS;
  let backwardM = speedMps * feasibleTimeS;
  // P-3 spawn-upstream floor: the back-walk from the exit-leg conflict consumes
  // the connecting + exit arc FIRST, so the spawn only lands on the approach
  // when backwardM exceeds the through-junction distance. A long junction
  // connector (55 m on Yale 849) otherwise swallows the whole time-sized
  // run-up and the subject spawns mid-turn — the straight-route defect. Floor the
  // distance so the spawn always sits MIN_APPROACH_RUNUP_M up the approach (or
  // its predecessors), and grow the schedule to match (the ETA solve below and
  // the walker hold both key off the achieved time).
  const throughJunctionM = Math.max(0, site.conflictArc - approachLen);
  const minBackwardM = throughJunctionM + MIN_APPROACH_RUNUP_M;
  if (backwardM < minBackwardM) {
    backwardM = minBackwardM;
    feasibleTimeS = backwardM / speedMps;
  }

  // The subject turn route: approach → connecting → partial exit, ending at the
  // exit-leg conflict. `buildPlannedActorFromTopology` back-walks the run-up
  // (walking predecessors upstream when the approach alone is too short) and
  // fills `postConflictWaypoints` with the exit-lane centerline PAST the conflict,
  // so the avoided subject completes the turn into the exit lane instead of
  // overshooting.
  let subject: PlannedActor | null = buildPlannedActorFromTopology(
    topology,
    built.chain,
    site.conflictArc,
    backwardM,
    site.conflictPoint,
    feasibleTimeS,
  );
  if (!subject) return null;

  // Where the maneuver ENDS, stopped.
  //  - DRIVEWAY exits (Fix 2): the destination IS the stop. Truncate the tail so
  //    the subject parks inside the driveway with clearance from the garage/fence,
  //    and mark the plan as terminating there.
  //  - STREET exits (P6): reroute the post-conflict tail into the nearest
  //    curbside parking-lane spot along the exit leg, so the subject finishes by
  //    pulling in and stopping.
  // Pre-conflict geometry/ETA are untouched in both cases, so the meet-timing
  // solve below is unaffected.
  let parkEnding: TurnPedParkEnding | null = null;
  if (site.drivewayExit) {
    const stopped = resolveDrivewayStopEnding(subject, site);
    subject = stopped.subject;
    parkEnding = {
      spot: stopped.spot,
      alongExitM: stopped.alongExitM,
      kind: "driveway",
      clearanceM: stopped.clearanceM,
    };
  } else if (a.parkingLanes && a.parkingLanes.length > 0) {
    const parked = resolveCurbsideParkEnding(subject, site, a.parkingLanes);
    if (parked) {
      subject = parked.subject;
      parkEnding = {
        spot: parked.spot,
        alongExitM: parked.alongExitM,
        kind: "curbside",
        clearanceM: PARK_TAIL_BACKOFF_M,
      };
    }
  }

  // ACHIEVED subject ETA: `finalizePlannedActor` scales the sim speed so the subject
  // covers the actual polyline (joint gaps included) in exactly `feasibleTimeS`,
  // so the real arrival at the conflict is arcLength / expectedSpeed ≈ feasibleTimeS.
  const subjectEtaS = subject.arcLengthM / (subject.expectedSpeedKph / 3.6);

  // Walker TIMING (crossing GEOMETRY — start/end/via/crossLenM — was resolved
  // above the runway cap). The curb hold is SOLVED so the walker reaches the
  // conflict at subjectEtaS; a via, when present, is timed to the same ETA so the
  // meet-at-conflict solve stays exact.
  const tToConflictS = preConflictM / crossSpeedMps;
  const crossDurS = crossLenM / crossSpeedMps;
  const holdS = Math.max(0, subjectEtaS - tToConflictS);

  const startT = holdS > MIN_HOLD_S ? holdS : 0;
  // A sharp via corner (the sidewalk-tier walk can pivot >90° at the mouth) is
  // authored as a single vertex, which the replayed track crosses in one tick —
  // the M1.2 lint reads that as a heading DISCONTINUITY (integrity violation,
  // Belmont 1577: 126° in one sample) and rejects the draft. Chamfer the
  // corner: replace the via vertex with two points ~0.5 m along each leg, so
  // the pivot spreads across two segments (~half the angle each). The corner
  // cut is ≤ ~0.15 m — well inside the meet-at-conflict tolerance.
  const viaEntries: Array<{ x: number; y: number; time: number }> = [];
  if (via) {
    const viaT = startT + tToConflictS;
    const inLen = Math.hypot(via.x - start.x, via.y - start.y);
    const outLen = Math.hypot(end.x - via.x, end.y - via.y);
    const inDir = { x: (via.x - start.x) / (inLen || 1), y: (via.y - start.y) / (inLen || 1) };
    const outDir = { x: (end.x - via.x) / (outLen || 1), y: (end.y - via.y) / (outLen || 1) };
    const turnRad = Math.acos(
      Math.max(-1, Math.min(1, inDir.x * outDir.x + inDir.y * outDir.y)),
    );
    const CHAMFER_M = 0.5;
    const MAX_STEP_RAD = Math.PI / 3;
    const c = Math.min(CHAMFER_M, 0.4 * inLen, 0.4 * outLen);
    if (turnRad > MAX_STEP_RAD && c > 0.05) {
      const dtC = c / crossSpeedMps;
      viaEntries.push(
        { x: via.x - inDir.x * c, y: via.y - inDir.y * c, time: viaT - dtC },
        { x: via.x + outDir.x * c, y: via.y + outDir.y * c, time: viaT + dtC },
      );
    } else {
      viaEntries.push({ x: via.x, y: via.y, time: viaT });
    }
  }
  const waypoints = [
    { x: start.x, y: start.y, time: 0 },
    ...(holdS > MIN_HOLD_S ? [{ x: start.x, y: start.y, time: holdS }] : []),
    ...viaEntries,
    { x: end.x, y: end.y, time: startT + crossDurS },
  ];

  const crossedWhat = site.drivewayExit
    ? crossingSource === "driveway_sidewalk"
      ? "the driveway mouth, sidewalk to sidewalk"
      : "the driveway mouth (along the main road's sidewalk)"
    : "the destination leg";
  const walker: PlannedWalker = {
    spawnPoint: start,
    waypoints,
    rationale: `Turn-across-crosswalk — subject turns ${site.turn} through gate ${site.gate.id} (junction ${site.gate.junctionId}); walker crosses ${crossLenM.toFixed(0)}m of ${crossedWhat} (${crossingSource} curb), holds ${holdS.toFixed(1)}s (solved from subject ETA ${subjectEtaS.toFixed(1)}s) then reaches the conflict point at ${subjectEtaS.toFixed(1)}s.`,
  };

  const collision: PlannedCollision = {
    conflictPoint: site.conflictPoint,
    arrivalTimeS: subjectEtaS,
    subject,
    npc: subject, // the walker is the conflicting principal, surfaced separately
    rationale: `Turn-across-crosswalk pedestrian — subject ${site.turn} gate ${site.gate.id} at junction ${site.gate.junctionId}; ped crosses the destination-leg crosswalk at the conflict point (${site.conflictPoint.x.toFixed(1)}, ${site.conflictPoint.y.toFixed(1)}), timed to meet the subject at ${subjectEtaS.toFixed(1)}s.`,
    // Authoritative gate identity: the turn direction drives the subject's junction
    // maneuver (CARLA-native turn primitive for the collision variant) via
    // `subjectTurnForSite`, which reads subjectGate.turnRelation.
    subjectGate: {
      junctionId: site.gate.junctionId,
      gateId: site.gate.id,
      turnRelation: site.turn,
      headingChangeRad: site.gate.headingChangeRad,
    },
  };
  if (parkEnding?.kind === "curbside") {
    collision.rationale += ` Subject ends by pulling into a curbside parking spot ${parkEnding.alongExitM.toFixed(0)}m past the turn (park ending), and STOPS there.`;
  } else if (parkEnding?.kind === "driveway") {
    collision.rationale += ` Subject ends by pulling ${parkEnding.alongExitM.toFixed(0)}m into the driveway and coming to a complete stop, ${parkEnding.clearanceM.toFixed(0)}m clear of the end of the leg (driveway ending).`;
  }
  // Kinematic-runway provenance (dib 2026-07-24): surface when the clip budget
  // shortened the run-up so the slowed turn + ped aftermath fit, or when the
  // site is too tight to fit even at minTimeS (a possible overrun to watch).
  if (runwayCappedByClip) {
    collision.rationale += ` Run-up capped to ${feasibleTimeS.toFixed(1)}s (from ${floatedTimeS.toFixed(1)}s) so the slowed turn (+${turnSlowdownPenaltyS.toFixed(1)}s) and ${aftermathReserveS.toFixed(1)}s of ped aftermath fit the ${clipLenS.toFixed(0)}s clip (kinematic runway).`;
  } else if (clipBudgetTooTight) {
    collision.rationale += ` Run-up held at minTimeS ${minTimeS.toFixed(1)}s — the slowed turn (+${turnSlowdownPenaltyS.toFixed(1)}s) plus ${aftermathReserveS.toFixed(1)}s of ped aftermath exceed the ${clipLenS.toFixed(0)}s clip budget (kinematic runway: site too tight, may overrun).`;
  }

  return { collision, walker, parkEnding };
}
