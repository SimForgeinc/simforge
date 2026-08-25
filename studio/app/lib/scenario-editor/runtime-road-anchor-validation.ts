import type {
  ScenarioEditorActorDraft,
  ScenarioEditorRoadAnchor,
} from "@simforge/studio-shared";
import type { RuntimeRoadOverlayCollection } from "@/app/lib/editor-map/types";
import type { RuntimeLaneTypeId } from "@/app/lib/editor-map/runtime-layer-visibility";
import type { RuntimeMapResponse } from "@/app/lib/runtime/runtime-types";
import { worldAnchorAtFraction } from "@/app/lib/scenario-editor/batch-scenario-generator/routing";

export class RuntimeRoadAnchorValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RuntimeRoadAnchorValidationError";
  }
}

type RuntimeAnchorValidationOptions = {
  contextLabel?: string;
};

export const VEHICLE_RUNTIME_LANE_TYPE_IDS = [
  "driving",
  "bidirectional",
] as const satisfies readonly RuntimeLaneTypeId[];
export const WALKER_RUNTIME_LANE_TYPE_IDS = [
  "sidewalk",
  "shoulder",
  "parking",
  "biking",
  "driving",
  "bidirectional",
] as const satisfies readonly RuntimeLaneTypeId[];

const VEHICLE_RUNTIME_LANE_TYPES = new Set<string>(
  VEHICLE_RUNTIME_LANE_TYPE_IDS,
);
const WALKER_RUNTIME_LANE_TYPES = new Set<string>(WALKER_RUNTIME_LANE_TYPE_IDS);

type RuntimeRoadAnchorRecord = {
  laneType: string;
  segment?: NonNullable<RuntimeMapResponse["road_segments"]>[number];
};

const DURABLE_WORLD_ANCHOR_DECIMAL_PLACES = 6;

function durableWorldAnchor(
  anchor: NonNullable<ScenarioEditorRoadAnchor["world_anchor"]>,
): NonNullable<ScenarioEditorRoadAnchor["world_anchor"]> {
  const round = (value: number) =>
    Number(value.toFixed(DURABLE_WORLD_ANCHOR_DECIMAL_PLACES));
  return {
    x: round(anchor.x),
    y: round(anchor.y),
    z: round(anchor.z),
    yaw: round(anchor.yaw),
  };
}

function normalizeRuntimeLaneType(laneType: unknown): string {
  return String(laneType ?? "").trim().toLowerCase() || "unknown";
}

function normalizeYawDegrees(yaw: number): number {
  const wrapped = ((yaw % 360) + 360) % 360;
  return wrapped > 180 ? wrapped - 360 : wrapped;
}

/**
 * Facing yaw for a re-stamped road anchor.
 *
 * `spawn.world_anchor.yaw` and `spawn_yaw` describe the SAME spawn transform, so
 * their yaws must agree (runtime-road-snap.ts:423; the preview publishes the
 * anchor's yaw verbatim as the spawn pose in corridor-geometry.server.ts:1063).
 * The worker enforces that agreement twice — at the job boundary
 * (validation.py `_validate_actor`, 90 degree budget) and again at spawn
 * (runner_helpers `authenticated_authored_yaw_mismatch`).
 *
 * Re-deriving the yaw from the lane centerline UNCONDITIONALLY broke both for
 * any actor authored facing off its lane: the server replaced the authored yaw
 * with the lane's forward travel yaw and the worker then rejected the job for
 * "an explicit spawn yaw opposite its authenticated road direction" — blaming
 * the author for a yaw the server had just written (catalog B1, a bay-parked car
 * reversing out; also B7/F10/J6).
 *
 * Precedence:
 *   1. The authored anchor yaw, when the draft ALSO pins the pose with an
 *      explicit `spawn_yaw`. Two independently authored yaws then reach the
 *      worker and its guard still catches an author who wrote them inconsistently.
 *      Requiring `spawn_yaw` keeps generated drafts (which carry a stamped
 *      `world_anchor` and no `spawn_yaw`) on the runtime-authored path, so a
 *      stale anchor yaw from a renumbered bundle is still refreshed.
 *   2. Otherwise the runtime lane travel yaw at `s_fraction`, turned 180 degrees
 *      when the actor is authored facing against lane travel. Same rule the
 *      editor renders (useScenarioEditorMapModel.ts:544) and the worker spawns
 *      with (spawn_actor_helpers.py:1503).
 *
 * `route_direction: "reverse"` is deliberately NOT a facing input: a reversing
 * car still FACES along its lane and travels backwards. Only `lane_facing`
 * turns the pose, and only for the spawn anchor — a route anchor's yaw is lane
 * geometry consumed by route resolution, not a pose.
 *
 * Position (x/y/z) is re-derived from the runtime bundle — the anti-renumbering
 * authentication this stamp exists for — EXCEPT for a deliberately off-lane
 * spawn pose, which `stampedAnchorPosition` preserves under its own witness
 * rule (defect #20).
 */
