import type {
  ScenarioEditorActorDraft,
  TimedInstructionIntent,
} from "@simforge/studio-shared";
import type { RuntimeRoadSegment } from "@/app/lib/runtime/runtime-types";
import type { ParkingLaneRef } from "@/app/lib/maps/topology/parking-lanes";
import type {
  BatchParkedDensity,
  BatchScenarioStrategy,
  ScenarioVariation,
  StopScenarioPlan,
  StopVariant,
} from "./types";
import {
  HEAVY_VEHICLE_BLUEPRINTS,
  OVERTAKE_HEAVY_LEAD_EXTRA_GAP_M,
  OVERTAKE_HEAVY_LEAD_FRACTION,
  OVERTAKE_LEAD_BLUEPRINT,
  OVERTAKE_LEAD_MIN_SPEED_KPH,
  OVERTAKE_LEAD_ROUTE_RUNWAY_M,
  OVERTAKE_LEAD_SPEED_FRACTION,
  OVERTAKE_MAX_GAP_M,
  OVERTAKE_MIN_GAP_M,
  OVERTAKE_QUEUE_COUNT,
  OVERTAKE_QUEUE_SPACING_M,
  OVERTAKE_TRAIL_GAP_M,
  PARKED_BLUEPRINTS,
  PARKED_DENSITY_PRESETS,
  PARKED_EGO_CLEARANCE_METERS,
  PARKED_MUTUAL_CLEARANCE_METERS,
  PARKED_FILL_RADIUS_METERS,
  PARKED_MIN_LANE_LENGTH_METERS,
  PARKED_VEHICLE_SPACING_METERS,
  STOP_LEAD_BLUEPRINT,
  STOP_LEAD_RESUME_RUNWAY_M,
  STOP_VRU_BLUEPRINT,
  STOP_VRU_CENTER_PAUSE_S,
  TRAFFIC_BLUEPRINTS,
  TRAFFIC_CAUSE_CLEARANCE_M,
} from "./constants";
import {
  segmentLengthMeters,
} from "./graph";
import {
  buildForwardRouteThroughSuccessors,
  centerlinePointAtFraction,
  forwardIsIncreasingS,
  hashSeed,
  polylineMinDistanceToPoint,
  randomInRange,
  roundTo,
  sampleParkingPolyline,
  seededRandom,
  withWorldAnchor,
} from "./routing";

// ---------------------------------------------------------------------------
// Scene dressing + scripted causes: street parking, the caused-stop lead, the
// overtake lead/queue, and the crossing VRU. Split from actors.ts (wave-2a:
// files over ~1000 lines are split); actors.ts re-exports this module, so
// existing `./actors` importers are unchanged.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Street parking: static parked vehicles along curb lanes.
// ---------------------------------------------------------------------------

function parkingKey(lane: ParkingLaneRef): string {
  return `${lane.road_id}:${lane.section_id ?? ""}:${lane.lane_id ?? ""}`;
}

/**
 * Static parked vehicles lining the curb near the subject, drawn from the map's
 * annotated Parking lanes (`parkingLanes`, the lane-backed street-parking
 * candidates from the topology index) within PARKED_FILL_RADIUS_METERS of the
 * subject spawn.
 *
 * Placement is by explicit world POINT, not road anchor: the baked CARLA
 * runtime maps expose only Driving lanes in their OpenDRIVE, so a parking-lane
 * road anchor (road/lane id) does not resolve in the worker. Each car is placed
 * at the parking lane's polyline point (runtime frame) with the lane tangent as
 * heading; the worker keeps that x,y, raycasts the ground z, and applies the
 * yaw — no lane snapping — so the cars sit parallel-parked at the curb.
 *
 * Every car is `is_static: true` + `autopilot: false` (physics frozen by the
 * worker), so parked cars never move and never enter the subject's lane. Fully
 * deterministic via seededRandom(hashSeed([...])).
 *
 * NOTE: space-backed street-parking candidates (parking-space polygons that
 * aren't modeled as Parking lanes) live in map_candidate_locations in WGS84 and
 * are not placed here; lane-backed parking covers the urban/residential pilot
 * maps. A roadside-offset fallback (no parking lane near the subject) is deferred.
 */
