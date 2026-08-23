/**
 * Deterministic auto-repair adjustments. Each function takes the draft that
 * just failed esmini validation plus the measured metrics, and returns a
 * mutated draft tagged with the `repair_kind` that produced it. The
 * orchestrator (`scenario-validation/repair/orchestrator.ts`) calls these in
 * a fixed priority order and stops at the first one that proposes a change.
 *
 * These adjustments operate on the draft fields the supported planner path
 * emits (`placement_mode: "timed_path"` + spawn_point/timed_waypoints). They do
 * not re-run the lane-graph planner — that would require map loading and
 * a server round-trip the repair budget can't afford. Instead, each repair
 * is a local mutation on the draft polyline / speed, equivalent to nudging
 * the planner's free parameters without re-solving them.
 *
 * If none of the adjustments below produces a candidate, the orchestrator
 * escalates to the LLM repair (one-shot Claude call).
 */
import type {
  EsminiValidationMetrics,
  ScenarioEditorActorDraft,
  ScenarioEditorDraft,
  ScenarioEditorMapPoint,
  ScenarioValidationRepairKind,
} from "@simcloud/shared";

export interface RepairInput {
  draft: ScenarioEditorDraft;
  metrics: EsminiValidationMetrics;
  /**
   * Time-of-impact the original planner targeted. The draft schema doesn't
   * carry this explicitly so the orchestrator threads it through from the
   * planner output (or falls back to draft.simulationConfig.duration / 2).
   */
  expectedArrivalTimeS: number;
  /**
   * Actor id the orchestrator considers "subject" — usually literally "subject".
   * Repair targets either the subject or the NPC's path; the walker, if any,
   * gets a separate path.
   */
  subjectActorId: string;
  /**
   * When true, NEVER move the subject (skip the `retime_subject` fallback) — only the
   * colliding NPC / walker is adjusted. This is the contract for the tiered
   * collision repair loop: the deterministic creator fixed the subject + background
   * + parking, so the repairer's sole job is to control the conflicting actor.
   * Defaults to false (the esmini editor flow keeps the subject-retime fallback).
   */
  npcOnly?: boolean;
  /**
   * The `ped_incomplete` signal from a 2D CARLA run (scene_outcome): the conflict
   * pedestrian wedged on non-navmesh and never completed its crossing. When
   * present + value, the FIRST repair nudges the ped's path geometry (a stuck ped
   * needs a reachable spawn, not a re-time). Absent for the esmini/turn flows.
   */
  pedIncomplete?: { value: boolean; reason?: string };
  /**
   * Observed closest-approach positions from the 2D run's actor track (runtime
   * frame): where the subject and the conflict NPC actually were at
   * `min_distance.t`. Present only for the tiered repair loop (the harness
   * reads actor_track.json). Enables the SPATIAL repair: turn egos drive a
   * CARLA-native arc that systematically passes ~3-4m from the PLANNED
   * conflict point, and when timing is already aligned no retime closes that
   * lateral gap — the fix is translating the NPC's path onto the subject's
   * observed arc.
   */
  observedClosestApproach?: {
    subject: { x: number; y: number };
    npc: { x: number; y: number };
  };
  /**
   * The TRUE lead/lag of the conflict actor, measured in a CARLA 2D run
   * (`contactMetrics.path_crossing_m` / `conflict_lead_s`). Absent on the esmini
   * path, which cannot produce it.
   *
   * `min_distance` is a SAME-FRAME comparison and so conflates two failures that
   * demand opposite responses:
   *
   *   pathCrossingM large  -> the paths never converge. A SPATIAL miss; no schedule
   *                           shift can ever fix it.
   *   pathCrossingM small  -> the paths cross, but the actors were not there
   *                           together. A TIMING miss, fixed EXACTLY by shifting the
   *                           conflict actor by -conflictLeadS.
   *
   * Without this, the repairer had to infer timing from
   * `min_distance.t - expectedArrivalTimeS` — a JOINT time that says nothing about
   * WHO was early. Measured on the r8 fleet run it shifted the wrong way and clamped
   * to a no-op, and the `min_distance <= 25 m` plausibility gate was backwards: it
   * ACCEPTED left-582-1 (min_d 23.6 m, but the paths only ever come within 23.5 m —
   * unfixable) and REJECTED left-2809-3 (min_d 39.3 m, but the paths pass within
   * 3.3 m and the NPC is 10.8 s late — perfectly fixable).
   */
  conflictTiming?: {
    /** Closest the two PATHS come, ignoring time (m). */
    pathCrossingM: number;
    /** t_conflict - t_subject at that crossing. Positive = conflict arrived LATE. */
    conflictLeadS: number;
  };
}

