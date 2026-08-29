/**
 * actor-utils.ts — pure helper functions for native editor actor state.
 * Pure helper functions for actor state derivation. Complex helpers that
 * depend on Svelte-specific code are stubbed with TODO comments.
 */

import type {
  RuntimeScenarioEditorActor,
  ScenarioEditorActorDraft,
  ScenarioEditorTimedWaypoint,
  ScenarioEditorTimelineClip,
  ScenarioEditorTimelineAction,
} from "@simforge-oss/studio-shared";
import {
  DEFAULT_CARLA_ACTOR_BLUEPRINTS,
} from "@simforge-oss/studio-shared";
import {
  SCENARIO_TIMING,
} from "@simforge-oss/scenario/contracts";
import type { ActorBlueprintLibrary } from "@/app/lib/runtime/runtime-types";
import type { RuntimeRoadOverlayCollection } from "@/app/lib/editor-map/types";

// ---------------------------------------------------------------------------
// Local types (mirrors types.local.ts in Svelte editor)
// ---------------------------------------------------------------------------

export type LaneFacingMode = "with_lane" | "against_lane";
export type RouteDirectionMode = "forward" | "reverse";

// ---------------------------------------------------------------------------
// Constants (mirrors constants.ts in Svelte editor)
// ---------------------------------------------------------------------------

export const timelineDurationSeconds = SCENARIO_TIMING.defaultDurationSeconds;
export const vehicleSpeedLimitKph = 240;
export const walkerSpeedLimitKph = 25;
/** 30 mph, expressed in the CARLA/editor km/h contract. */
export const defaultVehicleSpeedKph = 48.28032;
export const defaultWalkerSpeedKph = 5;
// Editor picker. Generation-1 walkers (0001..0014) and 0052 are catalogued but
// NOT published by the 0.10 image, so offering them let an author choose a
// blueprint the worker would silently substitute away. See
// packages/shared/src/carla-ue5-walker-blueprints.ts.
export const curatedPedestrianBlueprints = [
  "walker.pedestrian.0015",
  "walker.pedestrian.0016",
  "walker.pedestrian.0017",
  "walker.pedestrian.0018",
  "walker.pedestrian.0019",
  "walker.pedestrian.0020",
  "walker.pedestrian.0021",
  "walker.pedestrian.0022",
  "walker.pedestrian.0023",
  "walker.pedestrian.0024",
  "walker.pedestrian.0025",
  "walker.pedestrian.0026",
  "walker.pedestrian.0027",
  "walker.pedestrian.0028",
  "walker.pedestrian.0029",
  "walker.pedestrian.0030",
  "walker.pedestrian.0031",
  "walker.pedestrian.0032",
  "walker.pedestrian.0033",
  "walker.pedestrian.0034",
  "walker.pedestrian.0035",
  "walker.pedestrian.0036",
  "walker.pedestrian.0037",
  "walker.pedestrian.0038",
  "walker.pedestrian.0039",
  "walker.pedestrian.0040",
  "walker.pedestrian.0041",
  "walker.pedestrian.0042",
  "walker.pedestrian.0043",
  "walker.pedestrian.0044",
  // 0045-0047 removed: CARLA_UE5_WALKER_DENYLIST (the "paraglider persona"
  // triplet, dib 2026-08-02 Munich review) — offering them lets an author pick
  // a skin the worker will substitute away.
] as const;
export const defaultBlueprints: ActorBlueprintLibrary = {
  vehicles: [...DEFAULT_CARLA_ACTOR_BLUEPRINTS.vehicles],
  walkers: [...DEFAULT_CARLA_ACTOR_BLUEPRINTS.walkers],
};

export const vehicleColorValues = [
  "0,201,167",
  "200,30,30",
  "47,100,220",
  "230,200,40",
  "240,240,240",
  "170,170,180",
  "230,120,30",
];

const RANDOM_VEHICLE_BLACK_MAX_CHANNEL = 32;

function parseVehicleColorChannels(
  value: string,
): [number, number, number] | null {
  let text = value.trim();
  if (!text) return null;
  if (text.startsWith("#")) {
    let hexValue = text.slice(1);
    if (hexValue.length === 3) {
      hexValue = Array.from(
        hexValue,
        (channel) => `${channel}${channel}`,
      ).join("");
    }
    if (hexValue.length !== 6) return null;
    const channels = [0, 2, 4].map((index) =>
      Number.parseInt(hexValue.slice(index, index + 2), 16),
    );
    return channels.every(Number.isFinite)
      ? (channels as [number, number, number])
      : null;
  }

  const lowered = text.toLowerCase();
  if (lowered.startsWith("rgb(") && lowered.endsWith(")")) {
    text = text.slice(4, -1);
  }

  const channels = text
    .split(",")
    .slice(0, 3)
    .map((part) => Number(part.trim()));
  if (
    channels.length < 3 ||
    channels.some((channel) => !Number.isFinite(channel))
  ) {
    return null;
  }
  return channels as [number, number, number];
}