export function buildParkedActors(input: {
  subject: ScenarioEditorActorDraft;
  spawnSegment: RuntimeRoadSegment;
  variation: ScenarioVariation;
  density: BatchParkedDensity;
  parkingLanes: ReadonlyArray<ParkingLaneRef>;
  seed: number;
  datasetId: string;
  /** Already-placed DYNAMIC vehicles (ring + fill + scripted cause) whose WORLD
   * positions a curb-parked car must also clear — else a parked car lands on a
   * moving fill car and both eject in 3D physics ("flying car"; Yale
   * batch-parked × batch-fill-traffic 2.45 m overlap). Absent → curb-only dedup
   * (byte-identical to the pre-fix behaviour). */
  avoidVehicles?: ReadonlyArray<ScenarioEditorActorDraft>;
}): ScenarioEditorActorDraft[] {
  if (input.density === "none") return [];
  const preset = PARKED_DENSITY_PRESETS[input.density];
  const { subject } = input;
  const subjectPoint = centerlinePointAtFraction(input.spawnSegment, input.variation.spawnFraction);
  if (!subjectPoint) return [];
  const random = seededRandom(hashSeed([input.datasetId, "parked", input.seed, input.density]));

  // Two DIFFERENT clearances: the subject is in another lane so PARKED_EGO_CLEARANCE_METERS
  // is a small framing clearance, but parked-vs-parked must clear a full car length or
  // the two bodies overlap and eject in 3D physics (the "flying parked car" the Munich
  // review flagged). Reusing the 4m subject clearance for both let cross-lane cars on
  // overlapping/duplicated parking-lane records (Munich) land ~4-5m apart and fly.
  const placedParked: Array<{ x: number; y: number }> = [];
  const clearOfAvoid = (p: { x: number; y: number }) =>
    Math.hypot(p.x - subjectPoint.x, p.y - subjectPoint.y) >= PARKED_EGO_CLEARANCE_METERS &&
    placedParked.every(
      (q) => Math.hypot(p.x - q.x, p.y - q.y) >= PARKED_MUTUAL_CLEARANCE_METERS,
    );
  // World positions of the already-placed dynamic vehicles (traffic ring, heavy
  // fill, scripted lead/VRU/overtake). Traffic/fill carry spawn.world_anchor;
  // point-mode actors carry spawn_point. A parked car must clear these by a full
  // vehicle length (TRAFFIC_CAUSE_CLEARANCE_M) so bumpers never overlap.
  const dynamicXY: Array<{ x: number; y: number }> = [];
  for (const actor of input.avoidVehicles ?? []) {
    const w = actor.spawn?.world_anchor;
    const xy =
      w && Number.isFinite(w.x) && Number.isFinite(w.y)
        ? { x: w.x, y: w.y }
        : actor.spawn_point && Number.isFinite(actor.spawn_point.x)
          ? { x: actor.spawn_point.x, y: actor.spawn_point.y }
          : null;
    if (xy) dynamicXY.push(xy);
  }
  const clearOfDynamic = (p: { x: number; y: number }) =>
    dynamicXY.every((q) => Math.hypot(p.x - q.x, p.y - q.y) >= TRAFFIC_CAUSE_CLEARANCE_M);

  const actors: ScenarioEditorActorDraft[] = [];
  const pushParked = (
    lane: ParkingLaneRef,
    sample: { x: number; y: number; yawDeg: number },
  ) => {
    placedParked.push(sample);
    const index = actors.length + 1;
    actors.push({
      ...subject,
      id: `batch-parked-${input.seed}-${index}`,
      label: `Parked Car ${index}`,
      kind: "vehicle",
      role: "traffic",
      is_static: true,
      placement_mode: "point",
      blueprint: PARKED_BLUEPRINTS[(index - 1) % PARKED_BLUEPRINTS.length] ?? "vehicle.lincoln.mkz",
      color: "90,96,104",
      // spawn is unused in point mode but required by the schema; record the
      // source parking lane for traceability.
      spawn: {
        road_id: String(lane.road_id),
        section_id: lane.section_id ?? null,
        lane_id: lane.lane_id ?? null,
        s_fraction: 0,
      },
      spawn_point: { x: roundTo(sample.x, 3), y: roundTo(sample.y, 3) },
      spawn_yaw: roundTo(sample.yawDeg, 2),
      destination: null,
      destination_point: null,
      speed_kph: 0,
      autopilot: false,
      route: [],
      timeline: [],
      sensors: [],
      timedInstructions: undefined,
      timed_waypoints: undefined,
    });
  };

  // Annotated Parking lanes near the subject, nearest-first.
  const nearParking = input.parkingLanes
    .filter((lane) => lane.points.length >= 2 && lane.length_m >= PARKED_MIN_LANE_LENGTH_METERS)
    .map((lane) => ({ lane, distance: polylineMinDistanceToPoint(lane.points, subjectPoint) }))
    .filter((entry) => entry.distance <= PARKED_FILL_RADIUS_METERS)
    .sort(
      (a, b) =>
        a.distance - b.distance || (parkingKey(a.lane) < parkingKey(b.lane) ? -1 : 1),
    );

  for (const { lane } of nearParking) {
    if (actors.length >= preset.maxVehicles) break;
    const length = Math.max(1, lane.length_m);
    let cursorMeters = randomInRange(random, 0.5, PARKED_VEHICLE_SPACING_METERS);
    while (cursorMeters < length - 1 && actors.length < preset.maxVehicles) {
      if (random() <= preset.slotOccupancy) {
        const fraction = cursorMeters / length;
        const sample = sampleParkingPolyline(lane.points, fraction);
        if (sample && clearOfAvoid(sample) && clearOfDynamic(sample)) {
          pushParked(lane, sample);
        }
      }
      cursorMeters += PARKED_VEHICLE_SPACING_METERS;
    }
  }
  // Roadside fallback (no annotated Parking lane near the subject) is intentionally
  // deferred: it requires offsetting laterally from a Driving-lane centerline
  // and placing via point mode, which needs verified runtime-frame handling
  // (spawn_yaw is DEGREES, spawn_point is {x,y} with ground-height resolution).
  // The pilot maps (Yale, San Ramon P1) carry annotated Parking lanes near the
  // chosen roads, so the primary path covers them; shipping an unverified
  // roadside placement would risk cars in the lane or off-ground. Tracked as a
  // follow-up once a parking-lane-free region actually needs it.
  return actors;
}