export interface RepairResult {
  draft: ScenarioEditorDraft;
  kind: ScenarioValidationRepairKind;
  notes: string;
}

const KPH_TO_MPS = 1 / 3.6;
const MIN_SCALE_FACTOR = 0.2;
const MAX_SCALE_FACTOR = 4.0;
const MIN_LEAD_SEGMENT_M = 5;

function distance(a: ScenarioEditorMapPoint, b: ScenarioEditorMapPoint): number {
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  return Math.sqrt(dx * dx + dy * dy);
}

function pathPoints(actor: ScenarioEditorActorDraft): ScenarioEditorMapPoint[] {
  if (!actor.spawn_point) return [];
  const timed = [...(actor.timed_waypoints ?? [])]
    .sort((left, right) => left.time - right.time)
    .map((point) => ({ x: point.x, y: point.y }));
  return [actor.spawn_point, ...timed];
}

function clamp(value: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, value));
}

/**
 * Move the spawn point of `actor` along the first segment of its planned
 * path by a scale factor on the segment's length. `factor > 1` pushes the
 * spawn back (further from the conflict point), `factor < 1` pulls it
 * forward. Intermediate waypoints and destination are untouched, so the
 * planned trajectory shape stays intact.
 *
 * Returns a new actor object; never mutates the input. Returns null when
 * the actor doesn't have enough waypoints to define a first segment.
 */
function scaleSpawnDistance(
  actor: ScenarioEditorActorDraft,
  factor: number,
): ScenarioEditorActorDraft | null {
  if (actor.placement_mode !== "timed_path") return null;
  if (!actor.spawn_point) return null;
  const pts = pathPoints(actor);
  if (pts.length < 2) return null;
  const first = pts[0]!;
  const next = pts[1]!;
  const segLen = distance(first, next);
  if (segLen <= 0) return null;
  const newLen = clamp(segLen * factor, MIN_LEAD_SEGMENT_M, segLen * MAX_SCALE_FACTOR);
  const t = newLen / segLen;
  // Walk from `next` *back* toward (and past, if factor>1) `first`.
  const newSpawn: ScenarioEditorMapPoint = {
    x: next.x - (next.x - first.x) * t,
    y: next.y - (next.y - first.y) * t,
  };
  return { ...actor, spawn_point: newSpawn };
}

function adjustSpeedKph(
  actor: ScenarioEditorActorDraft,
  factor: number,
): ScenarioEditorActorDraft {
  const current = actor.speed_kph ?? 0;
  return { ...actor, speed_kph: clamp(current * factor, 1, 200) };
}

/** Below this magnitude a repair adjustment is a no-op and not worth an
 *  esmini attempt (avoids the loop burning its budget re-running an
 *  unchanged scenario). */
const MIN_EFFECTIVE_SHIFT_S = 0.05;

/**
 * Shift every `timed_waypoints` time of a timed-path actor by `deltaS` seconds,
 * keeping positions the same — so the actor reaches each point (including the
 * conflict) `deltaS` seconds later (positive) or earlier (negative). Works for
 * any timed-path actor: the walker (`rerun_pedestrian_timing`) and the subject
 * (`retime_subject`). We never let the waypoints start before t=0.
 *
 * Returns null when the requested shift collapses to a no-op — e.g. the actor
 * needs to arrive *earlier* but already starts at t=0, so the clamp zeroes the
 * shift. Re-running an identical draft would only waste a repair attempt;
 * signalling null lets the orchestrator stop (or try the next adjustment).
 */
function shiftWalkerTiming(
  actor: ScenarioEditorActorDraft,
  deltaS: number,
): ScenarioEditorActorDraft | null {
  if (actor.placement_mode !== "timed_path") return null;
  const wps = actor.timed_waypoints ?? [];
  if (wps.length === 0) return null;
  const minT = Math.min(...wps.map((w) => w.time));
  const clampedDelta = minT + deltaS < 0 ? -minT : deltaS;
  if (Math.abs(clampedDelta) < MIN_EFFECTIVE_SHIFT_S) return null;
  return {
    ...actor,
    timed_waypoints: wps.map((w) => ({ ...w, time: w.time + clampedDelta })),
  };
}