function stampedAnchorYawDegrees(
  actor: ScenarioEditorActorDraft,
  anchor: ScenarioEditorRoadAnchor,
  field: string,
  laneTravelYaw: number,
): number {
  const isSpawnAnchor = field === "spawn";
  const authoredYaw = anchor.world_anchor?.yaw;
  if (
    isSpawnAnchor &&
    typeof authoredYaw === "number" &&
    Number.isFinite(authoredYaw) &&
    typeof actor.spawn_yaw === "number" &&
    Number.isFinite(actor.spawn_yaw)
  ) {
    return authoredYaw;
  }
  if (isSpawnAnchor && actor.lane_facing === "against_lane") {
    return normalizeYawDegrees(laneTravelYaw + 180);
  }
  return laneTravelYaw;
}

/**
 * How far an authored spawn `world_anchor` may sit off its bound lane's
 * centerline and still keep its authored position through the re-stamp.
 *
 * MUST equal the worker's `_AUTHORED_ROAD_SPAWN_MAX_OFFSET_M`
 * (spawn_actor_helpers.py): the worker spawns a road vehicle at its authored
 * `spawn_point`/`spawn_yaw` when that pose is within this offset of the
 * resolved lane waypoint, and the preview engine spawns exactly at the stamped
 * `world_anchor` ("a stamped pose wins over the corridor's head" —
 * corridor-geometry.server.ts `spawnByActor`). A narrower web tolerance would
 * open a band where CARLA honors a bay pose the preview no longer shows.
 * Evidence: perpendicular/parallel parking bays sit 2.5–4.7 m lateral of their
 * aisle lane (catalog B1 4.67 m, B5 4.1 m); 8 m covers a full bay depth plus
 * drift while sitting just above the worker's direction-aligned geometry guard
 * tier (7.0 m), so anything farther is a genuinely different road.
 */
export const AUTHORED_SPAWN_ANCHOR_MAX_OFFSET_M = 8.0;

/**
 * World position for a re-stamped road anchor.
 *
 * Re-deriving the position from the lane centerline UNCONDITIONALLY destroyed
 * every deliberately off-lane spawn: a car authored parked in a bay 4.67 m
 * lateral of the aisle it anchors to was teleported onto the aisle centerline
 * at submit time, perpendicular across the subject's lane (defect #20; catalog
 * B1's mini authored at (-245.64, 193.6) reached the worker at
 * (-241.712, 197.863), B3's two bay cars re-stamped onto adjacent centerlines
 * spawned overlapping). The bay placement IS the scenario for the whole
 * B-reverse family: the car parks in the bay while its corridor is the aisle.
 *
 * Precedence, mirroring `stampedAnchorYawDegrees`:
 *   1. The authored anchor position, when the actor is a VEHICLE, the anchor is
 *      the SPAWN anchor, the draft ALSO pins the pose with an explicit finite
 *      `spawn_point` (the same second witness the worker consumes for its
 *      authored-pose spawn), and the authored point lies within
 *      `AUTHORED_SPAWN_ANCHOR_MAX_OFFSET_M` of the runtime centerline sample.
 *      Requiring `spawn_point` keeps generated drafts (which carry a stamped
 *      `world_anchor` and no `spawn_point` — batch traffic/fill) on the
 *      runtime-authored path, so a stale anchor from a renumbered bundle is
 *      still refreshed.
 *   2. Otherwise the runtime centerline sample at `s_fraction` — the
 *      anti-renumbering authentication, unchanged. A point beyond the offset
 *      guard (wrong road, stale bundle; the 2026-07-22 Belmont audit saw
 *      ~170 m) still snaps exactly as before, and the road binding
 *      (road_id/section/lane/s_fraction) is validated and kept regardless, so
 *      corridor resolution is untouched.
 *
 * `z` keeps the authored value when finite (a bay floor is not the aisle
 * surface; B1 authors bay z 2.534 vs aisle z 3.01) and otherwise falls back to
 * the centerline sample; the worker raycasts the ground either way.
 */
