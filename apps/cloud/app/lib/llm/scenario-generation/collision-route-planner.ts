/**
 * Deterministic collision-route planner.
 *
 * Given a `CollisionFamilyId` + a `GeometryReport` (the same one the LLM
 * collected via `inspect_location_geometry`), this module returns concrete
 * spawn positions and waypoint polylines for subject + NPC so the two actors
 * meet at a planned conflict point at a planned time-of-impact.
 *
 * The output rides existing draft-schema fields:
 *   - `spawnPoint` → `ScenarioEditorActorDraft.spawn_point`
 *   - `waypoints[1..n]` → `ScenarioEditorActorDraft.timed_waypoints`
 *   - callers set `placement_mode: "timed_path"` and `autopilot: false`,
 *     so the CARLA worker's path controller drives the planned polyline.
 *
 * The planner consumes a small, radius-bounded projection of the
 * runtime-bound XODR topology index. `lane-graph.ts` keeps the bounded
 * forward/backward walk API while the index remains the connectivity and
 * travel-direction authority.
 */
import "server-only";
import { COLLISION_TEMPLATES, TARGET_COLLISION_TIME_S, type CollisionFamilyId } from "@simcloud/shared";
import { getMapAssetByRuntimeNameFromDb } from "@/app/lib/db/map-asset-store";
import {
  getRuntimeBoundMapTopology,
  getRuntimeLaneTravelDirections,
} from "@/app/lib/maps/topology/server/topology-index-service";
import type { GeometryReport, GeometryLaneSample } from "@/app/lib/maps/search/server/inspect-location-geometry";
import {
  angleDifference,
  buildLaneGraphFromTopology,
  laneNodeId,
  leftTurnSuccessorPicker,
  pointOnLane,
  projectPointOntoLanePolyline,
  walkBack,
  walkForward,
  type LaneGraph,
  type LaneNode,
  type LanePosition,
} from "@/app/lib/llm/scenario-generation/lane-graph";
// NOTE: leftTurnSuccessorPicker is retained for the legacy fallback grid;
// the gate-driven path lives in
// `@/app/lib/llm/scenario-generation/planner/gated-collision-planner`.

// ── Public types ────────────────────────────────────────────────────────────

export interface PlannedActor {
  /** Lane node id (`road_id:section_id:lane_id`) the actor spawns on. */
  spawnLaneId: string;
  /** Position along the spawn lane in [0, 1]. */
  spawnSFraction: number;
  /** World point of the spawn (becomes the draft's `spawn_point`). */
  spawnPoint: { x: number; y: number };
  /** Yaw at spawn in radians (forward-travel direction). */
  spawnYaw: number;
  /** Ordered world-point polyline from spawn to conflict point. The first
   *  element equals `spawnPoint`, the last equals `conflictPoint`. */
  waypoints: ReadonlyArray<{ x: number; y: number }>;
  /** Effective speed used in the backward walk, kph. */
  expectedSpeedKph: number;
  /** Total planned arc length from spawn to conflict point, meters. */
  arcLengthM: number;
  /** For turn actors: the rest of the turn geometry PAST the conflict — the
   *  connecting/exit-lane centerline from the conflict point to the end of the gate
   *  chain. The collision (contact) variant ends at the conflict and ignores this;
   *  the AVOIDED variant appends it so the subject completes a proper turn INTO the exit
   *  lane (rather than overshooting onto the curb because its path stopped mid-turn
   *  at the conflict — dib 2026-07-09). First element ≈ conflictPoint. */
  postConflictWaypoints?: ReadonlyArray<{ x: number; y: number }>;
  /**
   * The plan ENDS here, stopped — it is not a point the actor drives through.
   * Set by families whose maneuver terminates in a deliberate stop: the subject
   * pulls into a driveway / parking bay and stays there (dib 2026-07-23 US
   * avoidance review — "the subject must stop once it's situated in the driveway
   * and not try to go past it"; "subject drives into a fence at the end — if it
   * just stopped in the parking lot it would've been 4-5 star").
   *
   * `plannedCollisionToDraftActors` turns this into (a) a stationary hold
   * waypoint at `point` — the validated parking-probe pattern that halts
   * pursuit parked — and (b) a `terminal_stop` marker on the draft, which stops
   * `extendActorPathsBeyondConflict` from laying its usual run-out tail past
   * the stop. `clearanceM` is the drivable run left between `point` and the far
   * obstacle (end of the destination leg / the parking spot's backoff), carried
   * for provenance + CoT.
   */
  terminalStop?: {
    point: { x: number; y: number };
    holdS: number;
    clearanceM: number;
    reason: "driveway" | "curbside_park";
  };
}

/**
 * Spawn heading (scenario-draft degrees, normalized to (-180, 180]) for a
 * planned actor, derived from the **planned path's first segment** rather
 * than the lane reference-line tangent.
 *
 * `PlannedActor.spawnYaw` comes from the OpenDRIVE road reference line
 * (+s tangent). A lane's actual travel direction relative to that tangent
 * flips with the lane-id sign (right-side `id<0` travels +s; left-side
 * `id>0` travels −s) and is undefined for `bidirectional` lanes — which
 * is why the old blanket `+180°` correction spawned half the scenarios
 * reversed. The waypoint polyline is already in travel order
 * (`waypoints[0]` == spawn, last == conflict), so its first non-degenerate
 * segment is the unambiguous true heading regardless of lane side. Falls
 * back to the reference yaw only if the path has no distinct second point.
 */
export function spawnYawDegFromPlannedPath(
  planned: Pick<PlannedActor, "spawnPoint" | "waypoints" | "spawnYaw">,
): number {
  const norm = (deg: number) => ((((deg + 180) % 360) + 360) % 360) - 180;
  const a = planned.waypoints[0] ?? planned.spawnPoint;
  let b: { x: number; y: number } | null = null;
  for (let i = 1; i < planned.waypoints.length; i++) {
    const w = planned.waypoints[i]!;
    if (w.x !== a.x || w.y !== a.y) {
      b = w;
      break;
    }
  }
  if (!b) return norm((planned.spawnYaw * 180) / Math.PI);
  return norm((Math.atan2(b.y - a.y, b.x - a.x) * 180) / Math.PI);
}

