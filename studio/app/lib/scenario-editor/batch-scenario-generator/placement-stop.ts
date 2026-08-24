import type { TimedInstructionPrimitiveId } from "@simcloud/shared";
import type { RuntimeRoadSegment } from "@/app/lib/runtime/runtime-types";
import type {
  Candidate,
  PlacedVariation,
  ScenarioVariation,
  StopPlacementRejectLogger,
  StopVariant,
} from "./types";
import {
  CLIP_DURATION_S,
  STOP_BRAKING_WINDOW_S,
  STOP_COMFORT_DECEL_MPS2,
  STOP_COMFORT_DECEL_MPS2_SHORT,
  STOP_FOLLOW_REST_GAP_M,
  STOP_LEAD_VEHICLE_LENGTH_M,
  STOP_MIN_BRAKE_DELAY_S,
  STOP_PROCEED_RELATIONS_EGO,
  STOP_PROCEED_RELATIONS_LEAD,
  STOP_PROCEED_SPEED_KPH_CAP,
  STOP_QUEUE_EGO_RESUME_LAG_S,
  STOP_RESUME_ACCEL_CREDIT_S,
  STOP_SHORT_LANE_CRUISE_KPH,
  STOP_SHORT_MIN_INITIAL_GAP_M,
  STOP_VRU_CROSS_HALF_WIDTH_M,
  STOP_VRU_CROSS_SECONDS,
  STOP_VRU_REST_GAP_M,
  STOP_VRU_SPEED_KPH,
} from "./constants";
import {
  segmentEndsAtJunctionEntry,
  segmentLengthMeters,
  turnExitSegment,
} from "./graph";
import {
  centerlinePointAtFraction,
  forwardIsIncreasingS,
  laneHeadingAtFraction,
  metersToNextJunction,
  roundTo,
  survivalRunwayMeters,
  upstreamChainCapacityMeters,
  upstreamSpawnForApproach,
} from "./routing";

function proceedPrimitiveForRelation(
  relation: "Left" | "Right" | "Straight",
): TimedInstructionPrimitiveId {
  if (relation === "Right") return "turn_right_at_next_intersection";
  if (relation === "Straight") return "go_straight_at_next_intersection";
  return "turn_left_at_next_intersection";
}

/**
 * Pick the junction branch a stopped vehicle proceeds through after the hold:
 * the first relation in `preference` that (a) exists on the junction-approach
 * candidate with a resolvable exit, (b) also exists on the (possibly
 * upstream) spawn segment — the timed-instruction compiler validates the
 * proceed row against the SPAWN segment's turn_options, so this guarantees
 * the draft compiles — and (c) has survival runway through the exit for the
 * remaining clip time after the resume.
 */
function chooseJunctionProceed(
  segments: ReadonlyMap<string, RuntimeRoadSegment>,
  candidateSegment: RuntimeRoadSegment,
  spawnSegment: RuntimeRoadSegment,
  speedMps: number,
  drivingSecondsAfterResume: number,
  preference: readonly ("Left" | "Right" | "Straight")[],
  onReject?: StopPlacementRejectLogger,
): { relation: "Left" | "Right" | "Straight"; primitiveId: TimedInstructionPrimitiveId } | null {
  for (const relation of preference) {
    const exit = turnExitSegment(segments, candidateSegment, relation);
    if (!exit) {
      onReject?.(`proceed:${relation}:no_branch`);
      continue;
    }
    if (
      spawnSegment !== candidateSegment &&
      !turnExitSegment(segments, spawnSegment, relation)
    ) {
      onReject?.(`proceed:${relation}:spawn_compile_guard`);
      continue;
    }
    const exitNeeded =
      speedMps * Math.max(3, drivingSecondsAfterResume - STOP_RESUME_ACCEL_CREDIT_S);
    if (survivalRunwayMeters(segments, exit, 0, exitNeeded) < exitNeeded) {
      onReject?.(`proceed:${relation}:runway_short`);
      continue;
    }
    return { relation, primitiveId: proceedPrimitiveForRelation(relation) };
  }
  return null;
}

