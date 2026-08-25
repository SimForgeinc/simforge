/**
 * Per-actor spawn-point overlays for the map-detail page's 2D + 3D views.
 *
 * Companion to `scenario-trajectories.ts` (which emits the polylines) and
 * `scenario-collision-point.ts` (which emits the red-X marker). Same input
 * (`ScenarioEditorActorDraft[]`), same map-asset projection, same per-id
 * color contract through `deriveActorColor` — different geometry: one
 * marker per actor at its spawn pose.
 *
 * The 2D path projects to lng/lat for `react-map-gl` Markers (rendered as
 * the editor's `ActorIcon` SVGs); the 3D path projects to scene meters
 * for a CityViewer mesh per actor (a colored box for vehicles, a capsule
 * for walkers).
 */

import type { MapAsset, ScenarioEditorActorDraft } from "@simcloud/shared";
import { runtimePointToLngLat } from "@/app/lib/editor-map/coordinates";
import { lonLatToScene } from "@/app/lib/maps/frontend/city-scene-coordinates"
import { deriveActorColor } from "@/app/lib/scenario-editor/actor-color";
import { inferFreeformPathSpawnYaw } from "@/app/lib/scenario-editor/actor-utils";

export type ActorSpawnKind = "vehicle" | "walker" | "prop";

/**
 * Normalize a yaw value (degrees) into (−180, 180].
 * Mirrors the unexported `normalizeYawDegrees` in actor-utils.ts.
 */
function normalizeYawDeg(yaw: number): number {
  let normalized = ((yaw % 360) + 360) % 360;
  if (normalized > 180) normalized -= 360;
  return normalized;
}

/**
 * Derive the actor's heading in DEGREES from its draft, matching the logic
 * used by `useScenarioEditorMapModel.authoredActorRotation`:
 *
 *  - For `timed_path` actors the heading is inferred from the first
 *    waypoint that is >0.5 m past the spawn (via `inferFreeformPathSpawnYaw`).
 *  - Otherwise `spawn_yaw` (which is stored in DEGREES) is used directly.
 *
 * Returns null when no heading information is available.
 */
export function actorHeadingDeg(
  actor: Pick<
    ScenarioEditorActorDraft,
    | "kind"
    | "placement_mode"
    | "spawn_point"
    | "spawn_yaw"
    | "destination_point"
    | "path_placement"
    | "timed_waypoints"
    | "route_direction"
  >,
): number | null {
  const pathYaw =
    actor.placement_mode === "timed_path"
      ? inferFreeformPathSpawnYaw(actor)
      : null;
  const yaw = pathYaw ?? (typeof actor.spawn_yaw === "number" ? actor.spawn_yaw : null);
  return yaw; // DEGREES — caller applies the vehicle/walker frame offset
}

export interface PlannedActorSpawn {
  id: string;
  label: string;
  kind: ActorSpawnKind;
  /** Final hex color from `deriveActorColor` — matches the trajectory line. */
  color: string;
  blueprint: string | null;
  /** Authored spawn heading in DEGREES when present; null when unknown. The
   *  2D + 3D renderers each map this into their own frame's rotation. */
  headingDeg: number | null;
  /** Runtime-meter spawn position (the canonical frame the actor draft
   *  itself is authored in). */
  point: { x: number; y: number };
}

function normalizeKind(value: unknown): ActorSpawnKind {
  if (value === "walker") return "walker";
  if (value === "prop") return "prop";
  return "vehicle";
}

/**
 * Extract the spawn-point overlay records from a draft's actor list.
 * Skips actors without a resolvable spawn point (a random-traffic region
 * or a `road`-anchored actor that hasn't been projected yet).
 *
 * Color resolution goes through the shared `deriveActorColor` helper so
 * the marker matches its trajectory line and stays distinct from the
 * red collision X.
 */
export function actorPlannedSpawns(
  actors: ReadonlyArray<ScenarioEditorActorDraft> | null | undefined,
): PlannedActorSpawn[] {
  if (!actors?.length) return [];
  const out: PlannedActorSpawn[] = [];
  for (const actor of actors) {
    if (!actor.spawn_point) continue;
    out.push({
      ...actorSpawnIdentity(actor),
      point: { x: actor.spawn_point.x, y: actor.spawn_point.y },
    });
  }
  return out;
}

