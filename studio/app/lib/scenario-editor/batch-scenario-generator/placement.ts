import type { RuntimeRoadSegment } from "@/app/lib/runtime/runtime-types";
import {
  isLaneChangeStrategy,
  isLaneKeepStrategy,
  isRampStrategy,
  isStopJunctionStrategy,
  laneChangeSide,
} from "./types";
import type {
  BatchScenarioStrategy,
  Candidate,
  PlacedVariation,
  ScenarioVariation,
  StopPlacementRejectLogger,
} from "./types";
import {
  CANDIDATE_RESAMPLE_ATTEMPTS,
  CLIP_DURATION_S,
  SUBJECT_STOP_FORWARD_RUNWAY_M,
  HIGHWAY_MERGE_ACCEL_CREDIT_S,
  HIGHWAY_RAMP_SPEED_FRACTION,
  HIGHWAY_RAMP_SPEED_KPH_MAX,
  HIGHWAY_RAMP_SPEED_KPH_MIN,
  LANE_CHANGE_HORIZON_S,
  LANE_CHANGE_MIN_BEGIN_CLEAR_M,
  laneChangeCurveMeters,
  LANE_CHANGE_TRANSITION_M,
  ROUTE_OVERRUN_DEMAND_FACTOR,
  ROUTE_OVERRUN_DEMAND_MARGIN_M,
  SURVIVAL_HORIZON_S,
  TURN_RESUME_ACCEL_CREDIT_S,
} from "./constants";
import {
  laneChangeTarget,
  segmentLengthMeters,
  segmentRsl,
  turnExitSegment,
} from "./graph";
import {
  buildForwardRouteThroughSuccessors,
  buildRouteViaChain,
  measureEmittedRouteCorridor,
  metersToNextJunction,
  roundTo,
  routeFollowRunwayMeters,
  survivalRunwayBestBranchMeters,
  survivalRunwayMeters,
  upstreamApproachPath,
  upstreamSpawnForApproach,
} from "./routing";
import {
  placeStopVariation,
  stopVariantFallbackOrder,
} from "./placement-stop";
import {
  highwayEntryChainForCandidate,
  highwayExitChainForCandidate,
  sameDirectionLaneCountsFor,
} from "./highway";
import { type MapExtent, corridorWithinExtent, placementWithinExtent } from "./extent";

/**
 * Assessment of the subject's planned corridor against the dead-end overrun
 * demand (see ROUTE_OVERRUN_DEMAND_FACTOR in constants.ts). `plannedMeters` is
 * the corridor the subject can ACTUALLY drive; `endsAtDeadEnd` marks a corridor
 * that terminates at the physical end of the mesh (an overrun there = the subject
 * falls into the void → actor_integrity_rejected at render).
 */
export type RouteOverrunAssessment = {
  demandMeters: number;
  plannedMeters: number;
  endsAtDeadEnd: boolean;
  ok: boolean;
};

/**
 * Dead-end overrun guard (dib 2026-07-17). Basis per family — chosen to match
 * how the WORKER actually drives the subject, so "gate passes" means "the subject
 * cannot run off the mesh":
 *
 *  - ROUTE-FOLLOWER egos (lane_keep / highway_lane_keep / highway ramps /
 *    stop-junction families / cause-first + stop-line stops): measure the
 *    EXACT route emit will build (same builder, same arguments —
 *    buildForwardRouteThroughSuccessors / buildRouteViaChain), truncated at
 *    the first discontiguous hop (defective bundle chains teleport; the subject
 *    physically ends at the gap). Pass when the measured contiguous corridor
 *    covers the demand, OR when it ends mid-mesh (adjacent routable successor
 *    exists past the route end): the route-end handbrake hold may stall the
 *    scene — the 2D gate's business — but the subject stays on pavement.
 *
 *  - TM / timed-instruction egos (lane_change_* / highway_lane_change_* /
 *    overtake_*, forced-stop variants): no deterministic route — the subject lane-
 *    follows successors and may take ANY branch at a fork, so the WORST-CASE
 *    survival runway must cover the demand (loops already count as indefinite
 *    continuation, so only a genuinely reachable dead end rejects). The walk
 *    follows PHYSICALLY ADJACENT successors only (survivalRunwayMeters is
 *    adjacency-aware) — bundles carry wrong-end/teleport links (SR-P1 road 41
 *    → junction 4731, 350m away) that previously let the graph walk see
 *    endless runway on roads whose mesh ends. Lane changes must satisfy the
 *    demand on BOTH lanes: the merge
 *    target (where the subject ends up) and the spawn lane (where it stays if the
 *    worker's paired-lane walk silently demotes the maneuver to the TM
 *    set_path no-op).
 *
 *  - TURN egos: the junction branch is pinned by the turn primitive; the
 *    follow-through uses the BEST-branch continuation from the turn exit
 *    (matching the existing post-turn placement doctrine, dib 2026-07-13 —
 *    the 2D gate rejects egos that pick a bad branch; turn cruise speeds keep
 *    the demand small).
 */