/**
 * The lead vehicle that CAUSES a stop (variants B/C): spawns ahead on the
 * subject's approach lane at the subject's cruise speed and runs its own timed
 * instructions (anchored/mid-block stop, optional post-window proceed). It is
 * a normal traffic-role actor, so the worker compiles and drives it exactly
 * like the subject's timed plan.
 */
export function buildStopLeadActor(input: {
  subject: ScenarioEditorActorDraft;
  lead: NonNullable<StopScenarioPlan["lead"]>;
  variant: StopVariant;
  strategy: BatchScenarioStrategy;
  seed: number;
  segments: ReadonlyMap<string, RuntimeRoadSegment>;
}): ScenarioEditorActorDraft {
  const { subject, lead, seed } = input;
  const generatorMeta = (tags: string[]) => ({
    seed: String(seed),
    strategyId: input.strategy,
    candidateRank: 0,
    tags: ["batch", "normal_driving", input.strategy, `stop_${input.variant}`, ...tags],
  });
  // Route-follower lead: stop + resume via `set_speed` (NOT the `stop` primitive).
  // The worker's pursuit control brakes to a full stop for target speed 0 and
  // accelerates again for a cruise target — both worker-driven, so the lead
  // deterministically halts then PULLS AWAY on cue (the `stop` primitive's
  // held-brake never releases cleanly → the lead would never resume).
  const rows: TimedInstructionIntent[] = [
    {
      id: `tii_batch_${seed}_lead`,
      timestampSeconds: lead.stopAtSeconds,
      rowOrder: 0,
      enabled: true,
      primitiveId: "set_speed",
      args: { speedKph: 0 },
      source: "generator",
      generator: generatorMeta(["stop_lead"]),
      validationErrors: [],
    },
  ];
  if (lead.resume) {
    rows.push({
      id: `tii_batch_${seed}_lead_resume`,
      timestampSeconds: lead.resume.atSeconds,
      rowOrder: 1,
      enabled: true,
      primitiveId: "set_speed",
      args: { speedKph: lead.resume.speedKph },
      source: "generator",
      generator: generatorMeta(["stop_lead", "stop_resume"]),
      validationErrors: [],
    });
  }
  return {
    ...subject,
    id: `batch-stop-lead-${seed}`,
    label: "Stop Cause Lead",
    role: "traffic",
    blueprint: STOP_LEAD_BLUEPRINT,
    color: "210,170,60",
    placement_mode: "road",
    spawn: withWorldAnchor(
      {
        road_id: String(lead.spawnSegment.road_id),
        section_id: lead.spawnSegment.section_id ?? null,
        lane_id: lead.spawnSegment.lane_id ?? null,
        s_fraction: lead.spawnFraction,
      },
      lead.spawnSegment,
      lead.spawnFraction,
    ),
    destination: null,
    speed_kph: lead.speedKph,
    // Route-follower, NOT TM: autopilot off so `set_speed` drives the worker
    // pursuit control (brake-to-stop / accelerate-to-resume) directly instead of
    // diverting into the TM branch (which won't release a held lead).
    autopilot: false,
    // Route-follower (not TM): an explicit forward route on the lead's lane makes
    // the worker drive it via path control, so its timed `stop` (controlled-decel)
    // and `set_speed` RESUME work through worker control — a TM lead won't restart
    // after a manual-brake stop (brake latch). The route extends THROUGH successor
    // segments so the resuming lead has room to actually drive away (the lead
    // spawns far down its lane; a single-segment route often left no room).
    route: buildForwardRouteThroughSuccessors(
      input.segments,
      lead.spawnSegment,
      lead.spawnFraction,
      lead.speedKph,
      STOP_LEAD_RESUME_RUNWAY_M,
    ),
    timeline: [],
    sensors: [],
    timedInstructions: {
      schemaVersion: "simforge.timed-instructions.v1",
      intent: rows,
      resolvedPlan: null,
      status: "draft",
      manifest: [],
    },
  };
}

