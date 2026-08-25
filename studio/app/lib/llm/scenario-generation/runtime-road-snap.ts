/**
 * Snap auto-generated draft actors onto CARLA's *runtime* road network.
 *
 * Background: the AI-Search collision builder anchors actors using two
 * geometry sources that are NOT guaranteed to agree with the map CARLA
 * actually loads at simulation time:
 *
 *   - The Tier-0 gated planner sources gate polylines + the conflict point
 *     from the XODR `MapTopologyIndex` (uploaded OpenDRIVE).
 *   - Heuristic / pedestrian placements project points geometrically.
 *
 * CARLA prunes roads when it loads a map (lanes the OpenDRIVE importer
 * drops, disconnected segments, etc.), so a point that is valid in the
 * uploaded XODR can land off every drivable lane CARLA exposes. Such a
 * draft previews fine in the editor but misbehaves in the sim: the actor
 * fails to spawn, gets teleported by `get_waypoint(project_to_road=True)`,
 * or refuses to follow its path.
 *
 * The CARLA-truth road network already lives in the central map bundle:
 * `bundle.runtime.road_segments` is built from the worker's
 * `world.get_map().generate_waypoints()` crawl (see
 * `services/carla-worker/carla_worker/metadata.py::_runtime_map`), i.e. the
 * pruned drivable network. This module snaps explicit SPAWN points onto the
 * nearest runtime lane of the appropriate type, derives anchors from that
 * runtime lane, and rejects the draft when the nearest valid road is
 * implausibly far (the location is genuinely absent from CARLA's runtime map).
 * Road-mode anchors are not repaired: they must already match an exact runtime
 * `road_id`, `section_id`, and `lane_id`. Path geometry is trusted, not
 * re-snapped (see the vehicle PATH note below).
 *
 * Type-aware: vehicles snap to driving/bidirectional lanes; walkers snap to
 * sidewalk (falling back to other walkable lanes). For a pedestrian crossing
 * only the start is snapped onto a walkable surface — the remaining
 * waypoints ARE the road crossing and are left as planned, so snapping
 * doesn't collapse the crossing onto the curb.
 *
 * Vehicle PATH mode: we snap ONLY the spawn onto a drivable runtime lane and
 * then RIGID-TRANSLATE the planner's `path_placement` (+ destination) by the
 * spawn delta. The planner's pre-snap topology path is already smooth and
 * straight on CARLA-runtime-constrained lanes; reshaping it per-point (the old
 * lane-coherent / nearest-vertex snaps) only introduced junction zig-zag and a
 * tail U-turn. Trusting the straight path and translating it rigidly keeps
 * `path_placement[0] == snapped spawn` while preserving the planner geometry
 * exactly.
 */
import "server-only";
import type {
  ScenarioEditorActorDraft,
  ScenarioEditorRoadAnchor,
} from "@simforge/studio-shared";
import type { RuntimeMapResponse } from "@/app/lib/runtime/runtime-types";
import { ScenarioDraftBridgeError } from "@/app/lib/scenario-editor/draft-generator";
import { worldAnchorAtFraction } from "@/app/lib/scenario-editor/batch-scenario-generator/routing";

export type RuntimeRoadSegment = NonNullable<
  RuntimeMapResponse["road_segments"]
>[number];

/**
 * Default ceiling on how far a generated point may be moved to reach the
 * nearest CARLA runtime lane. ~Half a typical urban block — tolerant of
 * XODR-vs-CARLA sampling drift without teleporting an actor across the
 * map. Beyond this the location is treated as absent from CARLA's loaded
 * map and the draft is rejected rather than snapped. Overridable via
 * `CARLA_AUTOGEN_SNAP_MAX_DISTANCE_M` for maps with coarse waypoint
 * sampling.
 */
const DEFAULT_MAX_SNAP_DISTANCE_M = 25;