export interface PlannedCollision {
  conflictPoint: { x: number; y: number };
  /** Time-of-impact in seconds since scenario start. */
  arrivalTimeS: number;
  subject: PlannedActor;
  npc: PlannedActor;
  /** Human-readable summary of how the plan was constructed. Written into
   *  the draft's `metadata.notes`. */
  rationale: string;
  /**
   * The topology gate the subject is planned to traverse, when the planner
   * resolved one — i.e. for Tier-0 gated plans. The downstream validator
   * consults `subjectGate.turnRelation` directly for the `maneuver_executed`
   * check (authoritative Left/Right/Straight from XODR) instead of
   * inferring turn type from waypoint headings. Null on legacy Tier-1
   * plans, which fall back to the heading heuristic.
   */
  subjectGate?: {
    junctionId: string;
    gateId: string;
    turnRelation: "Left" | "Right" | "Straight" | "UTurnLeft" | "UTurnRight";
    /** Net heading change of the gate's connecting road (signed, +CCW). */
    headingChangeRad: number;
  } | null;
}

export interface PlannedWalker {
  spawnPoint: { x: number; y: number };
  waypoints: ReadonlyArray<{ x: number; y: number; time: number }>;
  rationale: string;
}

export interface PlanCollisionRoutesArgs {
  family: CollisionFamilyId;
  geometry: GeometryReport;
  approachGeometries: readonly GeometryReport[];
  subjectSpeedKph: number;
  npcSpeedKph: number;
  /** Scenario duration in seconds — used to derive arrivalTimeS. */
  durationS: number;
  /** When the cut-in NPC is a cyclist, the planner widens its adjacent-
   *  lane search to include biking / shoulder lanes (the runtime bundle
   *  filters those out of the driving-adjacency pointers, so the planner
   *  has to walk the graph directly to find them). Null for vehicle-NPC
   *  defaults. */
  npcVehicleType?: "car" | "bicycle" | "motorcycle" | null;
}

// ── Planner constants ───────────────────────────────────────────────────────

/** How far around the document we load lane geometry. Wide enough to
 *  comfortably contain a 167 m backward walk (80 kph × 7.5 s) plus the
 *  junction interior. The radius keeps the planner projection bounded;
 *  connectivity itself remains the index's exact directed graph. */
const PLANNER_BUNDLE_RADIUS_M = 250;

/** Default waypoint sampling along planned polylines. */
const SAMPLING_M = 5;

/** When the backward walk would exceed the longest reachable approach, we
 *  cap at this fraction of the available arc so spawn never lands on the
 *  absolute first vertex (which CARLA sometimes rejects as off-road). */
const SPAWN_S_FRACTION_FLOOR = 0.02;

/** Cut-in lane-change arc duration in seconds. */
const CUT_IN_LANE_CHANGE_SECONDS = 1.5;

/** A backward walk that achieves less than this fraction of the
 *  requested run-up distance is rejected (no real approach → the actor
 *  would spawn on the conflict point). */
const MIN_RUNUP_FRACTION = 0.5;


/** Walker constants — pulled in from the previous builder constants. */
// Walker curb-hold is no longer a constant — it's solved from the subject
// ETA in planPedestrianCrossing (hold = arrivalTimeS − CROSS/2).
const WALKER_CROSSING_DURATION_S = 6;
const PEDESTRIAN_CROSSING_HALF_WIDTH_M = 4;

// Arrival time is now uniform (`TARGET_COLLISION_TIME_S`, imported from
// @simcloud/shared) — every actor is back-calculated so the collision
// lands at the same planned moment regardless of family.

// ── Bundle loading ──────────────────────────────────────────────────────────

interface LoadedSegments {
  graph: LaneGraph;
  /** Document center in runtime-world meters. */
  center: { x: number; y: number };
}

async function loadLaneGraphAroundDocument(
  geometry: GeometryReport,
): Promise<LoadedSegments | null> {
  if (!geometry.documentCenter) return null;
  const asset = await getMapAssetByRuntimeNameFromDb(geometry.backendMapName);
  if (!asset) return null;
  const bound = await getRuntimeBoundMapTopology({
    mapAssetId: asset.map_asset_id,
    runtime: "carla_ue5",
  });
  const resolvedTravelIncreasesS = new Map<string, boolean>(
    Object.entries(bound.index.laneTravelIncreasesS ?? {}),
  );
  if (resolvedTravelIncreasesS.size < Object.keys(bound.index.lanes).length) {
    for (const [rsl, increasesS] of await getRuntimeLaneTravelDirections(bound)) {
      resolvedTravelIncreasesS.set(rsl, increasesS);
    }
  }
  const center = geometry.documentCenter;
  const graph = buildLaneGraphFromTopology(
    bound.index,
    center,
    PLANNER_BUNDLE_RADIUS_M,
    resolvedTravelIncreasesS,
  );
  return graph.nodes.size > 0 ? { graph, center } : null;
}

// ── Approach-lane resolution ────────────────────────────────────────────────

/**
 * Pick subject's approach lane node in the graph. Mirrors the legacy
 * `pickApproachLane` heuristic but resolves to an actual `LaneNode`.
 *
 * Strategy:
 *   1. If `approachGeometries` is non-empty, pick the closest forward-
 *      facing drivable lane from those reports.
 *   2. Otherwise, pick the closest forward-facing drivable lane near the
 *      document center.
 *
 * "Forward-facing" means the lane's midpoint heading aligns with the
 * direction TO the conflict centre (positive dot product, cos > 0.1).
 */
function pickSubjectApproachLane(
  graph: LaneGraph,
  geometry: GeometryReport,
  approachGeometries: readonly GeometryReport[],
): LaneNode | null {
  const target = geometry.documentCenter;
  if (!target) return null;
  const candidates: GeometryLaneSample[] = [];
  for (const report of approachGeometries) {
    for (const lane of report.availableLanes) {
      if (lane.lane_type === "driving" || lane.lane_type === "bidirectional") {
        candidates.push(lane);
      }
    }
  }
  if (candidates.length === 0) {
    for (const lane of geometry.availableLanes) {
      if (lane.lane_type === "driving" || lane.lane_type === "bidirectional") {
        candidates.push(lane);
      }
    }
  }

  let best: { node: LaneNode; distance: number } | null = null;
  for (const sample of candidates) {
    const node = graph.nodes.get(laneNodeId(sample.road_id, sample.section_id, sample.lane_id));
    if (!node) continue;
    if (node.is_junction) continue;
    if (node.lane_type !== "driving" && node.lane_type !== "bidirectional") continue;
    // Use the lane's midpoint, not its endpoint, for the forward-facing
    // check. This matches the legacy `pickApproachLane` heuristic and
    // handles the case where the target sits beside the lane (e.g.
    // pedestrian-crossing scenarios where the POI is across the curb,
    // not ahead of subject). A lane whose midpoint heading aligns with the
    // toward-target direction is still a valid approach even if the
    // lane's endpoint is past the target.
    const mid = pointOnLane(node, 0.5);
    const toTargetX = target.x - mid.x;
    const toTargetY = target.y - mid.y;
    const toTargetLen = Math.hypot(toTargetX, toTargetY);
    if (toTargetLen === 0) continue;
    const dot =
      (Math.cos(mid.yaw) * toTargetX + Math.sin(mid.yaw) * toTargetY) / toTargetLen;
    // Relaxed alignment — the lane must point roughly toward OR
    // perpendicular to the target (within ~107° of toward-target).
    // Perpendicular lanes still count because pedestrian-crossing
    // documents typically sit BESIDE subject's lane (across the curb), so a
    // strict "lane points at target" filter would reject every valid
    // approach. Reverse-direction lanes (dot < -0.3) are still excluded.
    if (dot < -0.3) continue;
    if (!best || toTargetLen < best.distance) best = { node, distance: toTargetLen };
  }
  return best ? best.node : null;
}

