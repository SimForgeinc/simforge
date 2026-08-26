/**
 * Maps a deterministic planner result (`PlanCollisionRoutesResult`) into
 * minimal `ScenarioEditorActorDraft` objects, using the SAME field mapping
 * the production builder applies on its planner-happy-path
 * (`collision-scenario-builder.ts`): vehicles and walkers ride
 * `placement_mode: "timed_path"` with concrete spawn/waypoint geometry.
 *
 * This lets the builder's deterministic auto-repair loop validate a tuned
 * plan WITHOUT re-running the full (DB-bound) actor assembly, and lets
 * tests exercise the exact draft shape the simulator will judge.
 */
import {
  CARLA_UE5_WALKER_BLUEPRINTS,
  DEFAULT_REACTION_AGGRESSIVENESS,
  TIMED_INSTRUCTION_PRIMITIVE_FOR_JUNCTION_DIRECTION,
  type ScenarioEditorActorDraft,
  type TimedInstructions,
} from "@simforge-oss/studio-shared";
import { PEDESTRIAN_LIMITS } from "@simforge-oss/engine";
import {
  ADULT_RUN_SPEED_MPS,
  conflictWalkerBlueprint,
  walkerProfileSpec,
  type WalkerProfile,
} from "@/app/lib/llm/scenario-generation/walker-profile";
import {
  spawnYawDegFromPlannedPath,
  type PlannedActor,
  type PlannedWalker,
  type PlanCollisionRoutesResult,
} from "@/app/lib/llm/scenario-generation/collision-route-planner";
import { finalizeGeneratedActorBehaviors } from "@/app/lib/scenario-generation/generated-actor-behavior";
import { DRIVEWAY_TURN_ENTRY_SPEED_MPS } from "@/app/lib/llm/scenario-generation/planner/turn-ped-crosswalk-planner";

const WALKER_ACCELERATION_MPS2 = PEDESTRIAN_LIMITS.accelMax;

function emptyNonRoadSpawnAnchor(): ScenarioEditorActorDraft["spawn"] {
  return { road_id: "", s_fraction: 0.5, lane_id: null, section_id: null };
}

/**
 * The walker's crossing pace (km/h) implied by its authored schedule — the
 * speed/time of its longest moving segment (the actual crossing, past the
 * curb-hold). Driving the draft at this pace makes the walker honor the planned
 * waypoint times so it reaches the conflict point when the subject does.
 */
function walkerCrossingSpeedKph(
  waypoints: ReadonlyArray<{ x: number; y: number; time: number }>,
  spawnPoint: { x: number; y: number },
): number {
  const FALLBACK_KPH = 4.68; // ~1.3 m/s, the planner's default walker speed
  let bestDist = 0;
  let bestKph = FALLBACK_KPH;
  let prev: { x: number; y: number; time: number } = { ...spawnPoint, time: 0 };
  for (const wp of waypoints) {
    const dist = Math.hypot(wp.x - prev.x, wp.y - prev.y);
    const dt = wp.time - prev.time;
    if (dist > bestDist && dist > 0.5 && dt > 0.1) {
      bestDist = dist;
      bestKph = (dist / dt) * 3.6;
    }
    prev = wp;
  }
  return bestKph;
}

function timedWaypointsForPlanned(
  planned: PlannedActor,
): NonNullable<ScenarioEditorActorDraft["timed_waypoints"]> {
  const speedMps = Math.max(0.1, planned.expectedSpeedKph / 3.6);
  let elapsed = 0;
  return planned.waypoints.slice(1).map((waypoint, index) => {
    const previous = planned.waypoints[index] ?? planned.spawnPoint;
    elapsed += Math.hypot(waypoint.x - previous.x, waypoint.y - previous.y) / speedMps;
    return {
      x: waypoint.x,
      y: waypoint.y,
      time: elapsed,
      speed_kph: planned.expectedSpeedKph,
    };
  });
}

/**
 * Append a planned actor's post-conflict continuation (the gate chain past the
 * conflict point — exit-lane centerline for a turner, through-lane for a crosser)
 * to its draft `timed_waypoints`, retimed at the actor's expected speed. No-op when
 * the plan carries no continuation or the draft has no waypoints.
 */
function appendPostConflictWaypoints(
  draft: ScenarioEditorActorDraft,
  planned: PlannedActor,
): void {
  const post = planned.postConflictWaypoints;
  const tw = draft.timed_waypoints;
  if (!post || post.length < 2 || !tw || tw.length === 0) return;
  const speedMps = Math.max(0.1, planned.expectedSpeedKph / 3.6);
  let prev = tw[tw.length - 1]!;
  let elapsed = prev.time;
  const extra: NonNullable<ScenarioEditorActorDraft["timed_waypoints"]> = [];
  for (const p of post) {
    const step = Math.hypot(p.x - prev.x, p.y - prev.y);
    if (step < 0.3) continue; // skip the duplicate conflict point / tiny steps
    elapsed += step / speedMps;
    extra.push({ x: p.x, y: p.y, time: elapsed, speed_kph: planned.expectedSpeedKph });
    prev = { x: p.x, y: p.y, time: elapsed };
  }
  if (extra.length > 0) draft.timed_waypoints = [...tw, ...extra];
}

/** Fix 2 (dib 2026-07-23 US avoidance review): pull-in speed (km/h) for the last
 *  authored segment before a terminal stop, so the subject EASES into the driveway /
 *  bay instead of arriving at the curvature-retimed cruise and slamming to 0. */
const TERMINAL_STOP_PULL_IN_KPH = 8;
/** Minimum stationary hold authored at a terminal stop. */
const TERMINAL_STOP_MIN_HOLD_S = 1;
/** The authored path must actually REACH the terminal point for the hold to be
 *  appended — the contact variant's path ends at the conflict, metres short. */
const TERMINAL_STOP_REACH_M = 1.5;

/**
 * Fix 2 — make a plan that ENDS in a deliberate stop actually terminate there
 * (dib 2026-07-23: "the subject must stop once it's situated in the driveway and not
 * try to go past it"; "subject drives into a fence at the end"). Two effects:
 *
 *   1. `terminal_stop` on the draft — read by `extendActorPathsBeyondConflict`,
 *      which otherwise appends ≥40 m of lane-following run-out past EVERY
 *      vehicle's last waypoint and drove the parked subject back out of the
 *      driveway / lot into the garage, fence or barrier behind it.
 *   2. A stationary HOLD waypoint at the stop point (same position, +holdS,
 *      speed 0) — the validated parking-probe pattern that halts pursuit
 *      parked — preceded by a pull-in crawl on the final segment.
 *
 * Runs AFTER `retimeWithCurvature` (which dedupes near-duplicate points and
 * rebuilds times from geometry, and would otherwise eat the hold).
 */
function applyTerminalStop(
  draft: ScenarioEditorActorDraft,
  planned: PlannedActor,
  opts: {
    /**
     * AVOIDED variant: the path is authored THROUGH the stop, so an
     * unreachable stop is a defect — leave `terminal_stop` unset and let the
     * run-out extension give the subject a legal continuation (codex 2026-07-28
     * finding 2: marker-before-reach-check suppressed run-out with no hold).
     * CONTACT variant (`reachRequired: false`): the path deliberately ends AT
     * the conflict, metres short — the collision consumes the maneuver, and
     * the marker must still suppress run-out past the planned contact.
     */
    reachRequired: boolean;
  },
): void {
  const stop = planned.terminalStop;
  if (!stop) return;
  if (!opts.reachRequired) (draft as Record<string, unknown>).terminal_stop = true;
  // Fix 3 (dib 2026-07-24 review #2, leftped-1774-7 / rightped-1362-0): a
  // DRIVEWAY turn-in is sharper than a through-junction turn, so the shared
  // TURN_ENTRY_SPEED_MPS (5.0) clamp still overshoots into the driveway. Author
  // a lower per-actor turn-entry speed onto the subject spec; the worker's turn
  // clamp reads it (`_arm_turn_speed_clamp`, `turn_entry_speed_mps`). Only the
  // driveway ending gets it — the curbside-park ending is a normal street turn.
  if (stop.reason === "driveway") {
    (draft as Record<string, unknown>).turn_entry_speed_mps = DRIVEWAY_TURN_ENTRY_SPEED_MPS;
  }
  const tw = draft.timed_waypoints;
  if (!tw || tw.length === 0) return;
  const last = tw[tw.length - 1]!;
  if (Math.hypot(last.x - stop.point.x, last.y - stop.point.y) > TERMINAL_STOP_REACH_M) return;
  // The pull-in ease is baked into the retime profile itself (the retime call
  // sites pass `endSpeedMps` for terminal-stop plans, so the backward accel
  // pass lays a bounded decel ramp all the way into the stop). The profile
  // floors at TURN_MIN_SPEED_MPS though ("keep the maneuver alive"), so the
  // schedule still ARRIVES at ~2.2 m/s and the hold would drop it to 0 in one
  // tick — at a stop-at-mouth driveway that seam coincides with the planned
  // contact and sits inside the lint window (jerk 31-44 m/s³, Belmont 1577).
  // FINAL BRAKE RAMP: re-time the trailing ~3 m from the arrival speed down to
  // a creep, so the hold transition is a ~0.3 m/s step the lint reads as a
  // normal stop.
  const BRAKE_M = 4.0;
  const CREEP_MPS = 0.3;
  let backArc = 0;
  let k = tw.length - 1;
  while (k > 0 && backArc < BRAKE_M) {
    backArc += Math.hypot(tw[k]!.x - tw[k - 1]!.x, tw[k]!.y - tw[k - 1]!.y);
    k -= 1;
  }
  const n = tw.length - 1 - k;
  if (n >= 1) {
    const dtIn = k > 0 ? tw[k]!.time - tw[k - 1]!.time : 0;
    const dIn = k > 0 ? Math.hypot(tw[k]!.x - tw[k - 1]!.x, tw[k]!.y - tw[k - 1]!.y) : 0;
    const vIn = Math.max(
      CREEP_MPS,
      dtIn > 1e-6 && dIn > 1e-6 ? dIn / dtIn : TERMINAL_STOP_PULL_IN_KPH / 3.6,
    );
    // TIME-RESAMPLE the ramp (constant decel in v² over the trailing arc):
    // re-timing the EXISTING vertices leaves ~0.4 m spacing, and at creep
    // speeds a 0.4 m vertex is a whole-second segment whose boundary speed
    // step still reads as 16-22 m/s³ of jerk. Emitting every ~0.2 s keeps each
    // replayed step at ~a·dt.
    const tail = tw.slice(k);
    const cum: number[] = [0];
    for (let i = 1; i < tail.length; i += 1) {
      cum.push(
        cum[i - 1]! +
          Math.hypot(tail[i]!.x - tail[i - 1]!.x, tail[i]!.y - tail[i - 1]!.y),
      );
    }
    const totalArc = cum[cum.length - 1]!;
    if (totalArc > 0.3) {
      const posAt = (s: number): { x: number; y: number } => {
        for (let i = 1; i < tail.length; i += 1) {
          if (cum[i]! >= s) {
            const seg = cum[i]! - cum[i - 1]!;
            const f = seg > 1e-9 ? (s - cum[i - 1]!) / seg : 0;
            return {
              x: tail[i - 1]!.x + (tail[i]!.x - tail[i - 1]!.x) * f,
              y: tail[i - 1]!.y + (tail[i]!.y - tail[i - 1]!.y) * f,
            };
          }
        }
        return { x: tail[tail.length - 1]!.x, y: tail[tail.length - 1]!.y };
      };
      const vAt = (s: number): number =>
        Math.max(
          CREEP_MPS,
          Math.sqrt(
            Math.max(0, vIn * vIn + ((CREEP_MPS ** 2 - vIn * vIn) * s) / totalArc),
          ),
        );
      const RAMP_EMIT_DT_S = 0.2;
      const RAMP_FINE_M = 0.1;
      const ramp: NonNullable<ScenarioEditorActorDraft["timed_waypoints"]> = [];
      let t = tw[k]!.time;
      let sinceEmit = 0;
      let s = 0;
      while (s < totalArc - 1e-9) {
        const step = Math.min(RAMP_FINE_M, totalArc - s);
        const vMid = vAt(s + step / 2);
        s += step;
        const dt = step / vMid;
        t += dt;
        sinceEmit += dt;
        const isFinal = s >= totalArc - 1e-9;
        if (sinceEmit >= RAMP_EMIT_DT_S || isFinal) {
          const p = isFinal ? { x: tail[tail.length - 1]!.x, y: tail[tail.length - 1]!.y } : posAt(s);
          ramp.push({
            x: p.x,
            y: p.y,
            time: t,
            speed_kph: Math.round(vAt(s) * 3.6 * 100) / 100,
          });
          sinceEmit = 0;
        }
      }
      draft.timed_waypoints = [...tw.slice(0, k + 1), ...ramp];
    }
  }
  const finalTw = draft.timed_waypoints!;
  const settled = finalTw[finalTw.length - 1]!;
  finalTw.push({
    x: settled.x,
    y: settled.y,
    time: settled.time + Math.max(TERMINAL_STOP_MIN_HOLD_S, stop.holdS),
    speed_kph: 0,
  });
  // Only NOW mark the draft: `extendActorPathsBeyondConflict` skips any actor
  // with `terminal_stop`, so setting it before the reach check suppressed the
  // run-out tail on paths that never got the hold — a truncated end with no
  // stop and no legal continuation. Unreachable stop → no marker → the normal
  // run-out extension applies.
  (draft as Record<string, unknown>).terminal_stop = true;
}