/** Lane types a vehicle may spawn / drive on. */
const DRIVABLE_LANE_TYPES = new Set(["driving", "bidirectional"]);

interface RoadVertex {
  x: number;
  y: number;
  /** Centerline elevation at this vertex (0 when the bundle omits z). */
  z: number;
  /** Lane heading at this vertex, degrees, frontend/runtime frame (0 → +x). */
  yawDeg: number;
  s: number;
  segIndex: number;
}

interface SegmentMeta {
  road_id: number;
  section_id: number;
  lane_id: number;
  lane_type: string;
  minS: number;
  maxS: number;
  /** The source runtime segment (kept by reference for world_anchor stamping). */
  source: RuntimeRoadSegment;
}

interface RuntimeRoadIndex {
  vertices: RoadVertex[];
  segments: SegmentMeta[];
}

export interface SnapDraftOptions {
  maxSnapDistanceM?: number;
}

export interface SnapDraftSummary {
  /** Distinct actors that had at least one point moved. */
  snappedActorCount: number;
  /** Total individual points (spawn / waypoints / destination) moved. */
  pointsSnapped: number;
  /** Largest single move applied, in meters. */
  maxSnapDistanceM: number;
  /** Effective rejection threshold used. */
  thresholdM: number;
}

function resolveMaxSnapDistanceM(options?: SnapDraftOptions): number {
  if (options?.maxSnapDistanceM != null && Number.isFinite(options.maxSnapDistanceM)) {
    return options.maxSnapDistanceM;
  }
  const env = Number.parseFloat(process.env.CARLA_AUTOGEN_SNAP_MAX_DISTANCE_M ?? "");
  return Number.isFinite(env) && env > 0 ? env : DEFAULT_MAX_SNAP_DISTANCE_M;
}

function buildRuntimeRoadIndex(
  roadSegments: readonly RuntimeRoadSegment[],
): RuntimeRoadIndex {
  const vertices: RoadVertex[] = [];
  const segments: SegmentMeta[] = [];
  for (const seg of roadSegments) {
    const centerline = seg.centerline ?? [];
    if (centerline.length === 0) continue;
    const segIndex = segments.length;
    let minS = Number.POSITIVE_INFINITY;
    let maxS = Number.NEGATIVE_INFINITY;
    for (const p of centerline) {
      if (!Number.isFinite(p.x) || !Number.isFinite(p.y)) continue;
      const s = Number.isFinite(p.s) ? p.s : 0;
      if (s < minS) minS = s;
      if (s > maxS) maxS = s;
      vertices.push({
        x: p.x,
        y: p.y,
        z: Number.isFinite(p.z) ? (p.z as number) : 0,
        // Runtime centerline yaw is in DEGREES (CARLA Transform.Rotation.yaw).
        yawDeg: Number.isFinite(p.yaw) ? p.yaw : 0,
        s,
        segIndex,
      });
    }
    segments.push({
      road_id: seg.road_id,
      section_id: seg.section_id,
      lane_id: seg.lane_id,
      lane_type: (seg.lane_type ?? "").toLowerCase() || "unknown",
      minS: Number.isFinite(minS) ? minS : 0,
      maxS: Number.isFinite(maxS) ? maxS : 0,
      source: seg,
    });
  }
  return { vertices, segments };
}

function distance(ax: number, ay: number, bx: number, by: number): number {
  const dx = ax - bx;
  const dy = ay - by;
  return Math.sqrt(dx * dx + dy * dy);
}

interface NearestResult {
  vertex: RoadVertex;
  segment: SegmentMeta;
  distanceM: number;
}

/**
 * Nearest runtime-road vertex to `point` whose lane type is in `allowed`.
 * Linear scan — the number of snapped points per draft is a handful and the
 * index is built once, so the O(points × vertices) cost is immaterial next
 * to the surrounding S3 + DB work.
 */
