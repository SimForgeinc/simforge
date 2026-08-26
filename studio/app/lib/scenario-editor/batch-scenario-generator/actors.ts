import type {
  ScenarioEditorActorDraft,
} from "@simforge-oss/studio-shared";
import type { RuntimeRoadSegment } from "@/app/lib/runtime/runtime-types";
import { laneChangeSide } from "./types";
import type {
  Candidate,
  ForbiddenFractionZones,
  ScenarioVariation,
} from "./types";
import {
  BIKE_BLUEPRINTS,
  BIKE_FILL_FRACTION,
  BIKE_MAX_SPEED_KPH,
  HEAVY_TRAFFIC_EGO_TAIL_BUFFER_METERS,
  HEAVY_TRAFFIC_FILL_RADIUS_METERS,
  HEAVY_TRAFFIC_LANE_CHANGE_GAP_METERS,
  DENSE_FLOW_SPEED_FACTOR_MAX,
  DENSE_FLOW_SPEED_FACTOR_MIN,
  DENSE_JAM_SPEED_FACTOR_MAX,
  DENSE_JAM_SPEED_FACTOR_MIN,
  MEDIUM_FLOW_SPEED_FACTOR_MAX,
  MEDIUM_FLOW_SPEED_FACTOR_MIN,
  JAM_PACE_LEAD_GAP_M,
  JAM_PACE_LEAD_SPEED_FACTOR,
  TAPER_MIN_LANE_SEPARATION_M,
  TAPER_NO_FILL_APPROACH_M,
  DENSE_MIN_SPEED_KPH,
  HEAVY_TRAFFIC_MAX_HEADWAY_METERS,
  HEAVY_TRAFFIC_MIN_HEADWAY_METERS,
  HEAVY_TRAFFIC_TARGET_DEFAULT,
  HEAVY_TRAFFIC_TARGET_MAX,
  HEAVY_TRAFFIC_TARGET_MIN,
  HEAVY_VEHICLE_BLUEPRINTS,
  HEAVY_VEHICLE_EXTRA_HEADWAY_METERS,
  HEAVY_VEHICLE_FILL_FRACTION,
  HEAVY_VEHICLE_MIN_LANE_LENGTH_METERS,
  MAX_BATCH_TRAFFIC_ACTORS,
  MEDIUM_TRAFFIC_HEADWAY_MAX_METERS,
  MEDIUM_TRAFFIC_HEADWAY_MIN_METERS,
  RUNWAY_HORIZON_S,
  TRAFFIC_BLUEPRINTS,
  SPAWN_MIN_SEPARATION_M,
  TRAFFIC_CAUSE_CLEARANCE_M,
  AMBIENT_RUNWAY_HORIZON_S,
  AMBIENT_MIN_RUNWAY_M,
} from "./constants";
import {
  adjacentSameDirectionLane,
  hasKnownDrivableSuccessor,
  isDrivableSegment,
  laneChangeTarget,
  oppositeDirectionLanes,
  segmentLengthMeters,
  segmentRsl,
} from "./graph";
import {
  addForbiddenWindow,
  centerlinePointAtFraction,
  forwardIsIncreasingS,
  fractionIsForbidden,
  hashSeed,
  laneMinDistanceToPoint,
  markForwardCorridorForbidden,
  randomInRange,
  roundTo,
  seededRandom,
  withWorldAnchor,
} from "./routing";

/**
 * Would an ambient (autopilot, route:[]) car spawned here be destroyed by the
 * CARLA Traffic Manager mid-clip? The TM removes a free-roaming vehicle the
 * instant it reaches a lane with no drivable successor — a map-edge dead-end,
 * common on these clipped dev extracts. One such removal is a car popping out of
 * existence mid-clip; it sits below the mass-despawn reject threshold, so it ships.
 *
 * The car vanishes only if it reaches such a dead-end within the clip: so it is
 * safe if EITHER (a) it has `need` metres of travel-forward runway on THIS lane
 * alone, OR (b) the lane has a drivable successor to continue onto. Direction
 * matters — on an against-s lane forward is DECREASING s, so the runway is
 * `fraction·len`, not `(1−fraction)·len` (getting this wrong falsely rejects safe
 * cars). This is a single-hop check: it catches the dominant case (a spawn near a
 * no-successor boundary spur) without the direction hazards of a recursive
 * multi-hop runway walk; a far-downstream dead-end is left to the 2D despawn gate.
 * `speedKph` is an upper bound so faster cars are held to a longer runway.
 */