/** Largest 0.1s-quantized brake delay (<= the drawn delay) whose anchored
 * stop approach v * delay + v * STOP_BRAKING_WINDOW_S / 2 + restOffsetMeters
 * fits an upstream chain of `capacityMeters`. Real generated grids run
 * blocks of 30-100m, so rigidly demanding the full drawn-delay approach
 * starved the junction-anchored variants; braking a little earlier (never
 * before STOP_MIN_BRAKE_DELAY_S, so the subject is still at cruise at the 5.1s
 * keyframe and at rest by delay + 2s <= 9.5s) fits the same chain. Null when
 * even the floor doesn't fit. */
function fitStopDelayToChain(
  capacityMeters: number,
  speedMps: number,
  drawnDelaySeconds: number,
  restOffsetMeters: number,
): number | null {
  const brakeTravel = (speedMps * STOP_BRAKING_WINDOW_S) / 2;
  const maxDelay =
    Math.floor(((capacityMeters - brakeTravel - restOffsetMeters) / speedMps) * 10) / 10;
  const delay = Math.min(drawnDelaySeconds, maxDelay);
  return delay >= STOP_MIN_BRAKE_DELAY_S ? roundTo(delay, 1) : null;
}

/**
 * Variant A — stop at the junction entry line, then proceed (~50% draw).
 * Anchored-stop spawn math: spawn-to-line distance =
 *   pre-brake travel   v * delay   (delay = drawn instructionDelaySeconds,
 *   adaptively shortened down to STOP_MIN_BRAKE_DELAY_S when the upstream
 *   chain is short — see fitStopDelayToChain)
 * + brake-ramp travel  v * STOP_BRAKING_WINDOW_S / 2  (full brake ramps
 *   v -> 0 over ~2s, average speed v/2; see the worker stop primitive)
 * + rest margin        stopMarginMeters (2-6m before the entry line)
 * Rest lands at delay + 2s <= 9.5s, inside the [5.1, 11.5]s label window;
 * the proceed fires at 12.0-13.5s, strictly after the window, capped at
 * STOP_PROCEED_SPEED_KPH_CAP (junction creep), so the gate (which only
 * inspects the window) is unaffected and the post-resume runway demand stays
 * map-realistic.
 */
function placeJunctionProceedStop(
  segments: ReadonlyMap<string, RuntimeRoadSegment>,
  candidate: Candidate,
  variation: ScenarioVariation,
  onReject?: StopPlacementRejectLogger,
): PlacedVariation | null {
  const segment = candidate.segment;
  if (!segmentEndsAtJunctionEntry(segments, segment)) {
    onReject?.("A:not_junction_entry");
    return null;
  }
  const speedMps = variation.speedKph / 3.6;
  const margin = variation.stopMarginMeters ?? 4;
  const brakeTravel = (speedMps * STOP_BRAKING_WINDOW_S) / 2;
  const desiredApproach =
    speedMps * variation.instructionDelaySeconds + brakeTravel + margin;
  const capacity = upstreamChainCapacityMeters(segments, segment, desiredApproach);
  const delay = fitStopDelayToChain(
    capacity,
    speedMps,
    variation.instructionDelaySeconds,
    margin,
  );
  if (delay === null) {
    onReject?.("A:no_upstream_approach");
    return null;
  }
  const approachMeters = speedMps * delay + brakeTravel + margin;
  const spawn = upstreamSpawnForApproach(segments, segment, approachMeters);
  if (!spawn) {
    onReject?.("A:no_upstream_approach");
    return null;
  }
  const resumeAt = variation.stopResumeAtSeconds ?? 12.5;
  const proceedSpeedKph = Math.min(variation.speedKph, STOP_PROCEED_SPEED_KPH_CAP);
  const proceed = chooseJunctionProceed(
    segments,
    segment,
    spawn.segment,
    proceedSpeedKph / 3.6,
    CLIP_DURATION_S - resumeAt,
    STOP_PROCEED_RELATIONS_EGO,
    onReject ? (reason) => onReject(`A:${reason}`) : undefined,
  );
  if (!proceed) {
    onReject?.("A:no_proceed_branch");
    return null;
  }
  return {
    variation: {
      ...variation,
      spawnFraction: roundTo(spawn.fraction, 3),
      instructionDelaySeconds: delay,
    },
    spawnSegment: spawn.segment,
    stopPlan: {
      variant: "junction_proceed",
      subjectStopAtSeconds: delay,
      subjectResume: {
        atSeconds: resumeAt,
        primitiveId: proceed.primitiveId,
        speedKph: proceedSpeedKph,
      },
      lead: null,
      vru: null,
    },
  };
}

