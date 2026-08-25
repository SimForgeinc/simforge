import {
  applyAggressivenessToSpeedKph,
  type CollisionActorRecipe,
  type CollisionActorRole,
  type NpcAggressiveness,
  type ScenarioEditorActorDraft,
  type ScenarioEditorTimelineClip,
} from "@simforge/studio-shared";
import {
  PRESET_SDG_AV,
  sensorsFromPreset,
} from "@/app/lib/scenario-editor/sensor-rigs";
import type { GeometryLaneSample } from "@/app/lib/maps/search/server/inspect-location-geometry";
import {
  buildActorLabel,
  defaultActorColor,
} from "@/app/lib/scenario-editor/actor-utils";
import {
  spawnYawDegFromPlannedPath,
  type PlanCollisionRoutesResult,
  type PlannedActor,
  type PlannedWalker,
} from "@/app/lib/llm/scenario-generation/collision-route-planner";
import {
  buildRoadAnchor,
  emptyNonRoadSpawnAnchor,
  fallbackAnchorForLaneId,
  type ActorPlacement,
} from "@/app/lib/llm/scenario-generation/collision-anchor-resolution";
import { finalizeGeneratedActorBehaviors } from "@/app/lib/scenario-generation/generated-actor-behavior";

type CollisionTemplateForAssembly = {
  durationSeconds: number;
  actorRecipe: readonly CollisionActorRecipe[];
};

export type NpcVehicleOverride = {
  blueprint: string;
  baseSpeedKph: number;
} | null;

/**
 * Default sensor rig for an auto-generated subject actor. We attach
 * `PRESET_SDG_AV` (NVIDIA Sensor Config) — the same full-coverage rig used
 * for hand-authored SDG scenarios:
 *   - `TRAILING_CAMERA_SENSOR` (spring-arm preview mount) so the scene is
 *     immediately previewable with a third-person chase view.
 *   - 7× RGB cameras (front center / front left / front right / left side /
 *     right side / rear left / rear right) at 1920×1208, 120° FOV with
 *     depth + segmentation supported.
 *   - 1× roof-center LiDAR (128 channels, 250 m range).
 *
 * Auto-generated scenarios get the heavy rig by default; users filter down
 * to 1–2 cameras at render-submission time via `sdgCameraMountIds` when
 * iterating. NPC vehicles and walkers stay sensor-less (standard
 * AV data-collection convention).
 *
 * `sensorsFromPreset` mints fresh UUIDs per call, so each subject in a draft
 * gets distinct sensor ids.
 *
 * @internal Exported for unit tests.
 */
export function defaultActorSensors(
  isSubject: boolean,
): ReturnType<typeof sensorsFromPreset> {
  if (!isSubject) return [];
  return sensorsFromPreset(PRESET_SDG_AV).map((sensor) => ({
    ...sensor,
    attachTo: "subject",
  }));
}