export function assessEgoRouteOverrun(
  segments: ReadonlyMap<string, RuntimeRoadSegment>,
  candidate: Candidate,
  placed: PlacedVariation,
): RouteOverrunAssessment {
  const strategy = candidate.strategy;
  const cruiseKph = placed.variation.speedKph;
  const speedMps = cruiseKph / 3.6;
  // Ramps drive a two-speed profile (exit: cruise to the gore then ramp speed;
  // entry: ramp speed to the merge then cruise) — demand the clip's PLANNED
  // motion profile instead of full-clip cruise, else highway_exit (which ends
  // the clip at 35-55 km/h on the ramp) over-demands by ~2x.
  const demandMeters =
    (placed.highwayRoute
      ? (placed.highwayRoute.preSpeedKph / 3.6) *
          Math.min(placed.variation.instructionDelaySeconds, CLIP_DURATION_S) +
        (placed.highwayRoute.postSpeedKph / 3.6) *
          Math.max(0, CLIP_DURATION_S - placed.variation.instructionDelaySeconds)
      : speedMps * CLIP_DURATION_S) *
      ROUTE_OVERRUN_DEMAND_FACTOR +
    ROUTE_OVERRUN_DEMAND_MARGIN_M;
  // Float guard: capped walks reconstruct the demand additively (e.g.
  // distToChange + (demand - distToChange)), so "exactly enough runway" can
  // land an ulp below the demand and spuriously reject.
  const DEMAND_EPS_M = 0.001;
  const spawnFraction = placed.variation.spawnFraction;

  const isRouteFollower =
    isLaneKeepStrategy(strategy) ||
    isRampStrategy(strategy) ||
    isStopJunctionStrategy(strategy) ||
    (strategy === "stop" &&
      (placed.stopPlan?.subjectStopMode === "tm_follow" ||
        placed.stopPlan?.subjectStopMode === "stop_line"));
  if (isRouteFollower) {
    // Mirror emit.ts applyGeneratedDraft exactly: same target runway, same
    // builder, same straightest-successor flag — so the corridor measured here
    // IS the emitted route's corridor.
    const subjectForwardRunwayM = Math.max(
      SUBJECT_STOP_FORWARD_RUNWAY_M,
      speedMps * (SURVIVAL_HORIZON_S + 4),
    );
    const route = placed.highwayRoute
      ? buildRouteViaChain(
          segments,
          placed.spawnSegment,
          spawnFraction,
          placed.highwayRoute.chain,
          placed.highwayRoute.preSpeedKph,
          placed.highwayRoute.postSpeedKph,
          placed.highwayRoute.switchAtChainIndex,
          subjectForwardRunwayM,
        )
      : buildForwardRouteThroughSuccessors(
          segments,
          placed.spawnSegment,
          spawnFraction,
          cruiseKph,
          subjectForwardRunwayM,
          isLaneKeepStrategy(strategy),
        );
    const corridor = measureEmittedRouteCorridor(
      segments,
      placed.spawnSegment,
      spawnFraction,
      route,
    );
    return {
      demandMeters,
      plannedMeters: corridor.meters,
      endsAtDeadEnd: corridor.endsAtDeadEnd,
      ok: corridor.meters >= demandMeters - DEMAND_EPS_M || !corridor.endsAtDeadEnd,
    };
  }

  if (strategy === "turn_left" || strategy === "turn_right") {
    const exit = turnExitSegment(
      segments,
      candidate.segment,
      strategy === "turn_left" ? "Left" : "Right",
    );
    const approachMeters = speedMps * (placed.variation.approachTimeSeconds ?? 6.5);
    const postDemand = Math.max(0, demandMeters - approachMeters);
    const post = exit
      ? survivalRunwayBestBranchMeters(segments, exit, 0, postDemand)
      : 0;
    const plannedMeters = approachMeters + post;
    return {
      demandMeters,
      plannedMeters,
      endsAtDeadEnd: plannedMeters < demandMeters - DEMAND_EPS_M,
      ok: plannedMeters >= demandMeters - DEMAND_EPS_M,
    };
  }

  // TM / timed-instruction egos: worst-case continuation from the spawn.
  // ADJACENT successors only — the plain graph walk trusts wrong-end/teleport
  // bundle links (SR-P1 road 41's "successor" sits 350m away at the road
  // START), which is exactly how the fallen scenes passed the old gates.
  let plannedMeters = survivalRunwayMeters(
    segments,
    placed.spawnSegment,
    spawnFraction,
    demandMeters,
  );
  const side = laneChangeSide(strategy);
  if (side) {
    const target = laneChangeTarget(segments, placed.spawnSegment, side);
    if (target) {
      const distToChange = speedMps * placed.variation.instructionDelaySeconds;
      const changeFraction = Math.min(
        0.95,
        spawnFraction + distToChange / Math.max(1, segmentLengthMeters(target)),
      );
      const targetDemand = Math.max(0, demandMeters - distToChange);
      const targetRunway = survivalRunwayMeters(
        segments,
        target,
        changeFraction,
        targetDemand,
      );
      plannedMeters = Math.min(plannedMeters, distToChange + targetRunway);
    }
  }
  return {
    demandMeters,
    plannedMeters,
    endsAtDeadEnd: plannedMeters < demandMeters - DEMAND_EPS_M,
    ok: plannedMeters >= demandMeters - DEMAND_EPS_M,
  };
}