export function ambientSpawnVanishes(
  segments: ReadonlyMap<string, RuntimeRoadSegment>,
  segment: RuntimeRoadSegment,
  fraction: number,
  speedKph: number,
): boolean {
  const need = Math.max(AMBIENT_MIN_RUNWAY_M, (speedKph / 3.6) * AMBIENT_RUNWAY_HORIZON_S);
  const distToLaneEnd =
    (forwardIsIncreasingS(segments, segment) ? 1 - fraction : fraction) *
    segmentLengthMeters(segment);
  if (distToLaneEnd >= need) return false;
  return !hasKnownDrivableSuccessor(segments, segment);
}

/**
 * Deterministic background traffic that can never blockade the labeled subject
 * maneuver: same-lane vehicles spawn only BEHIND the subject. Lead vehicles on
 * the subject's own lane stay forbidden — the old approach of cloning the subject at
 * +/- s-fraction offsets on its own lane put lead vehicles on the subject's
 * exact path, where they died at map-tile edges or stopped at junctions and
 * boxed the subject in for the whole scenario. Front-camera density comes from
 * (a) adjacent same-direction lanes — 2-3 vehicles each, mixed slightly
 * behind/ahead of the subject, never the target lane of a lane-change maneuver —
 * and (b) oncoming lanes, where vehicles spawn ahead of the subject driving
 * toward it, crossing the camera's view without ever entering its lane.
 */
/**
 * HEAVY profile: a same-lane pace lead ~20 m ahead of the subject at queue speed.
 * The subject's maneuver corridor is deliberately kept clear of random fill, which
 * previously left the subject un-paced — it drove its desired speed through a
 * crawling jam ("racing through stopped vehicles", dib 2026-07-27). A lead the
 * subject car-follows embeds it in the queue; for lane-change strategies the slow
 * lead also MOTIVATES the maneuver. Skipped (empty) when the spawn segment
 * lacks runway ahead or the lead would be destroyed at a dead-end.
 */
export function buildJamPaceLead(input: {
  segments: ReadonlyMap<string, RuntimeRoadSegment>;
  subject: ScenarioEditorActorDraft;
  spawnSegment: RuntimeRoadSegment;
  variation: ScenarioVariation;
  seed: number;
}): ScenarioEditorActorDraft[] {
  const seg = input.spawnSegment;
  const len = Math.max(1, segmentLengthMeters(seg));
  const subjectMeters = (input.subject.spawn?.s_fraction ?? 0) * len;
  const leadMeters = subjectMeters + JAM_PACE_LEAD_GAP_M;
  if (leadMeters > len * 0.95) return [];
  const fraction = leadMeters / len;
  const freeFlowKph = input.variation.freeFlowSpeedKph ?? input.variation.speedKph;
  const speedKph = Math.max(
    DENSE_MIN_SPEED_KPH,
    Math.round(freeFlowKph * JAM_PACE_LEAD_SPEED_FACTOR),
  );
  if (ambientSpawnVanishes(input.segments, seg, fraction, speedKph * 1.15)) return [];
  return [
    {
      ...input.subject,
      id: `batch-jam-lead-${input.seed}`,
      label: "Jam Pace Lead",
      role: "traffic",
      blueprint: TRAFFIC_BLUEPRINTS[0] ?? "vehicle.lincoln.mkz",
      color: "95,100,110",
      spawn: withWorldAnchor(
        {
          road_id: String(seg.road_id),
          section_id: seg.section_id ?? null,
          lane_id: seg.lane_id ?? null,
          s_fraction: roundTo(fraction, 3),
        },
        seg,
        roundTo(fraction, 3),
      ),
      speed_kph: speedKph,
      autopilot: true,
      route: [],
      timeline: [],
      sensors: [],
      timedInstructions: undefined,
    },
  ];
}