/**
 * Variant B — queue behind a lead at the junction (~30% draw). The lead gets
 * its own anchored stop so IT rests stopMarginMeters before the entry line;
 * the subject's anchored stop rests STOP_LEAD_VEHICLE_LENGTH_M + queue gap
 * further back (2-5m bumper gap behind the lead's rear). Both spawn on the
 * same upstream approach chain at the same cruise speed, so the spawn-time
 * separation v*(tEgo - tLead) + (subjectRest - leadRest) (~16-32m) holds until
 * the lead brakes. After the hold the lead proceeds through the junction and
 * the subject follows via set_speed — or stays queued (still causal) when the
 * worst-case post-junction runway can't host it.
 */
function placeQueueAtJunctionStop(
  segments: ReadonlyMap<string, RuntimeRoadSegment>,
  candidate: Candidate,
  variation: ScenarioVariation,
  onReject?: StopPlacementRejectLogger,
): PlacedVariation | null {
  const segment = candidate.segment;
  if (!segmentEndsAtJunctionEntry(segments, segment)) {
    onReject?.("B:not_junction_entry");
    return null;
  }
  const speedMps = variation.speedKph / 3.6;
  const leadMargin = variation.stopMarginMeters ?? 4;
  const queueGap = variation.stopQueueGapMeters ?? 3;
  const subjectRestMeters = leadMargin + STOP_LEAD_VEHICLE_LENGTH_M + queueGap;
  const brakeTravel = (speedMps * STOP_BRAKING_WINDOW_S) / 2;
  // The subject's approach is the longer of the two (its rest sits a car length
  // + gap behind the lead's); fit ITS brake delay to the chain and the
  // lead's shorter approach fits automatically.
  const desiredEgoApproach =
    speedMps * variation.instructionDelaySeconds + brakeTravel + subjectRestMeters;
  const capacity = upstreamChainCapacityMeters(segments, segment, desiredEgoApproach);
  const subjectStopAt = fitStopDelayToChain(
    capacity,
    speedMps,
    variation.instructionDelaySeconds,
    subjectRestMeters,
  );
  if (subjectStopAt === null) {
    onReject?.("B:no_upstream_approach_subject");
    return null;
  }
  const leadStopAt = roundTo(
    Math.max(0.5, subjectStopAt - (variation.stopLeadDeltaSeconds ?? 1.5)),
    1,
  );
  const leadApproachMeters = speedMps * leadStopAt + brakeTravel + leadMargin;
  const subjectApproachMeters = speedMps * subjectStopAt + brakeTravel + subjectRestMeters;
  const subjectSpawn = upstreamSpawnForApproach(segments, segment, subjectApproachMeters);
  if (!subjectSpawn) {
    onReject?.("B:no_upstream_approach_subject");
    return null;
  }
  const leadSpawn = upstreamSpawnForApproach(segments, segment, leadApproachMeters);
  if (!leadSpawn) {
    onReject?.("B:no_upstream_approach_lead");
    return null;
  }
  const leadResumeAt = variation.stopLeadResumeAtSeconds ?? 12.2;
  const proceedSpeedKph = Math.min(variation.speedKph, STOP_PROCEED_SPEED_KPH_CAP);
  const leadProceed = chooseJunctionProceed(
    segments,
    segment,
    leadSpawn.segment,
    proceedSpeedKph / 3.6,
    CLIP_DURATION_S - leadResumeAt,
    STOP_PROCEED_RELATIONS_LEAD,
    onReject ? (reason) => onReject(`B:${reason}`) : undefined,
  );
  if (!leadProceed) {
    onReject?.("B:no_lead_proceed_branch");
    return null;
  }
  // The resumed subject is TM-driven with no routed branch, so it may take ANY
  // junction branch — require worst-case runway from the entry line onward
  // (at the capped follow speed, matching its set_speed row).
  const subjectResumeAt = roundTo(leadResumeAt + STOP_QUEUE_EGO_RESUME_LAG_S, 1);
  const subjectResumeNeeded =
    (proceedSpeedKph / 3.6) *
    Math.max(3, CLIP_DURATION_S - subjectResumeAt - STOP_RESUME_ACCEL_CREDIT_S);
  const subjectCanResume =
    survivalRunwayMeters(segments, segment, 1, subjectResumeNeeded) >= subjectResumeNeeded;
  // Non-fatal: the scenario still places, the subject just stays queued.
  if (!subjectCanResume) onReject?.("info:B:subject_stays_queued");
  return {
    variation: {
      ...variation,
      spawnFraction: roundTo(subjectSpawn.fraction, 3),
      instructionDelaySeconds: subjectStopAt,
    },
    spawnSegment: subjectSpawn.segment,
    stopPlan: {
      variant: "queue_at_junction",
      subjectStopAtSeconds: subjectStopAt,
      subjectResume: subjectCanResume
        ? {
            atSeconds: subjectResumeAt,
            primitiveId: "set_speed",
            speedKph: proceedSpeedKph,
          }
        : null,
      lead: {
        spawnSegment: leadSpawn.segment,
        spawnFraction: roundTo(leadSpawn.fraction, 3),
        speedKph: variation.speedKph,
        stopAtSeconds: leadStopAt,
        resume: {
          atSeconds: leadResumeAt,
          primitiveId: leadProceed.primitiveId,
          speedKph: proceedSpeedKph,
        },
      },
      vru: null,
    },
  };
}