export function isRandomizableVehicleColor(
  value: string | null | undefined,
): value is string {
  if (typeof value !== "string") return false;
  const text = value.trim();
  if (!text) return false;
  const channels = parseVehicleColorChannels(text);
  if (!channels) return true;
  return Math.max(...channels) > RANDOM_VEHICLE_BLACK_MAX_CHANNEL;
}

export function randomizableVehicleColorValues(
  values: readonly (string | null | undefined)[],
): string[] {
  return values.filter(isRandomizableVehicleColor);
}

/** Timeline actions that represent a "base navigation mode" at t=0. */
export const baseNavigationActions: Array<
  Extract<ScenarioEditorTimelineAction, "follow_route" | "ram_actor">
> = ["follow_route", "ram_actor"];

// ---------------------------------------------------------------------------
// Config status
// ---------------------------------------------------------------------------

export type ActorConfigStatus = "default" | "needs-config" | "configured" | "none";

// ---------------------------------------------------------------------------
// Core helpers
// ---------------------------------------------------------------------------

export function isParkedRoadActor(
  actor: Pick<ScenarioEditorActorDraft, "kind" | "placement_mode" | "is_static">,
): boolean {
  return (
    actor.kind === "vehicle" &&
    actor.placement_mode === "road" &&
    Boolean(actor.is_static)
  );
}

export function actorLabelPrefix(
  actor: Pick<
    ScenarioEditorActorDraft,
    "kind" | "role" | "is_static" | "placement_mode"
  > & { blueprint?: string },
): string {
  if (actor.kind === "prop") return "Prop";
  if (actor.role === "subject") return "Subject";
  if (isParkedRoadActor(actor)) return "Parked";
  if (actor.is_static) return "Static";
  if (actor.kind === "walker") return "Pedestrian";
  if (actor.kind === "vehicle" && actor.placement_mode === "timed_path") {
    return "Path car";
  }
  // Subdivide vehicle traffic by blueprint family so a cyclist NPC isn't
  // labelled "Traffic 1" alongside cars. Cyclist / Motorbike give the
  // user an at-a-glance read on what kind of actor was placed.
  const bp = ("blueprint" in actor && typeof actor.blueprint === "string"
    ? actor.blueprint.toLowerCase()
    : "");
  if (
    bp.includes("crossbike") ||
    bp.includes("bicycle") ||
    bp.includes("diamondback") ||
    bp.includes("gazelle") ||
    bp.includes("omafiets")
  ) return "Cyclist";
  if (
    bp.includes("motorcycle") ||
    bp.includes("motorbike") ||
    bp.includes("harley") ||
    bp.includes("kawasaki") ||
    bp.includes("yamaha") ||
    bp.includes("ninja")
  ) return "Motorbike";
  return "Traffic";
}

export function buildActorLabel(
  actor: Pick<
    ScenarioEditorActorDraft,
    "kind" | "role" | "is_static" | "placement_mode"
  > & { blueprint?: string },
  existingActors: Array<
    Pick<
      ScenarioEditorActorDraft,
      "kind" | "role" | "is_static" | "placement_mode"
    > & { blueprint?: string }
  >,
): string {
  const prefix = actorLabelPrefix(actor);
  const count =
    existingActors.filter(
      (current) => actorLabelPrefix(current) === prefix,
    ).length + 1;
  return `${prefix} ${count}`;
}

export function blueprintForActorKind(
  kind: ScenarioEditorActorDraft["kind"],
  blueprints: ActorBlueprintLibrary = defaultBlueprints,
  fallbackBlueprint?: string | null,
): string {
  if (kind === "prop") return fallbackBlueprint ?? "";
  if (kind === "vehicle") {
    return (
      blueprints.vehicles[0] ??
      defaultBlueprints.vehicles[0] ??
      fallbackBlueprint ??
      ""
    );
  }
  return (
    curatedPedestrianBlueprints[0] ??
    fallbackBlueprint ??
    ""
  );
}

export function defaultActorSpeedKph(
  actor: Pick<ScenarioEditorActorDraft, "kind" | "is_static">,
): number {
  if (actor.is_static) return 0;
  return actor.kind === "walker"
    ? defaultWalkerSpeedKph
    : defaultVehicleSpeedKph;
}