export function buildBatchTrafficActors(input: {
  segments: ReadonlyMap<string, RuntimeRoadSegment>;
  subject: ScenarioEditorActorDraft;
  candidate: Candidate;
  variation: ScenarioVariation;
  spawnSegment?: RuntimeRoadSegment;
  seed: number;
  datasetId: string;
  /** Scales the ring's speed band with density (speed-density fundamental
   * diagram): "medium" ≈ 50-65% of free-flow, "heavy" ≈ 30-45%. Absent /
   * "normal" keeps the free-flow band AND the exact RNG stream (one draw per
   * car, only the range differs), so normal-profile drafts stay byte-identical. */
  trafficProfile?: "normal" | "medium" | "heavy";
  /** Actors this ambient traffic must NOT spawn on top of — the subject + the scripted
   * cause (braking lead / crossing VRU). The generator places every ambient car, so
   * two cars at one spot (→ 3D-physics eject = "flying car") is OURS to prevent;
   * CARLA's collision check won't catch a ~1.5m same-lane gap. */
  keepClear?: ScenarioEditorActorDraft[];
}): ScenarioEditorActorDraft[] {
  const { segments, subject, candidate, variation } = input;
  const segment = input.spawnSegment ?? candidate.segment;
  const segLen = Math.max(1, segmentLengthMeters(segment));
  const random = seededRandom(
    hashSeed([input.datasetId, candidate.strategy, input.seed, "traffic"]),
  );
  const actors: ScenarioEditorActorDraft[] = [];
  const [ringFactorMin, ringFactorMax] =
    input.trafficProfile === "heavy"
      ? [DENSE_FLOW_SPEED_FACTOR_MIN, DENSE_FLOW_SPEED_FACTOR_MAX]
      : input.trafficProfile === "medium"
        ? [MEDIUM_FLOW_SPEED_FACTOR_MIN, MEDIUM_FLOW_SPEED_FACTOR_MAX]
        : [0.85, 1.15];
  const trafficSpeed = () =>
    Math.max(
      input.trafficProfile === "heavy" || input.trafficProfile === "medium" ? 10 : 20,
      Math.round(variation.speedKph * randomInRange(random, ringFactorMin, ringFactorMax)),
    );

  // Keep-clear occupancy: per-lane (road:section:lane) meters-along-lane of the subject
  // + cause. A candidate within TRAFFIC_CAUSE_CLEARANCE_M of one on the SAME lane is
  // skipped (different lanes can't collide, so only same-lane proximity matters).
  const spawnRslOf = (sp: ScenarioEditorActorDraft["spawn"] | null | undefined) =>
    sp && sp.road_id != null ? `${sp.road_id}:${sp.section_id ?? ""}:${sp.lane_id ?? ""}` : null;
  const keepClearByRsl = new Map<string, number[]>();
  const markKeepClear = (sp: ScenarioEditorActorDraft["spawn"] | null | undefined) => {
    const rsl = spawnRslOf(sp);
    const seg = rsl ? segments.get(rsl) : null;
    if (!rsl || !seg) return;
    const meters = (sp!.s_fraction ?? 0) * Math.max(1, segmentLengthMeters(seg));
    keepClearByRsl.set(rsl, [...(keepClearByRsl.get(rsl) ?? []), meters]);
  };
  markKeepClear(subject.spawn);
  for (const actor of input.keepClear ?? []) markKeepClear(actor.spawn);
  const clustersWithCause = (spawn: ScenarioEditorActorDraft["spawn"], meters: number) => {
    const taken = keepClearByRsl.get(spawnRslOf(spawn) ?? "");
    return Boolean(taken) && taken!.some((t) => Math.abs(t - meters) < TRAFFIC_CAUSE_CLEARANCE_M);
  };

  const push = (spawn: ScenarioEditorActorDraft["spawn"], fraction: number, seg: RuntimeRoadSegment) => {
    if (actors.length >= MAX_BATCH_TRAFFIC_ACTORS) return;
    if (clustersWithCause(spawn, fraction * Math.max(1, segmentLengthMeters(seg)))) return;
    // Don't spawn a car the Traffic Manager will drive off a dead-end and destroy
    // mid-clip. (Upper-bounded speed so the fastest draw is still covered.)
    if (ambientSpawnVanishes(segments, seg, fraction, variation.speedKph * 1.15)) return;
    const index = actors.length + 1;
    actors.push({
      ...subject,
      id: `batch-traffic-${input.seed}-${index}`,
      label: `Auto-Traffic Car ${index}`,
      role: "traffic",
      blueprint: TRAFFIC_BLUEPRINTS[(index - 1) % TRAFFIC_BLUEPRINTS.length] ?? "vehicle.lincoln.mkz",
      color: "80,120,220",
      spawn: withWorldAnchor(
        { ...spawn, s_fraction: roundTo(fraction, 3) },
        seg,
        roundTo(fraction, 3),
      ),
      speed_kph: trafficSpeed(),
      autopilot: true,
      route: [],
      timeline: [],
      sensors: [],
      timedInstructions: undefined,
    });
  };

  // Same lane, strictly behind the subject with headway. "Behind" is OPPOSITE the
  // lane's travel direction: on +s lanes that's decreasing s_fraction, but on
  // against-s lanes (common for on/off-ramp connectors) it's INCREASING —
  // decrementing there spawns the "behind" cars AHEAD of the subject, into its
  // path (the highway_entry ramp collision at t≈1.6s, Page Mill). Direction-
  // aware; byte-identical for the +s case (same draw order, same step sign).
  const trafficForwardIncreasingS = forwardIsIncreasingS(segments, segment);
  let fraction = variation.spawnFraction;
  for (let i = 0; i < 4; i += 1) {
    const step = randomInRange(random, 14, 24) / segLen;
    fraction += trafficForwardIncreasingS ? -step : step;
    if (trafficForwardIncreasingS ? fraction < 0.03 : fraction > 0.97) break;
    push(subject.spawn, fraction, segment);
  }

  // Adjacent same-direction lanes: 2-3 vehicles per usable lane at distinct
  // s-fractions (one slightly behind the subject, the rest ahead) — but never
  // the target lane of a lane-change maneuver (the subject must find it clear).
  const adjacentSides: Array<"left" | "right"> = ["left", "right"];
  for (const side of adjacentSides) {
    if (actors.length >= MAX_BATCH_TRAFFIC_ACTORS) break;
    // Never fill the target lane of a lane-change / overtake maneuver — the subject
    // must find the side it merges toward clear (the slow overtake lead sits in
    // the subject's OWN lane, not the target).
    if (laneChangeSide(candidate.strategy) === side) {
      continue;
    }
    const adjacent = adjacentSameDirectionLane(segments, segment, side);
    if (!adjacent) continue;
    const adjacentSpawn = {
      road_id: String(adjacent.road_id),
      section_id: adjacent.section_id ?? null,
      lane_id: adjacent.lane_id ?? null,
      s_fraction: 0,
    };
    const adjacentLen = Math.max(1, segmentLengthMeters(adjacent));
    const adjacentCount = random() < 0.5 ? 2 : 3;
    // Disjoint offset bands keep the sampled fractions distinct.
    const offsetsMeters = [
      -randomInRange(random, 8, 20),
      randomInRange(random, 10, 30),
      randomInRange(random, 38, 62),
    ];
    for (let i = 0; i < adjacentCount; i += 1) {
      const adjacentFraction = variation.spawnFraction + (offsetsMeters[i] ?? 0) / adjacentLen;
      if (adjacentFraction < 0.03 || adjacentFraction > 0.92) continue;
      push(adjacentSpawn, adjacentFraction, adjacent);
    }
  }

  // Oncoming lanes fill the FRONT camera: opposite-direction vehicles spawn
  // ahead of the subject and drive toward it. The worker resolves s_fraction
  // along the road's OpenDRIVE s-axis for every lane of the road, and this
  // generator's convention is that higher fractions sit AHEAD of the subject —
  // opposite-sign lanes travel the other way, so vehicles placed above the
  // subject's fraction start ahead and close head-on, never entering its lane.
  const oncomingLanes = oppositeDirectionLanes(segments, segment, 2);
  if (oncomingLanes.length > 0) {
    const oncomingCount = 3 + Math.floor(randomInRange(random, 0, 3));
    const aheadCursorsMeters = oncomingLanes.map(() => randomInRange(random, 15, 30));
    for (let i = 0; i < oncomingCount; i += 1) {
      const laneIndex = i % oncomingLanes.length;
      const lane = oncomingLanes[laneIndex];
      if (!lane) break;
      const laneLen = Math.max(1, segmentLengthMeters(lane));
      const oncomingFraction =
        variation.spawnFraction + (aheadCursorsMeters[laneIndex] ?? 20) / laneLen;
      aheadCursorsMeters[laneIndex] =
        (aheadCursorsMeters[laneIndex] ?? 20) + randomInRange(random, 14, 26);
      if (oncomingFraction > 0.95) continue;
      push(
        {
          road_id: String(lane.road_id),
          section_id: lane.section_id ?? null,
          lane_id: lane.lane_id ?? null,
          s_fraction: 0,
        },
        oncomingFraction,
        lane,
      );
    }
  }

  return actors;
}