/**
 * Validate a (candidate, variation) pair against survival-runway and
 * in-window timing constraints; for turns, place the spawn upstream so the
 * subject reaches the junction at approachTimeSeconds. Returns null when the
 * candidate cannot host the maneuver at this speed. Every successful placement
 * additionally passes the dead-end overrun guard (assessEgoRouteOverrun);
 * rejects log "route_runway_overrun" to the diagnostic logger.
 */
export function placeVariationOnCandidate(
  segments: ReadonlyMap<string, RuntimeRoadSegment>,
  candidate: Candidate,
  variation: ScenarioVariation,
  onStopReject?: StopPlacementRejectLogger,
): PlacedVariation | null {
  const placed = placeVariationOnCandidateUngated(
    segments,
    candidate,
    variation,
    onStopReject,
  );
  if (!placed) return null;
  const overrun = assessEgoRouteOverrun(segments, candidate, placed);
  if (!overrun.ok) {
    onStopReject?.("route_runway_overrun");
    return null;
  }
  return placed;
}

function placeVariationOnCandidateUngated(
  segments: ReadonlyMap<string, RuntimeRoadSegment>,
  candidate: Candidate,
  variation: ScenarioVariation,
  onStopReject?: StopPlacementRejectLogger,
): PlacedVariation | null {
  const speedMps = variation.speedKph / 3.6;
  const segment = candidate.segment;
  const strategy = candidate.strategy;

  if (strategy === "turn_left" || strategy === "turn_right") {
    const exit = turnExitSegment(segments, segment, strategy === "turn_left" ? "Left" : "Right");
    if (!exit) return null;
    // Try the sampled approach time, then shorter ones down to 4.8s (the
    // turn still starts inside the 5.1-11.5s label window after junction
    // entry) — approach stubs are short, upstream chains often shorter.
    for (const approachTime of [variation.approachTimeSeconds ?? 6.5, 5.6, 4.8]) {
      const spawn = upstreamSpawnForApproach(segments, segment, speedMps * approachTime);
      if (!spawn) continue;
      // Post-turn continuation so the subject survives to the END of the clip, not
      // just the label window (else it despawns after the turn). BEST branch,
      // not worst: the follow-through may involve further turns/loops — one
      // survivable path suffices, the 2D gate rejects egos that pick a dead-end
      // branch (dib 2026-07-13). The accel credit reflects the subject re-accelerating
      // from turn speed instead of covering the whole tail at cruise.
      const exitNeeded =
        speedMps * Math.max(3, SURVIVAL_HORIZON_S - approachTime - TURN_RESUME_ACCEL_CREDIT_S);
      if (survivalRunwayBestBranchMeters(segments, exit, 0, exitNeeded) < exitNeeded) continue;
      return {
        variation: {
          ...variation,
          spawnFraction: roundTo(spawn.fraction, 3),
          approachTimeSeconds: approachTime,
        },
        spawnSegment: spawn.segment,
      };
    }
    return null;
  }

  if (strategy === "stop") {
    // Every stop is caused: junction-anchored (variants A/B) or behind a
    // braking lead (variant C). The old free timed stop is gone.
    return placeStopVariation(segments, candidate, variation, onStopReject);
  }

  if (isRampStrategy(strategy)) {
    // highway_exit / highway_entry: the subject is a ROUTE-FOLLOWER through the
    // resolved gore/merge chain. instructionDelaySeconds (5.3-7.5s draw) is
    // the target time to reach the gore (exit) / the merge point (entry), so
    // the maneuver lands inside the label window; a shorter-arrival ladder
    // rescues short lanes.
    const counts = sameDirectionLaneCountsFor(segments);
    const chain =
      strategy === "highway_exit"
        ? highwayExitChainForCandidate(segments, counts, segment)
        : highwayEntryChainForCandidate(segments, counts, segment);
    if (!chain || chain.length === 0) return null;
    const cruiseKph = variation.speedKph;
    const rampKph = Math.round(
      Math.min(
        HIGHWAY_RAMP_SPEED_KPH_MAX,
        Math.max(HIGHWAY_RAMP_SPEED_KPH_MIN, cruiseKph * HIGHWAY_RAMP_SPEED_FRACTION),
      ),
    );
    // Pre-event speed: exit approaches at cruise; entry rolls the ramp at ramp speed.
    const preKph = strategy === "highway_exit" ? cruiseKph : rampKph;
    const preMps = preKph / 3.6;
    const length = Math.max(1, segmentLengthMeters(segment));
    const lastChain = chain[chain.length - 1]!;
    // The EVENT (gore peel-off / mainline merge) happens at the END of the
    // pre-event stretch: for exit that's the spawn segment's end; for entry
    // the subject must also cover the connector chain BEFORE the mainline lane —
    // omit that and the merge lands ~10s late, outside the label window
    // (smoke 2026-07-13: merge at 18.6s instead of ~6s).
    const preChainMeters =
      strategy === "highway_entry"
        ? chain.slice(0, -1).reduce((sum, seg) => sum + segmentLengthMeters(seg), 0)
        : 0;
    // Ladder: the drawn arrival first, then earlier and LATER rungs — a merge
    // as late as ~10.5s still lands inside the 11.5s label window, which
    // rescues long feeder ramps whose connector chain alone consumes the
    // early arrivals.
    for (const arrivalS of [variation.instructionDelaySeconds, 5.3, 4.5, 8.5, 10.5]) {
      // Distance on the spawn segment before the gore / the merge chain.
      const preDistance = preMps * arrivalS - preChainMeters;
      if (preDistance < 2) continue; // connectors alone exceed this arrival
      // Resolve the spawn. For highway_exit the approach may not fit on the one
      // gore-candidate segment (Page Mill's "highway" lanes are ≤85 m stubs,
      // shorter than a 4.5 s @ 85 km/h approach) — walk it back through the
      // upstream highway stubs and PREPEND that path to the route so the subject
      // still flows to the gore inside the label window (diagnostic 2026-07-13:
      // 49 Page Mill exits, all rejected as spawn_lane_too_short). Entry keeps
      // the single feeder segment (its connector chain is handled above).
      let spawnSegment = segment;
      let spawnFraction = 1 - preDistance / length;
      let routeChain = chain;
      let switchIndex = strategy === "highway_exit" ? 0 : chain.length - 1;
      if (spawnFraction < 0.02) {
        if (strategy !== "highway_exit") continue;
        const up = upstreamApproachPath(segments, segment, preDistance);
        if (!up) continue;
        spawnSegment = up.segment;
        spawnFraction = up.fraction;
        routeChain = [...up.path, ...chain];
        switchIndex = up.path.length; // the gore connector follows the approach prefix
      }
      // Post-event continuation: exit needs ramp runway past the gore at ramp
      // speed; entry needs mainline runway past the merge at cruise (minus an
      // accel credit — the subject speeds up from ramp speed). Best-branch: the
      // route-follower steers the branch choice deterministically.
      const postSeconds = Math.max(
        3,
        SURVIVAL_HORIZON_S - arrivalS - (strategy === "highway_entry" ? HIGHWAY_MERGE_ACCEL_CREDIT_S : 0),
      );
      const postMps = (strategy === "highway_exit" ? rampKph : cruiseKph) / 3.6;
      const chainMeters = chain.reduce((sum, seg) => sum + segmentLengthMeters(seg), 0);
      const postNeeded = Math.max(0, postMps * postSeconds - chainMeters);
      if (
        postNeeded > 0 &&
        survivalRunwayBestBranchMeters(segments, lastChain, 0, postNeeded) < postNeeded
      ) {
        continue;
      }
      return {
        variation: {
          ...variation,
          spawnFraction: roundTo(spawnFraction, 3),
          instructionDelaySeconds: roundTo(arrivalS, 1),
        },
        spawnSegment,
        highwayRoute: {
          chain: routeChain,
          preSpeedKph: preKph,
          // Exit slows from the FIRST gore connector; entry accelerates on the
          // mainline lane (the last chain hop).
          postSpeedKph: strategy === "highway_exit" ? rampKph : cruiseKph,
          switchAtChainIndex: switchIndex,
        },
      };
    }
    return null;
  }

  // Survive the whole clip (not just the label window) so the subject never
  // vanishes mid-scene by reaching a dead end. Lane changes use the shorter
  // lane-change horizon: the follow-through may bend into a turn (dib
  // 2026-07-13), so 18s of guaranteed straight-line road over-rejects.
  const laneChangeMergeSide = laneChangeSide(strategy);
  const isLaneChange = laneChangeMergeSide !== null;
  const horizonS = isLaneChange ? LANE_CHANGE_HORIZON_S : SURVIVAL_HORIZON_S;
  const runwayNeeded = speedMps * horizonS + 8;
  // Lane changes need the WHOLE S-curve on open road before the next junction:
  // the approach (instruction delay) + the curve the worker actually builds +
  // a margin. Finishing the change on a junction APPROACH — then turning — is
  // still a valid scene; what is not valid is a junction INSIDE the merge, which
  // breaks the worker's paired-lane walk and silently demotes the maneuver to the
  // no-op TM set_path backend (19% executed vs 89%, measured 2026-07-14). Earlier
  // spawn fractions (the 0.12/0.05 fallbacks) push that junction farther away, so
  // they double as the junction-clearance fallback.
  const junctionClearanceNeeded = isLaneChange
    ? speedMps * variation.instructionDelaySeconds +
      laneChangeCurveMeters(speedMps) +
      LANE_CHANGE_MIN_BEGIN_CLEAR_M
    : 0;
  // Short suburban lanes often only work from near the lane start: retry the
  // sampled spawn fraction with early-lane fallbacks before rejecting.
  let spawnFraction: number | null = null;
  for (const fraction of [variation.spawnFraction, 0.12, 0.05]) {
    // lane_keep egos are ROUTE-FOLLOWERS (emit builds a preferStraight route
    // through junctions), so their runway is the straightest-routable-successor
    // corridor — nearly every lane that isn't hard against the map edge
    // qualifies, small streets included (dib 2026-07-13).
    const runwayMeters =
      isLaneKeepStrategy(strategy) || isStopJunctionStrategy(strategy)
        ? // stop-junction egos, like lane_keep, are route-followers THROUGH the junction:
          // their runway is the routable-successor corridor (they stop at the junction's
          // control, then proceed). Their candidate lane ENDS at the junction, so the
          // survival-runway check (18s of forward road on THIS lane) would reject every
          // valid site.
          routeFollowRunwayMeters(segments, segment, fraction, runwayNeeded)
        : survivalRunwayMeters(segments, segment, fraction, runwayNeeded);
    if (runwayMeters < runwayNeeded) {
      continue;
    }
    if (
      isLaneChange &&
      metersToNextJunction(segments, segment, fraction, junctionClearanceNeeded) <
        junctionClearanceNeeded
    ) {
      continue; // the change couldn't even BEGIN before the junction line
    }
    spawnFraction = fraction;
    break;
  }
  if (spawnFraction === null) return null;
  variation = { ...variation, spawnFraction };
  if (laneChangeMergeSide) {
    const target = laneChangeTarget(segments, segment, laneChangeMergeSide);
    if (!target) return null;
    // The subject finishes the window on the target lane; it needs survival
    // runway there from the lane-change point onward.
    const changeFraction = Math.min(
      0.95,
      variation.spawnFraction +
        (speedMps * variation.instructionDelaySeconds) / Math.max(1, segmentLengthMeters(target)),
    );
    const targetNeeded =
      speedMps * Math.max(3, horizonS - variation.instructionDelaySeconds) + 8;
    if (survivalRunwayMeters(segments, target, changeFraction, targetNeeded) < targetNeeded) {
      return null;
    }
  }
  return { variation, spawnSegment: segment };
}