/** One slow route-follower in the subject's lane (the overtake lead or a queue member
 *  ahead of it). Cruises forward at `speedKph` with no stops; the subject passes it. */
function buildOvertakeLaneVehicle(input: {
  subject: ScenarioEditorActorDraft;
  segment: RuntimeRoadSegment;
  fraction: number;
  speedKph: number;
  blueprint: string;
  color: string;
  id: string;
  label: string;
  segments: ReadonlyMap<string, RuntimeRoadSegment>;
}): ScenarioEditorActorDraft {
  const { subject, segment, fraction, speedKph, segments } = input;
  return {
    ...subject,
    id: input.id,
    label: input.label,
    role: "traffic",
    blueprint: input.blueprint,
    color: input.color,
    placement_mode: "road",
    spawn: withWorldAnchor(
      {
        road_id: String(segment.road_id),
        section_id: segment.section_id ?? null,
        lane_id: segment.lane_id ?? null,
        s_fraction: fraction,
      },
      segment,
      fraction,
    ),
    destination: null,
    speed_kph: speedKph,
    // Route-follower (autopilot off): explicit forward route → steady slow cruise,
    // walking successors so it keeps rolling past the segment boundary.
    autopilot: false,
    route: buildForwardRouteThroughSuccessors(
      segments,
      segment,
      fraction,
      speedKph,
      OVERTAKE_LEAD_ROUTE_RUNWAY_M,
    ),
    timeline: [],
    sensors: [],
    timedInstructions: undefined,
  };
}

/**
 * The slow traffic the overtaking subject swings out to pass (overtake_left /
 * overtake_right): a LEAD in the subject's own lane plus a short QUEUE of slower
 * vehicles ahead of it (dib 2026-07-09: "traffic in the lead car's lane"), so the
 * subject passes a LINE of slow traffic rather than a single car. The lead is a heavy
 * vehicle (bus/truck) a fraction of the time — a stronger reason to pass. All are
 * route-followers cruising at a fraction of the subject's speed.
 *
 * Returns [] when the subject spawns too near the end of its lane to leave a sensible
 * forward gap (rare — placement guarantees runway); the caller then emits a bare
 * lane change.
 */