// Junction-window smoothing (post-turn centering, dib 2026-07-10): how far around
// the conflict point gets Chaikin-rounded + densified.
const JUNCTION_WINDOW_BEFORE_M = 12;
const JUNCTION_WINDOW_AFTER_M = 25;
const JUNCTION_RESAMPLE_M = 2.0;

/**
 * Round the arc→exit tangent kink at the conflict and densify targets so pursuit
 * exits the turn centered instead of overshooting outward and converging late.
 * Operates on the subject's timed_waypoints GEOMETRY only (positions); timestamps are
 * rebuilt afterwards by retimeWithCurvature, so run this BEFORE it. The window is
 * anchored at the subject's planned conflict arc-length (end of the pre-append path).
 */
function smoothJunctionWindow(
  draft: ScenarioEditorActorDraft,
  planned: PlannedActor,
): void {
  const tw = draft.timed_waypoints;
  if (!tw || tw.length < 4) return;
  // Conflict sits at the planned path's end (before the exit append) — locate it
  // by arc length along the CURRENT waypoints.
  const conflictArc = planned.arcLengthM;
  const cum: number[] = [0];
  for (let i = 1; i < tw.length; i += 1) {
    cum.push(cum[i - 1]! + Math.hypot(tw[i]!.x - tw[i - 1]!.x, tw[i]!.y - tw[i - 1]!.y));
  }
  const total = cum[cum.length - 1]!;
  const winStart = Math.max(0, conflictArc - JUNCTION_WINDOW_BEFORE_M);
  const winEnd = Math.min(total, conflictArc + JUNCTION_WINDOW_AFTER_M);
  if (winEnd - winStart < 4) return;
  const inWindow = (arc: number) => arc >= winStart && arc <= winEnd;
  // Split into prefix / window / suffix by arc.
  const prefix: typeof tw = [];
  let window: Array<{ x: number; y: number }> = [];
  const suffix: typeof tw = [];
  for (let i = 0; i < tw.length; i += 1) {
    if (cum[i]! < winStart) prefix.push(tw[i]!);
    else if (inWindow(cum[i]!)) window.push({ x: tw[i]!.x, y: tw[i]!.y });
    else suffix.push(tw[i]!);
  }
  if (window.length < 3) return;
  // Two Chaikin corner-cutting passes round the kink (endpoint-preserving).
  for (let pass = 0; pass < 2; pass += 1) {
    const out = [window[0]!];
    for (let i = 0; i < window.length - 1; i += 1) {
      const a = window[i]!;
      const b = window[i + 1]!;
      out.push({ x: 0.75 * a.x + 0.25 * b.x, y: 0.75 * a.y + 0.25 * b.y });
      out.push({ x: 0.25 * a.x + 0.75 * b.x, y: 0.25 * a.y + 0.75 * b.y });
    }
    out.push(window[window.length - 1]!);
    window = out;
  }
  // Resample the smoothed window at ~2 m so pursuit gets dense targets.
  const dense: Array<{ x: number; y: number }> = [window[0]!];
  let acc = 0;
  for (let i = 1; i < window.length; i += 1) {
    const step = Math.hypot(window[i]!.x - window[i - 1]!.x, window[i]!.y - window[i - 1]!.y);
    acc += step;
    if (acc >= JUNCTION_RESAMPLE_M) {
      dense.push(window[i]!);
      acc = 0;
    }
  }
  if (dense[dense.length - 1] !== window[window.length - 1]) dense.push(window[window.length - 1]!);
  // Reassemble; times are placeholders (retimeWithCurvature rebuilds them).
  const speed = planned.expectedSpeedKph;
  const rebuilt = [
    ...prefix,
    ...dense.map((p) => ({ x: p.x, y: p.y, time: 0, speed_kph: speed })),
    ...suffix,
  ];
  // Restore monotone provisional times by arc (retime overwrites with the real
  // curvature schedule, but keep them sane in case retime bails).
  let t = prefix.length > 0 ? prefix[prefix.length - 1]!.time : 0;
  const v = Math.max(1, speed / 3.6);
  for (let i = Math.max(1, prefix.length); i < rebuilt.length; i += 1) {
    const step = Math.hypot(rebuilt[i]!.x - rebuilt[i - 1]!.x, rebuilt[i]!.y - rebuilt[i - 1]!.y);
    t += step / v;
    rebuilt[i] = { ...rebuilt[i]!, time: t };
  }
  draft.timed_waypoints = rebuilt;
}

// Comfortable lateral acceleration for the curvature speed cap (m/s^2). ~2.0 is a
// relaxed human left-turn; pursuit tracks the arc cleanly at this envelope.
const TURN_LATERAL_ACCEL_MPS2 = 2.0;
// Never schedule below this through the arc (keeps the maneuver alive).
const TURN_MIN_SPEED_MPS = 2.2;
// Longitudinal accel/decel bound for the retimed speed PROFILE (m/s²). The old
// one-neighbor ramp let the schedule step from cruise to the arc cap across a
// single ~2-4 m segment — a 8-30 m/s² decel + 10-120 m/s³ jerk in the replayed
// preview frames, which the M1.2 kinematic lint (draft-validator hard gate)
// rightly failed: EVERY curvature-retimed turn draft was rejected and the turn
// families emitted ZERO scenes (P-3, dib 2026-07-27). A proper forward/backward
// pass bounds the profile to this comfort envelope (decel warn is 3.5, viol 9;
// jerk viol 10 m/s³), which is also far closer to what the worker's controller
// actually drives.
const TURN_LONG_ACCEL_MPS2 = 1.2;
// Mirror of the lint engine's DEFAULT_LINT_CONFIG.smoothingWindowS: the lint
// derives yaw-rate/accel from a 0.4 s local regression, so an ISOLATED heading
// or speed step of Δ reads as Δ/0.4 — the kink cap + resample step below are
// sized against exactly that measure. Kept in sync by hand (this module must
// not depend on the lint engine).
const LINT_SMOOTHING_WINDOW_S = 0.4;
// Lateral-accel target at polyline kinks (below the lint warn 3 / violation 6).
const KINK_LATERAL_TARGET_MPS2 = 2.5;

/**
 * Retime a draft's `timed_waypoints` with a curvature-aware speed profile:
 * per-vertex speed = min(cruise, sqrt(a_lat_max / curvature)), times recomputed
 * cumulatively. On the straight approach curvature≈0 → cruise → the original
 * schedule is preserved (conflict setup timing intact); through the junction arc
 * the schedule slows to a comfortable lateral-g, so the worker's pursuit — which
 * chases the SCHEDULED point — stops corner-cutting/overshooting onto the curb
 * (dib 2026-07-09: "left-turns need to be a bit smoother" + curb clips). The
 * neighbouring-vertex min gives a short decel ramp INTO each tight section.
 */
/**
 * Near-duplicate points (the post-conflict continuation rejoins the chain AT the
 * conflict point; Chaikin can also emit sub-cm steps) become 0.00s segments after
 * the worker's time rounding and fail spec validation with
 * `invalid_actor_timed_path_speed` ("... kph over 0.00s" — r6: 5/24 scenes blocked,
 * subject AND conflict NPC). Drop any point closer than 0.25m to its predecessor,
 * always keeping the final point. Kept points keep their authored times, so the
 * conflict sync is untouched.
 */
function dedupeCloseWaypoints(draft: ScenarioEditorActorDraft): void {
  const tw = draft.timed_waypoints;
  if (!tw || tw.length < 2) return;
  const deduped = [tw[0]!];
  for (let i = 1; i < tw.length; i += 1) {
    const prev = deduped[deduped.length - 1]!;
    const cur = tw[i]!;
    if (Math.hypot(cur.x - prev.x, cur.y - prev.y) >= 0.25) {
      deduped.push(cur);
    } else if (i === tw.length - 1 && deduped.length > 1) {
      deduped[deduped.length - 1] = cur; // keep the true endpoint
    }
  }
  draft.timed_waypoints = deduped;
}

/**
 * Per-vertex curvature-aware speed caps over a bare polyline: cruise on the
 * straights, `sqrt(a_lat / curvature)` (Menger) through arcs, plus the KINK cap
 * for sharp lane-joint corners between long segments.
 *
 * Shared by `retimeWithCurvature` (the pre-conflict schedule) and the run-out
 * tail retime in `extend-actor-paths.ts`. The tail case is why this is
 * exported: `extendActorPathsBeyondConflict` runs AFTER the retime and used to
 * append its lane-following tail at CONSTANT cruise — so a subject that had been
 * carefully slowed for its junction was scheduled straight back to ~8.3 m/s at
 * the junction EXIT and through every downstream connector the tail traverses.
 * Measured on the retained 32-scene turn corpus (#486): the feasibility gate
 * rejected 18/32 scenes and every violation was a tail vertex at cruise. The
 * live symptom is dib's 2026-08-02 Munich review: "right turns grazing the
 * left curb ... mounted the left-curb after the right turn due to overshooting"
 * (munich/bicyclistavoid/right-2186-2) — the overshoot is the exit, which is
 * exactly where the tail begins.
 */