function nearestVertex(
  index: RuntimeRoadIndex,
  point: { x: number; y: number },
  allowed: Set<string>,
): NearestResult | null {
  let best: NearestResult | null = null;
  for (const v of index.vertices) {
    const seg = index.segments[v.segIndex]!;
    if (!allowed.has(seg.lane_type)) continue;
    const d = distance(point.x, point.y, v.x, v.y);
    if (!best || d < best.distanceM) {
      best = { vertex: v, segment: seg, distanceM: d };
    }
  }
  return best;
}

/**
 * Project `point` onto the polyline `centerline`, returning the closest point
 * ON the line. The nearest-VERTEX snap quantizes along-track by up to half the
 * vertex spacing; because the spawn delta is applied RIGIDLY to the whole
 * authored path, that along-track error rotates into a PURE LATERAL offset
 * once the path turns (avoided-left r10/r11: the post-turn tail ran a constant
 * ~2m off the exit-lane centerline — dib: "doesn't turn into the closest
 * lane"). Projection keeps only the true cross-track correction.
 */
function projectOntoCenterline(
  point: { x: number; y: number },
  centerline: ReadonlyArray<{ x: number; y: number }>,
): { x: number; y: number } | null {
  if (centerline.length < 2) return null;
  let best: { x: number; y: number; d2: number } | null = null;
  for (let i = 1; i < centerline.length; i += 1) {
    const a = centerline[i - 1]!;
    const b = centerline[i]!;
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const L2 = dx * dx + dy * dy;
    if (L2 < 1e-12) continue;
    const t = Math.max(0, Math.min(1, ((point.x - a.x) * dx + (point.y - a.y) * dy) / L2));
    const px = a.x + t * dx;
    const py = a.y + t * dy;
    const d2 = (point.x - px) ** 2 + (point.y - py) ** 2;
    if (!best || d2 < best.d2) best = { x: px, y: py, d2 };
  }
  return best ? { x: best.x, y: best.y } : null;
}

function sFractionForVertex(vertex: RoadVertex, segment: SegmentMeta): number {
  const span = segment.maxS - segment.minS;
  if (span <= 0) return 0.5;
  return Math.min(1, Math.max(0, (vertex.s - segment.minS) / span));
}

function anchorFromNearest(result: NearestResult): ScenarioEditorRoadAnchor {
  return {
    road_id: String(result.segment.road_id),
    s_fraction: sFractionForVertex(result.vertex, result.segment),
    lane_id: result.segment.lane_id,
    section_id: result.segment.section_id,
    // Additive geometry so the UE5/0.10 worker can resolve the anchor even
    // when the runtime RENUMBERS road ids vs the bundle (a road_id lookup
    // that "succeeds" can land on a different physical road and spawn the
    // actor inside geometry — belmont collision subjects, 2026-07-06). The
    // snapped vertex IS the intended world position; UE4/0.9 ignores it.
    world_anchor: {
      x: result.vertex.x,
      y: result.vertex.y,
      z: result.vertex.z,
      yaw: result.vertex.yawDeg,
    },
  };
}

function normalizeDeg(deg: number): number {
  return ((((deg + 180) % 360) + 360) % 360) - 180;
}

function yawDegBetween(
  from: { x: number; y: number },
  to: { x: number; y: number },
): number | null {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  if (dx === 0 && dy === 0) return null;
  return normalizeDeg((Math.atan2(dy, dx) * 180) / Math.PI);
}

function actorNoun(actor: ScenarioEditorActorDraft): string {
  const role = actor.role === "subject" ? "subject" : actor.role;
  return `${role} ${actor.kind}`;
}

/** Tracks per-call snap statistics + raises the rejection error. */
class SnapSession {
  snappedActors = new Set<string>();
  pointsSnapped = 0;
  maxSnapDistanceM = 0;

  constructor(
    readonly index: RuntimeRoadIndex,
    readonly thresholdM: number,
  ) {}