/**
 * Find a lane node travelling opposite to a reference lane, ideally on the
 * same road and same section. Used by the unprotected-left-turn planner to
 * find the oncoming-traffic approach.
 */
function pickOpposingApproachLane(
  graph: LaneGraph,
  subject: LaneNode,
  geometry: GeometryReport,
): LaneNode | null {
  const target = geometry.documentCenter;
  if (!target) return null;
  const subjectEnd = subject.forwardPolyline[subject.forwardPolyline.length - 1]!;
  const subjectEndYaw = subjectEnd.yaw;
  const opposingYaw = subjectEndYaw + Math.PI;
  let best: { node: LaneNode; score: number } | null = null;
  for (const node of graph.nodes.values()) {
    if (node.id === subject.id) continue;
    if (node.is_junction) continue;
    if (node.lane_type !== "driving" && node.lane_type !== "bidirectional") continue;
    const mid = pointOnLane(node, 0.5);
    const toTargetX = target.x - mid.x;
    const toTargetY = target.y - mid.y;
    const toTargetLen = Math.hypot(toTargetX, toTargetY);
    if (toTargetLen === 0) continue;
    const dot =
      (Math.cos(mid.yaw) * toTargetX + Math.sin(mid.yaw) * toTargetY) / toTargetLen;
    if (dot < -0.3) continue;
    const yawDelta = angleDifference(mid.yaw, opposingYaw);
    if (yawDelta > Math.PI / 3) continue;
    // Prefer same road as subject (true opposing), then closest distance.
    const sameRoadBonus = node.road_id === subject.road_id ? -1000 : 0;
    const score = sameRoadBonus + toTargetLen + yawDelta * 10;
    if (!best || score < best.score) best = { node, score };
  }
  return best ? best.node : null;
}

/** Find an adjacent same-direction lane on the same road/section as subject.
 *
 * Default behaviour follows the bundle's `left_lane_id` / `right_lane_id`
 * pointers — set only for `Driving` / `Bidirectional` neighbours by the
 * orchestrator's `_drivable_adjacent_lane_id` helper.
 *
 * Cyclist override: when the NPC is a cyclist, the relevant neighbour
 * isn't another driving lane — it's the *bike lane* parallel to subject.
 * The orchestrator deliberately strips bike lanes from the adjacency
 * pointers (so vehicle cut-ins don't accidentally pick a bike lane),
 * but the bike-lane *nodes* are in the graph. Walk the graph for any
 * same-road / same-section / same-direction biking or shoulder node.
 */
function pickAdjacentLaneNode(
  graph: LaneGraph,
  subject: LaneNode,
  npcVehicleType: "car" | "bicycle" | "motorcycle" | null,
): LaneNode | null {
  for (const neighborLane of [subject.left_lane_id, subject.right_lane_id]) {
    if (neighborLane == null || neighborLane === subject.lane_id) continue;
    if (Math.sign(neighborLane) !== Math.sign(subject.lane_id)) continue;
    const node = graph.nodes.get(laneNodeId(subject.road_id, subject.section_id, neighborLane));
    if (node) return node;
  }
  if (npcVehicleType === "bicycle") {
    for (const node of graph.nodes.values()) {
      if (node.road_id !== subject.road_id) continue;
      if (node.section_id !== subject.section_id) continue;
      if (node.lane_id === subject.lane_id) continue;
      if (Math.sign(node.lane_id) !== Math.sign(subject.lane_id)) continue;
      if (node.lane_type !== "biking" && node.lane_type !== "shoulder") continue;
      return node;
    }
  }
  return null;
}

// ── Polyline-intersection helper ────────────────────────────────────────────

function segmentsIntersect(
  p1: { x: number; y: number },
  p2: { x: number; y: number },
  p3: { x: number; y: number },
  p4: { x: number; y: number },
): { x: number; y: number; t1: number; t2: number } | null {
  const d1x = p2.x - p1.x;
  const d1y = p2.y - p1.y;
  const d2x = p4.x - p3.x;
  const d2y = p4.y - p3.y;
  const denom = d1x * d2y - d1y * d2x;
  if (Math.abs(denom) < 1e-9) return null;
  const t1 = ((p3.x - p1.x) * d2y - (p3.y - p1.y) * d2x) / denom;
  const t2 = ((p3.x - p1.x) * d1y - (p3.y - p1.y) * d1x) / denom;
  if (t1 < 0 || t1 > 1 || t2 < 0 || t2 > 1) return null;
  return { x: p1.x + t1 * d1x, y: p1.y + t1 * d1y, t1, t2 };
}

/**
 * Find the first intersection (or closest approach if no true crossing)
 * between two polylines. Used to pinpoint the conflict point inside a
 * junction once both actors' forward routes are sampled.
 */