export function curvatureSpeedCapsMps(
  pts: ReadonlyArray<{ x: number; y: number }>,
  cruiseMps: number,
): number[] {
  const caps = pts.map(() => cruiseMps);
  for (let i = 1; i < pts.length - 1; i += 1) {
    const p0 = pts[i - 1]!;
    const p1 = pts[i]!;
    const p2 = pts[i + 1]!;
    const a = Math.hypot(p1.x - p0.x, p1.y - p0.y);
    const b = Math.hypot(p2.x - p1.x, p2.y - p1.y);
    const c = Math.hypot(p2.x - p0.x, p2.y - p0.y);
    if (a < 1e-3 || b < 1e-3 || c < 1e-3) continue;
    const area2 = Math.abs((p1.x - p0.x) * (p2.y - p0.y) - (p2.x - p0.x) * (p1.y - p0.y));
    const curvature = (2 * area2) / (a * b * c);
    if (curvature >= 1e-4) {
      caps[i] = Math.max(
        TURN_MIN_SPEED_MPS,
        Math.min(cruiseMps, Math.sqrt(TURN_LATERAL_ACCEL_MPS2 / curvature)),
      );
    }
    // KINK cap (P-3): Menger spreads a sharp corner's angle over the chord, so
    // a lane-joint kink between two LONG segments barely registers — the actor
    // corners a ~20° joint at cruise and the replayed track reads ~7 m/s² of
    // lateral accel (lint: yaw step / smoothing window × speed). Cap the speed
    // so v·Δθ/window stays inside the comfort target at every vertex.
    const hIn = Math.atan2(p1.y - p0.y, p1.x - p0.x);
    const hOut = Math.atan2(p2.y - p1.y, p2.x - p1.x);
    let dTheta = Math.abs(hOut - hIn);
    if (dTheta > Math.PI) dTheta = 2 * Math.PI - dTheta;
    if (dTheta > 1e-3) {
      caps[i] = Math.max(
        TURN_MIN_SPEED_MPS,
        Math.min(caps[i]!, (KINK_LATERAL_TARGET_MPS2 * LINT_SMOOTHING_WINDOW_S) / dTheta),
      );
    }
  }
  return caps;
}

/**
 * Curvature-aware, accel-bounded speed profile for an APPENDED run-out tail.
 *
 * `pts[0]` is the boundary — the planned path's final waypoint, whose TIME the
 * caller must not change — and `pts[1..]` are the appended tail vertices. The
 * returned array is per-vertex speed (m/s), same length as `pts`:
 *
 *  - entry speed seeds the profile at the boundary (the speed the planned
 *    schedule actually arrives with, so a subject that yielded to 2 m/s ramps out
 *    at the comfort accel instead of teleporting to cruise),
 *  - per-vertex caps from `curvatureSpeedCapsMps` keep the schedule slow
 *    through every downstream connector the tail traverses,
 *  - a backward pass bounds the DECEL into each slow vertex and a forward pass
 *    bounds the ACCEL out of it (same `TURN_LONG_ACCEL_MPS2` envelope as the
 *    pre-conflict retime), so the tail schedule is trackable, not a step.
 *
 * The backward pass may bound the boundary vertex's speed below the entry
 * speed; that only lengthens the FIRST TAIL SEGMENT's duration (its time is
 * free), never the planned schedule.
 */
export function tailSpeedProfileMps(
  pts: ReadonlyArray<{ x: number; y: number }>,
  cruiseMps: number,
  entrySpeedMps: number,
): number[] {
  const cruise = Math.max(TURN_MIN_SPEED_MPS, cruiseMps);
  const profile = curvatureSpeedCapsMps(pts, cruise);
  profile[0] = Math.min(profile[0]!, Math.max(TURN_MIN_SPEED_MPS, entrySpeedMps));
  for (let i = profile.length - 2; i >= 0; i -= 1) {
    const d = Math.hypot(pts[i + 1]!.x - pts[i]!.x, pts[i + 1]!.y - pts[i]!.y);
    profile[i] = Math.min(profile[i]!, Math.sqrt(profile[i + 1]! ** 2 + 2 * TURN_LONG_ACCEL_MPS2 * d));
  }
  for (let i = 1; i < profile.length; i += 1) {
    const d = Math.hypot(pts[i]!.x - pts[i - 1]!.x, pts[i]!.y - pts[i - 1]!.y);
    profile[i] = Math.min(profile[i]!, Math.sqrt(profile[i - 1]! ** 2 + 2 * TURN_LONG_ACCEL_MPS2 * d));
  }
  for (let i = 0; i < profile.length; i += 1) {
    profile[i] = Math.max(TURN_MIN_SPEED_MPS, profile[i]!);
  }
  return profile;
}

function retimeWithCurvature(
  draft: ScenarioEditorActorDraft,
  cruiseKph: number,
  opts?: {
    /** Terminal-stop plans: the profile must ARRIVE at this speed (the pull-in
     *  crawl), so the backward accel pass builds the full bounded decel ramp
     *  into the arrival — a post-hoc ease re-time can only step coarsely across
     *  the trailing vertices, which the lint reads as jerk. */
    endSpeedMps?: number;
  },
): void {
  dedupeCloseWaypoints(draft);
  const tw = draft.timed_waypoints;
  // 2-point paths have no curvature but still need the constant-branch time
  // rebuild (the P-3 NPC reconcile iterates cruise on straight NPC paths).
  if (!tw || tw.length < 2) return;
  const cruise = Math.max(TURN_MIN_SPEED_MPS, cruiseKph / 3.6);
  // Per-vertex curvature (Menger) + kink speed caps — shared with the run-out
  // tail retime; see curvatureSpeedCapsMps.
  const caps = curvatureSpeedCapsMps(tw, cruise);
  // Terminal-stop arrival speed: cap the FINAL vertex so the accel passes lay a
  // proper bounded decel ramp into the stop (see opts.endSpeedMps).
  if (opts?.endSpeedMps != null) {
    caps[caps.length - 1] = Math.max(
      TURN_MIN_SPEED_MPS,
      Math.min(caps[caps.length - 1]!, opts.endSpeedMps),
    );
  }
  // Accel-limited speed profile (P-3): a backward pass bounds the DECEL into
  // each slow vertex (v_i ≤ sqrt(v_{i+1}² + 2·a·d)) and a forward pass bounds
  // the ACCEL out of it, so the schedule ramps over the real ramp distance
  // instead of snapping across one segment (the kinematic-lint hard-fail).
  const smoothed = caps.slice();
  for (let i = smoothed.length - 2; i >= 0; i -= 1) {
    const d = Math.hypot(tw[i + 1]!.x - tw[i]!.x, tw[i + 1]!.y - tw[i]!.y);
    smoothed[i] = Math.min(
      smoothed[i]!,
      Math.sqrt(smoothed[i + 1]! ** 2 + 2 * TURN_LONG_ACCEL_MPS2 * d),
    );
  }
  for (let i = 1; i < smoothed.length; i += 1) {
    const d = Math.hypot(tw[i]!.x - tw[i - 1]!.x, tw[i]!.y - tw[i - 1]!.y);
    smoothed[i] = Math.min(
      smoothed[i]!,
      Math.sqrt(smoothed[i - 1]! ** 2 + 2 * TURN_LONG_ACCEL_MPS2 * d),
    );
  }
  // Constant-cruise profile (straight path): keep the classic per-vertex output
  // — byte-identical to the pre-P-3 behavior for every non-turn draft.
  if (smoothed.every((v) => v >= cruise - 0.05)) {
    // Spawn-leg seam: the implicit spawn→tw[0] leg replays at d0/tw[0].time.
    // Re-time tw[0] at THIS cruise so the seam is continuous — for a schedule
    // authored at the same cruise this reproduces the original value exactly
    // (byte-stable); after a prior retime pass at a DIFFERENT cruise (the NPC
    // reconcile iterates) it removes the leftover speed step the lint flags.
    const spawnPt = draft.spawn_point;
    if (spawnPt && tw[0]!.time > 1e-6) {
      const dSpawn = Math.hypot(tw[0]!.x - spawnPt.x, tw[0]!.y - spawnPt.y);
      if (dSpawn > 1e-6) tw[0] = { ...tw[0]!, time: dSpawn / cruise };
    }
    let t = tw[0]!.time;
    const out = [tw[0]!];
    for (let i = 1; i < tw.length; i += 1) {
      const prev = tw[i - 1]!;
      const cur = tw[i]!;
      const step = Math.hypot(cur.x - prev.x, cur.y - prev.y);
      const v = Math.max(TURN_MIN_SPEED_MPS, Math.min(smoothed[i - 1]!, smoothed[i]!));
      t += step / v;
      out.push({ ...cur, time: t, speed_kph: v * 3.6 });
    }
    draft.timed_waypoints = out;
    return;
  }
  // Varying profile (a real arc): TIME-RESAMPLE the schedule (P-3). The
  // kinematic sim replays a timed_path by LINEAR position interpolation, so the
  // speed it sees is constant per segment and every speed change lands in ONE
  // tick at a vertex. On sparse vertices that reads as a 12-76 m/s³ jerk /
  // 9-30 m/s² decel spike and the M1.2 lint hard-fails the draft (the zero-
  // draft turn emits). Emitting waypoints every ~RESAMPLE_DT_S along the
  // accel-limited profile (v² linear in arc between vertices ⇒ constant accel)
  // bounds each per-vertex speed step to ~a·dt — a genuinely smooth replay.
  const RESAMPLE_DT_S = 0.15;
  const FINE_STEP_M = 0.25;
  // The profile DOMAIN includes the implicit spawn→first-waypoint leg (the sim
  // prepends the spawn at t=0). Without it, any decel ramp reaching the route
  // start begins abruptly AT the first waypoint — an accel step (0 → −a) inside
  // the lint's boundary window that reads as a ~10 m/s³ jerk spike. With the
  // spawn in the domain, the ramp is already in progress at t=0 — no step.
  // Include the spawn leg whenever it has ANY length: its traversal time must
  // be in the schedule (on dense real-map polylines the first vertex sits
  // ~0.2 m from the spawn — dropping that leg's ~0.03 s made the sim's first
  // segment read ~1.6 m/s fast, a boundary step the lint saw as 22 m/s³ jerk).
  const spawn = draft.spawn_point;
  const d0 = spawn ? Math.hypot(tw[0]!.x - spawn.x, tw[0]!.y - spawn.y) : 0;
  const hasSpawnLeg = spawn != null && d0 > 1e-6;
  const pts: Array<{ x: number; y: number }> = hasSpawnLeg
    ? [{ x: spawn!.x, y: spawn!.y }, ...tw]
    : [...tw];
  const prof: number[] = hasSpawnLeg ? [cruise, ...smoothed] : [...smoothed];
  // Re-run the accel passes over the extended domain (only lowers values).
  for (let i = prof.length - 2; i >= 0; i -= 1) {
    const d = Math.hypot(pts[i + 1]!.x - pts[i]!.x, pts[i + 1]!.y - pts[i]!.y);
    prof[i] = Math.min(prof[i]!, Math.sqrt(prof[i + 1]! ** 2 + 2 * TURN_LONG_ACCEL_MPS2 * d));
  }
  for (let i = 1; i < prof.length; i += 1) {
    const d = Math.hypot(pts[i]!.x - pts[i - 1]!.x, pts[i]!.y - pts[i - 1]!.y);
    prof[i] = Math.min(prof[i]!, Math.sqrt(prof[i - 1]! ** 2 + 2 * TURN_LONG_ACCEL_MPS2 * d));
  }
  const speedAt = (i: number, frac: number): number => {
    const v0 = prof[i]!;
    const v1 = prof[i + 1] ?? v0;
    return Math.sqrt(Math.max(TURN_MIN_SPEED_MPS ** 2, v0 * v0 + (v1 * v1 - v0 * v0) * frac));
  };
  const out: NonNullable<ScenarioEditorActorDraft["timed_waypoints"]> = [];
  let t = 0; // the domain starts at the spawn (t=0); times integrate from there
  let sinceEmitS = 0;
  for (let i = 0; i < pts.length - 1; i += 1) {
    const a = pts[i]!;
    const b = pts[i + 1]!;
    const segLen = Math.hypot(b.x - a.x, b.y - a.y);
    if (segLen < 1e-9) continue;
    const steps = Math.max(1, Math.ceil(segLen / FINE_STEP_M));
    for (let s = 1; s <= steps; s += 1) {
      const f0 = (s - 1) / steps;
      const f1 = s / steps;
      const vMid = speedAt(i, (f0 + f1) / 2);
      const dt = (segLen / steps) / vMid;
      t += dt;
      sinceEmitS += dt;
      const isFinal = i === pts.length - 2 && s === steps;
      if (sinceEmitS >= RESAMPLE_DT_S || isFinal) {
        out.push({
          x: isFinal ? b.x : a.x + (b.x - a.x) * f1,
          y: isFinal ? b.y : a.y + (b.y - a.y) * f1,
          time: t,
          speed_kph: Math.round(speedAt(i, f1) * 3.6 * 100) / 100,
        });
        sinceEmitS = 0;
      }
    }
  }
  if (out.length >= 2) draft.timed_waypoints = out;
}