function stampedAnchorPosition(
  actor: ScenarioEditorActorDraft,
  anchor: ScenarioEditorRoadAnchor,
  field: string,
  laneAnchor: { x: number; y: number; z: number },
): { x: number; y: number; z: number } {
  if (field !== "spawn" || actor.kind !== "vehicle") return laneAnchor;
  const authored = anchor.world_anchor;
  const spawnPoint = actor.spawn_point;
  if (
    !authored ||
    !Number.isFinite(authored.x) ||
    !Number.isFinite(authored.y) ||
    !spawnPoint ||
    !Number.isFinite(spawnPoint.x) ||
    !Number.isFinite(spawnPoint.y)
  ) {
    return laneAnchor;
  }
  const offsetM = Math.hypot(authored.x - laneAnchor.x, authored.y - laneAnchor.y);
  if (offsetM > AUTHORED_SPAWN_ANCHOR_MAX_OFFSET_M) return laneAnchor;
  return {
    x: authored.x,
    y: authored.y,
    z: Number.isFinite(authored.z) ? authored.z : laneAnchor.z,
  };
}

function allowedLaneTypesForActor(
  actor: ScenarioEditorActorDraft,
): ReadonlySet<string> | null {
  if (actor.kind === "vehicle") return VEHICLE_RUNTIME_LANE_TYPES;
  if (actor.kind === "walker") return WALKER_RUNTIME_LANE_TYPES;
  return null;
}

export function runtimeLaneTypeIdsForActorKind(
  kind: ScenarioEditorActorDraft["kind"] | null | undefined,
): readonly RuntimeLaneTypeId[] {
  if (kind === "vehicle") return VEHICLE_RUNTIME_LANE_TYPE_IDS;
  if (kind === "walker") return WALKER_RUNTIME_LANE_TYPE_IDS;
  return [];
}

function roadAnchorKey(anchor: ScenarioEditorRoadAnchor): string | null {
  if (anchor.section_id == null || anchor.lane_id == null) return null;
  const roadId = String(anchor.road_id ?? "").trim();
  if (!roadId) return null;
  return `${roadId}:${anchor.section_id}:${anchor.lane_id}`;
}

function formatRoadAnchor(anchor: ScenarioEditorRoadAnchor): string {
  return [
    `road ${anchor.road_id || "?"}`,
    `section ${anchor.section_id ?? "?"}`,
    `lane ${anchor.lane_id ?? "?"}`,
  ].join(" ");
}

function runtimeRoadAnchors(
  runtimeMap: RuntimeMapResponse | null,
): Map<string, RuntimeRoadAnchorRecord> {
  const anchors = new Map<string, RuntimeRoadAnchorRecord>();
  for (const segment of runtimeMap?.road_segments ?? []) {
    if (segment.section_id == null || segment.lane_id == null) continue;
    anchors.set(`${segment.road_id}:${segment.section_id}:${segment.lane_id}`, {
      laneType: normalizeRuntimeLaneType(segment.lane_type),
      segment,
    });
  }
  return anchors;
}

function runtimeRoadAnchorsFromOverlay(
  runtimeRoadOverlay: object | null,
): Map<string, RuntimeRoadAnchorRecord> {
  const overlay = runtimeRoadOverlay as RuntimeRoadOverlayCollection | null;
  const anchors = new Map<string, RuntimeRoadAnchorRecord>();
  for (const feature of overlay?.features ?? []) {
    const properties = feature.properties;
    if (
      properties.feature_kind !== "lane_centerline" ||
      properties.source !== "runtime" ||
      properties.section_id == null ||
      properties.lane_id == null
    ) {
      continue;
    }
    anchors.set(
      `${properties.road_id}:${properties.section_id}:${properties.lane_id}`,
      { laneType: normalizeRuntimeLaneType(properties.lane_type) },
    );
  }
  return anchors;
}