export function findPolylineConflict(
  subjectPath: ReadonlyArray<{ x: number; y: number }>,
  npcPath: ReadonlyArray<{ x: number; y: number }>,
): { point: { x: number; y: number }; subjectArc: number; npcArc: number } | null {
  if (subjectPath.length < 2 || npcPath.length < 2) return null;
  // First pass: look for a true segment-segment intersection.
  let subjectArc = 0;
  for (let i = 1; i < subjectPath.length; i++) {
    const ea = subjectPath[i - 1]!;
    const eb = subjectPath[i]!;
    const subjectSegLen = Math.hypot(eb.x - ea.x, eb.y - ea.y);
    let npcArc = 0;
    for (let j = 1; j < npcPath.length; j++) {
      const na = npcPath[j - 1]!;
      const nb = npcPath[j]!;
      const npcSegLen = Math.hypot(nb.x - na.x, nb.y - na.y);
      const hit = segmentsIntersect(ea, eb, na, nb);
      if (hit) {
        return {
          point: { x: hit.x, y: hit.y },
          subjectArc: subjectArc + hit.t1 * subjectSegLen,
          npcArc: npcArc + hit.t2 * npcSegLen,
        };
      }
      npcArc += npcSegLen;
    }
    subjectArc += subjectSegLen;
  }
  // Fallback: closest-approach midpoint between any two segments.
  let bestDistance = Infinity;
  let bestResult: { point: { x: number; y: number }; subjectArc: number; npcArc: number } | null = null;
  let cumulativeSubjectArc = 0;
  for (let i = 1; i < subjectPath.length; i++) {
    const ea = subjectPath[i - 1]!;
    const eb = subjectPath[i]!;
    const subjectSegLen = Math.hypot(eb.x - ea.x, eb.y - ea.y);
    let npcArc = 0;
    for (let j = 1; j < npcPath.length; j++) {
      const na = npcPath[j - 1]!;
      const nb = npcPath[j]!;
      const npcSegLen = Math.hypot(nb.x - na.x, nb.y - na.y);
      const pairs: Array<[{ x: number; y: number }, { x: number; y: number }, number, number]> = [
        [ea, na, cumulativeSubjectArc, npcArc],
        [ea, nb, cumulativeSubjectArc, npcArc + npcSegLen],
        [eb, na, cumulativeSubjectArc + subjectSegLen, npcArc],
        [eb, nb, cumulativeSubjectArc + subjectSegLen, npcArc + npcSegLen],
      ];
      for (const [ep, np, ea2, na2] of pairs) {
        const distance = Math.hypot(ep.x - np.x, ep.y - np.y);
        if (distance < bestDistance) {
          bestDistance = distance;
          bestResult = {
            point: { x: (ep.x + np.x) / 2, y: (ep.y + np.y) / 2 },
            subjectArc: ea2,
            npcArc: na2,
          };
        }
      }
      npcArc += npcSegLen;
    }
    cumulativeSubjectArc += subjectSegLen;
  }
  return bestResult;
}

// ── Per-family solvers ──────────────────────────────────────────────────────

/**
 * Unprotected left turn. Subject turns across an oncoming-traffic stream;
 * conflict point lies inside the junction where subject's left-turn arc
 * meets the opposing approach's centerline.
 */
/**
 * How far back the subject must spawn to arrive at the conflict at `arrivalTimeS` — DRIVING THE
 * WAY IT ACTUALLY DRIVES.
 *
 * The planner used to place the subject at `speed x arrivalTime` metres back, i.e. assuming a
 * constant full-speed approach. But the subject DECELERATES into a turn: it cannot take a 7 m
 * radius corner at 35 km/h. Measured over 28 turn-collision scenes (2026-07-14), its mean
 * run-up speed was only 0.80x nominal (range 0.23-0.97) — a ~25% late arrival, ~1.5 s on a
 * 6 s run-up, during which the NPC (which DOES hold its speed) travels ~14.5 m. That is
 * exactly the miss distance in the data (median 17.4 m on right_turn_hook), and it is why
 * unprotected_left_turn converted at 16% and right_turn_hook at 5%. The collision never
 * happened because the subject turned up after the conflict had gone through.
 *
 * The slowdown is REAL and must be kept — a car that corners at full speed is not a scene we
 * want. So rather than cancel it with a fudge factor, MODEL it and let the geometry decide:
 *
 *   1. curvature-limited speed at each point:  v = sqrt(A_LAT_MAX / |kappa|)   (capped at cruise)
 *   2. a backward pass so the subject BRAKES IN TIME for a slower section ahead
 *      (v[i] <= sqrt(v[i+1]^2 + 2*A_BRAKE*ds))
 *   3. walk BACKWARD from the conflict point accumulating dt = ds / v(s) until the time spent
 *      equals arrivalTimeS — the distance covered IS the run-up.
 *
 * Same answer as the old formula on a straight approach (v == cruise everywhere), and a
 * correctly SHORTER run-up the sharper the turn. Per-scene, from the real geometry.
 */
const A_LAT_MAX_MPS2 = 3.0;   // comfortable lateral accel — sets the cornering speed
const A_BRAKE_MPS2 = 2.5;     // comfortable deceleration into the corner
const V_MIN_TURN_MPS = 3.0;   // floor: even a hairpin is taken at walking-ish pace, not 0
const PROFILE_STEP_M = 1.0;   // integration step

/** Menger curvature at b, from three consecutive points (1/radius, in 1/m). */
function curvatureAt(
  a: { x: number; y: number },
  b: { x: number; y: number },
  c: { x: number; y: number },
): number {
  const ab = Math.hypot(b.x - a.x, b.y - a.y);
  const bc = Math.hypot(c.x - b.x, c.y - b.y);
  const ca = Math.hypot(a.x - c.x, a.y - c.y);
  if (ab < 1e-6 || bc < 1e-6 || ca < 1e-6) return 0;
  // 2 * triangle area / (|ab| |bc| |ca|)
  const cross = (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
  return Math.abs(2 * cross) / (ab * bc * ca);
}

/** Point at arc-length `s` along a polyline (clamped). */
function pointAtArc(poly: ReadonlyArray<{ x: number; y: number }>, s: number): { x: number; y: number } {
  if (poly.length === 0) return { x: 0, y: 0 };
  let acc = 0;
  for (let i = 0; i + 1 < poly.length; i += 1) {
    const a = poly[i]!;
    const b = poly[i + 1]!;
    const seg = Math.hypot(b.x - a.x, b.y - a.y);
    if (acc + seg >= s) {
      const t = seg < 1e-9 ? 0 : (s - acc) / seg;
      return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t };
    }
    acc += seg;
  }
  return poly[poly.length - 1]!;
}

/**
 * The run-up distance (m) whose traversal takes exactly `arrivalTimeS` under the subject's real
 * speed profile along `polyline` up to `conflictArc`. Falls back to the constant-speed
 * distance when the geometry is unusable.
 */