// ---------------------------------------------------------------------------
// Heavy traffic profile: deterministic bumper-to-bumper lane fill.
// ---------------------------------------------------------------------------

export function clampHeavyTrafficTargetCount(value: number | null | undefined): number {
  if (value == null || !Number.isFinite(value)) return HEAVY_TRAFFIC_TARGET_DEFAULT;
  return Math.min(
    HEAVY_TRAFFIC_TARGET_MAX,
    Math.max(HEAVY_TRAFFIC_TARGET_MIN, Math.round(value)),
  );
}

/**
 * HEAVY traffic profile: mass lane-fill around the subject so the scene reads as
 * near-bumper-to-bumper congestion. On top of the near-field ring
 * (buildBatchTrafficActors), every non-junction Driving/Bidirectional lane
 * within HEAVY_TRAFFIC_FILL_RADIUS_METERS of the subject spawn — both travel
 * directions — is filled nearest-lane-first with autopilot vehicles at seeded
 * 5-8m headway until `targetTotalVehicles` (subject + ring + fill) is reached.
 * Speeds are corridor-aware: lanes on the subject's road in the subject's travel
 * direction crawl at jam speed (5-15 kph); all other lanes (cross streets,
 * opposite direction, other roads) flow at urban speed (25-40 kph). Fully
 * deterministic: every draw flows through seededRandom(hashSeed([...])).
 *
 * Maneuver invariants are preserved:
 * - the subject's forward corridor (own lane ahead + every successor branch it
 *   could take, runway-horizon deep) stays clear, so the labeled maneuver and
 *   its survival runway are never blockaded by parked jam traffic;
 * - lane-change target lanes keep a gap window around the subject's s-position
 *   (~30m behind it, plus the whole forward merge corridor) so the lane
 *   change remains completable;
 * - junction-internal segments are never statically filled (vehicles would
 *   straddle the intersection box), though the corridor walk passes THROUGH
 *   them to protect the lanes beyond.
 *
 * Spawn-collision safety: per-lane fill is constructed at >=5m center-to-
 * center spacing, and every position is deduped against the subject, the
 * near-field ring, and previously placed fill on the same lane.
 *
 * PERFORMANCE GUARDRAIL: hundreds of autopilot vehicles multiply CARLA's
 * per-tick cost (physics + Traffic Manager are roughly linear in actor
 * count); a 250-vehicle scene can tick several times slower than a 13-vehicle
 * one. Pilot heavy batches on a single worker slot and watch render wall
 * clock before scaling out.
 */