/**
 * Variant C — mid-block lead-vehicle brake (~20% draw). The lead spawns
 * d0 = STOP_LEAD_VEHICLE_LENGTH_M + restGap + v*deltaT meters ahead on the
 * subject's own lane at the same speed; it brakes at tLead, the subject at
 * tLead + deltaT. Both ramp v -> 0 over ~2s (extra v * 1m of travel each, so
 * the ramps cancel) and the rest bumper gap is exactly
 *   d0 - v*deltaT - STOP_LEAD_VEHICLE_LENGTH_M = restGap (3-6m, seeded).
 * The subject's rest lands at instructionDelaySeconds + 2s <= 9.5s, inside the
 * label window. No resume: a stopped car ahead for the rest of the clip is
 * realistic.
 */
function placeLeadBrakeStop(
  segments: ReadonlyMap<string, RuntimeRoadSegment>,
  candidate: Candidate,
  variation: ScenarioVariation,
  onReject?: StopPlacementRejectLogger,
): PlacedVariation | null {
  if (!candidate.hasKnownDrivableSuccessor) {
    onReject?.("C:no_drivable_successor");
    return null;
  }
  const segment = candidate.segment;
  const subjectStopAt = variation.instructionDelaySeconds; // kept for metadata only
  const leadStopAt = 1.5;
  const segLen = Math.max(1, segmentLengthMeters(segment));
  // Travel direction on this lane: "ahead" is +s for some lanes and −s for others
  // (OpenDRIVE side convention). Placing the lead at a blindly-HIGHER s_fraction
  // put it BEHIND the subject on half the lanes, so the subject drove the wrong way into
  // oncoming traffic. Place the lead `initialGap` ahead in the TRUE travel dir.
  const fwdIncS = forwardIsIncreasingS(segments, segment);
  const dirSign = fwdIncS ? 1 : -1;
  // Spawn fractions to try: near the travel-START of the lane so there's forward
  // runway for both subject and lead (low-s when forward is +s, high-s otherwise). Denser
  // sampling lifts emit yield — short blocks where the first 1-2 fractions overflow
  // the lead or rest in a junction often fit at a slightly different start fraction
  // (deterministic first-fit, so the extra tries only ADD placements, never change an
  // already-succeeding one).
  const spawnTries = fwdIncS
    ? [variation.spawnFraction, 0.08, 0.12, 0.18, 0.26, 0.05]
    : [variation.spawnFraction, 0.92, 0.88, 0.82, 0.74, 0.95];
  // Cause-first: the lead is a STATIONARY obstacle placed a comfortable stopping distance
  // ahead, braking EARLY so it's already at rest when the subject approaches; the subject CHASES it
  // and stops behind it. Two placement profiles are tried IN ORDER: the standard geometry,
  // then a SHORT-LANE retry (firmer comfort decel + a capped lower cruise) that shrinks the
  // comfortable-stopping gap so much shorter lanes fit. The lead stays the cause either way,
  // so the stop still scores valid. Standard wins first on long lanes → existing placements
  // are byte-identical; the short retry only ADDS placements that used to be dropped.
  const profiles = [
    { decel: STOP_COMFORT_DECEL_MPS2, speedKph: variation.speedKph },
    {
      decel: STOP_COMFORT_DECEL_MPS2_SHORT,
      speedKph: Math.min(variation.speedKph, STOP_SHORT_LANE_CRUISE_KPH),
    },
  ];
  for (const [pi, profile] of profiles.entries()) {
    // Only surface reject reasons for the LAST (short) profile — a standard-profile reject
    // that the short retry rescues is not a genuine reject.
    const log = pi === profiles.length - 1 ? onReject : undefined;
    const speedMps = profile.speedKph / 3.6;
    const comfortStopDistM = (speedMps * speedMps) / (2 * profile.decel);
    // Gap = comfortable stopping distance + rest, floored above the worker STOP_GAP (11) so
    // the subject never spawns already inside the gap.
    const initialGapMeters = Math.max(
      roundTo(comfortStopDistM + STOP_FOLLOW_REST_GAP_M, 1),
      STOP_SHORT_MIN_INITIAL_GAP_M,
    );
    // Runway from the subject spawn must cover the lead's full travel (it rests ahead) + buffer.
    const runwayNeeded =
      initialGapMeters + speedMps * (leadStopAt + STOP_BRAKING_WINDOW_S / 2) + 8;
    // The whole stop choreography must finish BEFORE the next junction — otherwise the subject
    // sails past its mid-block lead and halts inside the intersection. survivalRunwayMeters
    // walks THROUGH junctions so it can't catch this; metersToNextJunction stops AT the first.
    const leadRestMeters =
      initialGapMeters + speedMps * leadStopAt + (speedMps * STOP_BRAKING_WINDOW_S) / 2;
    const junctionClearanceNeeded = leadRestMeters + STOP_LEAD_VEHICLE_LENGTH_M + 4;
    for (const fraction of spawnTries) {
      const leadFraction = fraction + dirSign * (initialGapMeters / segLen);
      // The lead must spawn on the subject's own lane (same segment), AHEAD in travel.
      if (leadFraction > 0.95 || leadFraction < 0.05) {
        log?.("C:lead_fraction_overflow");
        continue;
      }
      if (survivalRunwayMeters(segments, segment, fraction, runwayNeeded) < runwayNeeded) {
        log?.("C:runway_short");
        continue;
      }
      // Mid-block only: the lead (and therefore the subject behind it) must rest before the next
      // junction. Short urban blocks that can't host the choreography are rejected here.
      if (
        metersToNextJunction(segments, segment, fraction, junctionClearanceNeeded) <
        junctionClearanceNeeded
      ) {
        log?.("C:rests_in_junction");
        continue;
      }
      return {
        variation: { ...variation, spawnFraction: fraction, speedKph: profile.speedKph },
        spawnSegment: segment,
        stopPlan: {
          variant: "lead_brake",
          // Cause-first: the subject is NOT force-stopped — it follows its route and stops behind
          // the lead (obstacle-aware), then RESUMES when the lead pulls away (resume default).
          subjectStopMode: "tm_follow",
          subjectStopAtSeconds: subjectStopAt,
          subjectResume: null,
          lead: {
            spawnSegment: segment,
            spawnFraction: roundTo(leadFraction, 3),
            speedKph: profile.speedKph,
            stopAtSeconds: leadStopAt,
            // Hold/resume mix (T1.5): a minority of leads HOLD (no resume → subject stays
            // stopped → valid_stop); the rest pull away (→ subject follows → valid_resume).
            resume: variation.stopLeadHolds
              ? null
              : {
                  atSeconds: variation.stopLeadResumeAtSeconds ?? 11.0,
                  primitiveId: "set_speed",
                  speedKph: profile.speedKph,
                },
          },
          vru: null,
        },
      };
    }
  }
  return null;
}