/**
 * Re-time a `timed_path` conflict actor so it reaches the conflict `shiftS` seconds
 * later (positive) or earlier (negative).
 *
 * DELAY (shiftS > 0) is just a time shift — unbounded.
 *
 * ADVANCE (shiftS < 0) cannot be: waypoints may not start before t=0, so a plain shift
 * clamps to nothing (measured: a scene needing the NPC 1.6 s later got a -0.08 s
 * "repair" — the clamp, i.e. a no-op). Nor can speed or spawn distance help: the worker
 * drives a timed path along an ABSOLUTE-timed trajectory, so the actor reaches each
 * (x, y, time) at that time whatever its speed_kph. The only honest lever is to TRIM the
 * lead-in — start the actor further along its own route and rebase the clock — so it
 * arrives earlier at its authored speed.
 */
/** Linearly interpolate a {x, y, time} waypoint on a timed path at absolute time `t`. */
function interpolateAtTime(
  wps: ReadonlyArray<{ x: number; y: number; time: number }>,
  t: number,
): { x: number; y: number; time: number } {
  if (t <= wps[0]!.time) return { ...wps[0]! };
  const last = wps[wps.length - 1]!;
  if (t >= last.time) return { ...last };
  for (let i = 0; i + 1 < wps.length; i++) {
    const a = wps[i]!;
    const b = wps[i + 1]!;
    if (t >= a.time && t <= b.time) {
      const span = b.time - a.time;
      const f = span > 1e-9 ? (t - a.time) / span : 0;
      return { x: a.x + (b.x - a.x) * f, y: a.y + (b.y - a.y) * f, time: t };
    }
  }
  return { ...last };
}

export function retimeConflictActor(
  actor: ScenarioEditorActorDraft,
  shiftS: number,
): ScenarioEditorActorDraft | null {
  if (actor.placement_mode !== "timed_path") return null;
  const wps = actor.timed_waypoints ?? [];
  if (wps.length === 0) return null;
  if (Math.abs(shiftS) < MIN_EFFECTIVE_SHIFT_S) return null;

  // Delay: a pure time shift works with any number of waypoints — nothing to trim.
  if (shiftS > 0) {
    return { ...actor, timed_waypoints: wps.map((w) => ({ ...w, time: w.time + shiftS })) };
  }

  // Advance needs a lead-in to trim, which needs at least two waypoints.
  if (wps.length < 2) return null;

  // Advance: drop the lead-in the actor no longer has time to drive, then rebase. Keep an
  // interpolated waypoint AT the trim time so a big advance can't strip the path below two
  // points (a 10.8 s advance on a 16 s path would otherwise leave one waypoint) — the
  // conflict end of the path, which is the whole point, must always survive.
  const advance = -shiftS;
  const lastT = wps[wps.length - 1]!.time;
  if (advance >= lastT) return null; // nothing left after the trim — a spatial problem
  const startPoint = interpolateAtTime(wps, advance);
  const kept = wps.filter((w) => w.time > advance);
  const rebased = [startPoint, ...kept].map((w) => ({ ...w, time: round3(w.time - advance) }));
  if (rebased.length < 2) return null;
  const head = rebased[0]!;
  return {
    ...actor,
    // Spawn where it now starts, or the worker would teleport it from the old origin.
    spawn_point: { x: head.x, y: head.y },
    timed_waypoints: rebased,
  };
}

/**
 * The conflict actor's TRUE lead over the subject, when a CARLA 2D run measured it.
 * Positive = the conflict arrived LATE (advance it); negative = EARLY (delay it).
 *
 * Falls back to the esmini-era proxy (`min_distance.t - expectedArrivalTimeS`), which is
 * a JOINT time and cannot say who was early — it is all esmini can offer, but on CARLA
 * runs it shifted the wrong way and clamped to a no-op.
 */
function conflictLeadSeconds(input: RepairInput): number | null {
  if (input.conflictTiming) return input.conflictTiming.conflictLeadS;
  return timingDeltaSeconds(input.metrics, input.expectedArrivalTimeS);
}