/** Spawn-anchor key for spatial dedup — the placement's spawn segment, scoped
 * by map. Matches the `road:section:lane` form the emit harness reads back from
 * the subject spawn, so a caller can feed prior anchors in via excludeSpawnRsls. */
export function placementAnchorKey(mapName: string, placed: PlacedVariation): string {
  return `${mapName}|${segmentRsl(placed.spawnSegment)}`;
}

/**
 * One scenario's candidate draw + placement, exactly as batchGenerateScenarios
 * runs it: build the (variant-laddered) draw plans, then up to
 * CANDIDATE_RESAMPLE_ATTEMPTS draws per plan. Extracted so the real-map stop
 * variant probe measures the PRODUCTION path instead of a re-implementation
 * that could drift.
 *
 * Draw policy (operator-review issue #1 — spawn repetition): the draw is now
 * UNIFORM over the (length-sorted) pool, not `random()**2` quadratic-biased
 * toward the 1-2 longest segments — that bias collapsed large maps onto 2-3
 * spots (Yale's 26 scenes → 2 real locations, 11 on one bad spot). When
 * `usedAnchors` is supplied the draw also SPREADS: a fresh segment (usage 0) is
 * taken immediately, otherwise the least-used candidate found across the
 * attempts wins, so the pool fills out evenly and only repeats once exhausted.
 */
