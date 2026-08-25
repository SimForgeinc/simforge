/**
 * Extend the primary actors' timed paths PAST the conflict point so a near-miss
 * doesn't freeze everyone at the site (the awkward "subject + ped both stop, nothing
 * happens" case). After the planned conflict:
 *   - VEHICLES (subject + any conflicting NPC) keep driving in their final heading
 *     until the scenario duration is up,
 *   - PEDESTRIANS step the last few metres past the far curb onto the sidewalk
 *     (completing the crossing instead of stopping at the road edge).
 *
 * Regression-safe by construction: it ONLY appends tail waypoints, leaving the
 * approach + conflict geometry/timing untouched. Apply it AFTER the kinematic
 * gate (so validation is unaffected) and BEFORE scene population (so only the
 * primary actors are touched). On a real collision the worker's collision-stop
 * halts the contacted actors before the tail runs, so the extension only changes
 * what near-misses do. Mutates the actors in place.
 */
import type { ScenarioEditorActorDraft } from "@simforge/studio-shared";
import type { RuntimeRoadSegment } from "@/app/lib/runtime/runtime-types";
import { tailSpeedProfileMps } from "@/app/lib/llm/scenario-generation/validation/planned-to-draft";

/** Don't bother extending the subject if under this much time remains. */
/** Tail sampling step + how close a tail point must be to a drivable-lane
 *  centerline vertex to count as on-road (vertex spacing ~2-5m + half lane). */
const TAIL_STEP_M = 5;
const TAIL_ON_ROAD_NEAR_M = 5;
/** Minimum usable truncated tail — shorter than this we skip the tail entirely
 *  (the worker's path-end brake+hold parks the subject just past the conflict). */
const MIN_TRUNCATED_TAIL_M = 5;
/** How far past the far curb a pedestrian steps onto the sidewalk (m). */
const PED_SIDEWALK_STEP_M = 4;
const WALKER_FALLBACK_MPS = 1.3;
/**
 * Stop a run-out this far short of a DEAD END of the lane network (no successor
 * to chain into). A tail that walks to the network's final vertex parks the
 * actor ON the cook boundary — dib 2026-08-02 Munich review, bicyclistavoid/
 * right-2101-0: "stop the cyclist from jumping off the edge of the map". The
 * margin applies only when the walk terminated for lack of successors; a tail
 * that delivered its full distance mid-network is untouched.
 */
const DEAD_END_MARGIN_M = 12;
/**
 * A pedal cycle is a `vehicle.*` blueprint; its lawful run-out may follow BIKE
 * lanes as well as driving lanes. Restricting the tail walk + on-road clamp to
 * `driving` lanes gave a cyclist ending on a bike lane NO tail at all (nearest
 * driving vertex > 6 m away), so it parked mid-scene with runway left — dib
 * 2026-08-02 Munich review: right-2186-2 / right-227-5 ("cyclist suddenly
 * stopped… let's get it as far as possible"), left-2131-2 ("stops at a sidewalk
 * with half the bike on the road"). Same token list as the worker's
 * _PEDAL_CYCLE_TOKENS.
 */
const PEDAL_CYCLE_TOKENS = ["crossbike", "diamondback", "century", "gazelle", "omafiets"];
const CYCLE_LANE_TYPES: ReadonlySet<string> = new Set(["driving", "biking", "shoulder"]);
const DRIVING_ONLY: ReadonlySet<string> = new Set(["driving"]);

function isPedalCycle(actor: ScenarioEditorActorDraft): boolean {
  const blueprint = (actor.blueprint ?? "").toLowerCase();
  return PEDAL_CYCLE_TOKENS.some((token) => blueprint.includes(token));
}
/**
 * Guaranteed run-out distance past the conflict for a vehicle (m). The conflict
 * actors often DECELERATE to meet the conflict on schedule; on a miss the subject
 * must clearly drive AWAY rather than crawl off or stop at the site (review G:
 * "subject stops at the planned conflict point when it misses"). We always lay a
 * tail target at least this far ahead — even when little sim time remains — so
 * the worker's pure-pursuit keeps a forward target and never parks on the last
 * waypoint.
 */