/** The subject's junction maneuver, when the family turns the subject through it. */
export type SubjectTurn = "left" | "right" | null;

/**
 * A timed-instruction turn primitive for the subject of a turn-collision family.
 *
 * The "drunk driving" turns (2026-06-17 review) came from driving the subject's
 * junction arc as a SPARSE `timed_path` polyline replayed by worker pure-pursuit
 * — the controller can't track the arc and the subject mounts curbs / goes off-road.
 * The fix is the CARLA-native `turn_*_at_next_intersection` primitive (the same
 * one the nominal generator uses): the worker drives the subject via the traffic
 * manager with a forced turn at the junction, a kinematically-valid maneuver.
 *
 * We KEEP the planned `timed_path` waypoints on the draft so the kinematic gate
 * still validates collision timing against the planned arc. At the generator
 * boundary the primitive is migrated through the shared mapping into a
 * `turn_at_next_intersection` behavior clip, which takes control when it fires.
 */
function subjectTurnInstructionIntents(
  direction: "left" | "right",
  speedKph: number,
): TimedInstructions["intent"] {
  return [
    {
      id: "tii_collision_subject_turn",
      timestampSeconds: 0,
      rowOrder: 0,
      enabled: true,
      primitiveId: TIMED_INSTRUCTION_PRIMITIVE_FOR_JUNCTION_DIRECTION[direction],
      args: { speedKph },
      source: "generator",
      validationErrors: [],
    },
  ];
}

/**
 * Walker blueprints for companion pedestrians (the conflict ped keeps a stable
 * blueprint so the validated pair is undisturbed). A small curated pool gives
 * visible variety — different people at the same crossing.
 */
// Drawn from the AVAILABLE 0.10 catalogue, children included. The previous
// hand-written list (0002..0012) was generation-1 (0.9-era) and every id was
// below the image's first entry (0015); companions still appeared because the
// worker substitutes a real walker for an unknown id, but the eight intended
// models collapsed onto seven (0002 and 0011 both landed on 0020), so "a
// distinct blueprint per companion" was not actually being delivered.
//
// Children are deliberately in this pool: a kid walking with an adult is
// ordinary street life, and a COMPANION never carries the family's validated
// conflict geometry — the principal walker does, and is untouched here.
// See packages/shared/src/carla-ue5-walker-blueprints.ts.
const COMPANION_WALKER_BLUEPRINTS = CARLA_UE5_WALKER_BLUEPRINTS;

/** Fixed adult for the conflict ped — see conflictWalkerBlueprint(). Retained
 *  as documentation of the pre-profile default: 0019 is what the worker already
 *  substituted the old (nonexistent) 0001 to, so adult scenes do not re-render. */
const DEFAULT_CONFLICT_WALKER_BLUEPRINT = "walker.pedestrian.0019";
void DEFAULT_CONFLICT_WALKER_BLUEPRINT;