  /**
   * Snap a required point: rejects the whole draft when the nearest valid
   * lane is past the threshold. Returns the chosen lane so callers can
   * re-anchor / re-derive heading.
   */
  snapRequired(
    actor: ScenarioEditorActorDraft,
    point: { x: number; y: number },
    allowed: Set<string>,
    label: string,
  ): NearestResult {
    const nearest = nearestVertex(this.index, point, allowed);
    if (!nearest) {
      throw new ScenarioDraftBridgeError(
        "location_off_runtime_road",
        `The map CARLA loads has no ${[...allowed].join("/")} lane to place the ${actorNoun(
          actor,
        )} (${label}). Pick a junction or street that exists in the CARLA map.`,
      );
    }
    if (nearest.distanceM > this.thresholdM) {
      throw new ScenarioDraftBridgeError(
        "location_off_runtime_road",
        `The generated ${actorNoun(actor)} ${label} is ~${nearest.distanceM.toFixed(
          0,
        )}m from the nearest road CARLA actually loads for this map — the uploaded map includes roads CARLA prunes at runtime, so this spot can't be simulated. Pick a location closer to a drivable road in the CARLA map, or a different junction/street.`,
      );
    }
    this.record(actor, nearest);
    return nearest;
  }

  record(actor: ScenarioEditorActorDraft, nearest: NearestResult): void {
    if (nearest.distanceM <= 1e-6) return;
    this.snappedActors.add(actor.id);
    this.pointsSnapped += 1;
    if (nearest.distanceM > this.maxSnapDistanceM) {
      this.maxSnapDistanceM = nearest.distanceM;
    }
  }
}