/**
 * Variant V — VRU yield: a pedestrian crosses the subject's lane a comfortable stopping
 * distance ahead. The subject is a worker route-follower whose obstacle-stop brakes for
 * walkers in its corridor, so it eases to a halt for the ped (the visible cause) and
 * resumes once the ped clears. The ped walks a perpendicular timed_path (hold at the
 * curb, then cross), timed so it enters the subject's corridor as the subject approaches.
 */
function placeVruStop(
  segments: ReadonlyMap<string, RuntimeRoadSegment>,
  candidate: Candidate,
  variation: ScenarioVariation,
  onReject?: StopPlacementRejectLogger,
): PlacedVariation | null {
  if (!candidate.hasKnownDrivableSuccessor) {
    onReject?.("V:no_drivable_successor");
    return null;
  }
  const segment = candidate.segment;
  const speedMps = variation.speedKph / 3.6;
  const comfortStopDistM = (speedMps * speedMps) / (2 * STOP_COMFORT_DECEL_MPS2);
  const crossDistM = roundTo(comfortStopDistM + STOP_VRU_REST_GAP_M, 1);
  const segLen = Math.max(1, segmentLengthMeters(segment));
  const fwdIncS = forwardIsIncreasingS(segments, segment);
  const dirSign = fwdIncS ? 1 : -1;
  const spawnTries = fwdIncS
    ? [variation.spawnFraction, 0.08, 0.12, 0.18, 0.05]
    : [variation.spawnFraction, 0.92, 0.88, 0.82, 0.95];
  const runwayNeeded = crossDistM + 12;
  // The crossing (and the subject's stop short of it) must sit mid-block, before the next
  // junction — same guard as the lead_brake choreography.
  const junctionClearanceNeeded = crossDistM + 6;
  for (const fraction of spawnTries) {
    const crossFraction = fraction + dirSign * (crossDistM / segLen);
    if (crossFraction > 0.95 || crossFraction < 0.05) {
      onReject?.("V:cross_fraction_overflow");
      continue;
    }
    if (survivalRunwayMeters(segments, segment, fraction, runwayNeeded) < runwayNeeded) {
      onReject?.("V:runway_short");
      continue;
    }
    if (
      metersToNextJunction(segments, segment, fraction, junctionClearanceNeeded) <
      junctionClearanceNeeded
    ) {
      onReject?.("V:rests_in_junction");
      continue;
    }
    const cross = centerlinePointAtFraction(segment, crossFraction);
    const heading = laneHeadingAtFraction(segment, crossFraction, fwdIncS);
    if (!cross || !heading) {
      onReject?.("V:no_geometry");
      continue;
    }
    // Perpendicular to travel (left of the lane): rotate the heading +90°. The ped
    // walks from one curb, THROUGH the subject corridor, to the other curb so it clears.
    const perp = { x: -heading.y, y: heading.x };
    const half = STOP_VRU_CROSS_HALF_WIDTH_M;
    // Both curbs share the subject lane's elevation (cross.z) — carried so the worker
    // grounds the walker on the subject's layer, not an upper stacked-geometry surface.
    const start = { x: cross.x + perp.x * half, y: cross.y + perp.y * half, z: cross.z };
    const end = { x: cross.x - perp.x * half, y: cross.y - perp.y * half, z: cross.z };
    // Timing: the ped reaches the lane centerline (mid-corridor) ~when the subject arrives
    // at the crossing (cruise arrival ≈ crossDist / speed). It holds at the curb until
    // then, so it enters the corridor as the subject closes in → the subject brakes, holds,
    // and resumes once the ped walks clear of the corridor.
    const subjectArriveS = crossDistM / Math.max(1e-3, speedMps);
    const holdSeconds = roundTo(Math.max(0.5, subjectArriveS - STOP_VRU_CROSS_SECONDS / 2), 1);
    return {
      variation: { ...variation, spawnFraction: fraction },
      spawnSegment: segment,
      stopPlan: {
        variant: "vru_yield",
        subjectStopMode: "tm_follow",
        subjectStopAtSeconds: variation.instructionDelaySeconds,
        subjectResume: null,
        lead: null,
        vru: {
          spawnPoint: { x: roundTo(start.x, 2), y: roundTo(start.y, 2), z: roundTo(start.z, 2) },
          crossEndPoint: { x: roundTo(end.x, 2), y: roundTo(end.y, 2), z: roundTo(end.z, 2) },
          holdSeconds,
          crossSeconds: STOP_VRU_CROSS_SECONDS,
          speedKph: STOP_VRU_SPEED_KPH,
        },
      },
    };
  }
  return null;
}