/**
 * Whether a NEWLY AUTHORED actor starts on Auto. It does not, ever.
 *
 * Auto hands the car to CARLA's Traffic Manager, which decides its own route.
 * That makes it the one baseline whose behavior an author cannot predict, read
 * off the screen, or reproduce: it takes a different turn on the second run, it
 * cannot be exported to OpenSCENARIO, and it drifts under a CARLA or map
 * upgrade. Every piece of guidance we wrote about it said "pick this, then
 * immediately Compile to route" — which is an admission that it was the wrong
 * default.
 *
 * A new car now starts on `cruise` (Keep lane): our own controller, holding the
 * authored speed along the lane it was dropped on. Deterministic from the first
 * frame, with no second step to remember.
 *
 * The function survives rather than being inlined because the DECISION is worth
 * a name and a place to argue with. `autopilot` itself is untouched on the wire
 * — ambient traffic (`random-traffic-region`), every batch generator and every
 * already-saved scenario still set and run it.
 */
export function defaultActorAutopilot(
  _actor: Pick<ScenarioEditorActorDraft, "kind" | "placement_mode" | "is_static">,
): boolean {
  return false;
}

export function defaultActorColor(
  actor: Pick<ScenarioEditorActorDraft, "kind">,
): string | null {
  return actor.kind === "vehicle" ? "230,200,40" : null;
}

function randomListItem<T>(
  items: readonly T[],
  rng: () => number,
): T | undefined {
  if (items.length === 0) return undefined;
  const index = Math.min(
    items.length - 1,
    Math.max(0, Math.floor(rng() * items.length)),
  );
  return items[index];
}

export function createRandomActorAppearance(
  kind: ScenarioEditorActorDraft["kind"],
  blueprints: ActorBlueprintLibrary = defaultBlueprints,
  fallbackBlueprint?: string | null,
  rng: () => number = Math.random,
): { blueprint: string; color: string | null } {
  if (kind === "walker") {
    return {
      blueprint:
        randomListItem(curatedPedestrianBlueprints, rng) ??
        blueprintForActorKind(kind, blueprints, fallbackBlueprint),
      color: null,
    };
  }

  if (kind !== "vehicle") {
    return {
      blueprint: blueprintForActorKind(kind, blueprints, fallbackBlueprint),
      color: defaultActorColor({ kind }),
    };
  }

  return {
    blueprint:
      randomListItem(blueprints.vehicles, rng) ??
      blueprintForActorKind(kind, blueprints, fallbackBlueprint),
    color:
      randomListItem(randomizableVehicleColorValues(vehicleColorValues), rng) ??
      defaultActorColor({ kind }),
  };
}

export function inferFreeformPathSpawnYaw(
  actor: Pick<
    ScenarioEditorActorDraft,
    | "kind"
    | "placement_mode"
    | "spawn_point"
    | "destination_point"
    | "path_placement"
    | "timed_waypoints"
    | "route_direction"
  >,
): number | null {
  const spawnPoint = actor.spawn_point;
  if (!spawnPoint) return null;

  const target =
    actor.placement_mode === "timed_path"
      ? (actor.timed_waypoints ?? []).find((waypoint) => {
          const dx = waypoint.x - spawnPoint.x;
          const dy = waypoint.y - spawnPoint.y;
          return Math.hypot(dx, dy) > 0.5;
        }) ?? null
      : null;

  if (!target) return null;
  const dx = target.x - spawnPoint.x;
  const dy = target.y - spawnPoint.y;
  if (Math.hypot(dx, dy) <= 0.5) return null;
  const yaw = (Math.atan2(dy, dx) * 180) / Math.PI;
  const firstSegmentDirection =
    target.direction === "reverse" ||
    (target.direction == null && actor.route_direction === "reverse")
      ? "reverse"
      : "forward";
  return actor.kind === "vehicle" && firstSegmentDirection === "reverse"
    ? normalizeYawDegrees(yaw + 180)
    : yaw;
}

function normalizeYawDegrees(yaw: number): number {
  let normalized = ((yaw % 360) + 360) % 360;
  if (normalized > 180) normalized -= 360;
  return normalized;
}