function snapVehicle(
  actor: ScenarioEditorActorDraft,
  index: RuntimeRoadIndex,
  session: SnapSession,
): void {
  // Timed-path / point placements carry an explicit spawn_point plus optional
  // timed_waypoints.
  //
  // We snap ONLY the spawn onto a drivable runtime lane, then RIGID-TRANSLATE
  // the rest of the authored geometry by the spawn delta. The planner's
  // pre-snap topology path is already smooth and straight on
  // CARLA-runtime-constrained lanes; per-point snapping (the old lane-coherent
  // / nearest-vertex code) only introduced junction zig-zag + a tail U-turn. A
  // rigid translation preserves that geometry exactly while pinning the path
  // start onto the snapped spawn.
  if (actor.spawn_point) {
    const original = { x: actor.spawn_point.x, y: actor.spawn_point.y };
    // Snap the spawn (required): rejects the whole draft when the nearest
    // drivable lane is past the threshold.
    const spawnNearest = session.snapRequired(
      actor,
      original,
      DRIVABLE_LANE_TYPES,
      "spawn",
    );
    // Refine the vertex snap by projecting onto the lane centerline: the delta
    // below is applied rigidly to the whole path, so any ALONG-TRACK component
    // (vertex quantization, up to half the vertex spacing) rotates into a
    // lateral offset after a turn — the subject then exits the junction riding the
    // lane boundary instead of the centerline. Projection keeps the delta
    // cross-track only.
    const projected = projectOntoCenterline(
      original,
      spawnNearest.segment.source.centerline ?? [],
    );
    const snapPos = projected ?? { x: spawnNearest.vertex.x, y: spawnNearest.vertex.y };
    actor.spawn_point = { x: snapPos.x, y: snapPos.y };
    actor.spawn = anchorFromNearest(spawnNearest);
    // The world anchor must be the intended world position (the 0.10 worker
    // resolves it directly); keep z/yaw from the vertex, position from the
    // projection.
    if (actor.spawn?.world_anchor) {
      actor.spawn.world_anchor.x = snapPos.x;
      actor.spawn.world_anchor.y = snapPos.y;
    }

    // Spawn snap delta — applied rigidly to the rest of the path geometry.
    const dx = actor.spawn_point.x - original.x;
    const dy = actor.spawn_point.y - original.y;

    if (Array.isArray(actor.path_placement)) {
      // Trust the authored path; do NOT per-point snap it. Translate rigidly
      // so the shape is preserved exactly and the start pins to the spawn.
      actor.path_placement = actor.path_placement.map((p) => ({
        x: p.x + dx,
        y: p.y + dy,
      }));
    }

    if (Array.isArray(actor.timed_waypoints)) {
      actor.timed_waypoints = actor.timed_waypoints.map((p) => ({
        ...p,
        x: p.x + dx,
        y: p.y + dy,
      }));
    }

    if (actor.destination_point) {
      // Destination is a routing hint, translated by the same delta — NOT
      // snapped (a soft destination snap reversed the path tail into a U-turn).
      actor.destination_point = {
        x: actor.destination_point.x + dx,
        y: actor.destination_point.y + dy,
      };
    }

    // Re-derive spawn heading from the translated geometry so the vehicle faces
    // along its (now on-road) path rather than the pre-snap direction. The
    // heading source is the first path point DISTINCT from the (translated)
    // spawn: some builders emit timed_waypoints[0] == spawn (planner contract),
    // where the old `timed_waypoints?.[0]` pick degenerated (zero-length leg →
    // yawDegBetween null) and fell back to the RAW nearest-vertex yaw — which
    // can oppose the travel direction. The worker derives the authored pose yaw
    // from the path's first non-degenerate leg (`_path_vehicle_spawn_yaw`), so
    // scan the same way here (mirrors spawnYawDegFromPlannedPath).
    const headingCandidates: Array<{ x: number; y: number }> = [
      ...(actor.timed_waypoints ?? []),
      ...(actor.path_placement ?? []).slice(1),
      ...(actor.destination_point ? [actor.destination_point] : []),
    ];
    const next =
      headingCandidates.find(
        (p) => p.x !== actor.spawn_point!.x || p.y !== actor.spawn_point!.y,
      ) ?? null;
    const yaw = next ? yawDegBetween(actor.spawn_point, next) : null;
    const travelYawDeg = yaw ?? spawnNearest.vertex.yawDeg;
    actor.spawn_yaw = travelYawDeg;
    // The world anchor and the pose (spawn_yaw) describe the SAME spawn
    // transform, so their yaws must agree. `anchorFromNearest` stamped the RAW
    // stored centerline yaw of the nearest runtime vertex, which can oppose the
    // actor's actual TRAVEL direction (nearest-by-distance vertex on an
    // opposing/adjacent lane, or a lane whose stored yaw disagrees with the
    // planned path). The worker AUTHENTICATES the authored pose yaw against
    // `spawn.world_anchor.yaw` (runner_helpers reason
    // `authenticated_authored_yaw_mismatch`, 90° budget), so a raw stored yaw
    // ~180° off fails the scene at render time even though the pose itself is
    // correct (dirosa pedavoid ped-midblock-2: authored −34.1° vs
    // world_anchor −178.98°, Δ=144.9°). Overwrite with the resolved travel yaw
    // — the exact value the pose uses — so the spec is internally consistent.
    if (actor.spawn?.world_anchor) {
      actor.spawn.world_anchor.yaw = travelYawDeg;
    }
    return;
  }

  // Road placement: the exact runtime anchor is the source of truth. Do not
  // repair stale generated/topology anchors by moving them to another lane.
  validateRoadModeActor(actor, index);
}