/**
 * Variant SS — stop sign: the subject brakes to a controlled stop at a junction entry
 * (where a stop sign controls its lane) and holds. Reuses the junction-entry placement;
 * the subject becomes a route-follower that the WORKER stops at the stop line (subjectStopMode "stop_line"). The
 * cause is not placed by the generator — the worker stamps `at_stop_sign` from the map's
 * real stop-sign landmark, and the metric/gate KEEP only junctions that actually have a
 * sign (the rest score uncaused and drop). So this needs no stop-sign coordinates in the
 * generator; it just needs stop-sign-rich maps (Yale / Di Rosa / Belmont / Saratoga /
 * Stanford / San Ramon).
 */
function placeStopSignStop(
  segments: ReadonlyMap<string, RuntimeRoadSegment>,
  candidate: Candidate,
  variation: ScenarioVariation,
  onReject?: StopPlacementRejectLogger,
): PlacedVariation | null {
  const placed = placeJunctionProceedStop(segments, candidate, variation, onReject);
  if (!placed || !placed.stopPlan) return null;
  return {
    ...placed,
    stopPlan: {
      ...placed.stopPlan,
      variant: "stop_sign",
      subjectStopMode: "stop_line",
      // v1 HOLDS at the line (the subject route ends at the junction entry; stop-and-go
      // THROUGH the junction needs a route across it — a follow-up). A hold at a stop
      // line with cross-traffic still reads as a correct stop-line stop.
      subjectResume: null,
    },
  };
}