export function runtimeSpawnAnchorOrEmpty(
  runtimeRoadOverlay: RuntimeRoadOverlayCollection | null,
): ScenarioEditorActorDraft["spawn"] {
  const segment = runtimeRoadOverlay?.features.find(
    (feature) =>
      feature.properties.feature_kind === "lane_centerline" &&
      feature.properties.source === "runtime" &&
      feature.properties.section_id != null &&
      feature.properties.lane_id != null,
  );

  if (segment) {
    return {
      road_id: String(segment.properties.road_id),
      section_id: segment.properties.section_id ?? null,
      lane_id: segment.properties.lane_id ?? null,
      s_fraction: 0.5,
    };
  }

  return {
    road_id: "",
    s_fraction: 0.5,
    lane_id: null,
    section_id: null,
  };
}

export function isBaseNavigationAction(
  action: ScenarioEditorTimelineAction,
): action is Extract<ScenarioEditorTimelineAction, "follow_route" | "ram_actor"> {
  return (
    baseNavigationActions as readonly ScenarioEditorTimelineAction[]
  ).includes(action);
}

export function clipUsesSpeed(action: ScenarioEditorTimelineAction): boolean {
  return (
    action === "follow_route" ||
    action === "set_speed" ||
    action === "ram_actor"
  );
}

export function clipUsesTargetActor(
  action: ScenarioEditorTimelineAction,
): boolean {
  return action === "ram_actor";
}

export function timelineActionsForActor(
  actor: Pick<ScenarioEditorActorDraft, "kind" | "placement_mode" | "is_static">,
): ScenarioEditorTimelineAction[] {
  if (actor.kind === "prop" || actor.is_static || actor.placement_mode === "point")
    return [];
  if (actor.kind === "walker") return [];
  if (actor.placement_mode === "road") {
    return [
      "set_speed",
      "follow_route",
      "ram_actor",
    ];
  }
  return [];
}

export function defaultClipSpeedKphForActor(
  actor: Pick<ScenarioEditorActorDraft, "kind" | "role">,
): number {
  if (actor.kind === "walker") return defaultWalkerSpeedKph;
  return defaultVehicleSpeedKph;
}

export function speedSliderMaxForActor(
  actor: Pick<ScenarioEditorActorDraft, "kind">,
): number {
  if (actor.kind === "prop") return 0;
  return actor.kind === "walker" ? walkerSpeedLimitKph : vehicleSpeedLimitKph;
}

export function speedSliderStepForActor(
  actor: Pick<ScenarioEditorActorDraft, "kind">,
): number {
  return actor.kind === "walker" ? 0.5 : 1;
}

export function speedSliderMinForActor(
  actor: Pick<ScenarioEditorActorDraft, "kind">,
): number {
  if (actor.kind === "prop") return 0;
  return speedSliderStepForActor(actor);
}

export function formatSpeedKph(
  value: number,
  actor: Pick<ScenarioEditorActorDraft, "kind">,
): string {
  const mph = value * 0.621371;
  return actor.kind === "walker"
    ? `${value.toFixed(1)} kph · ${mph.toFixed(1)} mph`
    : `${Math.round(value)} kph · ${Math.round(mph)} mph`;
}

export function actorLaneFacing(
  actor: Pick<ScenarioEditorActorDraft, "lane_facing">,
): LaneFacingMode {
  return actor.lane_facing === "against_lane" ? "against_lane" : "with_lane";
}

export function actorRouteDirection(
  actor: Pick<ScenarioEditorActorDraft, "route_direction">,
): RouteDirectionMode {
  return actor.route_direction === "reverse" ? "reverse" : "forward";
}

// ---------------------------------------------------------------------------
// Timeline helpers
// ---------------------------------------------------------------------------

export function clipWithActionDefaults(
  actor: Pick<ScenarioEditorActorDraft, "kind" | "role">,
  clip: ScenarioEditorTimelineClip,
  action: ScenarioEditorTimelineAction,
): ScenarioEditorTimelineClip {
  const defaultSpeedKph = defaultClipSpeedKphForActor(actor);
  return {
    ...clip,
    action,
    target_speed_kph: clipUsesSpeed(action)
      ? (clip.target_speed_kph ?? defaultSpeedKph)
      : null,
    target_actor_id: clipUsesTargetActor(action)
      ? (clip.target_actor_id ?? null)
      : null,
  };
}

export function createTimelineClip(
  actor: ScenarioEditorActorDraft,
  time: number,
): ScenarioEditorTimelineClip {
  const action = timelineActionsForActor(actor)[0] ?? "set_speed";
  return clipWithActionDefaults(
    actor,
    {
      id: crypto.randomUUID(),
      start_time: Math.min(Math.max(1, time), timelineDurationSeconds),
      end_time: null,
      action,
      target_speed_kph: null,
      target_actor_id: null,
      enabled: true,
    },
    action,
  );
}