function subjectRunUpDistanceForArrival(
  polyline: ReadonlyArray<{ x: number; y: number }>,
  conflictArc: number,
  subjectSpeedKph: number,
  arrivalTimeS: number,
): number {
  const cruise = subjectSpeedKph / 3.6;
  const constantSpeedDistance = cruise * arrivalTimeS;
  if (!Number.isFinite(conflictArc) || conflictArc <= 0 || polyline.length < 3) {
    return constantSpeedDistance;
  }

  // Sample the approach [0, conflictArc] at PROFILE_STEP_M and take the curvature-limited
  // speed at each sample.
  const n = Math.max(3, Math.ceil(conflictArc / PROFILE_STEP_M) + 1);
  const ds = conflictArc / (n - 1);
  const v: number[] = new Array(n);
  for (let i = 0; i < n; i += 1) {
    const s = i * ds;
    const a = pointAtArc(polyline, Math.max(0, s - ds));
    const b = pointAtArc(polyline, s);
    const c = pointAtArc(polyline, Math.min(conflictArc, s + ds));
    const kappa = curvatureAt(a, b, c);
    const vCurve = kappa > 1e-6 ? Math.sqrt(A_LAT_MAX_MPS2 / kappa) : cruise;
    v[i] = Math.min(cruise, Math.max(V_MIN_TURN_MPS, vCurve));
  }
  // Backward pass: the subject must be able to BRAKE down to whatever is coming.
  for (let i = n - 2; i >= 0; i -= 1) {
    const reachable = Math.sqrt(v[i + 1]! * v[i + 1]! + 2 * A_BRAKE_MPS2 * ds);
    v[i] = Math.min(v[i]!, reachable);
  }

  // Walk BACKWARD from the conflict, accumulating time, until we have spent arrivalTimeS.
  let t = 0;
  let dist = 0;
  for (let i = n - 1; i >= 1; i -= 1) {
    const vSeg = Math.max(V_MIN_TURN_MPS, 0.5 * (v[i]! + v[i - 1]!));
    const dt = ds / vSeg;
    if (t + dt >= arrivalTimeS) {
      dist += (arrivalTimeS - t) * vSeg; // partial step
      return dist;
    }
    t += dt;
    dist += ds;
  }
  // The modelled approach is shorter than arrivalTimeS of driving: the remaining time is
  // spent at cruise on the straight road upstream of the polyline.
  return dist + (arrivalTimeS - t) * cruise;
}


function planUnprotectedLeftTurn(
  graph: LaneGraph,
  geometry: GeometryReport,
  approachGeometries: readonly GeometryReport[],
  subjectSpeedKph: number,
  npcSpeedKph: number,
  arrivalTimeS: number,
): PlannedCollision | null {
  const subject = pickSubjectApproachLane(graph, geometry, approachGeometries);
  if (!subject) return null;
  const npc = pickOpposingApproachLane(graph, subject, geometry);
  if (!npc) return null;

  // Walk subject forward through the junction with a left-turn-preferring
  // successor picker. Distance: subject's approach length + a generous buffer
  // to cross the junction interior (~30 m typical).
  const subjectForward = walkForward(
    graph,
    { laneId: subject.id, sFraction: 0.5 },
    subject.length_m + 60,
    {
      samplingM: SAMPLING_M,
      pickSuccessor: leftTurnSuccessorPicker,
    },
  );
  if (!subjectForward) return null;
  const npcForward = walkForward(
    graph,
    { laneId: npc.id, sFraction: 0.5 },
    npc.length_m + 60,
    { samplingM: SAMPLING_M },
  );
  if (!npcForward) return null;

  const conflict = findPolylineConflict(subjectForward.forwardPolyline, npcForward.forwardPolyline);
  if (!conflict) return null;

  // Where must the subject START so that it REACHES the conflict at arrivalTimeS, given that it
  // decelerates through the turn? Solved from the real path geometry (see
  // subjectRunUpDistanceForArrival) — not `speed x time`, which assumed a corner taken at
  // full cruise and made the subject arrive ~25% late, after the NPC had already gone through.
  const subjectBackwardDistanceM = subjectRunUpDistanceForArrival(
    subjectForward.forwardPolyline,
    conflict.subjectArc,
    subjectSpeedKph,
    arrivalTimeS,
  );
  const npcBackwardDistanceM = (npcSpeedKph * arrivalTimeS) / 3.6;

  const subjectConflictPosition = positionOnLaneAtArcFromForwardPath(
    subjectForward.laneSequence,
    conflict.subjectArc,
    0.5,
  );
  const npcConflictPosition = positionOnLaneAtArcFromForwardPath(
    npcForward.laneSequence,
    conflict.npcArc,
    0.5,
  );
  if (!subjectConflictPosition || !npcConflictPosition) return null;

  const subjectPlan = buildPlannedActorFromBackwardWalk(
    graph,
    subjectConflictPosition,
    subjectBackwardDistanceM,
    subjectSpeedKph,
    conflict.point,
  );
  const npcPlan = buildPlannedActorFromBackwardWalk(
    graph,
    npcConflictPosition,
    npcBackwardDistanceM,
    npcSpeedKph,
    conflict.point,
  );
  if (!subjectPlan || !npcPlan) return null;

  return {
    conflictPoint: conflict.point,
    arrivalTimeS,
    subject: subjectPlan,
    npc: npcPlan,
    rationale: `Unprotected left turn — subject on ${subject.id} → conflict at (${conflict.point.x.toFixed(1)}, ${conflict.point.y.toFixed(1)}) vs NPC on ${npc.id}; arrival ${arrivalTimeS.toFixed(1)}s.`,
  };
}

/**
 * Unsafe cut-in. Subject is on a multi-lane arterial; NPC starts in the
 * adjacent same-direction lane and crosses into subject's lane just ahead of
 * subject. No junction crossing required.
 */