/** The per-actor fields that do not depend on how the pose was resolved. */
function actorSpawnIdentity(
  actor: ScenarioEditorActorDraft,
): Omit<PlannedActorSpawn, "point"> {
  const kind = normalizeKind(actor.kind);
  return {
    id: actor.id,
    label: actor.label ?? actor.id,
    kind,
    color: deriveActorColor({
      actorId: actor.id,
      kind,
      role: actor.role ?? "traffic",
      isStatic: Boolean(actor.is_static),
      authoredColor: actor.color,
    }),
    blueprint: actor.blueprint ?? null,
    headingDeg: actorHeadingDeg(actor),
  };
}

export interface ActorSpawn2D {
  id: string;
  label: string;
  kind: ActorSpawnKind;
  color: string;
  blueprint: string | null;
  /** Rotation in DEGREES for the 2D map (clockwise from north — matches
   *  the `RuntimeActorLayers` convention). Vehicles apply `90° - headingDeg`
   *  so the icon's nose points along travel (mirrors `authoredActorRotation`).
   *  Walkers use `headingDeg` directly. Null when no heading is available. */
  rotationDeg: number | null;
  lng: number;
  lat: number;
}

/**
 * Project each spawn into lng/lat for the 2D MapLibre overlay. Returns an
 * empty array when the asset is null (no coordinate frame to project in).
 */
export function buildActorSpawns2D(
  actors: ReadonlyArray<ScenarioEditorActorDraft> | null | undefined,
  asset: MapAsset | null,
): ActorSpawn2D[] {
  if (!asset) return [];
  const out: ActorSpawn2D[] = [];
  for (const spawn of actorPlannedSpawns(actors)) {
    const lngLat = runtimePointToLngLat(spawn.point, asset);
    if (!lngLat) continue;
    const rotationDeg =
      spawn.headingDeg == null
        ? null
        : spawn.kind === "vehicle"
          ? normalizeYawDeg(90 - spawn.headingDeg)
          : normalizeYawDeg(spawn.headingDeg);
    out.push({
      id: spawn.id,
      label: spawn.label,
      kind: spawn.kind,
      color: spawn.color,
      blueprint: spawn.blueprint,
      rotationDeg,
      lng: lngLat[0],
      lat: lngLat[1],
    });
  }
  return out;
}

export interface ActorSpawn3D {
  id: string;
  label: string;
  kind: ActorSpawnKind;
  color: string;
  /** Yaw in radians for the 3D scene-frame box / capsule. The CityViewer
   *  renderer rotates the primitive around its Y axis by this value when
   *  non-null; null leaves the primitive axis-aligned.
   *
   *  NOTE: The 3D scene's rotation frame convention / offset is a separate,
   *  unverified concern.  This field corrects only the gross units error
   *  (degrees stored as if they were radians); visual perfection in 3D
   *  is not claimed. */
  yawRad: number | null;
  /** Scene-space spawn point; y is a placeholder the viewer snaps to
   *  ground via `sampleGroundY`, same as proximity arrows + trajectories. */
  point: { x: number; y: number; z: number };
}

/**
 * Project each spawn into scene coords for the 3D CityViewer. Returns an
 * empty array when the asset or its coordinate reference is missing.
 */
export function buildActorSpawns3D(
  actors: ReadonlyArray<ScenarioEditorActorDraft> | null | undefined,
  asset: MapAsset | null,
  originLon: number,
  originLat: number,
): ActorSpawn3D[] {
  if (!asset) return [];
  const out: ActorSpawn3D[] = [];
  for (const spawn of actorPlannedSpawns(actors)) {
    const lngLat = runtimePointToLngLat(spawn.point, asset);
    if (!lngLat) continue;
    const scene = lonLatToScene(lngLat[0], lngLat[1], originLon, originLat, 0);
    out.push({
      id: spawn.id,
      label: spawn.label,
      kind: spawn.kind,
      color: spawn.color,
      yawRad: spawn.headingDeg == null ? null : (spawn.headingDeg * Math.PI) / 180,
      point: { x: scene.x, y: scene.y, z: scene.z },
    });
  }
  return out;
}