/**
 * Legacy-timeline helpers below take the RUNTIME actor shape: the legacy
 * `timeline` field left the persisted schema (wave 2b) and now only exists on
 * wire/runtime actors, where the payload boundary re-materializes it
 * (`expandLegacyWireActor`).
 */
export function sanitizeTimeline(
  actor: RuntimeScenarioEditorActor,
): ScenarioEditorTimelineClip[] {
  const allowed = new Set<ScenarioEditorTimelineAction>(
    timelineActionsForActor(actor),
  );
  for (const action of baseNavigationActions) {
    allowed.add(action);
  }
  return (actor.timeline ?? [])
    .filter((clip) => allowed.has(clip.action))
    .map((clip) =>
      clipWithActionDefaults(
        actor,
        {
          ...clip,
          start_time: Math.max(0, clip.start_time),
          end_time: null,
        },
        clip.action,
      ),
    )
    .sort((a, b) => a.start_time - b.start_time);
}

export function baseNavigationClip(
  actor: RuntimeScenarioEditorActor,
): ScenarioEditorTimelineClip | null {
  const clip = sanitizeTimeline(actor).find(
    (item) => item.start_time === 0 && isBaseNavigationAction(item.action),
  );
  return clip ?? null;
}

export function routePointSpeedKph(
  actor: ScenarioEditorActorDraft,
  pointIndex: number,
): number {
  const routePoint = actor.route[pointIndex];
  const speed = routePoint?.speed_kph;
  if (typeof speed === "number" && Number.isFinite(speed) && speed >= 0) {
    return speed;
  }
  return (
    baseNavigationClip(actor)?.target_speed_kph ??
    actor.speed_kph ??
    defaultClipSpeedKphForActor(actor)
  );
}

export function normalizeRoadFollowRouteActor(
  actor: RuntimeScenarioEditorActor,
): RuntimeScenarioEditorActor {
  const navigationClip = baseNavigationClip(actor);
  if (actor.placement_mode !== "road" || navigationClip?.action !== "follow_route") {
    return actor;
  }
  const navigationSpeedKph = navigationClip.target_speed_kph;
  const routeActor =
    typeof navigationSpeedKph === "number" &&
    Number.isFinite(navigationSpeedKph) &&
    navigationSpeedKph >= 0 &&
    actor.speed_kph !== navigationSpeedKph
      ? { ...actor, speed_kph: navigationSpeedKph }
      : actor;
  const speedClipsByRouteIndex = new Map<number, number>();
  for (const clip of routeActor.timeline ?? []) {
    if (clip.action !== "set_speed" || clip.enabled === false) continue;
    const routeIndex = Math.round(clip.start_time);
    if (routeIndex <= 0 || Math.abs(clip.start_time - routeIndex) > 1e-6) continue;
    const speed = clip.target_speed_kph;
    if (typeof speed === "number" && Number.isFinite(speed) && speed >= 0) {
      speedClipsByRouteIndex.set(routeIndex, speed);
    }
  }
  if (speedClipsByRouteIndex.size === 0) {
    return {
      ...routeActor,
      timeline: (routeActor.timeline ?? []).filter((clip) => clip.action !== "set_speed"),
    };
  }
  return {
    ...routeActor,
    route: routeActor.route.map((anchor, index) => {
      if (typeof anchor.speed_kph === "number" && anchor.speed_kph >= 0) return anchor;
      if (!speedClipsByRouteIndex.has(index)) return anchor;
      return { ...anchor, speed_kph: speedClipsByRouteIndex.get(index)! };
    }),
    timeline: (routeActor.timeline ?? []).filter((clip) => clip.action !== "set_speed"),
  };
}

export function pathSegmentSpeedKph(
  actor: Pick<ScenarioEditorActorDraft, "kind" | "speed_kph">,
  waypoint: Partial<Pick<ScenarioEditorTimedWaypoint, "speed_kph">>,
): number {
  const fallback =
    actor.speed_kph ?? (actor.kind === "walker" ? defaultWalkerSpeedKph : defaultVehicleSpeedKph);
  const value = waypoint.speed_kph;
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? value
    : fallback;
}

export function pathSegmentDirection(
  actor: Pick<ScenarioEditorActorDraft, "route_direction">,
  waypoint: Partial<Pick<ScenarioEditorTimedWaypoint, "direction">>,
): RouteDirectionMode {
  return waypoint.direction === "reverse" ||
    (waypoint.direction == null && actor.route_direction === "reverse")
    ? "reverse"
    : "forward";
}