const MIN_VEHICLE_RUNOUT_M = 40;

/**
 * Lane-following vehicle tail (dib review 2026-07-03: post-miss subjects read as
 * "drunk drivers" — off-road, curbs, wrong-way). Instead of extrapolating the
 * final heading, walk the nearest drivable lane centerline in the direction of
 * travel and chain into successor lanes, so the run-out follows the road like
 * a lawful driver. Returns the tail polyline (spaced ~TAIL_STEP_M), or null
 * when no usable lane is found near the start point (caller falls back to the
 * clamped straight tail).
 */
function laneFollowingTail(
  startX: number,
  startY: number,
  ux: number,
  uy: number,
  dist: number,
  segments: readonly RuntimeRoadSegment[],
  byKey: Map<string, RuntimeRoadSegment>,
  laneTypes: ReadonlySet<string> = DRIVING_ONLY,
): { tail: Array<{ x: number; y: number }>; deadEnd: boolean } | null {
  // Nearest usable-lane centerline vertex to the start point.
  let best: { seg: RuntimeRoadSegment; idx: number; d2: number } | null = null;
  for (const seg of segments) {
    const laneType = (seg.lane_type ?? "").toLowerCase();
    if (laneType && !laneTypes.has(laneType)) continue;
    const line = seg.centerline ?? [];
    for (let i = 0; i < line.length; i += 1) {
      const dx = line[i]!.x - startX;
      const dy = line[i]!.y - startY;
      const d2 = dx * dx + dy * dy;
      if (!best || d2 < best.d2) best = { seg, idx: i, d2 };
    }
  }
  // Must start ON the network (within ~half a lane) or we can't claim lawful.
  if (!best || best.d2 > 6 * 6) return null;

  const tail: Array<{ x: number; y: number }> = [];
  let seg = best.seg;
  let idx = best.idx;
  // Traverse direction: follow the centerline the way the actor is heading.
  let line = seg.centerline ?? [];
  const fwd =
    idx + 1 < line.length
      ? (line[idx + 1]!.x - line[idx]!.x) * ux + (line[idx + 1]!.y - line[idx]!.y) * uy >= 0
      : idx > 0
        ? (line[idx]!.x - line[idx - 1]!.x) * ux + (line[idx]!.y - line[idx - 1]!.y) * uy >= 0
        : true;
  let step = fwd ? 1 : -1;
  let traveled = 0;
  let prevX = startX;
  let prevY = startY;
  let hops = 0;
  // Walk far enough to DELIVER `dist`. The old hops<6 cap truncated the tail to ~6
  // short junction segments on dense maps (~30-60 m), so a yield-delayed subject ran out
  // of road mid-clip and stopped (2026-07-09). Size the hop budget to the distance
  // (short segments are ~5-15 m) with a generous ceiling; `traveled >= dist` still
  // ends it early on long through-lanes.
  const maxHops = Math.min(48, Math.max(6, Math.ceil(dist / 10)));
  while (traveled < dist && hops < maxHops) {
    line = seg.centerline ?? [];
    for (let i = idx + step; i >= 0 && i < line.length; i += step) {
      const p = line[i]!;
      const d = Math.hypot(p.x - prevX, p.y - prevY);
      if (d < 0.5) continue;
      traveled += d;
      prevX = p.x;
      prevY = p.y;
      tail.push({ x: p.x, y: p.y });
      if (traveled >= dist) return { tail, deadEnd: false };
    }
    // Chain into the best successor (heading-continuous continuation).
    const heading = tail.length >= 2
      ? {
          x: tail[tail.length - 1]!.x - tail[tail.length - 2]!.x,
          y: tail[tail.length - 1]!.y - tail[tail.length - 2]!.y,
        }
      : { x: ux, y: uy };
    const hl = Math.hypot(heading.x, heading.y) || 1;
    const refs = (step === 1 ? seg.successors : seg.predecessors) ?? [];
    let next: { seg: RuntimeRoadSegment; forward: boolean; score: number } | null = null;
    for (const ref of refs) {
      const key = `${ref.road_id}:${ref.section_id}:${ref.lane_id}`;
      const cand = byKey.get(key);
      const cl = cand?.centerline ?? [];
      if (!cand || cl.length < 2) continue;
      const laneType = (cand.lane_type ?? "").toLowerCase();
      if (laneType && !laneTypes.has(laneType)) continue;
      // Entry end = whichever endpoint is nearer to where we are.
      const dStart = Math.hypot(cl[0]!.x - prevX, cl[0]!.y - prevY);
      const dEnd = Math.hypot(cl[cl.length - 1]!.x - prevX, cl[cl.length - 1]!.y - prevY);
      const forward = dStart <= dEnd;
      if (Math.min(dStart, dEnd) > 8) continue; // not actually adjacent
      const a = forward ? cl[0]! : cl[cl.length - 1]!;
      const b = forward ? cl[1]! : cl[cl.length - 2]!;
      const dirX = b.x - a.x;
      const dirY = b.y - a.y;
      const dl = Math.hypot(dirX, dirY) || 1;
      const score = (dirX * heading.x + dirY * heading.y) / (dl * hl);
      if (score > 0.2 && (!next || score > next.score)) next = { seg: cand, forward, score };
    }
    if (!next) {
      // No successor to chain into: the network genuinely ends here (a dead
      // end / the cook boundary). The caller trims the dead-end margin.
      return tail.length >= 2 ? { tail, deadEnd: true } : null;
    }
    seg = next.seg;
    step = next.forward ? 1 : -1;
    idx = next.forward ? -1 : (seg.centerline?.length ?? 0);
    hops += 1;
  }
  return tail.length >= 2 ? { tail, deadEnd: false } : null;
}