function runtimeRoadAnchorContext(options: RuntimeAnchorValidationOptions): string {
  return options.contextLabel ? `${options.contextLabel}: ` : "";
}

export function assertRoadActorsReferenceRuntimeMap(
  actors: readonly ScenarioEditorActorDraft[],
  runtimeMap: RuntimeMapResponse | null,
  options: RuntimeAnchorValidationOptions = {},
): void {
  stampRoadActorsWithRuntimeMap(actors, runtimeMap, options);
}

export function stampRoadActorsWithRuntimeMap(
  actors: readonly ScenarioEditorActorDraft[],
  runtimeMap: RuntimeMapResponse | null,
  options: RuntimeAnchorValidationOptions = {},
): ScenarioEditorActorDraft[] {
  const runtimeAnchors = runtimeRoadAnchors(runtimeMap);
  const roadActors = actors.filter(
    (actor) => (actor.placement_mode ?? "road") === "road",
  );
  if (roadActors.length === 0) return [...actors];

  if (runtimeAnchors.size === 0) {
    throw new RuntimeRoadAnchorValidationError(
      `${runtimeRoadAnchorContext(options)}Runtime lane data is unavailable for this map. Actor road spawns and routes must come from the active CARLA runtime map, not GeoJSON/generated map data.`,
    );
  }

  return actors.map((actor) => {
    if ((actor.placement_mode ?? "road") !== "road") return actor;
    const stampedActor = {
      ...actor,
      spawn: stampRuntimeRoadAnchor(
        actor,
        actor.spawn,
        "spawn",
        runtimeAnchors,
        options,
      ),
    };
    if (Array.isArray(actor.route)) {
      stampedActor.route = actor.route.map(
        (anchor, index) =>
          stampRuntimeRoadAnchor(
            actor,
            anchor,
            `route[${index}]`,
            runtimeAnchors,
            options,
          ),
      );
    }
    return stampedActor;
  });
}

export function assertRoadActorsReferenceRuntimeOverlay(
  actors: readonly ScenarioEditorActorDraft[],
  runtimeRoadOverlay: object | null,
  options: RuntimeAnchorValidationOptions = {},
): void {
  assertRoadActorsReferenceRuntimeAnchors(
    actors,
    runtimeRoadAnchorsFromOverlay(runtimeRoadOverlay),
    options,
  );
}

function assertRoadActorsReferenceRuntimeAnchors(
  actors: readonly ScenarioEditorActorDraft[],
  runtimeAnchors: ReadonlyMap<string, RuntimeRoadAnchorRecord>,
  options: RuntimeAnchorValidationOptions,
): void {
  const roadActors = actors.filter(
    (actor) => (actor.placement_mode ?? "road") === "road",
  );
  if (roadActors.length === 0) return;
  if (runtimeAnchors.size === 0) {
    throw new RuntimeRoadAnchorValidationError(
      `${runtimeRoadAnchorContext(options)}Runtime lane data is unavailable for this map. Actor road spawns and routes must come from the active CARLA runtime map, not GeoJSON/generated map data.`,
    );
  }
  for (const actor of roadActors) {
    assertRuntimeRoadAnchor(actor, actor.spawn, "spawn", runtimeAnchors, options);
    (Array.isArray(actor.route) ? actor.route : []).forEach((anchor, index) => {
      assertRuntimeRoadAnchor(
        actor,
        anchor,
        `route[${index}]`,
        runtimeAnchors,
        options,
      );
    });
  }
}