/**
 * Closest the two paths come before a miss stops being a TIMING problem. Beyond this the
 * paths genuinely do not converge and no schedule shift can help — that is adjustment 0b's
 * job (translate the NPC's path onto the subject's observed arc).
 */
const PATH_CROSSING_TIMING_MAX_M = 4.0;

/** Is this miss fixable by re-timing (the paths DO cross), or is it spatial? */
function isTimingMiss(input: RepairInput): boolean {
  if (input.conflictTiming) {
    return input.conflictTiming.pathCrossingM <= PATH_CROSSING_TIMING_MAX_M;
  }
  return isPlausibleTimingMiss(input.metrics);
}

/**
 * Pick the closest-approach point reported by esmini and figure out which
 * direction to nudge timing. Returns the delta in seconds the *vehicles*
 * would need to compensate by (positive = arrived too late, need to move
 * spawn closer; negative = arrived too early, push spawn back).
 *
 * Returns null when esmini didn't report a min_distance (single-actor
 * scenarios, or trajectory parser failed).
 */
function timingDeltaSeconds(metrics: EsminiValidationMetrics, expectedArrivalTimeS: number): number | null {
  if (!metrics.min_distance) return null;
  return metrics.min_distance.t - expectedArrivalTimeS;
}

/**
 * Decide whether the close-approach reported by esmini is "close enough"
 * that scaling distances can plausibly close the gap, vs. truly missed
 * (e.g. actors on entirely wrong roads — needs LLM repair).
 */
function isPlausibleTimingMiss(metrics: EsminiValidationMetrics): boolean {
  if (!metrics.min_distance) return false;
  // 25 m is roughly two car-lengths plus the kinematic slop a single repair
  // can plausibly absorb. Beyond that, scaling the lead segment by a finite
  // factor won't reach the conflict point.
  return metrics.min_distance.meters <= 25;
}

/** Metres to push a wedged pedestrian's spawn + curb-hold toward the road per
 *  repair pass. Cumulative across the 2D-run loop's rounds — a small step so it
 *  finds the nearest navmesh without overshooting into the lane. */
const PED_PATH_NUDGE_STEP_M = 0.7;
const round3 = (n: number) => Math.round(n * 1000) / 1000;

/**
 * Nudge a stuck conflict pedestrian's spawn + curb-hold waypoints TOWARD the road
 * (along the crossing axis, spawn → far curb) so it steps off onto reachable
 * navmesh instead of wedging on the sidewalk edge / vegetation. The far-curb
 * target is left in place, so the crossing still reaches the conflict; only the
 * step-off origin moves. Returns null when there's no timed-path walker to fix.
 */
function nudgeWalkerPath(actor: ScenarioEditorActorDraft): ScenarioEditorActorDraft | null {
  if (actor.placement_mode !== "timed_path" || !actor.spawn_point) return null;
  const wps = actor.timed_waypoints ?? [];
  if (wps.length < 2) return null;
  const spawn = actor.spawn_point;
  const last = wps[wps.length - 1]!;
  const dx = last.x - spawn.x;
  const dy = last.y - spawn.y;
  const dl = Math.hypot(dx, dy);
  if (dl < 1e-3) return null;
  const ux = (dx / dl) * PED_PATH_NUDGE_STEP_M;
  const uy = (dy / dl) * PED_PATH_NUDGE_STEP_M;
  // Move the spawn + every curb-hold waypoint (those co-located with the spawn)
  // toward the road; leave the crossing/target waypoints untouched.
  const atSpawn = (w: { x: number; y: number }) =>
    Math.hypot(w.x - spawn.x, w.y - spawn.y) < 0.5;
  return {
    ...actor,
    spawn_point: { ...spawn, x: round3(spawn.x + ux), y: round3(spawn.y + uy) },
    timed_waypoints: wps.map((w) =>
      atSpawn(w) ? { ...w, x: round3(w.x + ux), y: round3(w.y + uy) } : w,
    ),
  };
}