/** Drop trailing tail points until `marginM` of arc length is removed — the
 *  dead-end back-off (stop short of the network end, don't park on it). */
function trimTailArc(
  tail: Array<{ x: number; y: number }>,
  marginM: number,
): Array<{ x: number; y: number }> {
  let removed = 0;
  while (tail.length >= 2 && removed < marginM) {
    const last = tail[tail.length - 1]!;
    const prev = tail[tail.length - 2]!;
    removed += Math.hypot(last.x - prev.x, last.y - prev.y);
    tail.pop();
  }
  return tail;
}

export function extendActorPathsBeyondConflict(
  actors: ScenarioEditorActorDraft[],
  durationS: number,
  roadSegments?: readonly RuntimeRoadSegment[],
): void {
  // Usable-lane centerline vertices, for clamping vehicle tails onto the road.
  // Two sets: ordinary vehicles clamp to DRIVING lanes; pedal cycles may also
  // run out along bike lanes/shoulders (see PEDAL_CYCLE_TOKENS above).
  const drivingVertices: Array<{ x: number; y: number }> = [];
  const cycleVertices: Array<{ x: number; y: number }> = [];
  for (const seg of roadSegments ?? []) {
    const laneType = (seg.lane_type ?? "").toLowerCase();
    const driving = !laneType || laneType === "driving";
    const cycleOk = !laneType || CYCLE_LANE_TYPES.has(laneType);
    if (!driving && !cycleOk) continue;
    for (const p of seg.centerline ?? []) {
      if (!Number.isFinite(p.x) || !Number.isFinite(p.y)) continue;
      if (driving) drivingVertices.push({ x: p.x, y: p.y });
      if (cycleOk) cycleVertices.push({ x: p.x, y: p.y });
    }
  }
  const nearRoadIn = (
    vertices: Array<{ x: number; y: number }>,
    x: number,
    y: number,
  ): boolean => {
    for (const v of vertices) {
      const dx = v.x - x;
      const dy = v.y - y;
      if (dx * dx + dy * dy <= TAIL_ON_ROAD_NEAR_M * TAIL_ON_ROAD_NEAR_M) return true;
    }
    return false;
  };
  const segByKey = new Map<string, RuntimeRoadSegment>();
  for (const seg of roadSegments ?? []) {
    segByKey.set(`${seg.road_id}:${seg.section_id}:${seg.lane_id}`, seg);
  }

  for (const actor of actors) {
    // Fix 2 (dib 2026-07-23 US avoidance review): a plan that ENDS in a
    // deliberate stop is never extended. The driveway / curbside-park families
    // author the subject to pull in and hold; the run-out below then laid ≥40 m of
    // lane-following tail past the parked pose and drove it straight into the
    // garage, fence or barrier behind the bay (leftped-1774-7, rightped-1759-15,
    // rightped-11170-4). The marker is set by `applyTerminalStop`.
    if ((actor as unknown as Record<string, unknown>).terminal_stop === true) continue;
    const wps = actor.timed_waypoints;
    if (!wps || wps.length < 2) continue;
    const last = wps[wps.length - 1]!;
    // Heading from the last NON-DEGENERATE segment: a planned collision arc ends
    // with duplicate waypoints AT the conflict point (the actor "arrives"), so
    // wps[-1]-wps[-2] is often zero-length and the old check skipped extension
    // entirely — leaving a turn/avoided subject with no road past the conflict to
    // recover onto (dib 2026-07-08). Walk back to the last segment with length.
    let prev = wps[wps.length - 2]!;
    let segLen = Math.hypot(last.x - prev.x, last.y - prev.y);
    for (let i = wps.length - 3; i >= 0 && segLen < 1e-3; i -= 1) {
      prev = wps[i]!;
      segLen = Math.hypot(last.x - prev.x, last.y - prev.y);
    }
    const dx = last.x - prev.x;
    const dy = last.y - prev.y;
    if (segLen < 1e-3) continue; // genuinely no heading to continue
    const ux = dx / segLen;
    const uy = dy / segLen;
    const dt = Math.max(1e-3, last.time - prev.time);

    if (actor.kind === "vehicle") {
      const finalSegMps = dt > 1e-3 ? segLen / dt : actor.speed_kph / 3.6;
      // Resume the nominal cruising speed for the run-out (never slower than the
      // final approach segment): a missed subject that decelerated to meet the
      // conflict on time should accelerate back up and pull away, not crawl off.
      const runOutMps = Math.max(finalSegMps, actor.speed_kph / 3.6);
      // ALWAYS extend a vehicle's run-out — never skip on "little schedule time
      // left". The old `remaining <= MIN_REMAINING_S` skip assumed wall-clock tracks
      // the waypoint schedule, but a reactive-yield subject runs SECONDS BEHIND schedule
      // (it holds at the junction), and lever #1's exit-lane continuation pushes
      // last.time near/past durationS — so the tail was skipped exactly for the
      // scenes that need it, and the subject exhausted its path mid-clip and parked with
      // nothing near it (route-end holds at t≈15-16s, nearest actor 28-82m away,
      // 2026-07-09 lever-verify). Extra road is harmless: pursuit just never
      // exhausts it, and the tail is clamped to the drivable network below.
      if (runOutMps <= 0.1) continue;
      // Size the tail to the WHOLE clip, not just `remaining`. A reactive-yield subject
      // spends several seconds STOPPED at the junction (holding for the gap), so it
      // reaches the conflict late and has more MOVING time left than `remaining`
      // implies — a tail sized to `remaining` runs out and the subject stops dead for the
      // last several seconds (the "turn completes then stops at route-end" reject,
      // 2026-07-09: v_end 0, trail 3-7s). Over-provisioning road ahead is harmless
      // (the subject just has a forward pure-pursuit target it never exhausts); the tail
      // stays lawful because laneFollowingTail walks drivable successors and the
      // run-out is clamped to the network below.
      const dist = Math.max(runOutMps * durationS, MIN_VEHICLE_RUNOUT_M);
      const cycle = isPedalCycle(actor);
      const laneTypes = cycle ? CYCLE_LANE_TYPES : DRIVING_ONLY;
      const vertices = cycle ? cycleVertices : drivingVertices;
      // Preferred: follow the lane centerline + successors (lawful run-out —
      // dib review 2026-07-03: straight tails read as "drunk driving" past a
      // miss). Fallback: the straight tail clamped to the usable network.
      const laneWalk =
        roadSegments && roadSegments.length > 0
          ? laneFollowingTail(last.x, last.y, ux, uy, dist, roadSegments, segByKey, laneTypes)
          : null;
      if (laneWalk) {
        // A walk that ended at a DEAD END stops the actor a margin short of the
        // network's last vertex (right-2101-0: cyclist rode off the map edge).
        const laneTail = laneWalk.deadEnd
          ? trimTailArc(laneWalk.tail, DEAD_END_MARGIN_M)
          : laneWalk.tail;
        // Clamp to the usable network first: a lane-follow can chain into a
        // successor whose far end runs off the mapped road (map edge / a lane
        // the runtime lacks), leaving the subject parked in the grass or a tree
        // (dib 2026-07-09: avoided-turn subject drives off-lane at the run-out).
        // Stop at the last on-road point so it parks lawfully.
        const kept: Array<{ x: number; y: number }> = [];
        for (const p of laneTail) {
          if (vertices.length > 0 && !nearRoadIn(vertices, p.x, p.y)) break;
          kept.push(p);
        }
        // An empty kept-list pushes nothing; the fall-through check below then
        // hands the actor the straight tail instead of no run-out at all.
        // Schedule the tail with the same curvature + accel envelope as the
        // pre-conflict retime. The old constant-cruise times put the subject back
        // at ~8.3 m/s AT the junction exit and through every downstream
        // connector the tail walks — the #486 feasibility gate rejected 18/32
        // retained turn scenes and EVERY violation was a tail vertex at
        // cruise; the reviewer-visible symptom is the right-turn exit
        // overshoot onto the far curb (munich/bicyclistavoid/right-2186-2,
        // dib 2026-08-02). The boundary vertex (the planned path's end) seeds
        // the profile with the ARRIVAL speed; its own time is never touched.
        // Runs on the CLAMPED, dead-end-trimmed tail so the profile schedules
        // exactly the vertices the actor will drive.
        const profile = tailSpeedProfileMps(
          [{ x: last.x, y: last.y }, ...kept],
          runOutMps,
          finalSegMps,
        );
        let t = last.time;
        let px = last.x;
        let py = last.y;
        for (let i = 0; i < kept.length; i += 1) {
          const p = kept[i]!;
          // Segment speed = min of its endpoint speeds — the same convention
          // the retime's constant branch uses, so the replayed segment speed
          // never exceeds either vertex's cap.
          const v = Math.min(profile[i]!, profile[i + 1]!);
          t += Math.hypot(p.x - px, p.y - py) / v;
          px = p.x;
          py = p.y;
          wps.push({ x: p.x, y: p.y, time: t, speed_kph: profile[i + 1]! * 3.6 });
        }
        if (wps[wps.length - 1] !== last) continue;
        // The whole tail was clamped away (first vertex already off-network):
        // fall through to the straight tail rather than leaving no run-out.
      }
      let straightDist = dist;
      if (vertices.length > 0) {
        let onRoad = 0;
        for (let k = TAIL_STEP_M; k <= straightDist + 1e-6; k += TAIL_STEP_M) {
          if (!nearRoadIn(vertices, last.x + ux * k, last.y + uy * k)) break;
          onRoad = k;
        }
        if (onRoad < MIN_TRUNCATED_TAIL_M) continue;
        straightDist = onRoad;
      }
      wps.push({
        x: last.x + ux * straightDist,
        y: last.y + uy * straightDist,
        time: last.time + straightDist / runOutMps,
        speed_kph: actor.speed_kph,
      });
    } else if (actor.kind === "walker") {
      // Step past the far curb onto the sidewalk, keeping the crossing pace.
      const speedMps = dt > 1e-3 ? segLen / dt : WALKER_FALLBACK_MPS;
      const walkS = PED_SIDEWALK_STEP_M / Math.max(0.3, speedMps);
      wps.push({
        x: last.x + ux * PED_SIDEWALK_STEP_M,
        y: last.y + uy * PED_SIDEWALK_STEP_M,
        time: last.time + walkS,
      });
    }
  }
}