export function buildOvertakeTrafficActors(input: {
  subject: ScenarioEditorActorDraft;
  spawnSegment: RuntimeRoadSegment;
  variation: ScenarioVariation;
  strategy: BatchScenarioStrategy;
  seed: number;
  segments: ReadonlyMap<string, RuntimeRoadSegment>;
}): ScenarioEditorActorDraft[] {
  const { subject, variation, seed, spawnSegment, segments } = input;
  const random = seededRandom(hashSeed(["overtake", seed, String(spawnSegment.road_id)]));
  const leadSpeedKph = Math.max(
    OVERTAKE_LEAD_MIN_SPEED_KPH,
    Math.round(variation.speedKph * OVERTAKE_LEAD_SPEED_FRACTION),
  );
  const heavyLead = random() < OVERTAKE_HEAVY_LEAD_FRACTION;
  const subjectMps = variation.speedKph / 3.6;
  const leadMps = leadSpeedKph / 3.6;
  const closingMps = Math.max(1.0, subjectMps - leadMps);
  // Initial spawn gap so the subject closes to ~OVERTAKE_TRAIL_GAP_M behind the lead by
  // the lane-change moment; a heavy lead sits a little further ahead for its body.
  const gapMeters = Math.min(
    OVERTAKE_MAX_GAP_M,
    Math.max(
      OVERTAKE_MIN_GAP_M,
      closingMps * variation.instructionDelaySeconds +
        OVERTAKE_TRAIL_GAP_M +
        (heavyLead ? OVERTAKE_HEAVY_LEAD_EXTRA_GAP_M : 0),
    ),
  );
  const forwardIncreasingS = forwardIsIncreasingS(segments, spawnSegment);
  const segLen = Math.max(1, segmentLengthMeters(spawnSegment));
  const fracDelta = gapMeters / segLen;
  const rawLeadFraction = forwardIncreasingS
    ? variation.spawnFraction + fracDelta
    : variation.spawnFraction - fracDelta;
  const leadFraction = roundTo(
    forwardIncreasingS
      ? Math.min(0.92, rawLeadFraction)
      : Math.max(0.08, rawLeadFraction),
    3,
  );
  const realGapM = Math.abs(leadFraction - variation.spawnFraction) * segLen;
  if (realGapM < 3) return [];

  const lead = buildOvertakeLaneVehicle({
    subject,
    segment: spawnSegment,
    fraction: leadFraction,
    speedKph: leadSpeedKph,
    blueprint: heavyLead
      ? HEAVY_VEHICLE_BLUEPRINTS[Math.floor(random() * HEAVY_VEHICLE_BLUEPRINTS.length)]!
      : OVERTAKE_LEAD_BLUEPRINT,
    color: heavyLead ? "200,120,40" : "60,90,200",
    id: `batch-overtake-lead-${seed}`,
    label: heavyLead ? "Overtake Lead (heavy, slow)" : "Overtake Lead (slow)",
    segments,
  });
  const actors: ScenarioEditorActorDraft[] = [lead];

  // Queue: slower vehicles AHEAD of the lead in the same lane. Walk the lead's own
  // forward route and drop a vehicle each time the cumulative distance from the lead
  // crosses another QUEUE_SPACING — this naturally spills onto successor lanes so the
  // queue stays on the road even when the spawn segment is short.
  const leadWorld = lead.spawn.world_anchor;
  const leadRoute = lead.route ?? [];
  if (leadWorld) {
    let prev = leadWorld;
    let cum = 0;
    let placed = 0;
    let nextTarget = OVERTAKE_QUEUE_SPACING_M;
    for (const anchor of leadRoute) {
      if (placed >= OVERTAKE_QUEUE_COUNT) break;
      const w = anchor.world_anchor;
      if (!w) continue;
      cum += Math.hypot(w.x - prev.x, w.y - prev.y);
      prev = w;
      if (cum < nextTarget) continue;
      const rsl = `${anchor.road_id}:${anchor.section_id ?? ""}:${anchor.lane_id ?? ""}`;
      const seg = segments.get(rsl);
      const frac = typeof anchor.s_fraction === "number" ? anchor.s_fraction : null;
      if (seg && frac !== null) {
        // Queue members cruise a touch slower/faster than the lead for variety, but
        // always well below the subject so the whole line is passable.
        const qSpeed = Math.max(
          OVERTAKE_LEAD_MIN_SPEED_KPH,
          Math.round(leadSpeedKph * (0.85 + random() * 0.25)),
        );
        actors.push(
          buildOvertakeLaneVehicle({
            subject,
            segment: seg,
            fraction: frac,
            speedKph: qSpeed,
            blueprint: TRAFFIC_BLUEPRINTS[Math.floor(random() * TRAFFIC_BLUEPRINTS.length)]!,
            color: "90,110,160",
            id: `batch-overtake-queue-${seed}-${placed}`,
            label: "Overtake Queue (slow)",
            segments,
          }),
        );
        placed += 1;
      }
      nextTarget += OVERTAKE_QUEUE_SPACING_M;
    }
  }
  return actors;
}