function assertRuntimeRoadAnchor(
  actor: ScenarioEditorActorDraft,
  anchor: ScenarioEditorRoadAnchor,
  field: string,
  runtimeAnchors: ReadonlyMap<string, RuntimeRoadAnchorRecord>,
  options: RuntimeAnchorValidationOptions,
): void {
  const key = roadAnchorKey(anchor);
  const runtimeAnchor = key ? runtimeAnchors.get(key) : null;
  const allowedLaneTypes = allowedLaneTypesForActor(actor);
  if (runtimeAnchor && (!allowedLaneTypes || allowedLaneTypes.has(runtimeAnchor.laneType))) {
    return;
  }
  const label = actor.label || actor.id;
  if (runtimeAnchor && allowedLaneTypes) {
    throw new RuntimeRoadAnchorValidationError(
      `${runtimeRoadAnchorContext(options)}Actor "${label}" ${field} anchor ${formatRoadAnchor(anchor)} is a ${runtimeAnchor.laneType} runtime lane, which is not valid for ${actor.kind} road placement. Actor road anchors must use runtime lane types valid for the actor kind, not GeoJSON/generated map data.`,
    );
  }
  throw new RuntimeRoadAnchorValidationError(
    `${runtimeRoadAnchorContext(options)}Actor "${label}" ${field} anchor ${formatRoadAnchor(anchor)} is not present in the active CARLA runtime map. Actor road anchors must come from runtime road data, not GeoJSON/generated map data.`,
  );
}

function stampRuntimeRoadAnchor(
  actor: ScenarioEditorActorDraft,
  anchor: ScenarioEditorRoadAnchor,
  field: string,
  runtimeAnchors: ReadonlyMap<string, RuntimeRoadAnchorRecord>,
  options: RuntimeAnchorValidationOptions,
): ScenarioEditorRoadAnchor {
  const key = roadAnchorKey(anchor);
  const runtimeAnchor = key ? runtimeAnchors.get(key) : null;
  const allowedLaneTypes = allowedLaneTypesForActor(actor);
  if (runtimeAnchor && (!allowedLaneTypes || allowedLaneTypes.has(runtimeAnchor.laneType))) {
    if (
      !Number.isFinite(anchor.s_fraction) ||
      anchor.s_fraction < 0 ||
      anchor.s_fraction > 1
    ) {
      const label = actor.label || actor.id;
      throw new RuntimeRoadAnchorValidationError(
        `${runtimeRoadAnchorContext(options)}Actor "${label}" ${field} anchor ${formatRoadAnchor(anchor)} has an invalid runtime lane fraction. Road anchor s_fraction must be finite and between 0 and 1.`,
      );
    }
    if (!runtimeAnchor.segment) {
      throw new RuntimeRoadAnchorValidationError(
        `${runtimeRoadAnchorContext(options)}Runtime lane geometry is unavailable for ${formatRoadAnchor(anchor)}.`,
      );
    }
    const worldAnchor = worldAnchorAtFraction(runtimeAnchor.segment, anchor.s_fraction);
    if (!worldAnchor) {
      const label = actor.label || actor.id;
      throw new RuntimeRoadAnchorValidationError(
        `${runtimeRoadAnchorContext(options)}Actor "${label}" ${field} anchor ${formatRoadAnchor(anchor)} has no finite centerline geometry in the active CARLA runtime map. Road actors require exact runtime lane geometry.`,
      );
    }
    // RDS Data API's JSON type hint can round a full-precision interpolated
    // double by a few ulps before JSONB readback. Hashing the pre-roundtrip
    // value would authenticate a different behavior from the one leased to
    // the worker. CARLA's geometry is float precision; six decimal places
    // retain sub-millimeter coordinates while remaining stable across the
    // JSON/Data API/Python boundary.
    return {
      ...anchor,
      world_anchor: durableWorldAnchor({
        ...stampedAnchorPosition(actor, anchor, field, worldAnchor),
        yaw: stampedAnchorYawDegrees(actor, anchor, field, worldAnchor.yaw),
      }),
    };
  }

  const label = actor.label || actor.id;
  if (runtimeAnchor && allowedLaneTypes) {
    throw new RuntimeRoadAnchorValidationError(
      `${runtimeRoadAnchorContext(options)}Actor "${label}" ${field} anchor ${formatRoadAnchor(anchor)} is a ${runtimeAnchor.laneType} runtime lane, which is not valid for ${actor.kind} road placement. Actor road anchors must use runtime lane types valid for the actor kind, not GeoJSON/generated map data.`,
    );
  }

  throw new RuntimeRoadAnchorValidationError(
    `${runtimeRoadAnchorContext(options)}Actor "${label}" ${field} anchor ${formatRoadAnchor(anchor)} is not present in the active CARLA runtime map. Actor road anchors must come from runtime road data, not GeoJSON/generated map data.`,
  );
}