/** Deterministic PRNG (mulberry32) so companion offsets/timing are reproducible. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Standard-normal sample via Box–Muller from a uniform PRNG. */
function gaussian(rng: () => number): number {
  const u = Math.max(1e-9, rng());
  const v = rng();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

type WalkerWaypoint = { x: number; y: number; time: number };

/** Frontend-frame spawn yaw (deg) a crossing walker should face: toward the
 * first waypoint it actually moves to. Without this the worker defaults an unset
 * walker yaw to 0° (facing +x / East) and the ped stands facing whatever is East
 * — often vegetation/off-road during the pre-step-off curb hold (ped-254-2).
 * Mirrors {@link spawnYawDegFromPlannedPath} for vehicles. */
function walkerSpawnYawDeg(
  spawnPoint: { x: number; y: number },
  waypoints: ReadonlyArray<{ x: number; y: number }>,
): number | undefined {
  const norm = (deg: number) => ((((deg + 180) % 360) + 360) % 360) - 180;
  for (const w of waypoints) {
    if (w.x !== spawnPoint.x || w.y !== spawnPoint.y) {
      return norm((Math.atan2(w.y - spawnPoint.y, w.x - spawnPoint.x) * 180) / Math.PI);
    }
  }
  return undefined;
}

function walkerActorDraft(
  id: string,
  label: string,
  blueprint: string,
  spawnPoint: { x: number; y: number },
  waypoints: ReadonlyArray<WalkerWaypoint>,
): ScenarioEditorActorDraft {
  return {
    id,
    label,
    kind: "walker",
    role: "pedestrian",
    is_static: false,
    placement_mode: "timed_path",
    blueprint,
    spawn: emptyNonRoadSpawnAnchor(),
    spawn_point: { x: spawnPoint.x, y: spawnPoint.y },
    spawn_yaw: walkerSpawnYawDeg(spawnPoint, waypoints),
    route: [],
    route_direction: "forward",
    lane_facing: "with_lane",
    destination: null,
    speed_kph: walkerCrossingSpeedKph(waypoints, spawnPoint),
    autopilot: false,
    timeline: [],
    timed_waypoints: waypoints.map((p) => ({ x: p.x, y: p.y, time: p.time })),
    sensors: [],
  } as ScenarioEditorActorDraft;
}

/**
 * Fix E follow-up (dib review 2026-07-23): the AVOIDED subject's draft is
 * curvature-retimed (`retimeWithCurvature` slows the junction arc), so its
 * ACTUAL time at the conflict lands later than the planner's constant-speed
 * ETA the walker's curb-hold was solved against. Left unreconciled, the
 * kinematic gate simulates a ped that has already walked past the conflict
 * when the slowed subject arrives — sub-metre "misses" that rejected exactly the
 * driveway-entrance turn sites the review asked to bring back (their old
 * oblique crossings only "passed" because the subject ran the ped down ALONG the
 * road; the perpendicular clamp made the timing honest). Shift the walker's
 * schedule so it reaches the conflict when the RETIMED subject does: the curb-hold
 * absorbs the delta (grown, or shrunk to zero at most), so the crossing pace
 * is untouched. At runtime the worker's closed-loop trigger
 * (`collision_target_id`) tightens the step-off further.
 */
/**
 * The authored schedule's time at the conflict: the time of the draft waypoint
 * nearest `conflictPoint`. Null when the draft has no timed waypoints. This is
 * the honest "when does the authored subject actually reach the conflict" after
 * curvature retiming — the kinematic gate + provenance should use IT, not the
 * planner's constant-speed ETA (P-3: the gap between the two is what rejected
 * every retimed turn draft as "contact N s off the planned time").
 */
export function draftTimeAtConflict(
  // Null as well as undefined: the subject lookup now reports "no vehicle
  // carries sensors" as null, and that is an ordinary absence here.
  draft: ScenarioEditorActorDraft | null | undefined,
  conflictPoint: { x: number; y: number },
): number | null {
  const tw = draft?.timed_waypoints;
  if (!tw || tw.length === 0) return null;
  let bestD = Infinity;
  for (const p of tw) {
    const d = Math.hypot(p.x - conflictPoint.x, p.y - conflictPoint.y);
    if (d < bestD) bestD = d;
  }
  // EARLIEST waypoint within tolerance of the closest approach — a route whose
  // post-conflict tail loops back near the conflict must not report the later
  // pass as "the" arrival.
  for (const p of tw) {
    if (Math.hypot(p.x - conflictPoint.x, p.y - conflictPoint.y) <= bestD + 0.5) {
      return p.time;
    }
  }
  return null;
}

/**
 * P-3 companion to {@link reconcileWalkerWithRetimedSubject}, for a VEHICLE
 * conflict NPC: the turn subject's curvature-retimed schedule reaches the conflict
 * seconds later than the planner's constant-speed ETA, while the NPC kept the
 * planner's clock — in the kinematic gate's replay they MISS (15/29 Belmont
 * unprotected-left sites: "the requested conflict did not happen").
 *
 * The NPC is re-timed with the same curvature/accel-bounded profile as the subject
 * (its own raw cruise arcs were failing the lateral-accel lint), with the
 * CRUISE solved so it reaches the conflict when the subject does. A naive uniform
 * time-stretch would scale the profile's accelerations by 1/f² and break the
 * accel bound whenever f deviates from 1 — re-timing at a scaled cruise
 * rebuilds the whole profile inside the bound instead. A small residual
 * stretch (≤2%) trues up the meet exactly.
 */
function reconcileNpcWithRetimedSubject(
  npc: ScenarioEditorActorDraft,
  subjectDraft: ScenarioEditorActorDraft,
  collision: PlanCollisionRoutesResult["collision"],
  npcCruiseKph: number,
): void {
  const subjectArrival = draftTimeAtConflict(subjectDraft, collision.conflictPoint);
  let cruiseKph = npcCruiseKph;
  for (let iter = 0; iter < 3; iter += 1) {
    retimeWithCurvature(npc, cruiseKph);
    const npcArrival = draftTimeAtConflict(npc, collision.conflictPoint);
    if (subjectArrival == null || npcArrival == null || npcArrival <= 0.1) return;
    const f = subjectArrival / npcArrival;
    if (Math.abs(f - 1) < 0.02) return; // met (also: straight families no-op)
    // Slower cruise ⇒ later arrival (monotone); clamp to a plausible band.
    cruiseKph = Math.max(4, Math.min(80, cruiseKph / f));
  }
  // Residual (cruise clamped / capped arcs): a small uniform stretch. Bounded
  // to ±20% so a pathological site cannot smuggle a big stretch back in.
  const npcArrival = draftTimeAtConflict(npc, collision.conflictPoint);
  if (subjectArrival == null || npcArrival == null || npcArrival <= 0.1) return;
  const f = Math.max(0.8, Math.min(1.2, subjectArrival / npcArrival));
  if (Math.abs(f - 1) < 0.02) return;
  npc.timed_waypoints = (npc.timed_waypoints ?? []).map((p) => ({
    ...p,
    time: Math.round(p.time * f * 1000) / 1000,
    ...(p.speed_kph != null
      ? { speed_kph: Math.round((p.speed_kph / f) * 1000) / 1000 }
      : {}),
  }));
}

function reconcileWalkerWithRetimedSubject(
  walker: PlannedWalker,
  subjectDraft: ScenarioEditorActorDraft,
  collision: PlanCollisionRoutesResult["collision"],
): PlannedWalker {
  const subjectTw = subjectDraft.timed_waypoints;
  const wps = walker.waypoints;
  if (!subjectTw || subjectTw.length < 2 || wps.length < 2) return walker;
  const P = collision.conflictPoint;
  let subjectArrival: number | null = null;
  let bestD = Infinity;
  for (const p of subjectTw) {
    const d = Math.hypot(p.x - P.x, p.y - P.y);
    if (d < bestD) {
      bestD = d;
      subjectArrival = p.time;
    }
  }
  if (subjectArrival == null) return walker;
  const delta = subjectArrival - collision.arrivalTimeS;
  if (Math.abs(delta) < 0.1) return walker;
  const first = wps[0]!;
  const holdExists = Math.hypot(wps[1]!.x - first.x, wps[1]!.y - first.y) < 1e-6;
  let shifted: WalkerWaypoint[];
  if (delta > 0) {
    // Subject arrives LATER: lengthen (or introduce) the curb-hold.
    const moved = wps.slice(1).map((p) => ({ ...p, time: p.time + delta }));
    shifted = holdExists
      ? [first, ...moved]
      : [first, { ...first, time: first.time + delta }, ...moved];
  } else {
    // Subject arrives EARLIER: shrink the hold, never below zero; a walker with no
    // hold cannot step off earlier than t=0.
    if (!holdExists) return walker;
    const hold = wps[1]!.time - first.time;
    const applied = Math.max(-hold, delta);
    if (applied >= 0) return walker;
    shifted = [first, ...wps.slice(1).map((p) => ({ ...p, time: p.time + applied }))];
  }
  return { ...walker, waypoints: shifted };
}

/** Max distance a companion spawn is snapped onto a mapped sidewalk polyline —
 *  beyond this the parallel corridor stands on its own (P-2.1b). */
const COMPANION_SIDEWALK_SNAP_M = 3.0;

/** Nearest point on any sidewalk polyline within `maxDistM` of `p`, or null. */
function nearestSidewalkPoint(
  p: { x: number; y: number },
  sidewalks: ReadonlyArray<{ polyline: ReadonlyArray<{ x: number; y: number }> }>,
  maxDistM: number,
): { x: number; y: number } | null {
  let best: { x: number; y: number; d2: number } | null = null;
  for (const sw of sidewalks) {
    const poly = sw.polyline;
    for (let i = 1; i < poly.length; i++) {
      const a = poly[i - 1]!;
      const b = poly[i]!;
      const vx = b.x - a.x;
      const vy = b.y - a.y;
      const l2 = vx * vx + vy * vy;
      if (l2 < 1e-12) continue;
      const t = Math.max(0, Math.min(1, ((p.x - a.x) * vx + (p.y - a.y) * vy) / l2));
      const qx = a.x + vx * t;
      const qy = a.y + vy * t;
      const d2 = (p.x - qx) ** 2 + (p.y - qy) ** 2;
      if (!best || d2 < best.d2) best = { x: qx, y: qy, d2 };
    }
  }
  return best && best.d2 <= maxDistM * maxDistM ? { x: best.x, y: best.y } : null;
}

/**
 * Companion pedestrians crossing the SAME location as the conflict ped, to make
 * the crossing read as a real group and raise contact likelihood (workstream H).
 *
 * P-2.1 (dib 2026-07-27, RC-2 "running in place"): companions walk a VALIDATED
 * corridor — a pure parallel offset of the conflict ped's own (already
 * clearance-checked) walk path at ±1.5–2.5 m lateral, clipped to the SAME
 * crossing band. The old along-walk back-shift (0.5–1.2 m behind the spawn)
 * pushed companion paths INTO the curb zone's invisible-to-the-planner street
 * furniture (hedges/fences) where the worker's wall-push escape couldn't free
 * them. Group texture now comes from the time stagger alone. Where a mapped
 * sidewalk runs near the companion's offset spawn, the stationary spawn/hold
 * prefix snaps onto it (the crossing corridor itself is untouched).
 *
 * Each companion is:
 *  - offset along the curb line (perpendicular to the walk direction) so they
 *    line up beside the conflict ped instead of overlapping it;
 *  - started at a Gaussian-jittered time (some step off a little before/after);
 *  - given a distinct blueprint from {@link COMPANION_WALKER_BLUEPRINTS}.
 * The conflict ped itself is unchanged (exact planned timing → the collision).
 */
function buildCompanionWalkers(
  walker: PlannedWalker,
  count: number,
  seed: number,
  sidewalks?: ReadonlyArray<{ polyline: ReadonlyArray<{ x: number; y: number }> }>,
  group?: WalkerGroupSpec | null,
): ScenarioEditorActorDraft[] {
  const wps = walker.waypoints;
  const last = wps[wps.length - 1] ?? walker.spawnPoint;
  const dx = last.x - walker.spawnPoint.x;
  const dy = last.y - walker.spawnPoint.y;
  const len = Math.hypot(dx, dy) || 1;
  let px = -dy / len; // unit vector perpendicular to the walk direction
  let py = dx / len;
  // GROUP MODE — orient the offset axis along the SUBJECT's approach, downstream.
  //
  // The perpendicular above is only defined up to a sign, and for a group the
  // sign decides whether the members are still hidden by the occluder. Measured
  // against the real placement geometry (`buildSightlineVanOccluder` + the OBB
  // straddle test, 30 combinations of body class x lane offset x sight
  // distance): the occluder's shadow ON THE CURB is strongly asymmetric. It
  // reaches at least +7.8 m DOWNSTREAM of the ped in every case sampled, but
  // upstream it collapses to as little as -1.0 m once the subject eye is far back
  // (car occluder, 6 m lane offset, 25 m sight). Today's alternating +-1.5 /
  // +2.5 layout therefore puts the SECOND companion outside the shadow at the
  // wider sites — it is already standing in the open when the "hidden" child
  // steps out, which is precisely the reveal CPNCO is about.
  //
  // So a group is laid out strictly downstream, where the shadow is deep in
  // every geometry sampled. When no approach direction is available we keep the
  // legacy alternating layout rather than guess a sign.
  if (group?.approachDir) {
    const a = group.approachDir;
    const al = Math.hypot(a.x, a.y) || 1;
    px = a.x / al;
    py = a.y / al;
  }
  const rng = mulberry32((Math.imul(seed, 0x9e3779b1) ^ 0x85ebca6b) >>> 0);
  const out: ScenarioEditorActorDraft[] = [];
  for (let i = 1; i <= count; i++) {
    const side = i % 2 === 1 ? 1 : -1;
    // Lateral band 1.5–2.5 m (P-2.1a): inside the validated corridor width, and
    // still >= the 1.1 m capsule-contact floor ("2 flying pedestrians",
    // 2026-07-02 review — spawn-touching capsules eject).
    //
    // A GROUP packs tighter and all on one side: children bolting together are
    // shoulder-to-shoulder, and the tight spacing keeps every member inside the
    // occluder shadow measured above. GROUP_SPACING_M stays above the same
    // 1.1 m capsule floor.
    const dist = group
      ? group.spacingM * i
      : side * (1.5 + 1.0 * Math.floor((i - 1) / 2)); // 1.5, -1.5, 2.5 …
    // Release. Independent companions get the wide Gaussian stagger — they are
    // unrelated people who happen to share a crossing. A GROUP is released
    // together: the whole point is that they read as ONE bolt into the road, so
    // the jitter is small enough to look human but far too small to read as
    // separate decisions.
    const dt = group
      ? Math.max(-group.releaseJitterS, Math.min(group.releaseJitterS, gaussian(rng) * group.releaseJitterS))
      : Math.max(-1.5, Math.min(1.5, gaussian(rng) * 0.8)); // staggered start
    let spawnPoint = {
      x: walker.spawnPoint.x + px * dist,
      y: walker.spawnPoint.y + py * dist,
    };
    const waypoints = wps.map((p) => ({
      x: p.x + px * dist,
      y: p.y + py * dist,
      time: Math.max(0.05, p.time + dt),
    }));
    // P-2.1b: snap the STATIONARY prefix (spawn + curb-hold vertices at the
    // spawn position) onto a mapped sidewalk within reach, so the companion
    // waits on real walkable geometry instead of a raw curb-line offset. The
    // moving corridor keeps its parallel geometry.
    const snapped = nearestSidewalkPoint(
      spawnPoint,
      sidewalks ?? [],
      COMPANION_SIDEWALK_SNAP_M,
    );
    if (snapped) {
      const sx = spawnPoint.x;
      const sy = spawnPoint.y;
      for (const wp of waypoints) {
        if (Math.hypot(wp.x - sx, wp.y - sy) > 1e-6) break;
        wp.x = snapped.x;
        wp.y = snapped.y;
      }
      spawnPoint = { x: snapped.x, y: snapped.y };
    }
    out.push(
      walkerActorDraft(
        // Dressing id prefix (`bg-`) on purpose: companions are NON-conflict
        // crowd (the collision is validated against `ped` only). The worker's
        // `_is_background_actor_spec` keys on this prefix, so a companion that
        // CARLA can't spawn (null_handle) or that falls through a mesh hole
        // degrades to a skipped actor instead of aborting the whole scene with
        // `actor_integrity_rejected` — the exact failure that killed the
        // otherwise-valid Munich ped-midblock-13 (ped-2 null_handle, 2026-07-20).
        // As a bonus, `_should_collision_lock` treats a dressing counterpart as
        // incidental, so a subject that clips a companion en route keeps driving to
        // the real target instead of freezing short of it. The conflict ped
        // ("ped") stays a critical semantic actor and still fails closed.
        group ? `bg-ped-group-${i}` : `bg-ped-companion-${i}`,
        group ? `${group.label} ${i + 1}` : `Companion Pedestrian ${i}`,
        // A group draws from the PRINCIPAL's own pool, so "2-3 kids running into
        // the street" is actually three children rather than a child plus two
        // adults from the mixed 37-model companion pool. The 0.10 image publishes
        // exactly two child models (0048/0049), so a group of three necessarily
        // repeats one — the pool index still spreads them as far as the image
        // allows. Group members keep the `bg-` prefix: the principal remains the
        // only conflict actor and the only thing the contact metric scores.
        group
          ? group.pool[i % group.pool.length]!
          : COMPANION_WALKER_BLUEPRINTS[(i - 1) % COMPANION_WALKER_BLUEPRINTS.length]!,
        spawnPoint,
        waypoints,
      ),
    );
  }
  return out;
}

/**
 * A CONFLICT GROUP: 2-3 pedestrians who cross as one unit (dib: "versions of
 * this where there are 2-3 kids running into the street instead of just
 * walking").
 *
 * This is a different object from the existing companion dressing even though it
 * reuses the builder. Companions are unrelated people sharing a crossing —
 * mixed-age pool, ±1.5 s independent release, alternating sides. A group is one
 * intent: the principal's own blueprint pool, a correlated release, and a
 * one-sided tight formation that stays inside the occluder's shadow. What it
 * deliberately does NOT change is the principal: it keeps its validated geometry
 * and stays the sole conflict actor, so a group can never turn into a second
 * staged collision.
 */
interface WalkerGroupSpec {
  /** Blueprint pool — the principal's, so a child group is all children. */
  readonly pool: readonly string[];
  /** Subject approach unit vector at the conflict. Members are laid out DOWNSTREAM
   *  along it, the deep side of the occluder's curb shadow. Null → fall back to
   *  the legacy alternating perpendicular layout. */
  readonly approachDir: { x: number; y: number } | null;
  /** Along-curb spacing between members. */
  readonly spacingM: number;
  /** Release jitter bound — small, so the group steps off as one. */
  readonly releaseJitterS: number;
  /** Review/CoT label stem, e.g. "Child pedestrian". */
  readonly label: string;
}

/** Along-curb spacing inside a group. Above the 1.1 m capsule-contact floor
 *  (spawn-touching walker capsules eject — the "2 flying pedestrians" review),
 *  tight enough that a trio spans 2.4 m and stays deep inside the measured
 *  occluder shadow. */
const GROUP_SPACING_M = 1.2;

/** Release spread inside a group. Children bolting together step off within a
 *  breath of each other; the ±1.5 s companion stagger would read as three
 *  separate decisions. */
const GROUP_RELEASE_JITTER_S = 0.2;

/**
 * How far the reactive companion lunges off the curb before stopping.
 *
 * Bounded at BOTH ends. Too long and a caretaker reaches the travel lane and
 * becomes a second conflict actor; too short and the dash cannot be authored as
 * anything a body could do. A lunge from rest that also has to STOP is a
 * triangular velocity profile — accelerate over d/2, decelerate over d/2 — whose
 * peak is sqrt(a*d), so d also sets how fast the adult can credibly be moving.
 * At 4 m that peaks near 2.4 m/s, which reads as a lunge and keeps every authored
 * speed step at ~12 m/s^2, inside the gate's 15 m/s^2 integrity limit.
 */
const REACTIVE_COMPANION_LUNGE_M = 4.0;

/**
 * Where the reactive companion stands, measured along the subject approach from the
 * principal. DOWNSTREAM, just past the last child.
 *
 * Upstream is the intuitive place for "behind the group" and it is wrong: the
 * occluder is parked upstream (its downstream end 0.5 m behind the ped, body
 * extending ~5 m back), so an adult standing 1.5 m upstream lunges straight
 * through the parked car. The generator's own occluder↔walker clearance pass
 * caught it and culled the actor — the reactive companion silently never
 * appeared in ANY emitted scene until this was measured. Downstream is clear of
 * the body and still inside the occluder's kerb shadow, so the adult is revealed
 * with the children rather than ahead of them.
 */
const REACTIVE_COMPANION_ALONG_M = 1.2;

/** How far short of the CONFLICT POINT the reactive companion must stop. A full
 *  walker capsule plus a vehicle half-width of margin: the adult reaches after
 *  the child, it never shares the subject's lane. */
const REACTIVE_COMPANION_CONFLICT_CLEARANCE_M = 2.5;

/**
 * The adult who HOLDS, then runs after the child once it steps off.
 *
 * dib, on the CPNCO round-2 review: "why is the adult just running in place - it
 * would be better if the adult was stopped and start running after the child to
 * stop the collision". Part of that report was the physics bug (a dressing
 * walker spawned with `simulate_physics` off cannot translate, so it plays the
 * walk animation standing still — fixed in ef5568248), but the underlying design
 * note stands on its own: today's companions have no relationship to the
 * conflict actor at all, so nothing about them reads as reacting to the child.
 *
 * The reaction is authored, not runtime-reactive, and deliberately so. The
 * principal's step-off time is SOLVED at plan time — it is exactly the curb hold
 * the planner already computed — so a timed path reproduces "waits, then bolts
 * after the child" frame-for-frame, with no new worker behaviour, no closed-loop
 * trigger, and nothing that can desync. It reuses the same repeated-waypoint
 * hold encoding the conflict walker itself uses.
 *
 * The lunge is CAPPED and aimed to stop short of the travel lane. A caretaker
 * chasing a child must never become a second conflict actor: the scene is
 * validated against the principal alone, and an adult that reached the subject's
 * lane would both invalidate that and hand the subject a second obstacle it was
 * never timed against.
 */
function buildReactiveCompanion(
  walker: PlannedWalker,
  approachDir: { x: number; y: number } | null,
  blueprint: string,
  conflictPoint: { x: number; y: number },
  alongOffsetM: number,
): ScenarioEditorActorDraft | null {
  const wps = walker.waypoints;
  if (wps.length < 2) return null;
  const spawn = walker.spawnPoint;
  const last = wps[wps.length - 1]!;
  const dx = last.x - spawn.x;
  const dy = last.y - spawn.y;
  const walkLen = Math.hypot(dx, dy);
  if (walkLen < 1e-3) return null;
  // Crossing direction (curb → far side): the child's own walk direction.
  const ux = dx / walkLen;
  const uy = dy / walkLen;

  // The principal's step-off: the last waypoint still AT the spawn. That is the
  // curb hold the planner solved, so the adult's hold ends exactly when the
  // child leaves the kerb — the reaction the operator asked for.
  let stepOffS = 0;
  for (const wp of wps) {
    if (Math.hypot(wp.x - spawn.x, wp.y - spawn.y) > 1e-6) break;
    stepOffS = wp.time;
  }

  // Stand just past the group, DOWNSTREAM along the subject approach — clear of the
  // occluder body parked upstream (see REACTIVE_COMPANION_ALONG_M). With no
  // approach direction, fall back to standing beside them across the curb.
  const alongX = approachDir ? approachDir.x : -uy;
  const alongY = approachDir ? approachDir.y : ux;
  const al = Math.hypot(alongX, alongY) || 1;
  const spawnPoint = {
    x: spawn.x + (alongX / al) * alongOffsetM,
    y: spawn.y + (alongY / al) * alongOffsetM,
  };

  // Lunge toward the road along the child's crossing direction, capped so the
  // adult stops well short of the lane the subject is in.
  //
  // The cap is measured against the CONFLICT POINT, not the crossing length. The
  // conflict is where the subject will be; half the full curb-to-far-kerb walk is the
  // middle of the ROAD, so scaling off `walkLen` would happily put a caretaker in
  // the subject's lane on a narrow crossing — the exact "second conflict actor" this
  // actor is not allowed to become. Stop at least CLEARANCE short of the conflict,
  // and drop the companion entirely when there is no room to dash at all.
  const dToConflictM = Math.hypot(spawn.x - conflictPoint.x, spawn.y - conflictPoint.y);
  const lungeM = Math.min(
    REACTIVE_COMPANION_LUNGE_M,
    dToConflictM - REACTIVE_COMPANION_CONFLICT_CLEARANCE_M,
  );
  if (lungeM < 1.0) return null; // no room for a legible dash — omit the actor
  // A dash that starts AND ends at rest is a triangular velocity profile:
  // accelerate over the first half at the walker cap, decelerate over the second.
  // Authoring it as one flat segment is the same discontinuity that made the
  // running child unemittable (measured: a 4.0 m/s step-off is 40 m/s^2 against a
  // 15 m/s^2 limit) — and the adult's own top speed is unreachable in 4 m anyway.
  // Peak here is sqrt(a*d) ~ 2.4 m/s, capped by the catalogue sprint for form.
  const halfM = lungeM / 2;
  const legS = Math.sqrt(lungeM / WALKER_ACCELERATION_MPS2); // time per half
  const peakMps = Math.min(
    Math.sqrt(WALKER_ACCELERATION_MPS2 * lungeM),
    ADULT_RUN_SPEED_MPS,
  );
  void peakMps; // documented intent; the profile is distance/time-authored
  const reactionS = 0.3; // a beat of "hey!" before moving — reads as human
  const t0 = Math.max(0.1, stepOffS + reactionS);
  const mid = {
    x: spawnPoint.x + ux * halfM,
    y: spawnPoint.y + uy * halfM,
  };
  const end = {
    x: spawnPoint.x + ux * lungeM,
    y: spawnPoint.y + uy * lungeM,
  };
  const waypoints: WalkerWaypoint[] = [
    { x: spawnPoint.x, y: spawnPoint.y, time: 0 },
    // Hold on the kerb, watching, until the child goes.
    { x: spawnPoint.x, y: spawnPoint.y, time: t0 },
    // Accelerating half.
    { x: mid.x, y: mid.y, time: t0 + legS },
    // Decelerating half — arrives at rest.
    { x: end.x, y: end.y, time: t0 + 2 * legS },
    // Terminal hold so the adult STOPS at the kerb edge instead of drifting on
    // into the lane once the authored schedule runs out.
    { x: end.x, y: end.y, time: t0 + 2 * legS + 4 },
  ];
  const draft = walkerActorDraft(
    // `bg-` so the adult is dressing: non-conflict, exempt from the fail-closed
    // actor-integrity check, and treated as incidental by the collision lock.
    "bg-ped-guardian",
    "Adult companion (reacts)",
    blueprint,
    spawnPoint,
    waypoints,
  );
  // This plan ENDS stopped, so the run-out extension must leave it alone. Without
  // the marker `extendActorPathsBeyondConflict` appends its 4 m "step past the far
  // curb onto the sidewalk" along the last segment's heading — which for a lunge
  // points INTO THE ROAD, walking the adult straight through the conflict-point
  // clearance this actor is built to respect (measured on belmont ped-1242-3: a
  // 2.34 m lunge became 6.34 m). Same marker the terminal-stop subjects use.
  (draft as Record<string, unknown>).terminal_stop = true;
  return draft;
}

/** Realistic following gap between cyclists in a stream (seconds). At ~16–20 kph
 *  (4.4–5.5 m/s) this is a ~7–9 m gap — a believable line of riders, NOT the
 *  tight 0.7 m lateral packing used for a pedestrian group (dib: cyclists spaced
 *  like peds read as unrealistic). */
const CYCLIST_COMPANION_INTERVAL_S = 1.6;

/**
 * Companion cyclists forming a STREAM behind the conflict cyclist along the same
 * path, spaced at realistic following intervals (workstream H for bikes, dib).
 * Unlike the pedestrian group (which packs tightly abreast), cyclists trail one
 * another: each companion `i` spawns `i·interval·speed` metres back along the
 * approach heading and reaches every point `i·interval` seconds later. A stream
 * keeps the conflict point occupied over a WIDER time window, so the subject hits
 * *some* rider even before the repair loop nails the primary's timing — and a
 * hit on any of them counts (the contact metric treats every non-`bg-` rider as
 * a conflict actor). The conflict cyclist itself is unchanged (validated pair).
 */
function buildCompanionCyclists(
  npc: ScenarioEditorActorDraft,
  count: number,
  seed: number,
  blueprints: readonly string[],
): ScenarioEditorActorDraft[] {
  const wps = npc.timed_waypoints ?? [];
  if (wps.length < 2 || !npc.spawn_point) return [];
  const dx = wps[1]!.x - wps[0]!.x;
  const dy = wps[1]!.y - wps[0]!.y;
  const hlen = Math.hypot(dx, dy) || 1;
  const ux = dx / hlen; // unit approach heading (travel direction)
  const uy = dy / hlen;
  const speedMps = Math.max(2, (npc.speed_kph ?? 16) / 3.6);
  const rng = mulberry32((Math.imul(seed, 0x9e3779b1) ^ 0x27d4eb2f) >>> 0);
  const out: ScenarioEditorActorDraft[] = [];
  for (let i = 1; i <= count; i++) {
    const lag = i * CYCLIST_COMPANION_INTERVAL_S + gaussian(rng) * 0.15;
    // Ride-up leg: the kinematic sim PREPENDS spawn_point at t=0 and
    // interpolates from there to the first timed waypoint, so the gap distance
    // must be solved against the FULL time available (the leader's own t0 plus
    // our lag), not against `lag` alone. That is what makes this leg replay at
    // cruise and join the leader's schedule with no speed step.
    const leadT0 = wps[0]!.time ?? 0;
    const back = speedMps * (leadT0 + lag); // realistic gap behind the leader
    const spawn = { x: wps[0]!.x - ux * back, y: wps[0]!.y - uy * back };
    // Follow the leader's exact line, each point reached `lag` seconds later.
    //
    // There is deliberately NO waypoint at the spawn position. Emitting one
    // (t=0.05, coincident with spawn_point) made the first segment cover ~0 m
    // in 0.05 s — a 0.01 m/s crawl — and the next segment jump straight to
    // cruise: a ~4.1 m/s step, i.e. ~80 m/s^2 and the 17-57 m/s^3 jerk spikes
    // that hard-failed the kinematic lint on EVERY bicycle scene. It went
    // unnoticed because companion cyclists only exist when npcVehicleType is
    // "bicycle", which was CELL_SKIP'd for having no blueprints.
    const timed_waypoints = wps.map((w) => ({
      x: w.x,
      y: w.y,
      time: Math.round(Math.max(0.1, (w.time ?? 0) + lag) * 1000) / 1000,
    }));
    out.push({
      ...npc,
      id: `npc-${i + 1}`,
      label: `Cyclist ${i + 1}`,
      blueprint: blueprints[(i - 1) % blueprints.length] ?? npc.blueprint,
      spawn_point: spawn,
      timed_waypoints,
    } as ScenarioEditorActorDraft);
  }
  return out;
}

function timedPathActorDraft(
  id: string,
  label: string,
  role: ScenarioEditorActorDraft["role"],
  blueprint: string,
  planned: PlannedActor,
): ScenarioEditorActorDraft {
  const wp = planned.waypoints;
  return {
    id,
    label,
    kind: "vehicle",
    role,
    is_static: false,
    placement_mode: "timed_path",
    blueprint,
    spawn: emptyNonRoadSpawnAnchor(),
    spawn_point: wp.length > 0 ? { x: wp[0]!.x, y: wp[0]!.y } : null,
    spawn_yaw: spawnYawDegFromPlannedPath(planned),
    route: [],
    route_direction: "forward",
    lane_facing: "with_lane",
    destination: null,
    destination_point: null,
    path_placement: [],
    timed_waypoints: timedWaypointsForPlanned(planned),
    speed_kph: planned.expectedSpeedKph,
    autopilot: false,
    timeline: [],
    sensors: [],
  } as ScenarioEditorActorDraft;
}

export function plannedCollisionToDraftActors(
  result: PlanCollisionRoutesResult,
  opts: {
    subjectBlueprint?: string;
    npcBlueprint?: string;
    subjectLabel?: string;
    npcLabel?: string;
    walkerLabel?: string;
    /** Conflict-walker stature. `child` draws from the 0.10 image's only small
     *  models (1.11 m) and labels the actor accordingly, which is what makes the
     *  occluder families a real Euro NCAP CPNCO analogue. */
    walkerProfile?: WalkerProfile;
    /**
     * When the family turns the subject through the junction, author it with a
     * CARLA-native turn primitive instead of a pure-pursuit arc (see
     * {@link subjectTurnInstructionIntents}). `null` keeps the straight `timed_path` subject
     * (pedestrian crossings, rear-end, sideswipe, cut-in).
     */
    subjectTurn?: SubjectTurn;
    /**
     * Add this many companion pedestrians crossing the same location as the
     * conflict ped (blueprint variety + Gaussian-staggered start times). 0 keeps
     * the single conflict ped. Only applies when the plan has a walker.
     */
    extraPedestrians?: number;
    /**
     * Size of the CONFLICT GROUP including the principal (1 = today's single
     * ped). 2-3 stages "2-3 kids running into the street": the extra members
     * draw from the principal's own pool, are released together, and are packed
     * downstream inside the occluder's shadow. Takes precedence over
     * `extraPedestrians`, which stays the unrelated-bystander knob.
     */
    walkerGroupSize?: number;
    /**
     * Add the adult who waits on the kerb and then runs after the child
     * (`buildReactiveCompanion`). Dressing only — never a conflict actor.
     */
    reactiveCompanion?: boolean;
    /**
     * Projected sidewalk polylines (runtime meters). When provided, each
     * companion's stationary spawn/hold snaps onto the nearest mapped sidewalk
     * within reach (P-2.1b) so it waits on real walkable geometry.
     */
    sidewalks?: ReadonlyArray<{ polyline: ReadonlyArray<{ x: number; y: number }> }>;
    /**
     * Add this many companion cyclists trailing the conflict NPC in a realistic
     * stream (only meaningful when the NPC is a cyclist). A stream widens the
     * time window the conflict point is occupied → more contact chances in the
     * repair loop. 0 keeps the single conflict cyclist.
     */
    extraCyclists?: number;
    /** Blueprint pool for companion cyclists (CARLA stock bikes). */
    cyclistBlueprints?: readonly string[];
    /** Seed for the deterministic companion offsets/timing. */
    seed?: number;
    /** Collision-AVOIDED variant: mark the subject reactive (worker brakes late +
     * hard for the conflict walker, then resumes once it clears). */
    subjectReactive?: boolean;
  } = {},
): ScenarioEditorActorDraft[] {
  const subject = timedPathActorDraft(
    "subject",
    opts.subjectLabel ?? "Subject",
    "subject",
    opts.subjectBlueprint ?? "vehicle.lincoln.mkz",
    result.collision.subject,
  );
  if (opts.subjectReactive) {
    // Stop-sign compliance (dib 2026-07-09: avoided subjects "blow through stop signs"):
    // the worker's landmark-based scripted stop is opt-in via this flag, and the
    // avoided arc-follower never carried it (only the NOMINAL generator set it). The
    // worker maintains a pursuit-mode stop-and-GO hold, so the subject stops at the sign,
    // then proceeds into the (possibly yielding) turn. Collision (non-reactive) subjects
    // must reach their conflict on schedule and still never carry the flag.
    (subject as Record<string, unknown>).stop_at_stop_line = true;
    // Complete the turn INTO THE EXIT LANE past the conflict. The planned subject path
    // ends AT the conflict (mid-turn, tangent ~45°), so a reactive avoided subject that
    // drives that path overshoots the junction onto the curb/opposite side once past
    // the conflict (dib 2026-07-09: "overshoots the left turn and drives into the
    // curb/building"). Append the exit-lane centerline from the gate chain so the subject
    // curves through the junction and settles into the exit lane; extend-actor-paths
    // then runs it out lawfully down that lane.
    appendPostConflictWaypoints(subject, result.collision.subject);
    // Smooth + densify the JUNCTION WINDOW (dib 2026-07-10: post-turn centering
    // and overshoot are crucial for piloting this category — "the subject must behave
    // perfectly to train VLAs"). The planned arc meets the appended exit chain at
    // the conflict point with a tangent KINK; pursuit overshoots the kink outward
    // (curb graze / off-center exit) and then converges slowly. Two levers:
    //  - Chaikin corner-cutting over the window rounds the kink into a drivable
    //    curve (schedule-level, so pursuit tracks instead of improvising);
    //  - 2 m resampling in the window gives pursuit dense targets, shrinking the
    //    tracking error that reads as "doesn't end up exactly mid-lane".
    smoothJunctionWindow(subject, result.collision.subject);
    // Smooth the turn: retime the subject's waypoints with a curvature-aware speed
    // profile (see retimeWithCurvature). Straight approach keeps its planned
    // schedule; the junction arc slows to a comfortable lateral-g so pursuit stops
    // corner-cutting onto the curb (dib 2026-07-09: "left-turns need to be a bit
    // smoother" / "gets on curb at the left turn").
    retimeWithCurvature(subject, result.collision.subject.expectedSpeedKph, {
      // A terminal-stop plan (driveway / curbside park) must ARRIVE at the
      // pull-in crawl — bake the decel ramp into the profile itself.
      endSpeedMps: result.collision.subject.terminalStop
        ? TERMINAL_STOP_PULL_IN_KPH / 3.6
        : undefined,
    });
  }
  const subjectTurnIntents = opts.subjectTurn
    ? subjectTurnInstructionIntents(
        opts.subjectTurn,
        result.collision.subject.expectedSpeedKph,
      )
    : undefined;
  if (opts.subjectTurn) {
    // P-3: the CONTACT turn subject's authored arc is what the kinematic gate
    // replays, and a constant-cruise schedule through a junction arc is
    // physically implausible (lateral accel 6-13 m/s² — the M1.2 lint hard-
    // fails it, which zeroed the turn-family emits). Retime it with the same
    // curvature envelope the avoided subject gets; the runtime subject is TM-clamped
    // through the turn anyway, so the slowed schedule is CLOSER to what
    // actually drives. The walker/NPC reconciles below keep the planned meet.
    if (!opts.subjectReactive) {
      retimeWithCurvature(subject, result.collision.subject.expectedSpeedKph, {
        endSpeedMps: result.collision.subject.terminalStop
          ? TERMINAL_STOP_PULL_IN_KPH / 3.6
          : undefined,
      });
    }
    // The turn primitive itself is no longer assigned here.
    //
    // This used to be `subject.timedInstructions = subjectTurnInstructions(...)`. That
    // helper is gone: the turn is now carried as an INTENT
    // (`subjectTurnInstructionIntents` above, attached as `timedInstructionIntents`
    // at the two draft-assembly sites below) so the compiled instruction list is
    // derived once at payload build rather than written twice into the draft.
    // The retiming above is unaffected — it is what the kinematic gate replays,
    // and it is the half of this block that still has to happen here.
  }
  // Fix 2: a driveway / curbside-park destination ENDS the plan — append the
  // stationary hold and mark the draft so the run-out extension leaves it alone.
  applyTerminalStop(subject, result.collision.subject, { reachRequired: opts.subjectReactive === true });

  if (result.walker) {
    // The subject above was curvature-retimed (AVOIDED variant, and since P-3 the
    // CONTACT turn subject too), so re-solve the walker's curb-hold against the
    // subject's ACTUAL time at the conflict (see reconcileWalkerWithRetimedSubject).
    // Straight-family contact variants keep the planner's schedule
    // byte-identical.
    const w =
      opts.subjectReactive || opts.subjectTurn
        ? reconcileWalkerWithRetimedSubject(result.walker, subject, result.collision)
        : result.walker;
    // The conflict ped keeps its exact planned timing + a stable blueprint (the
    // collision is validated against it). Companions are added beside it.
    // walkerCrossingSpeedKph: cross at the planner's timing pace, derived from
    // the authored waypoints (a hardcoded 5 km/h ran ~8% fast and the walker
    // arrived ahead of the subject — ped-561 missed by ~5 m even after the curb-hold
    // fix).
    const conflictPed = walkerActorDraft(
      "ped",
      opts.walkerLabel ?? walkerProfileSpec(opts.walkerProfile).label,
      // The PRINCIPAL walker — it carries the family's validated conflict
      // geometry, so it stays a fixed adult rather than varying per scene.
      // 0001 was generation-1 and absent from the 0.10 image; the worker had
      // been substituting it to 0019, so pinning 0019 makes the spec honest
      // WITHOUT changing a single rendered frame. A child variant selects a
      // different pool deliberately (Euro NCAP CPNCO), never by accident.
      conflictWalkerBlueprint(opts.walkerProfile),
      w.spawnPoint,
      w.waypoints,
    );
    // Subject approach direction AT the conflict, from a multi-point chord of the
    // planned route (robust against one noisy final segment) — the same way the
    // occluder builders derive it, so the group's downstream layout is measured
    // against the identical axis the occluder was placed on.
    const subjectPath = result.collision.subject.waypoints;
    const approachDir = (() => {
      if (subjectPath.length < 2) return null;
      const to = subjectPath[subjectPath.length - 1]!;
      const from = subjectPath[Math.max(0, subjectPath.length - 4)]!;
      const l = Math.hypot(to.x - from.x, to.y - from.y);
      return l < 1e-3 ? null : { x: (to.x - from.x) / l, y: (to.y - from.y) / l };
    })();
    // A GROUP replaces the bystander companions rather than stacking with them:
    // the ask is "2-3 kids", not 2-3 kids plus a seeded 0-2 strangers walking
    // the same corridor, which would put up to five walkers on one kerb and
    // muddy exactly the read the group exists to create.
    const groupExtra = Math.max(0, Math.min(3, opts.walkerGroupSize ?? 1) - 1);
    const companions =
      groupExtra > 0
        ? buildCompanionWalkers(w, groupExtra, opts.seed ?? 1, opts.sidewalks, {
            pool: walkerProfileSpec(opts.walkerProfile).pool,
            approachDir,
            spacingM: GROUP_SPACING_M,
            releaseJitterS: GROUP_RELEASE_JITTER_S,
            label: walkerProfileSpec(opts.walkerProfile).label,
          })
        : opts.extraPedestrians && opts.extraPedestrians > 0
          ? buildCompanionWalkers(w, Math.min(opts.extraPedestrians, 3), opts.seed ?? 1, opts.sidewalks)
          : [];
    // The adult who holds, then chases. Drawn from the ADULT pool regardless of
    // the principal's stature — the whole point is a grown-up going after a kid.
    // CROSSING COHORT (Codex P1 on #458). The worker arms a CLOSED-LOOP step-off
    // trigger for the walker named by `collision_target_id` and nothing else: if
    // the subject is slowed by traffic, a light, or a stall, the principal is held at
    // the kerb and released late. Group members and the guardian were left on
    // their authored wall-clock schedules, so a delayed subject would have the group
    // crossing while the principal still waited, and the adult "reacting" to a
    // child that had not moved — destroying both the correlated release and the
    // reaction, which are the entire point of these actors.
    //
    // Declaring the relationship here (rather than teaching the worker our id
    // prefixes) keeps the contract in the spec: the worker shifts every cohort
    // member by the SAME offset it gives the principal, which preserves the
    // relative timing — the group's jitter and the guardian's reaction beat — bit
    // for bit, whenever the principal is held, released, or force-released.
    const cohortOf = (a: ScenarioEditorActorDraft): ScenarioEditorActorDraft => {
      (a as Record<string, unknown>).crossing_cohort_of = "ped";
      return a;
    };
    for (const c of companions) cohortOf(c);
    const guardian = opts.reactiveCompanion
      ? buildReactiveCompanion(
          w,
          approachDir,
          conflictWalkerBlueprint("adult"),
          result.collision.conflictPoint,
          // Just past the last group member, so the adult reads as with them.
          (groupExtra + 1) * REACTIVE_COMPANION_ALONG_M,
        )
      : null;
    if (guardian) cohortOf(guardian);
    // BOTH variants declare the pedestrian as the target. The target does two things:
    //  1. arms the closed-loop walker trigger so the pedestrian steps off in front of the
    //     subject instead of on a wall-clock schedule (open-loop, the avoided walker finished
    //     crossing before the braking subject arrived — 4 "avoided" non-events where the subject
    //     never had to react, measured r8), and
    //  2. exempts the subject from braking for its target — but ONLY for the CONTACT subject. The
    //     worker gates that on `collision_target_id AND NOT reactive_braking`, so the
    //     AVOIDED subject (reactive_braking) still brakes for the pedestrian, which is the
    //     whole point. So the same field gives contact→hit and avoided→genuine near-miss.
    (subject as Record<string, unknown>).collision_target_id = "ped";
    if (opts.subjectReactive) {
      // THE AVOIDED SUBJECT MUST BRAKE FOR ITS PEDESTRIAN. Measured on the first
      // 3D canary of this category (belmont ped-1242-3): the subject held ~9.7 m/s
      // straight through the encounter, passing the child with a 0.50 m gap and
      // never slowing — `maneuverOutcome` said `expected_maneuver: "stop",
      // executed: false, "never stopped"` in 3 of 3 avoided scenes. An avoidance
      // set where nothing is avoided is not a near-miss dataset, it is a set of
      // non-events.
      //
      // Cause is a lossy migration, not the worker. `collision_target_id` always
      // carried TWO meanings — arm the closed-loop walker trigger, AND exempt the
      // subject from braking — and the worker separated them with an explicit
      // `collision_target_id AND NOT reactive_braking` gate, so only the CONTACT
      // subject got the exemption. `migrateActorDraftReactionProfile` flattens the
      // field into `exempt_actor_ids: [target]` and drops that condition, and the
      // worker's `tm_collision_exempt_actor_ids` documents that an authored
      // profile "means what it says ... regardless of the braking mode". So the
      // avoided subject was handed a profile saying it is allowed to hit the very
      // pedestrian it exists to yield to.
      //
      // Author the profile explicitly rather than letting it be derived:
      // `finalizeGeneratedActorBehavior` prefers an actor's own
      // `reaction_profile`, so this is the narrow, local correction. The empty
      // exempt list is the whole point — the target id still arms the trigger,
      // it just no longer doubles as permission to run the child down.
      (subject as Record<string, unknown>).reaction_profile = {
        mode: "brake",
        aggressiveness: DEFAULT_REACTION_AGGRESSIVENESS,
        exempt_actor_ids: [],
      };
    }
    return finalizeGeneratedActorBehaviors(
      [subject, conflictPed, ...companions, ...(guardian ? [guardian] : [])],
      {
        subject: {
          reactiveBraking: opts.subjectReactive,
          timedInstructionIntents: subjectTurnIntents,
        },
      },
    );
  }

  const npc = timedPathActorDraft(
    "npc",
    opts.npcLabel ?? "Conflicting vehicle",
    "traffic",
    opts.npcBlueprint ?? "vehicle.dodge.charger",
    result.collision.npc,
  );
  // The CONTACT subject hits the conflict vehicle and YIELDS TO ORDINARY TRAFFIC. The Traffic
  // Manager's strict rules otherwise make it brake for its OWN conflict (measured
  // 9.7 -> 4.7 m/s right at the conflict, then a clean miss); the worker turns this into a
  // per-pair `collision_detection(subject, npc, False)` so it ignores ONLY the npc.
  if (!opts.subjectReactive) {
    (subject as Record<string, unknown>).collision_target_id = "npc";
  }
  if (opts.subjectReactive) {
    // AVOIDED variant: the conflict NPC drives THROUGH and keeps going down its own
    // exit chain instead of parking at the conflict point (dib 2026-07-09: "why does
    // the other actor stop after the maneuver — continue that for a while too").
    // Contact variants keep the planned end-at-conflict (the collision consumes it).
    appendPostConflictWaypoints(npc, result.collision.npc);
    dedupeCloseWaypoints(npc);
    // The crosser stays assertive through the conflict but must not plow into
    // a STOPPED (yielding) subject dead ahead — real right-of-way drivers brake for
    // a stationary car in their lane (worker: anti_plow, stopped-vehicle-only,
    // 16m lookahead).
  }
  if (opts.subjectTurn || opts.subjectReactive) {
    // P-3: the turn/reactive context retimes the subject; the NPC gets the same
    // physically-plausible curvature/accel profile with its cruise SOLVED so it
    // still meets the retimed subject at the conflict (see
    // reconcileNpcWithRetimedSubject — 15/29 Belmont left-turn sites otherwise
    // missed in the gate's replay, and the right-hook NPC's raw cruise arcs
    // failed the lateral-accel lint).
    reconcileNpcWithRetimedSubject(npc, subject, result.collision, result.collision.npc.expectedSpeedKph);
  }
  const companionCyclists =
    opts.extraCyclists && opts.extraCyclists > 0
      ? buildCompanionCyclists(
          npc,
          Math.min(opts.extraCyclists, 3),
          opts.seed ?? 1,
          opts.cyclistBlueprints ?? [npc.blueprint],
        )
      : [];
  return finalizeGeneratedActorBehaviors(
    [subject, npc, ...companionCyclists],
    {
      subject: {
        reactiveBraking: opts.subjectReactive,
        timedInstructionIntents: subjectTurnIntents,
      },
      npc: { antiPlow: opts.subjectReactive },
    },
  );
}
