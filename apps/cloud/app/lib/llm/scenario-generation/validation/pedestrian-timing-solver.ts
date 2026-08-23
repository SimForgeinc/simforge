/**
 * Tier-2 deterministic repair: pedestrian-crossing timing solve.
 *
 * The pedestrian_crossing builder (planner happy-path AND heuristic
 * fallback) emits a walker `timed_path` with a hold-then-cross profile
 * whose step-off time is a fixed constant — it is never coupled to when
 * the subject actually arrives at the crossing. When the subject's ETA to the
 * crossing differs from the hardcoded mid-cross moment by even a fraction
 * of a second, the boxes miss by a metre or two and the kinematic
 * validator (correctly) FAILs `collision_occurred`. Tier-1 only tunes
 * subject/NPC *speed* through the planner — it never re-times the walker —
 * so this whole failure class slips through.
 *
 * This module re-times the walker (preserving its spatial path and its
 * crossing duration) so it reaches the crossing centre exactly when the
 * subject does. It is intentionally a pure, types-only module — no planner /
 * geometry / DB runtime — so it stays unit-testable alongside
 * `draft-validator.ts`, which re-validates the result.
 *
 * It returns `null` (caller falls back to the LLM revise loop) whenever
 * the miss is NOT a pure timing problem — the subject polyline never passes
 * near the crossing (a geometry/region miss), the subject has no resolvable
 * polyline/speed, or the solved hold is physically infeasible inside the
 * scenario horizon.
 */
import type { ScenarioEditorActorDraft } from "@simcloud/shared";

interface Vec2 {
  x: number;
  y: number;
}

/**
 * The subject polyline must pass within this distance of the crossing centre
 * for the miss to be treatable as a *timing* problem. Beyond it the subject
 * simply doesn't drive through the crossing — re-timing the walker can't
 * manufacture a collision, so we bail to the LLM revise path. Sized as
 * walker half-cross (~4 m) + vehicle/​walker footprint slack.
 */
const SUBJECT_PASS_RADIUS_M = 8;

export interface SolvedPedestrianTiming {
  /** Rebuilt walker timed-path: [start@0, start@hold, end@hold+cross]. */
  waypoints: { x: number; y: number; time: number }[];
  /** Solved curb hold (seconds). */
  holdS: number;
  /** The hold the draft shipped with, for the repair-strategy label. */
  previousHoldS: number;
  /** Subject ETA to the crossing centre the hold was solved against. */
  subjectEtaS: number;
}

function dist(a: Vec2, b: Vec2): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

/** Subject polyline in draft order: spawn → path_placement → destination. */
function subjectPolyline(subject: ScenarioEditorActorDraft): Vec2[] {
  const pts: Vec2[] = [];
  if (subject.spawn_point) pts.push({ x: subject.spawn_point.x, y: subject.spawn_point.y });
  for (const p of subject.path_placement ?? []) pts.push({ x: p.x, y: p.y });
  if (subject.destination_point) {
    pts.push({ x: subject.destination_point.x, y: subject.destination_point.y });
  }
  // Drop consecutive duplicates so zero-length segments don't skew arc length.
  const out: Vec2[] = [];
  for (const p of pts) {
    const last = out[out.length - 1];
    if (!last || last.x !== p.x || last.y !== p.y) out.push(p);
  }
  return out;
}

/**
 * Closest point on the polyline to `target`, returning the arc length
 * from the polyline start to that point and the perpendicular gap.
 */
function projectOntoPolyline(
  polyline: readonly Vec2[],
  target: Vec2,
): { arcLengthM: number; gapM: number } | null {
  if (polyline.length < 2) return null;
  let best: { arcLengthM: number; gapM: number } | null = null;
  let cum = 0;
  for (let i = 1; i < polyline.length; i++) {
    const a = polyline[i - 1]!;
    const b = polyline[i]!;
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const segLen = Math.hypot(dx, dy);
    if (segLen > 0) {
      const t = Math.max(
        0,
        Math.min(1, ((target.x - a.x) * dx + (target.y - a.y) * dy) / (segLen * segLen)),
      );
      const foot = { x: a.x + t * dx, y: a.y + t * dy };
      const gapM = dist(foot, target);
      if (!best || gapM < best.gapM) {
        best = { arcLengthM: cum + t * segLen, gapM };
      }
    }
    cum += segLen;
  }
  return best;
}