function validateRoadModeActor(
  actor: ScenarioEditorActorDraft,
  index: RuntimeRoadIndex,
): void {
  const anchor = actor.spawn;
  const roadId = Number.parseInt(anchor.road_id, 10);
  if (
    Number.isNaN(roadId) ||
    anchor.section_id == null ||
    anchor.lane_id == null
  ) {
    throw new ScenarioDraftBridgeError(
      "runtime_road_anchor_missing_identity",
      `The ${actorNoun(actor)} road anchor must include exact road_id, section_id, and lane_id from runtime.road_segments before it can be simulated.`,
    );
  }
  const exact = index.segments.find(
    (s) =>
      s.road_id === roadId &&
      s.section_id === anchor.section_id &&
      s.lane_id === anchor.lane_id,
  );
  // Only vehicles reach here (walkers are never snapped), so a road-mode
  // anchor must reference a drivable lane.
  if (!exact || !DRIVABLE_LANE_TYPES.has(exact.lane_type)) {
    throw new ScenarioDraftBridgeError(
      "location_off_runtime_road",
      `The ${actorNoun(actor)} road anchor ${anchor.road_id}:${anchor.section_id}:${anchor.lane_id} is not an exact valid runtime lane for this map. Actor road anchors must come from runtime.road_segments, not GeoJSON/generated map data.`,
    );
  }
  // Stamp the additive `world_anchor` (lane-centerline {x,y,z,yaw} at
  // s_fraction) exactly like the nominal generator does: the UE5/0.10 runtime
  // RENUMBERS road ids vs the bundle, so a road_id lookup that "succeeds" can
  // resolve to a different physical road and spawn the actor inside geometry
  // (belmont collision subjects: 5/9 deterministic spawn_collision, 2026-07-06).
  // The worker's geometry-primary resolver prefers world_anchor on carla_ue5;
  // UE4/0.9 ignores it. Additive only — road ids stay untouched.
  const worldAnchor = worldAnchorAtFraction(exact.source, anchor.s_fraction);
  if (worldAnchor) actor.spawn = { ...anchor, world_anchor: worldAnchor };
}

/**
 * Snap every actor in `actors` onto CARLA's runtime road network in place.
 *
 * Throws `ScenarioDraftBridgeError("location_off_runtime_road")` when a
 * required spawn / path point is farther than the threshold from any valid
 * runtime lane — the LLM service surfaces this so the agent picks a
 * different location. Returns a summary for the draft notes.
 *
 * Missing or empty runtime road data is a hard validation failure. Generated
 * scenarios must not rely on worker projection, GeoJSON, generated roads, or
 * guessed road ids for actor road anchors.
 */
export function snapDraftActorsToRuntimeRoads(
  actors: ScenarioEditorActorDraft[],
  roadSegments: readonly RuntimeRoadSegment[],
  options?: SnapDraftOptions,
): SnapDraftSummary {
  const thresholdM = resolveMaxSnapDistanceM(options);
  if (roadSegments.length === 0) {
    throw new ScenarioDraftBridgeError(
      "runtime_road_data_missing",
      "CARLA runtime road data is missing for this map. Generated actor spawns and routes must be validated against runtime.road_segments before simulation.",
    );
  }
  const index = buildRuntimeRoadIndex(roadSegments);
  if (index.vertices.length === 0) {
    throw new ScenarioDraftBridgeError(
      "runtime_road_data_missing",
      "CARLA runtime road data for this map has no usable lane vertices. Generated actor spawns and routes must be validated against runtime.road_segments before simulation.",
    );
  }

  const session = new SnapSession(index, thresholdM);
  for (const actor of actors) {
    // Walkers are NEVER snapped: the planner already places them on real
    // sidewalk/crosswalk geometry (the crossing-line resolver), and CARLA/esmini
    // spawn pedestrians by world coordinate — snapping would drag the walker onto
    // a (sidewalk-sparse) runtime driving lane and desync the crossing. Only
    // vehicles snap; props are placed deliberately and are not road-bound.
    if (actor.kind === "vehicle") snapVehicle(actor, index, session);
  }

  return {
    snappedActorCount: session.snappedActors.size,
    pointsSnapped: session.pointsSnapped,
    maxSnapDistanceM: Math.round(session.maxSnapDistanceM * 10) / 10,
    thresholdM,
  };
}