export function buildCrossingVruActor(input: {
  subject: ScenarioEditorActorDraft;
  vru: NonNullable<StopScenarioPlan["vru"]>;
  seed: number;
}): ScenarioEditorActorDraft {
  const { subject, vru, seed } = input;
  // A scripted walker on a timed_path: hold at the curb, then cross the subject's lane.
  // The worker interpolates timed_waypoints + applies WalkerControl; the subject's
  // obstacle-stop brakes for it. No autopilot, no timed instructions.
  return {
    ...subject,
    id: `batch-stop-vru-${seed}`,
    label: "Crossing Pedestrian",
    kind: "walker",
    role: "pedestrian",
    is_static: false,
    blueprint: STOP_VRU_BLUEPRINT,
    color: "230,120,40",
    placement_mode: "timed_path",
    spawn: { road_id: "", section_id: null, lane_id: null, s_fraction: 0 },
    spawn_point: { x: vru.spawnPoint.x, y: vru.spawnPoint.y, z: vru.spawnPoint.z },
    // Face the crossing direction (spawn → far curb); else the worker defaults an
    // unset walker yaw to 0° (East) and the ped stands facing off-road/vegetation.
    // atan2 already yields [-180, 180].
    spawn_yaw:
      (Math.atan2(
        vru.crossEndPoint.y - vru.spawnPoint.y,
        vru.crossEndPoint.x - vru.spawnPoint.x,
      ) *
        180) /
      Math.PI,
    destination: null,
    destination_point: null,
    speed_kph: vru.speedKph,
    autopilot: false,
    route: [],
    timeline: [],
    sensors: [],
    timedInstructions: undefined,
    timed_waypoints: (() => {
      // Centerline (corridor) point = midpoint of the two curbs. The ped holds at the
      // curb, walks to the centerline, PAUSES there (forcing the subject's full stop +
      // hold), then completes the crossing so the subject resumes once it clears.
      const mid = {
        x: roundTo((vru.spawnPoint.x + vru.crossEndPoint.x) / 2, 2),
        y: roundTo((vru.spawnPoint.y + vru.crossEndPoint.y) / 2, 2),
        z: roundTo((vru.spawnPoint.z + vru.crossEndPoint.z) / 2, 2),
      };
      const half = vru.crossSeconds / 2;
      const tMid = roundTo(vru.holdSeconds + half, 1);
      const tResume = roundTo(tMid + STOP_VRU_CENTER_PAUSE_S, 1);
      // z on every waypoint so the whole crossing path stays on the subject's layer
      // (the worker resolves each timed point to the surface nearest its z).
      return [
        { x: vru.spawnPoint.x, y: vru.spawnPoint.y, z: vru.spawnPoint.z, time: 0 },
        { x: vru.spawnPoint.x, y: vru.spawnPoint.y, z: vru.spawnPoint.z, time: vru.holdSeconds },
        { x: mid.x, y: mid.y, z: mid.z, time: tMid },
        { x: mid.x, y: mid.y, z: mid.z, time: tResume },
        { x: vru.crossEndPoint.x, y: vru.crossEndPoint.y, z: vru.crossEndPoint.z, time: roundTo(tResume + half, 1) },
      ];
    })(),
  };
}