export function drawPlacementForBucket(input: {
  segments: ReadonlyMap<string, RuntimeRoadSegment>;
  strategy: BatchScenarioStrategy;
  candidates: Candidate[];
  junctionEntryCandidates: Candidate[];
  baseVariation: ScenarioVariation;
  random: () => number;
  onStopReject?: StopPlacementRejectLogger;
  /** Map name for the dedup anchor key (issue #1). Optional → keys are unscoped. */
  mapName?: string;
  /** Spawn-anchor usage counts (mutated by the caller). When present, the draw
   * prefers the least-used anchor so placements spread across the map. */
  usedAnchors?: Map<string, number>;
  /** Map-edge guard: the map's usable extent. Placements outside it (or on the
   * boundary) are rejected like any other placement failure. Null → guard off. */
  extent?: MapExtent | null;
}): { candidate: Candidate; placed: PlacedVariation } | null {
  // Caused stops: the seeded variant draw (~50/30/20) tries its own pool
  // first, then falls back DOWN the causal ladder (junction_proceed ->
  // queue_at_junction -> lead_brake) — never to a free, uncaused stop.
  // Variants A/B draw from the junction-entry pool; C draws from lanes with
  // a known drivable successor (the lead and subject must rest mid-block on
  // drivable mesh).
  const drawPlans =
    input.strategy === "stop"
      ? stopVariantFallbackOrder(input.baseVariation.stopVariant ?? "junction_proceed")
          .map((variant) => ({
            // lead_brake AND vru_yield rest mid-block on drivable mesh (a braking lead /
            // a crossing ped ahead on the subject's own lane), so they draw from lanes with
            // a known drivable successor. The junction-anchored variants (A/B/stop_sign)
            // draw from the junction-entry pool.
            candidates:
              variant === "lead_brake" || variant === "vru_yield"
                ? input.candidates.filter(
                    (candidate) => candidate.hasKnownDrivableSuccessor,
                  )
                : input.junctionEntryCandidates,
            variation: { ...input.baseVariation, stopVariant: variant },
          }))
          .filter((plan) => plan.candidates.length > 0)
      : [{ candidates: input.candidates, variation: input.baseVariation }];
  const used = input.usedAnchors;
  for (const plan of drawPlans) {
    // Uniform draw over the pool; when dedup is on, keep the least-used valid
    // placement seen and return early the moment a fresh (usage-0) one turns up.
    let best: { candidate: Candidate; placed: PlacedVariation; usage: number } | null = null;
    for (let attempt = 0; attempt < CANDIDATE_RESAMPLE_ATTEMPTS; attempt += 1) {
      const drawn = plan.candidates[Math.floor(input.random() * plan.candidates.length)];
      if (!drawn) break;
      const placement = placeVariationOnCandidate(
        input.segments,
        drawn,
        plan.variation,
        input.onStopReject,
      );
      if (!placement) continue;
      // Map-edge guard: drop placements that spawn off / on the boundary of the
      // usable extent (would vanish "into the abyss" on the 0.10 render map).
      if (!placementWithinExtent(placement, input.extent ?? null)) continue;
      // Lane change / overtake drive a long forward corridor before the pass lands —
      // require the whole corridor to stay in-map, not just the spawn (the overtake
      // "edge of map, cars disappearing" reject, dib 2026-07-09).
      if (isLaneChangeStrategy(input.strategy)) {
        const corridorM =
          (placement.variation.speedKph / 3.6) * LANE_CHANGE_HORIZON_S + LANE_CHANGE_TRANSITION_M;
        if (!corridorWithinExtent(input.segments, placement, input.extent ?? null, corridorM)) {
          continue;
        }
      }
      if (!used) return { candidate: drawn, placed: placement };
      const usage = used.get(placementAnchorKey(input.mapName ?? "", placement)) ?? 0;
      if (usage === 0) return { candidate: drawn, placed: placement };
      if (!best || usage < best.usage) best = { candidate: drawn, placed: placement, usage };
    }
    if (best) return { candidate: best.candidate, placed: best.placed };
  }
  return null;
}