function planUnsafeCutIn(
  graph: LaneGraph,
  geometry: GeometryReport,
  approachGeometries: readonly GeometryReport[],
  subjectSpeedKph: number,
  npcSpeedKph: number,
  arrivalTimeS: number,
  npcVehicleType: "car" | "bicycle" | "motorcycle" | null,
  // Near-miss families delay only the subject leg: the NPC still owns the
  // conflict point at `arrivalTimeS`, so a late subject arrives to a cleanly
  // vacated gap of ~subjectSpeed x lead metres instead of a contact.
  subjectArrivalTimeS: number = arrivalTimeS,
): PlannedCollision | null {
  const subject = pickSubjectApproachLane(graph, geometry, approachGeometries);
  if (!subject) return null;
  const adjacent = pickAdjacentLaneNode(graph, subject, npcVehicleType);
  if (!adjacent) return null;

  // Straight approach (no turn) — the subject really does hold cruise, so speed x time is exact.
  const subjectBackwardDistanceM = (subjectSpeedKph * subjectArrivalTimeS) / 3.6;
  // NPC pre-change segment runs adjacent up to t_change_start.
  const tChangeStart = Math.max(0, arrivalTimeS - CUT_IN_LANE_CHANGE_SECONDS);
  const npcPreDistanceM = (npcSpeedKph * tChangeStart) / 3.6;

  // Conflict point: project the document center onto subject's lane when it's
  // a street doc (most cut-ins are anchored to a street); fall back to
  // subject's mid-lane when the projection lies outside the lane.
  let conflictSFraction = 0.5;
  if (geometry.documentCenter) {
    const projection = projectPointOntoLanePolyline(subject, geometry.documentCenter);
    if (projection.sFraction > 0.1 && projection.sFraction < 0.9) {
      conflictSFraction = projection.sFraction;
    }
  }
  const conflictAt = pointOnLane(subject, conflictSFraction);
  const conflictWorld = { x: conflictAt.x, y: conflictAt.y };
  const conflictPosition: LanePosition = { laneId: subject.id, sFraction: conflictSFraction };

  const subjectPlan = buildPlannedActorFromBackwardWalk(
    graph,
    conflictPosition,
    subjectBackwardDistanceM,
    subjectSpeedKph,
    conflictWorld,
  );
  if (!subjectPlan) return null;

  // NPC: walk back from the adjacent-lane projection of the conflict point
  // by npcPreDistanceM, then append a lane-change polyline.
  const adjacentProjection = projectPointOntoLanePolyline(adjacent, conflictWorld);
  const adjacentChangeStartPosition: LanePosition = {
    laneId: adjacent.id,
    sFraction: adjacentProjection.sFraction,
  };
  const npcBackward = walkBack(graph, adjacentChangeStartPosition, npcPreDistanceM, SAMPLING_M);
  if (!npcBackward) return null;
  const changeStartPoint = adjacentProjection.point;
  // Concatenate: spawn → adjacentPolyline → changeStartPoint → conflictPoint
  const npcWaypoints: Array<{ x: number; y: number }> = [];
  for (const p of npcBackward.forwardPolyline) {
    const last = npcWaypoints[npcWaypoints.length - 1];
    if (!last || last.x !== p.x || last.y !== p.y) npcWaypoints.push(p);
  }
  const lastNpc = npcWaypoints[npcWaypoints.length - 1];
  if (!lastNpc || lastNpc.x !== changeStartPoint.x || lastNpc.y !== changeStartPoint.y) {
    npcWaypoints.push({ x: changeStartPoint.x, y: changeStartPoint.y });
  }
  npcWaypoints.push(conflictWorld);
  const npcArcLength =
    npcBackward.arcLengthM + Math.hypot(conflictWorld.x - changeStartPoint.x, conflictWorld.y - changeStartPoint.y);

  return {
    conflictPoint: conflictWorld,
    arrivalTimeS,
    subject: subjectPlan,
    npc: {
      spawnLaneId: npcBackward.spawn.laneId,
      spawnSFraction: floorSFraction(npcBackward.spawn.sFraction),
      spawnPoint: npcBackward.spawnPoint,
      spawnYaw: npcBackward.spawnYaw,
      waypoints: npcWaypoints,
      expectedSpeedKph: npcSpeedKph,
      arcLengthM: npcArcLength,
    },
    rationale: `Unsafe cut-in — subject on ${subject.id}, NPC starts on adjacent lane ${adjacent.id}, conflict at (${conflictWorld.x.toFixed(1)}, ${conflictWorld.y.toFixed(1)}); cut-in arc ${CUT_IN_LANE_CHANGE_SECONDS}s.`,
  };
}

/**
 * Rear-end. Subject and a faster trailing vehicle share the same lane; the
 * trailing car closes on subject (which slows/stops at the conflict point).
 * No junction, no lane change — both ride the same polyline, so the
 * "route" is just a shared lane with the trailing car spawned further
 * back (its higher speed × the same arrival time ⇒ more backward arc).
 * The actual contact is CARLA's longitudinal dynamics; this only places
 * the two actors so the kinematic check sees them converge.
 */
function planRearEnd(
  graph: LaneGraph,
  geometry: GeometryReport,
  approachGeometries: readonly GeometryReport[],
  subjectSpeedKph: number,
  trailingSpeedKph: number,
  arrivalTimeS: number,
): PlannedCollision | null {
  const subject = pickSubjectApproachLane(graph, geometry, approachGeometries);
  if (!subject) return null;

  let conflictSFraction = 0.6;
  if (geometry.documentCenter) {
    const projection = projectPointOntoLanePolyline(subject, geometry.documentCenter);
    if (projection.sFraction > 0.1 && projection.sFraction < 0.9) {
      conflictSFraction = projection.sFraction;
    }
  }
  const conflictAt = pointOnLane(subject, conflictSFraction);
  const conflictWorld = { x: conflictAt.x, y: conflictAt.y };
  const conflictPosition: LanePosition = { laneId: subject.id, sFraction: conflictSFraction };

  const subjectPlan = buildPlannedActorFromBackwardWalk(
    graph,
    conflictPosition,
    (subjectSpeedKph * arrivalTimeS) / 3.6,
    subjectSpeedKph,
    conflictWorld,
  );
  const trailingPlan = buildPlannedActorFromBackwardWalk(
    graph,
    conflictPosition,
    (trailingSpeedKph * arrivalTimeS) / 3.6,
    trailingSpeedKph,
    conflictWorld,
  );
  if (!subjectPlan || !trailingPlan) return null;

  return {
    conflictPoint: conflictWorld,
    arrivalTimeS,
    subject: subjectPlan,
    npc: trailingPlan,
    rationale:
      `Rear-end — subject + trailing share lane ${subject.id}; trailing ` +
      `(${trailingSpeedKph} kph) closes on subject (${subjectSpeedKph} kph) at ` +
      `(${conflictWorld.x.toFixed(1)}, ${conflictWorld.y.toFixed(1)}); ` +
      `arrival ${arrivalTimeS.toFixed(1)}s.`,
  };
}

/**
 * Pedestrian crossing. Subject drives along its approach lane; walker crosses
 * perpendicular at the point where the document projects onto subject's lane.
 * The walker side returns a separate `PlannedWalker` because walker drafts
 * use `placement_mode: "timed_path"` rather than `path`.
 */