/** Deterministic fallback ladder when a drawn stop variant cannot anchor on
 * the map: junction_proceed -> queue_at_junction -> lead_brake. There is no
 * further fallback — a map that cannot host any causal stop skips the
 * scenario rather than emitting an uncaused stop. */
export function stopVariantFallbackOrder(variant: StopVariant): StopVariant[] {
  if (variant === "junction_proceed") {
    return ["junction_proceed", "queue_at_junction", "lead_brake"];
  }
  if (variant === "queue_at_junction") {
    return ["queue_at_junction", "lead_brake"];
  }
  // vru_yield falls back to lead_brake (a braking lead is the most broadly placeable
  // caused stop) when the map can't host a crossing.
  if (variant === "vru_yield") {
    return ["vru_yield", "lead_brake"];
  }
  // stop_sign needs a junction entry; if none, fall back to lead_brake (mid-block).
  if (variant === "stop_sign") {
    return ["stop_sign", "lead_brake"];
  }
  return ["lead_brake"];
}

/** Dispatch a stop placement to its causal variant. Free/uncaused timed
 * stops no longer exist: every stop is junction-anchored or lead-caused. */
export function placeStopVariation(
  segments: ReadonlyMap<string, RuntimeRoadSegment>,
  candidate: Candidate,
  variation: ScenarioVariation,
  onReject?: StopPlacementRejectLogger,
): PlacedVariation | null {
  const variant = variation.stopVariant ?? "junction_proceed";
  if (variant === "junction_proceed") {
    return placeJunctionProceedStop(segments, candidate, variation, onReject);
  }
  if (variant === "queue_at_junction") {
    return placeQueueAtJunctionStop(segments, candidate, variation, onReject);
  }
  if (variant === "vru_yield") {
    return placeVruStop(segments, candidate, variation, onReject);
  }
  if (variant === "stop_sign") {
    return placeStopSignStop(segments, candidate, variation, onReject);
  }
  return placeLeadBrakeStop(segments, candidate, variation, onReject);
}