const APPLY_ORDER: Array<(input: RepairInput) => RepairResult | null> = [
  /**
   * Adjustment −1 (ped-navmesh, VRU only): a 2D run flagged `ped_incomplete` — the
   * conflict pedestrian wedged and never crossed. Nudge its step-off geometry
   * toward the road FIRST (before any re-timing), since re-timing a ped that never
   * moves is futile. The 2D-run loop re-renders and repeats, so the nudge is small.
   */
  (input) => {
    if (!input.pedIncomplete?.value) return null;
    const walker = input.draft.actors.find(
      (a) => a.role === "pedestrian" && a.placement_mode === "timed_path",
    );
    if (!walker) return null;
    const adjusted = nudgeWalkerPath(walker);
    if (!adjusted) return null;
    return {
      draft: {
        ...input.draft,
        actors: input.draft.actors.map((a) => (a.id === walker.id ? adjusted : a)),
      },
      kind: "nudge_pedestrian_path",
      notes: `Ped ${input.pedIncomplete.reason ?? "incomplete"} — nudged spawn/curb-hold ${PED_PATH_NUDGE_STEP_M}m toward the road onto reachable navmesh.`,
    };
  },
  /**
   * Adjustment 0 (turn families): shift the conflict NPC VEHICLE's waypoint
   * TIMES. The worker drives a `timed_path` actor along an absolute-timed
   * FollowTrajectory, so it reaches each (x, y, time) waypoint at that ABSOLUTE
   * time regardless of spawn offset or `speed_kph` — which makes adjustments 1–2
   * (spawn-distance / speed scaling) no-ops for *when* the NPC reaches the
   * conflict (the same reason the subject uses a time-shift in adjustment 4). A
   * direct time-shift is the only lever that actually retimes it, so we try it
   * FIRST for the NPC vehicle. Pedestrian conflicts keep their walker re-timing
   * (adjustment 3); this targets the non-subject, non-pedestrian timed-path actor.
   */
  (input) => {
    const lead = conflictLeadSeconds(input);
    if (lead === null) return null;
    if (Math.abs(lead) < 0.1) return null;
    // Re-timing only works when the paths actually cross. If they never converge, this is
    // a SPATIAL miss and no shift can fix it — fall through to 0b, which moves the path.
    if (!isTimingMiss(input)) return null;
    const npc = input.draft.actors.find(
      (a) => a.role !== "subject" && a.role !== "pedestrian" && a.placement_mode === "timed_path",
    );
    if (!npc) return null;
    // Cancel the lead: shift by −lead. Positive lead (arrived LATE) => advance it.
    const adjusted = retimeConflictActor(npc, -lead);
    if (!adjusted) return null;
    return {
      draft: {
        ...input.draft,
        actors: input.draft.actors.map((a) => (a.id === npc.id ? adjusted : a)),
      },
      kind: "retime_npc",
      notes: `NPC reached the conflict ${Math.abs(lead).toFixed(2)}s ${lead > 0 ? "late" : "early"}; re-timed by ${(-lead).toFixed(2)}s to meet the subject's actual arrival.`,
    };
  },

  /**
   * Adjustment 0b (turn families) — SPATIAL: rigid-translate the conflict NPC's
   * path so it crosses the subject's OBSERVED closest-approach position. Fires only
   * when the miss is spatial, i.e. timing is already aligned (|delta| small or
   * unknown) but the paths pass laterally apart — the collision-regen signature
   * was a 3.0-4.0m min-distance floor invariant across retimes, because the
   * subject's CARLA-native turn arc runs ~3-4m from the PLANNED conflict point.
   * The whole path translates rigidly (spawn + timed_waypoints + destination),
   * preserving the planner's shape and timing; the worker re-projects the
   * spawn onto the road, mirroring the runtime-road-snap convention. Capped at
   * 6m so a structurally-broken scene (8-45m misses) is left for the planner
   * root-cause rather than teleported.
   */
  (input) => {
    const obs = input.observedClosestApproach;
    if (!obs) return null;
    const md = input.metrics.min_distance;
    if (!md) return null;
    if (md.meters <= 1.8) return null; // already contact-range; timing levers own it
    const delta = timingDeltaSeconds(input.metrics, input.expectedArrivalTimeS);
    if (delta !== null && Math.abs(delta) >= 0.75) return null; // timing miss — retime owns it
    const npc = input.draft.actors.find(
      (a) => a.role !== "subject" && a.role !== "pedestrian" && a.placement_mode === "timed_path",
    );
    if (!npc || !npc.spawn_point) return null;
    const dx = obs.subject.x - obs.npc.x;
    const dy = obs.subject.y - obs.npc.y;
    const shift = Math.sqrt(dx * dx + dy * dy);
    if (shift < 0.3) return null; // measurement noise
    if (shift > 6) return null; // structural miss — not a nudge candidate
    const translated: ScenarioEditorActorDraft = {
      ...npc,
      spawn_point: { x: npc.spawn_point.x + dx, y: npc.spawn_point.y + dy },
      timed_waypoints: (npc.timed_waypoints ?? []).map((p) => ({
        ...p,
        x: p.x + dx,
        y: p.y + dy,
      })),
      destination_point: npc.destination_point
        ? { x: npc.destination_point.x + dx, y: npc.destination_point.y + dy }
        : npc.destination_point,
    };
    return {
      draft: {
        ...input.draft,
        actors: input.draft.actors.map((a) => (a.id === npc.id ? translated : a)),
      },
      kind: "shift_npc_path",
      notes: `Spatial miss: paths pass ${md.meters.toFixed(2)}m apart with timing aligned; translated the NPC path by (${dx.toFixed(2)}, ${dy.toFixed(2)})m onto the subject's observed closest-approach point.`,
    };
  },

  /**
   * Adjustment 1: scale spawn distance on the non-subject vehicle. We prefer
   * to move the NPC because its arrival timing is the most common planner
   * mismatch (subject speeds are usually closer to user expectation; NPCs get
   * placed off rough heuristics).
   */
  (input) => {
    const delta = timingDeltaSeconds(input.metrics, input.expectedArrivalTimeS);
    if (delta === null || !isPlausibleTimingMiss(input.metrics)) return null;
    const npc = input.draft.actors.find(
      (a) => a.role !== "subject" && a.role !== "pedestrian" && a.placement_mode === "timed_path",
    );
    if (!npc) return null;
    // If NPC arrived early (delta<0), the actual collision-time miss is
    // negative; need NPC to arrive later → push spawn back → factor > 1.
    // If NPC arrived late (delta>0), pull spawn forward → factor < 1.
    const speedMps = (npc.speed_kph ?? 1) * KPH_TO_MPS;
    const pts = pathPoints(npc);
    if (pts.length < 2) return null;
    const segLen = distance(pts[0]!, pts[1]!);
    if (segLen <= 0 || speedMps <= 0) return null;
    const correctionM = -delta * speedMps;
    const factor = clamp((segLen + correctionM) / segLen, MIN_SCALE_FACTOR, MAX_SCALE_FACTOR);
    const adjusted = scaleSpawnDistance(npc, factor);
    if (!adjusted) return null;
    return {
      draft: {
        ...input.draft,
        actors: input.draft.actors.map((a) => (a.id === npc.id ? adjusted : a)),
      },
      kind: "scale_spawn_distance",
      notes: `NPC arrived ${delta.toFixed(2)}s ${delta > 0 ? "late" : "early"}; scaled NPC lead segment by ${factor.toFixed(2)} (correction ${correctionM.toFixed(1)} m).`,
    };
  },

  /**
   * Adjustment 2: nudge NPC speed when the spawn distance is already near
   * its limits or the delta is small. We try this second to keep geometric
   * planning intact when only kinematics need a tweak.
   */
  (input) => {
    const delta = timingDeltaSeconds(input.metrics, input.expectedArrivalTimeS);
    if (delta === null || !isPlausibleTimingMiss(input.metrics)) return null;
    if (Math.abs(delta) < 0.15) return null; // already close enough
    const npc = input.draft.actors.find(
      (a) => a.role !== "subject" && a.role !== "pedestrian" && a.placement_mode === "timed_path",
    );
    if (!npc) return null;
    // Speed factor: arrival time scales inversely with speed. If arrived
    // late (delta>0), bump speed up; if arrived early (delta<0), slow it
    // down so it gets to the conflict point on time.
    const observedT = input.metrics.min_distance!.t;
    const factor = clamp(observedT / input.expectedArrivalTimeS, MIN_SCALE_FACTOR, MAX_SCALE_FACTOR);
    const adjusted = adjustSpeedKph(npc, factor);
    return {
      draft: {
        ...input.draft,
        actors: input.draft.actors.map((a) => (a.id === npc.id ? adjusted : a)),
      },
      kind: "scale_npc_speed",
      notes: `NPC arrived ${delta.toFixed(2)}s ${delta > 0 ? "late" : "early"}; scaled NPC speed by ${factor.toFixed(2)} (now ${(adjusted.speed_kph ?? 0).toFixed(1)} kph).`,
    };
  },

  /**
   * Adjustment 3: re-time the walker. Only applies to pedestrian-crossing
   * scenarios. We don't try to re-solve the walker path geometry — we just
   * shift its `time` field so it arrives at the conflict point at the
   * planned arrival time.
   */
  (input) => {
    const delta = timingDeltaSeconds(input.metrics, input.expectedArrivalTimeS);
    if (delta === null) return null;
    const walker = input.draft.actors.find(
      (a) => a.placement_mode === "timed_path" && a.role === "pedestrian",
    );
    if (!walker) return null;
    if (Math.abs(delta) < 0.1) return null;
    // The walker arrived at the conflict point at the moment of min_distance.
    // Shifting timing by `-delta` brings the walker to the right moment.
    const adjusted = shiftWalkerTiming(walker, -delta);
    if (!adjusted) return null;
    return {
      draft: {
        ...input.draft,
        actors: input.draft.actors.map((a) => (a.id === walker.id ? adjusted : a)),
      },
      kind: "rerun_pedestrian_timing",
      notes: `Walker timing shifted by ${(-delta).toFixed(2)}s to align with the subject's actual approach.`,
    };
  },

  /**
   * Adjustment 4: re-time the SUBJECT to the walker's ACTUAL arrival. Pedestrian
   * scenarios with NO NPC vehicle where the walker can't be re-timed (it
   * already starts at t=0 but its closest approach lands at a different time)
   * leave the subject as the only lever: shift the subject's timed path so it reaches
   * the conflict point when the walker is actually there (`min_distance.t`)
   * instead of the planned arrival. We only get here once adjustment 3's walker
   * re-timing is a genuine no-op — the explicit guard below makes that local.
   *
   * Mechanism is a TIMING shift, not a spawn-distance scale: the path is an
   * absolute-timed FollowTrajectory, so moving the spawn only nudges the
   * teleport start — shifting the waypoint times is what actually delays the
   * subject's arrival (mirrors the walker re-timing).
   */
  (input) => {
    if (input.npcOnly) return null; // NPC-only contract: never move the subject.
    const delta = timingDeltaSeconds(input.metrics, input.expectedArrivalTimeS);
    if (delta === null || !isPlausibleTimingMiss(input.metrics)) return null;
    if (Math.abs(delta) < 0.1) return null;
    const walker = input.draft.actors.find(
      (a) => a.placement_mode === "timed_path" && a.role === "pedestrian",
    );
    if (!walker) return null; // subject-retiming is the pedestrian-no-NPC fallback.
    const hasNpcVehicle = input.draft.actors.some(
      (a) => a.role !== "subject" && a.role !== "pedestrian" && a.placement_mode === "timed_path",
    );
    if (hasNpcVehicle) return null; // adjustments 1-2 own the NPC case.
    // Only when the walker itself can't be re-timed (adjustment 3 was a no-op).
    if (shiftWalkerTiming(walker, -delta) !== null) return null;
    const subject = input.draft.actors.find((a) => a.id === input.subjectActorId);
    if (!subject) return null;
    // delta = min_distance.t − plannedArrival. Shift the subject's whole path by
    // +delta so it arrives `delta`s later (delta>0) / earlier (delta<0) — i.e.
    // exactly when the walker reaches the conflict point.
    const adjusted = shiftWalkerTiming(subject, delta);
    if (!adjusted) return null; // subject can't move earlier (already at t=0) → give up.
    return {
      draft: {
        ...input.draft,
        actors: input.draft.actors.map((a) => (a.id === subject.id ? adjusted : a)),
      },
      kind: "retime_subject",
      notes: `No NPC and walker re-timing was a no-op; retimed subject by ${delta.toFixed(2)}s to meet the walker's actual arrival (${input.metrics.min_distance!.t.toFixed(2)}s vs planned ${input.expectedArrivalTimeS.toFixed(2)}s).`,
    };
  },
];

export function applyDeterministicRepair(input: RepairInput): RepairResult | null {
  for (const attempt of APPLY_ORDER) {
    const result = attempt(input);
    if (result) return result;
  }
  return null;
}

// Exposed for unit tests so the orchestrator's "I tried scale_spawn but it
// was a no-op" branch can be exercised directly.
export const __testing = { scaleSpawnDistance, adjustSpeedKph, shiftWalkerTiming };