export function buildHeavyTrafficFillActors(input: {
  segments: ReadonlyMap<string, RuntimeRoadSegment>;
  subject: ScenarioEditorActorDraft;
  candidate: Candidate;
  variation: ScenarioVariation;
  spawnSegment?: RuntimeRoadSegment;
  seed: number;
  datasetId: string;
  targetTotalVehicles: number;
  /** Per-map hard ceiling on the fill count, applied AFTER
   * clampHeavyTrafficTargetCount (whose MIN=50 floor would otherwise undo a
   * deliberately-light target on dead-end-heavy maps like Munich). Undefined = no
   * cap. Additive: callers that don't pass it (e.g. the monolith) are unaffected. */
  ambientCap?: number;
  /** Already-placed vehicles (the near-field ring) to dedup spawns against. */
  existingTraffic: ScenarioEditorActorDraft[];
  /** "medium" profile: lane fill FLOWS instead of jamming — wider headway and
   * every lane (incl. the subject corridor) moves at ~road speed, so the scene
   * reads as moving traffic, not parked cars. "heavy" keeps the bumper-to-
   * bumper crawl. */
  flowing?: boolean;
  /** Mix in large vehicles (bus / semi-trailer / box truck). Off the subject's
   * jam corridor, on lanes long enough to hold the body + headway. */
  heavyVehicles?: boolean;
  /** Mix in cyclists (crawl speed, off the subject's jam corridor). */
  bikes?: boolean;
}): ScenarioEditorActorDraft[] {
  const { segments, subject, candidate, variation } = input;
  const headwayMin = input.flowing
    ? MEDIUM_TRAFFIC_HEADWAY_MIN_METERS
    : HEAVY_TRAFFIC_MIN_HEADWAY_METERS;
  const headwayMax = input.flowing
    ? MEDIUM_TRAFFIC_HEADWAY_MAX_METERS
    : HEAVY_TRAFFIC_MAX_HEADWAY_METERS;
  const subjectSegment = input.spawnSegment ?? candidate.segment;
  const subjectRsl = segmentRsl(subjectSegment);
  const subjectLength = Math.max(1, segmentLengthMeters(subjectSegment));
  const subjectFraction = variation.spawnFraction;
  const subjectPoint = centerlinePointAtFraction(subjectSegment, subjectFraction);
  if (!subjectPoint) return [];

  const clampedTarget = clampHeavyTrafficTargetCount(input.targetTotalVehicles);
  // Per-map ambient cap overrides the MIN=50 floor so dead-end-heavy maps stay light.
  const cappedTarget =
    input.ambientCap != null
      ? Math.min(clampedTarget, input.ambientCap)
      : clampedTarget;
  const fillBudget = cappedTarget - 1 - input.existingTraffic.length;
  if (fillBudget <= 0) return [];

  const random = seededRandom(
    hashSeed([input.datasetId, candidate.strategy, input.seed, "heavy-traffic"]),
  );
  const speedMps = variation.speedKph / 3.6;

  // --- Maneuver clearance zones -------------------------------------------
  const zones: ForbiddenFractionZones = new Map();
  // Subject forward corridor. Stop scenarios rest by instructionDelaySeconds + 2s
  // (brake ramp), so delay + 3.5s of cruise distance covers the pre-rest path
  // (and the lead ahead of it) with margin; post-window proceeds re-enter
  // moving traffic, which is fine outside the label window.
  const horizonSeconds =
    candidate.strategy === "stop"
      ? variation.instructionDelaySeconds + 3.5
      : RUNWAY_HORIZON_S;
  const corridorMeters = speedMps * horizonSeconds + 8;
  addForbiddenWindow(
    zones,
    subjectRsl,
    subjectFraction - HEAVY_TRAFFIC_EGO_TAIL_BUFFER_METERS / subjectLength,
    subjectFraction,
  );
  markForwardCorridorForbidden({
    segments,
    zones,
    start: subjectSegment,
    startFraction: subjectFraction,
    corridorMeters,
  });
  // Lane-change target lane: gap window around the subject's s-position plus the
  // forward merge corridor the subject occupies after changing lanes.
  const heavyFillMergeSide = laneChangeSide(candidate.strategy);
  if (heavyFillMergeSide) {
    const side = heavyFillMergeSide;
    const target = laneChangeTarget(segments, subjectSegment, side);
    if (target) {
      const targetRsl = segmentRsl(target);
      const targetLength = Math.max(1, segmentLengthMeters(target));
      addForbiddenWindow(
        zones,
        targetRsl,
        subjectFraction - HEAVY_TRAFFIC_LANE_CHANGE_GAP_METERS / targetLength,
        subjectFraction,
      );
      markForwardCorridorForbidden({
        segments,
        zones,
        start: target,
        startFraction: subjectFraction,
        corridorMeters,
      });
    }
  }

  // --- Spawn dedup across sources (subject + ring + fill) ----------------------
  const occupiedMetersByRsl = new Map<string, number[]>();
  const occupy = (rsl: string, meters: number) => {
    const list = occupiedMetersByRsl.get(rsl) ?? [];
    list.push(meters);
    occupiedMetersByRsl.set(rsl, list);
  };
  const isOccupiedNear = (rsl: string, meters: number) =>
    (occupiedMetersByRsl.get(rsl) ?? []).some(
      (taken) => Math.abs(taken - meters) < headwayMin,
    );
  // WORLD-space dedup, on top of the per-lane one above. The lane-keyed check only
  // compares vehicles in the SAME lane, so two fill cars in DIFFERENT lanes whose
  // centerlines converge (junction approaches, curves, merge tapers) can land on top
  // of each other — measured 2.25-3.0 m apart, i.e. overlapping bounding boxes, which
  // eject in 3D physics and the scene_outcome gate rejects (SPAWN_OVERLAP_M = 3.0).
  // This was the #1 reject across turns / stop / lane-change in the 2026-07-13
  // attrition run (15 of 17 overlaps were fill × fill).
  // The threshold sits just ABOVE the metric's 3.0 m so we prevent exactly what the
  // gate rejects, while still permitting legitimate SIDE-BY-SIDE traffic in adjacent
  // lanes (lane width ~3.5 m — those are not overlaps and must survive).
  const placedWorld: Array<{ x: number; y: number }> = [];
  const worldTooClose = (p: { x: number; y: number } | null) =>
    Boolean(p) &&
    placedWorld.some(
      (q) => Math.hypot(p!.x - q.x, p!.y - q.y) < SPAWN_MIN_SEPARATION_M,
    );
  const markWorld = (p: { x: number; y: number } | null) => {
    if (p) placedWorld.push({ x: p.x, y: p.y });
  };
  // Lane-taper no-fill zones: meters-along-lane past which fill is forbidden
  // because the lane's centerline converges below TAPER_MIN_LANE_SEPARATION_M
  // with a same-road physical neighbor (gore / lane-drop squeeze). Cached per
  // rsl; null = no taper on this lane. Coarse vertex-stride sampling keeps the
  // O(A×B) polyline sweep cheap on ~1 m-sampled freeway lanes.
  const taperZoneStartM = new Map<string, number | null>();
  const taperZoneFor = (laneRsl: string, segment: RuntimeRoadSegment): number | null => {
    const cached = taperZoneStartM.get(laneRsl);
    if (cached !== undefined) return cached;
    let zone: number | null = null;
    const laneIdNum = Number(segment.lane_id);
    const center = segment.centerline ?? [];
    if (Number.isFinite(laneIdNum) && center.length >= 2) {
      for (const neighborId of [laneIdNum - 1, laneIdNum + 1]) {
        if (neighborId === 0) continue;
        const nRsl = `${segment.road_id}:${segment.section_id ?? ""}:${neighborId}`;
        const neighbor = segments.get(nRsl)?.centerline ?? [];
        if (neighbor.length < 2) continue;
        let arcM = 0;
        for (let i = 0; i < center.length; i += 5) {
          if (i > 0) {
            const prev = center[Math.max(0, i - 5)]!;
            arcM += Math.hypot(center[i]!.x - prev.x, center[i]!.y - prev.y);
          }
          let best = Infinity;
          for (let j = 0; j < neighbor.length; j += 3) {
            const d = Math.hypot(center[i]!.x - neighbor[j]!.x, center[i]!.y - neighbor[j]!.y);
            if (d < best) best = d;
          }
          if (best < TAPER_MIN_LANE_SEPARATION_M) {
            const start = Math.max(0, arcM - TAPER_NO_FILL_APPROACH_M);
            zone = zone == null ? start : Math.min(zone, start);
            break;
          }
        }
      }
    }
    taperZoneStartM.set(laneRsl, zone);
    return zone;
  };
  const inTaperZone = (laneRsl: string, segment: RuntimeRoadSegment, meters: number): boolean => {
    const start = taperZoneFor(laneRsl, segment);
    return start != null && meters >= start;
  };
  occupy(subjectRsl, subjectFraction * subjectLength);
  markWorld(subjectPoint);
  for (const actor of input.existingTraffic) {
    const spawn = actor.spawn;
    if (!spawn || spawn.road_id == null) continue;
    const rsl = `${spawn.road_id}:${spawn.section_id ?? ""}:${spawn.lane_id ?? ""}`;
    const segment = segments.get(rsl);
    if (!segment) continue;
    const fraction = spawn.s_fraction ?? 0;
    occupy(rsl, fraction * Math.max(1, segmentLengthMeters(segment)));
    const anchor = spawn.world_anchor;
    markWorld(
      anchor && Number.isFinite(anchor.x)
        ? { x: anchor.x, y: anchor.y }
        : centerlinePointAtFraction(segment, fraction),
    );
  }

  // --- Lane enumeration: nearest Driving lanes around the subject, both
  // directions, junction-internal segments excluded ------------------------
  const lanes = [...segments.values()]
    .filter(isDrivableSegment)
    .map((segment) => ({
      segment,
      rsl: segmentRsl(segment),
      distance: laneMinDistanceToPoint(segment, subjectPoint),
    }))
    .filter((lane) => lane.distance <= HEAVY_TRAFFIC_FILL_RADIUS_METERS)
    .sort((a, b) => a.distance - b.distance || (a.rsl < b.rsl ? -1 : a.rsl > b.rsl ? 1 : 0));

  // Corridor-aware speeds: only the subject's own road in the subject's travel
  // direction (OpenDRIVE: same sign of lane_id) is the jam corridor and
  // crawls at jam speed; cross streets, opposite-direction lanes and other
  // roads flow at urban speed.
  // Exception: for a lane change, the TARGET lane must NOT jam-crawl — a 5-15kph
  // crawler just past the cleared merge window means the subject completes the
  // change and is instantly stuck behind it, reading as a failed/pointless
  // maneuver. Let the target lane flow at urban speed so the merge looks live.
  const subjectLaneSign = Math.sign(Number(subjectSegment.lane_id));
  const jamMergeSide = laneChangeSide(candidate.strategy);
  const laneChangeTargetRsl = jamMergeSide
    ? (() => {
        const target = laneChangeTarget(segments, subjectSegment, jamMergeSide);
        return target ? segmentRsl(target) : null;
      })()
    : null;
  const isJamCorridorLane = (segment: RuntimeRoadSegment) => {
    if (String(segment.road_id) !== String(subjectSegment.road_id)) return false;
    if (laneChangeTargetRsl && segmentRsl(segment) === laneChangeTargetRsl) return false;
    const laneSign = Math.sign(Number(segment.lane_id));
    return subjectLaneSign !== 0 && Number.isFinite(laneSign) && laneSign === subjectLaneSign;
  };

  // Upper bound on any fill car's speed used to keep free-roaming ambient
  // traffic away from dead ends where CARLA would destroy it.
  const fillGuardSpeedKph = Math.max(variation.speedKph, variation.freeFlowSpeedKph ?? 0) * 1.1;
  const actors: ScenarioEditorActorDraft[] = [];
  for (const lane of lanes) {
    if (actors.length >= fillBudget) break;
    const length = Math.max(1, segmentLengthMeters(lane.segment));
    if (length < headwayMin) continue;
    const jamCorridor = isJamCorridorLane(lane.segment);
    // Walk the lane front to back at the profile's headway with seeded jitter;
    // slots inside clearance zones or too close to occupied spawns are skipped
    // (the cursor still advances, keeping spacing monotone).
    let cursorMeters = randomInRange(random, 1, 4);
    while (cursorMeters < length * 0.98 && actors.length < fillBudget) {
      const fraction = cursorMeters / length;
      const slotPoint = centerlinePointAtFraction(lane.segment, fraction);
      const blocked =
        fraction < 0.02 ||
        fractionIsForbidden(zones, lane.rsl, fraction) ||
        isOccupiedNear(lane.rsl, cursorMeters) ||
        // cross-lane world overlap (different lanes, converging centerlines)
        worldTooClose(slotPoint) ||
        // gore / lane-drop squeeze ahead — a fill car here side-swipes its
        // neighbor as the centerlines converge (trafficval road 297)
        inTaperZone(lane.rsl, lane.segment, cursorMeters) ||
        // TM would drive this free-roaming fill car off a dead-end and destroy it
        ambientSpawnVanishes(segments, lane.segment, fraction, fillGuardSpeedKph);
      if (!blocked) {
        occupy(lane.rsl, cursorMeters);
        markWorld(slotPoint);
        const index = actors.length + 1;
        // Vehicle class for this slot. Bikes and heavy vehicles ride the
        // background fill but never the subject's own jam corridor (a 16m semi or a
        // slow cyclist boxing the subject reads badly). A single roll partitions the
        // fill — cyclists [0, BIKE), heavy [BIKE, BIKE+HEAVY), cars otherwise —
        // keeping the draw deterministic.
        const roll = random();
        const isBike = input.bikes === true && !jamCorridor && roll < BIKE_FILL_FRACTION;
        const useHeavy =
          !isBike &&
          input.heavyVehicles === true &&
          !jamCorridor &&
          length >= HEAVY_VEHICLE_MIN_LANE_LENGTH_METERS &&
          roll < BIKE_FILL_FRACTION + HEAVY_VEHICLE_FILL_FRACTION;
        const blueprint = isBike
          ? (BIKE_BLUEPRINTS[Math.floor(random() * BIKE_BLUEPRINTS.length)] ?? BIKE_BLUEPRINTS[0])
          : useHeavy
            ? (HEAVY_VEHICLE_BLUEPRINTS[
                Math.floor(random() * HEAVY_VEHICLE_BLUEPRINTS.length)
              ] ?? HEAVY_VEHICLE_BLUEPRINTS[0])
            : (TRAFFIC_BLUEPRINTS[(index - 1) % TRAFFIC_BLUEPRINTS.length] ??
              "vehicle.lincoln.mkz");
        // "medium" (flowing): every lane moves at ~the subject's road speed so the
        // scene reads as moving traffic. "heavy" (dense): the WHOLE flow is
        // congested — speeds are a fraction of the road's free-flow speed, with
        // the subject's own queue slowest. Keeping every lane in a narrow, slow band
        // (rather than a 5 km/h lane beside a 40 km/h one) is what stops the
        // pile-ups. Cyclists always crawl, whatever the lane.
        const freeFlowKph = variation.freeFlowSpeedKph ?? variation.speedKph;
        const laneSpeedKph = input.flowing
          ? Math.max(
              15,
              Math.round(
                variation.speedKph *
                  randomInRange(random, MEDIUM_FLOW_SPEED_FACTOR_MIN, MEDIUM_FLOW_SPEED_FACTOR_MAX),
              ),
            )
          : Math.max(
              DENSE_MIN_SPEED_KPH,
              Math.round(
                freeFlowKph *
                  (jamCorridor
                    ? randomInRange(random, DENSE_JAM_SPEED_FACTOR_MIN, DENSE_JAM_SPEED_FACTOR_MAX)
                    : randomInRange(
                        random,
                        DENSE_FLOW_SPEED_FACTOR_MIN,
                        DENSE_FLOW_SPEED_FACTOR_MAX,
                      )),
              ),
            );
        const speedKph = isBike
          ? Math.min(BIKE_MAX_SPEED_KPH, Math.max(10, Math.round(laneSpeedKph * 0.4)))
          : laneSpeedKph;
        actors.push({
          ...subject,
          id: `batch-fill-traffic-${input.seed}-${index}`,
          label: `${isBike ? "Cyclist" : useHeavy ? "Heavy Vehicle" : input.flowing ? "Traffic" : "Heavy Traffic"} ${index}`,
          role: "traffic",
          blueprint,
          color: "120,128,140",
          spawn: withWorldAnchor(
            {
              road_id: String(lane.segment.road_id),
              section_id: lane.segment.section_id ?? null,
              lane_id: lane.segment.lane_id ?? null,
              s_fraction: roundTo(fraction, 4),
            },
            lane.segment,
            roundTo(fraction, 4),
          ),
          speed_kph: speedKph,
          autopilot: true,
          route: [],
          timeline: [],
          sensors: [],
          timedInstructions: undefined,
        });
        // A long body needs more room before the next spawn.
        if (useHeavy) cursorMeters += HEAVY_VEHICLE_EXTRA_HEADWAY_METERS;
      }
      cursorMeters += randomInRange(random, headwayMin, headwayMax);
    }
  }

  return actors;
}

// Street parking + scripted causes (stop lead / overtake / crossing VRU) live
// in the split module; re-exported so every `./actors` importer keeps working.
export * from "./actors-scripted";