function planPedestrianCrossing(
  graph: LaneGraph,
  geometry: GeometryReport,
  approachGeometries: readonly GeometryReport[],
  subjectSpeedKph: number,
  arrivalTimeS: number,
  // Near-miss: walker timing stays solved against `arrivalTimeS`; only the
  // subject leg is stretched, so the walker has cleared the lane on arrival.
  subjectArrivalTimeS: number = arrivalTimeS,
): { collision: PlannedCollision; walker: PlannedWalker } | null {
  const subject = pickSubjectApproachLane(graph, geometry, approachGeometries);
  if (!subject) return null;
  const center = geometry.documentCenter;
  if (!center) return null;

  const projection = projectPointOntoLanePolyline(subject, center);
  const conflictWorld = projection.point;
  // Primary design: back-calculate BOTH actors to the same planned
  // time-of-impact (`arrivalTimeS`, the uniform TARGET_COLLISION_TIME_S).
  // Subject back-walks `subjectSpeed · arrivalTimeS` to its spawn; the walker's
  // curb-hold is solved so it reaches the lane centreline (the conflict
  // point) exactly at `arrivalTimeS`. It crosses the centre half-way
  // through its WALKER_CROSSING_DURATION_S traversal, so:
  //   hold + CROSS/2 = arrivalTimeS  ⇒  hold = arrivalTimeS − CROSS/2
  // (This makes the Tier-2 timing-solve repair redundant on this path.)
  const reconciledArrivalTimeS = arrivalTimeS;
  // Straight approach to the crosswalk — the subject holds cruise; speed x time is exact.
  const subjectBackwardDistanceM = (subjectSpeedKph * subjectArrivalTimeS) / 3.6;
  const timeToCentreS = WALKER_CROSSING_DURATION_S / 2;
  const walkerHoldS = Math.max(0, reconciledArrivalTimeS - timeToCentreS);

  const conflictPosition: LanePosition = { laneId: subject.id, sFraction: projection.sFraction };
  const subjectPlan = buildPlannedActorFromBackwardWalk(
    graph,
    conflictPosition,
    subjectBackwardDistanceM,
    subjectSpeedKph,
    conflictWorld,
  );
  if (!subjectPlan) return null;

  // Walker: spawn on the document-center side of the lane, walk
  // perpendicular across to the far curb.
  const subjectEndYaw = pointOnLane(subject, projection.sFraction).yaw;
  const perpX = -Math.sin(subjectEndYaw);
  const perpY = Math.cos(subjectEndYaw);
  // Side selection: which side of the lane the document center sits on.
  const dx = center.x - conflictWorld.x;
  const dy = center.y - conflictWorld.y;
  const side = dx * perpX + dy * perpY >= 0 ? 1 : -1;
  const start = {
    x: conflictWorld.x + perpX * PEDESTRIAN_CROSSING_HALF_WIDTH_M * side,
    y: conflictWorld.y + perpY * PEDESTRIAN_CROSSING_HALF_WIDTH_M * side,
  };
  const end = {
    x: conflictWorld.x - perpX * PEDESTRIAN_CROSSING_HALF_WIDTH_M * side,
    y: conflictWorld.y - perpY * PEDESTRIAN_CROSSING_HALF_WIDTH_M * side,
  };
  const walker: PlannedWalker = {
    spawnPoint: start,
    waypoints: [
      { x: start.x, y: start.y, time: 0 },
      { x: start.x, y: start.y, time: walkerHoldS },
      { x: end.x, y: end.y, time: walkerHoldS + WALKER_CROSSING_DURATION_S },
    ],
    rationale: `Walker holds ${walkerHoldS.toFixed(1)}s (solved from subject ETA) then crosses ${PEDESTRIAN_CROSSING_HALF_WIDTH_M * 2}m over ${WALKER_CROSSING_DURATION_S}s — mid-crossing at the planned ${reconciledArrivalTimeS.toFixed(1)}s.`,
  };

  return {
    collision: {
      conflictPoint: conflictWorld,
      arrivalTimeS: reconciledArrivalTimeS,
      subject: subjectPlan,
      npc: subjectPlan, // walker is the NPC, but it's surfaced separately
      rationale: `Pedestrian crossing — subject on ${subject.id}, walker crosses ${(PEDESTRIAN_CROSSING_HALF_WIDTH_M * 2).toFixed(0)}m perpendicular at projection (sFraction=${projection.sFraction.toFixed(2)}).`,
    },
    walker,
  };
}

// ── Helpers used by all solvers ─────────────────────────────────────────────

/**
 * Given a forward-walk's lane sequence and the walk's start sFraction on
 * `laneSequence[0]`, find the (laneId, sFraction) that lies
 * `arcLengthFromStart` meters along the walked polyline.
 */
export function positionOnLaneAtArcFromForwardPath(
  laneSequence: readonly LaneNode[],
  arcLengthFromStart: number,
  startSFraction: number,
): LanePosition | null {
  if (laneSequence.length === 0) return null;
  let consumedArc = 0;
  for (let i = 0; i < laneSequence.length; i++) {
    const node = laneSequence[i]!;
    const startS = i === 0 ? startSFraction : 0;
    const remainingOnThisLane = (1 - startS) * node.length_m;
    if (consumedArc + remainingOnThisLane >= arcLengthFromStart) {
      const within = arcLengthFromStart - consumedArc;
      const sFraction = Math.max(0, Math.min(1, startS + within / node.length_m));
      return { laneId: node.id, sFraction };
    }
    consumedArc += remainingOnThisLane;
  }
  const last = laneSequence[laneSequence.length - 1]!;
  return { laneId: last.id, sFraction: 1 };
}

export function buildPlannedActorFromBackwardWalk(
  graph: LaneGraph,
  startPosition: LanePosition,
  backwardDistanceM: number,
  speedKph: number,
  conflictPoint: { x: number; y: number },
): PlannedActor | null {
  const result = walkBack(graph, startPosition, backwardDistanceM, SAMPLING_M);
  if (!result) return null;
  // Reject when the lane couldn't afford a real run-up. If the backward
  // walk dead-ended far short of the requested distance, the actor would
  // spawn ~on top of the conflict point (the "start in a collided state"
  // bug). A scenario with no run-up is not a valid collision scenario —
  // fail here so Tier-1 / heuristic / the LLM revise loop can recover,
  // rather than emitting a broken draft. (Belt with the validator's
  // t≈0 / mistimed guard.)
  if (
    backwardDistanceM > 0 &&
    result.arcLengthM < backwardDistanceM * MIN_RUNUP_FRACTION
  ) {
    return null;
  }
  const waypoints: Array<{ x: number; y: number }> = [];
  for (const p of result.forwardPolyline) {
    const last = waypoints[waypoints.length - 1];
    if (!last || last.x !== p.x || last.y !== p.y) waypoints.push(p);
  }
  // Ensure the polyline terminates exactly at the conflict point.
  const lastWp = waypoints[waypoints.length - 1];
  if (!lastWp || lastWp.x !== conflictPoint.x || lastWp.y !== conflictPoint.y) {
    waypoints.push({ x: conflictPoint.x, y: conflictPoint.y });
  }
  return {
    spawnLaneId: result.spawn.laneId,
    spawnSFraction: floorSFraction(result.spawn.sFraction),
    spawnPoint: result.spawnPoint,
    spawnYaw: result.spawnYaw,
    waypoints,
    expectedSpeedKph: speedKph,
    arcLengthM: result.arcLengthM,
  };
}