function timedWaypointsForPlannedActor(
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

function resolveTimelineClips(
  recipe: CollisionActorRecipe,
  aggressiveness: NpcAggressiveness,
  roleIdMap: Record<string, string>,
): ScenarioEditorTimelineClip[] {
  return recipe.timeline.map((clip, index) => {
    const speed = clip.target_speed_kph != null
      ? recipe.aggressivenessAppliesTo === "speed"
        ? applyAggressivenessToSpeedKph(clip.target_speed_kph, aggressiveness)
        : clip.target_speed_kph
      : null;
    const targetActorId = clip.target_role ? roleIdMap[clip.target_role] ?? null : null;
    const built: ScenarioEditorTimelineClip = {
      id: `clip-${recipe.role}-${index}`,
      start_time: clip.start_time,
      ...(clip.end_time != null ? { end_time: clip.end_time } : {}),
      action: clip.action,
      ...(speed != null ? { target_speed_kph: speed } : {}),
      ...(targetActorId ? { target_actor_id: targetActorId } : {}),
      ...(clip.following_distance_m != null
        ? { following_distance_m: clip.following_distance_m }
        : {}),
      enabled: true,
    };
    return built;
  });
}

export function buildCollisionDraftActors(input: {
  template: CollisionTemplateForAssembly;
  plannerResult: PlanCollisionRoutesResult | null;
  rolePlacements: Partial<Record<CollisionActorRole, ActorPlacement>>;
  roleIdMap: Record<string, string>;
  npcOverride: NpcVehicleOverride;
  aggressiveness: NpcAggressiveness;
  subjectAnchor: GeometryLaneSample | null;
  subjectPedestrianDestination: { x: number; y: number } | null;
}): ScenarioEditorActorDraft[] {
  const {
    template,
    plannerResult,
    rolePlacements,
    roleIdMap,
    npcOverride,
    aggressiveness,
    subjectAnchor,
    subjectPedestrianDestination,
  } = input;
  const actors: ScenarioEditorActorDraft[] = [];
  for (const recipe of template.actorRecipe) {
    const id = roleIdMap[recipe.role]!;
    // For the NPC, apply the vehicle-type override's base speed when
    // present so a cyclist NPC doesn't end up driving at car speed.
    const effectiveBaseSpeed =
      recipe.role !== "subject" && npcOverride
        ? npcOverride.baseSpeedKph
        : recipe.baseSpeedKph;
    const speed = recipe.aggressivenessAppliesTo === "speed"
      ? applyAggressivenessToSpeedKph(effectiveBaseSpeed, aggressiveness)
      : effectiveBaseSpeed;

    // Planner-emit branch.
    if (plannerResult) {
      const planned: PlannedActor | null =
        recipe.role === "subject"
          ? plannerResult.collision.subject
          : recipe.kind === "vehicle"
            ? plannerResult.collision.npc
            : null;
      const walker: PlannedWalker | null =
        recipe.kind === "walker" ? plannerResult.walker : null;

      if (recipe.kind === "vehicle" && planned) {
        const spawnAnchor = fallbackAnchorForLaneId(planned.spawnLaneId, planned.spawnSFraction)
          ?? emptyNonRoadSpawnAnchor();
        // Apply the NPC vehicle-type override (cyclist / motorcycle)
        // when the LLM passed one. Subject always keeps the recipe's
        // blueprint — the override targets the conflicting NPC only.
        const blueprint =
          recipe.role !== "subject" && npcOverride
            ? npcOverride.blueprint
            : recipe.blueprint;
        const actor: ScenarioEditorActorDraft = {
          id,
          label: buildActorLabel(
            {
              kind: recipe.kind,
              role: recipe.scenarioRole,
              placement_mode: "timed_path",
              is_static: false,
              blueprint,
            },
            actors,
          ),
          kind: recipe.kind,
          role: recipe.scenarioRole,
          is_static: false,
          placement_mode: "timed_path",
          blueprint,
          spawn: spawnAnchor,
          spawn_point: planned.spawnPoint,
          // Heading from the planned path's first segment — robust to
          // OpenDRIVE lane-id sign / bidirectional lanes (see
          // spawnYawDegFromPlannedPath). Replaces the old blanket +180°.
          spawn_yaw: spawnYawDegFromPlannedPath(planned),
          route: [],
          route_direction: "forward",
          lane_facing: "with_lane",
          destination: null,
          destination_point: null,
          path_placement: [],
          timed_waypoints: timedWaypointsForPlannedActor(planned),
          speed_kph: planned.expectedSpeedKph,
          // Autopilot OFF for planner-driven vehicles — timed_waypoints
          // are the spec. CARLA's worker routes timed-path actors through
          // its path controller.
          autopilot: false,
          color: defaultActorColor({ kind: recipe.kind }),
          notes: null,
          // Strip recipe timeline; emit a single set_speed clip so the
          // path-follower receives a constant target. The maneuver itself
          // (the left turn / lane change) is encoded by the planner's
          // waypoint geometry.
          timeline: [
            {
              id: `clip-${recipe.role}-0`,
              start_time: 0,
              end_time: template.durationSeconds,
              action: "set_speed",
              target_speed_kph: planned.expectedSpeedKph,
              enabled: true,
            },
          ],
          sensors: defaultActorSensors(recipe.role === "subject"),
        };
        actors.push(actor);
        continue;
      }
      if (recipe.kind === "walker" && walker) {
        const actor: ScenarioEditorActorDraft = {
          id,
          label: buildActorLabel(
            {
              kind: recipe.kind,
              role: recipe.scenarioRole,
              placement_mode: "timed_path",
              is_static: false,
              blueprint: recipe.blueprint,
            },
            actors,
          ),
          kind: recipe.kind,
          role: recipe.scenarioRole,
          is_static: false,
          placement_mode: "timed_path",
          blueprint: recipe.blueprint,
          spawn: emptyNonRoadSpawnAnchor(),
          spawn_point: walker.spawnPoint,
          spawn_yaw: undefined,
          route: [],
          route_direction: "forward",
          lane_facing: "with_lane",
          destination: null,
          destination_point: null,
          speed_kph: speed,
          autopilot: false,
          color: defaultActorColor({ kind: recipe.kind }),
          notes: null,
          timeline: [],
          timed_waypoints: walker.waypoints.map((w) => ({ x: w.x, y: w.y, time: w.time })),
          sensors: [],
        };
        actors.push(actor);
        continue;
      }
      // Planner returned a result but this specific role didn't get a
      // plan (e.g. walker role with no walker plan). Fall through to the
      // heuristic build for this actor only.
    }

    // ── Heuristic fallback ────────────────────────────────────────────
    const placement = rolePlacements[recipe.role]!;
    const placementMode: "road" | "point" | "timed_path" =
      placement.kind === "lane"
        ? "road"
        : placement.kind === "timed_path"
          ? "timed_path"
          : "point";
    // The schema requires `spawn` (road anchor) even for non-road
    // placements; the runtime ignores it then. We use the subject's lane
    // as a benign placeholder when present so any code path that does
    // read `spawn.road_id` still sees a coherent value.
    const fallbackLane = placement.kind === "lane" ? placement.lane : subjectAnchor;
    const spawnPoint =
      placement.kind === "point"
        ? placement.point
        : placement.kind === "timed_path"
          ? placement.spawnPoint
          : null;
    const timedWaypoints =
      placement.kind === "timed_path"
        ? placement.waypoints.map((w) => ({ x: w.x, y: w.y, time: w.time }))
        : undefined;
    // Apply NPC vehicle-type override on the heuristic fallback path
    // too, so cyclist / motorcycle still works when the planner
    // degraded.
    const fallbackBlueprint =
      recipe.role !== "subject" && npcOverride
        ? npcOverride.blueprint
        : recipe.blueprint;
    const actor: ScenarioEditorActorDraft = {
      id,
      label: buildActorLabel(
        {
          kind: recipe.kind,
          role: recipe.scenarioRole,
          placement_mode: placementMode,
          is_static: false,
          blueprint: fallbackBlueprint,
        },
        actors,
      ),
      kind: recipe.kind,
      role: recipe.scenarioRole,
      is_static: false,
      placement_mode: placementMode,
      blueprint: fallbackBlueprint,
      spawn: fallbackLane
        ? buildRoadAnchor(
            fallbackLane,
            placement.kind === "lane" ? placement.s_fraction : undefined,
          )
        : emptyNonRoadSpawnAnchor(),
      spawn_point: spawnPoint,
      spawn_yaw: undefined,
      route: [],
      route_direction: "forward",
      lane_facing: "with_lane",
      destination: null,
      // Pin the subject's `destination_point` for the pedestrian_crossing
      // family so CARLA's traffic manager routes through the crossing
      // rather than turning off at a junction before reaching it.
      // All other actors (and other families) keep destination_point=null.
      destination_point:
        recipe.role === "subject" && subjectPedestrianDestination
          ? subjectPedestrianDestination
          : null,
      speed_kph: speed,
      autopilot: recipe.autopilot,
      color: defaultActorColor({ kind: recipe.kind }),
      notes: null,
      // Strip the recipe's timeline for timed-path walkers — the
      // trajectory itself is the spec, and the recipe is intentionally
      // empty in that case (see template comment).
      timeline:
        placement.kind === "timed_path"
          ? []
          : resolveTimelineClips(recipe, aggressiveness, roleIdMap),
      ...(timedWaypoints ? { timed_waypoints: timedWaypoints } : {}),
      sensors: defaultActorSensors(recipe.role === "subject"),
    };
    actors.push(actor);
  }
  return finalizeGeneratedActorBehaviors(actors);
}