/** Walker timed path → endpoints + crossing duration. Null if unusable. */
function walkerCrossing(
  walker: ScenarioEditorActorDraft,
): { start: Vec2; end: Vec2; crossDurS: number; previousHoldS: number } | null {
  const wps = walker.timed_waypoints ?? [];
  if (wps.length < 2) return null;
  const start = { x: wps[0]!.x, y: wps[0]!.y };
  const last = wps[wps.length - 1]!;
  const end = { x: last.x, y: last.y };
  if (dist(start, end) < 1e-3) return null;
  // The step-off waypoint is the last one still co-located with `start`;
  // hold = its time, crossing duration = remaining time after it.
  let stepOffTime = wps[0]!.time;
  for (const w of wps) {
    if (dist({ x: w.x, y: w.y }, start) < 1e-3) stepOffTime = w.time;
  }
  const crossDurS = last.time - stepOffTime;
  if (!(crossDurS > 0)) return null;
  return { start, end, crossDurS, previousHoldS: stepOffTime };
}

/**
 * Re-time the walker so it reaches the crossing centre exactly when the
 * subject does. Returns null when the miss isn't a pure timing problem (see
 * module docstring) — the caller then leaves the draft to the LLM revise
 * loop rather than claiming a repair it didn't make.
 */
export function solvePedestrianCrossingTiming(args: {
  subject: ScenarioEditorActorDraft;
  walker: ScenarioEditorActorDraft;
  durationS: number;
}): SolvedPedestrianTiming | null {
  const { subject, walker, durationS } = args;

  const crossing = walkerCrossing(walker);
  if (!crossing) return null;
  const { start, end, crossDurS, previousHoldS } = crossing;

  const subjectSpeedMps = Math.max(0, subject.speed_kph) / 3.6;
  if (subjectSpeedMps <= 0) return null;
  const poly = subjectPolyline(subject);
  if (poly.length < 2) return null;

  // Crossing centre = midpoint of the walker traversal. By construction
  // the walker path is the perpendicular through the subject lane, so its
  // midpoint is the lane-centerline conflict point.
  const centre: Vec2 = { x: (start.x + end.x) / 2, y: (start.y + end.y) / 2 };

  const proj = projectOntoPolyline(poly, centre);
  if (!proj) return null;
  // Subject never drives through the crossing → geometric miss, not timing.
  if (proj.gapM > SUBJECT_PASS_RADIUS_M) return null;

  const subjectEtaS = proj.arcLengthM / subjectSpeedMps;

  // Time for the walker to travel from the curb to the crossing centre,
  // at the path's existing (preserved) crossing speed.
  const startToCentre = dist(start, centre);
  const fullCross = dist(start, end);
  const tCentreFromStepOff =
    fullCross > 0 ? crossDurS * (startToCentre / fullCross) : crossDurS / 2;

  const holdS = subjectEtaS - tCentreFromStepOff;

  // Feasibility inside the scenario horizon: the walker can't step off
  // before t=0, and the full hold+cross (and the subject's arrival) must fit
  // within the simulated duration. Anything else is not a timing fix.
  if (!Number.isFinite(holdS) || holdS < 0) return null;
  if (holdS + crossDurS > durationS) return null;
  if (subjectEtaS > durationS) return null;

  return {
    waypoints: [
      { x: start.x, y: start.y, time: 0 },
      { x: start.x, y: start.y, time: holdS },
      { x: end.x, y: end.y, time: holdS + crossDurS },
    ],
    holdS,
    previousHoldS,
    subjectEtaS,
  };
}