function floorSFraction(s: number): number {
  return Math.max(SPAWN_S_FRACTION_FLOOR, Math.min(1, s));
}

// ── Public API ──────────────────────────────────────────────────────────────

export interface PlanCollisionRoutesResult {
  collision: PlannedCollision;
  /** Present only for pedestrian_crossing. Carries the walker's
   *  `timed_waypoints` polyline. */
  walker: PlannedWalker | null;
}

/**
 * Build a planned collision for the given family + geometry. Returns null
 * when the lane graph can't support the planned trajectory; the caller is
 * expected to degrade to the legacy heuristic placement.
 */
export async function planCollisionRoutes(
  args: PlanCollisionRoutesArgs,
): Promise<PlanCollisionRoutesResult | null> {
  const loaded = await loadLaneGraphAroundDocument(args.geometry);
  if (!loaded) return null;
  const arrivalTimeS = TARGET_COLLISION_TIME_S;
  switch (args.family) {
    case "unprotected_left_turn": {
      const plan = planUnprotectedLeftTurn(
        loaded.graph,
        args.geometry,
        args.approachGeometries,
        args.subjectSpeedKph,
        args.npcSpeedKph,
        arrivalTimeS,
      );
      return plan ? { collision: plan, walker: null } : null;
    }
    case "unsafe_cut_in": {
      const plan = planUnsafeCutIn(
        loaded.graph,
        args.geometry,
        args.approachGeometries,
        args.subjectSpeedKph,
        args.npcSpeedKph,
        arrivalTimeS,
        args.npcVehicleType ?? null,
      );
      return plan ? { collision: plan, walker: null } : null;
    }
    case "pedestrian_crossing": {
      const plan = planPedestrianCrossing(
        loaded.graph,
        args.geometry,
        args.approachGeometries,
        args.subjectSpeedKph,
        arrivalTimeS,
      );
      return plan ? { collision: plan.collision, walker: plan.walker } : null;
    }
    case "near_miss_cut_in": {
      const plan = planUnsafeCutIn(
        loaded.graph,
        args.geometry,
        args.approachGeometries,
        args.subjectSpeedKph,
        args.npcSpeedKph,
        arrivalTimeS,
        args.npcVehicleType ?? null,
        nearMissSubjectArrivalTimeS(args.family, arrivalTimeS),
      );
      return plan ? { collision: plan, walker: null } : null;
    }
    case "near_miss_pedestrian": {
      const plan = planPedestrianCrossing(
        loaded.graph,
        args.geometry,
        args.approachGeometries,
        args.subjectSpeedKph,
        arrivalTimeS,
        nearMissSubjectArrivalTimeS(args.family, arrivalTimeS),
      );
      return plan ? { collision: plan.collision, walker: plan.walker } : null;
    }
    default:
      return null;
  }
}

/**
 * Load the lane graph around a document ONCE so callers can drive many
 * `planCollisionRoutesWithGraph` attempts (e.g. the builder's deterministic
 * speed-tuning auto-repair) without re-reading the central map bundle from
 * S3 per attempt. Returns null when the document has no resolvable center
 * or no nearby segments.
 */
export async function loadCollisionLaneGraph(
  geometry: GeometryReport,
): Promise<LaneGraph | null> {
  const loaded = await loadLaneGraphAroundDocument(geometry);
  return loaded ? loaded.graph : null;
}


function nearMissSubjectArrivalTimeS(
  family: CollisionFamilyId,
  arrivalTimeS: number,
): number {
  const margin = COLLISION_TEMPLATES[family].nearMissMargin;
  return arrivalTimeS + (margin?.conflictLeadTimeS ?? 0);
}

/** Exposed for unit tests so fixtures don't need to round-trip through S3. */
export function planCollisionRoutesWithGraph(
  graph: LaneGraph,
  args: PlanCollisionRoutesArgs,
): PlanCollisionRoutesResult | null {
  const arrivalTimeS = TARGET_COLLISION_TIME_S;
  switch (args.family) {
    case "unprotected_left_turn": {
      const plan = planUnprotectedLeftTurn(
        graph,
        args.geometry,
        args.approachGeometries,
        args.subjectSpeedKph,
        args.npcSpeedKph,
        arrivalTimeS,
      );
      return plan ? { collision: plan, walker: null } : null;
    }
    // Sideswipe is geometrically a same-direction adjacent-lane
    // convergence — identical route construction to a cut-in (the
    // milder lateral contact vs. abrupt cut is a CARLA-dynamics /
    // aggressiveness concern, not a different route).
    case "unsafe_cut_in":
    case "sideswipe": {
      const plan = planUnsafeCutIn(
        graph,
        args.geometry,
        args.approachGeometries,
        args.subjectSpeedKph,
        args.npcSpeedKph,
        arrivalTimeS,
        args.npcVehicleType ?? null,
      );
      return plan ? { collision: plan, walker: null } : null;
    }
    case "rear_end": {
      const plan = planRearEnd(
        graph,
        args.geometry,
        args.approachGeometries,
        args.subjectSpeedKph,
        args.npcSpeedKph,
        arrivalTimeS,
      );
      return plan ? { collision: plan, walker: null } : null;
    }
    case "pedestrian_crossing": {
      const plan = planPedestrianCrossing(
        graph,
        args.geometry,
        args.approachGeometries,
        args.subjectSpeedKph,
        arrivalTimeS,
      );
      return plan ? { collision: plan.collision, walker: plan.walker } : null;
    }
    case "near_miss_cut_in": {
      const plan = planUnsafeCutIn(
        graph,
        args.geometry,
        args.approachGeometries,
        args.subjectSpeedKph,
        args.npcSpeedKph,
        arrivalTimeS,
        args.npcVehicleType ?? null,
        nearMissSubjectArrivalTimeS(args.family, arrivalTimeS),
      );
      return plan ? { collision: plan, walker: null } : null;
    }
    case "near_miss_pedestrian": {
      const plan = planPedestrianCrossing(
        graph,
        args.geometry,
        args.approachGeometries,
        args.subjectSpeedKph,
        arrivalTimeS,
        nearMissSubjectArrivalTimeS(args.family, arrivalTimeS),
      );
      return plan ? { collision: plan.collision, walker: plan.walker } : null;
    }
    default:
      return null;
  }
}
