/**
 * Planned actor trajectories for the map-assets panel.
 *
 * When a scenario draft carries explicit timed paths, this module turns those
 * actors into:
 *
 *   - a 2D GeoJSON overlay for `MapAssetsMap` (lng/lat LineStrings), and
 *   - 3D scene-space polylines for the CityViewer (meters, lon/lat-local).
 *
 * It is intentionally map-panel-scoped and free of any scenario-editor
 * imports — only the shared draft type, the runtime↔lng/lat projector, and
 * the 3D scene projector.
 */

import type { MapAsset, ScenarioEditorActorDraft } from "@simforge/studio-shared";
import { runtimePointToLngLat } from "@/app/lib/editor-map/coordinates";
import { lonLatToScene } from "@/app/lib/maps/frontend/city-scene-coordinates"
import { deriveActorColor } from "@/app/lib/scenario-editor/actor-color";

type RuntimePoint = { x: number; y: number };

export type PlannedActorTrajectory = {
  id: string;
  label: string;
  color: string;
  /** Ordered spawn → … → destination runtime-meter points (≥2). */
  points: RuntimePoint[];
};

function actorTrajectoryColor(actor: ScenarioEditorActorDraft): string {
  return deriveActorColor({
    actorId: actor.id,
    kind: actor.kind === "vehicle" || actor.kind === "walker" || actor.kind === "prop"
      ? actor.kind
      : "vehicle",
    role: actor.role ?? "traffic",
    isStatic: Boolean(actor.is_static),
    authoredColor: actor.color,
  });
}

function orderedRuntimePoints(
  actor: ScenarioEditorActorDraft,
): RuntimePoint[] {
  const points: RuntimePoint[] = [];
  if (actor.spawn_point) {
    points.push({ x: actor.spawn_point.x, y: actor.spawn_point.y });
  }
  if (actor.placement_mode === "timed_path") {
    for (const wp of actor.timed_waypoints ?? []) {
      points.push({ x: wp.x, y: wp.y });
    }
  }
  // Drop consecutive duplicates so degenerate authored points don't create
  // zero-length segments.
  return points.filter(
    (p, i) => i === 0 || p.x !== points[i - 1]!.x || p.y !== points[i - 1]!.y,
  );
}

/**
 * Extract each actor's planned trajectory as ordered runtime-meter points.
 * Only `timed_path` actors carry an explicit authored polyline; `road`/`point`
 * actors are skipped.
 */
export function actorPlannedTrajectories(
  actors: ReadonlyArray<ScenarioEditorActorDraft> | null | undefined,
): PlannedActorTrajectory[] {
  if (!actors?.length) return [];
  const out: PlannedActorTrajectory[] = [];
  for (const actor of actors) {
    if (actor.placement_mode !== "timed_path") {
      continue;
    }
    const points = orderedRuntimePoints(actor);
    if (points.length < 2) continue;
    out.push({
      id: actor.id,
      label: actor.label ?? actor.id,
      color: actorTrajectoryColor(actor),
      points,
    });
  }
  return out;
}

type FeatureCollection = {
  type: "FeatureCollection";
  features: Array<{
    type: "Feature";
    geometry:
      | { type: "LineString"; coordinates: Array<[number, number]> }
      | { type: "Point"; coordinates: [number, number] }
      | { type: "Polygon"; coordinates: Array<Array<[number, number]>> };
    properties: Record<string, unknown>;
  }>;
};

/**
 * 2D overlay: one LineString per actor (+ a start marker) in lng/lat, for
 * `MapAssetsMap`'s GeoJSON layer plumbing.
 */
/**
 * A small triangular arrowhead (lng/lat ring) at `spawn`, pointing along
 * `spawn → next` — the actor's initial heading. Rendered as a filled
 * polygon, NOT a text/glyph, because self-hosted maplibre fonts don't
 * include arrow glyphs (▲ etc. silently fail to render). Returns null when
 * the two points coincide (no derivable heading).
 */
const HEADING_LEN_M = 4;
const HEADING_HALF_W_M = 1.5;

function headingArrowRing(
  [lon1, lat1]: [number, number],
  [lon2, lat2]: [number, number],
): Array<[number, number]> | null {
  const latRad = (lat1 * Math.PI) / 180;
  const mPerDegLat = 111320;
  const mPerDegLon = 111320 * Math.max(Math.cos(latRad), 1e-6);

  // Forward vector in local meters (east, north).
  const ex = (lon2 - lon1) * mPerDegLon;
  const ny = (lat2 - lat1) * mPerDegLat;
  const len = Math.hypot(ex, ny);
  if (len < 1e-3) return null;
  const ux = ex / len;
  const uy = ny / len;
  // Left perpendicular.
  const px = -uy;
  const py = ux;

  const toLngLat = (mEast: number, mNorth: number): [number, number] => [
    lon1 + mEast / mPerDegLon,
    lat1 + mNorth / mPerDegLat,
  ];

  const tip = toLngLat(ux * HEADING_LEN_M, uy * HEADING_LEN_M);
  const baseL = toLngLat(px * HEADING_HALF_W_M, py * HEADING_HALF_W_M);
  const baseR = toLngLat(-px * HEADING_HALF_W_M, -py * HEADING_HALF_W_M);
  return [baseL, tip, baseR, baseL];
}

export function buildActorTrajectoryGeoJSON(
  actors: ReadonlyArray<ScenarioEditorActorDraft> | null | undefined,
  asset: MapAsset | null,
): FeatureCollection | null {
  if (!asset) return null;
  const trajectories = actorPlannedTrajectories(actors);
  if (trajectories.length === 0) return null;

  const features: FeatureCollection["features"] = [];
  for (const traj of trajectories) {
    const lngLat = traj.points
      .map((p) => runtimePointToLngLat(p, asset))
      .filter((c): c is [number, number] => c != null);
    if (lngLat.length < 2) continue;
    features.push({
      type: "Feature",
      geometry: { type: "LineString", coordinates: lngLat },
      properties: {
        id: `${traj.id}-trajectory-line`,
        label: traj.label,
        color: traj.color,
        kind: "actor-trajectory-line",
      },
    });
    features.push({
      type: "Feature",
      geometry: { type: "Point", coordinates: lngLat[0]! },
      properties: {
        id: `${traj.id}-trajectory-start`,
        label: traj.label,
        color: traj.color,
        kind: "actor-trajectory-start",
      },
    });
    // Initial-heading arrowhead: a filled triangle at the spawn pointing
    // along the first path segment (the direction the actor faces).
    const headingRing = headingArrowRing(lngLat[0]!, lngLat[1]!);
    if (headingRing) {
      features.push({
        type: "Feature",
        geometry: { type: "Polygon", coordinates: [headingRing] },
        properties: {
          id: `${traj.id}-trajectory-heading`,
          color: traj.color,
          kind: "actor-trajectory-heading",
        },
      });
    }
  }
  if (features.length === 0) return null;
  return { type: "FeatureCollection", features };
}

export type SceneTrajectory = {
  id: string;
  color: string;
  /** Scene-space points; y is a placeholder — the viewer snaps to ground. */
  points: Array<{ x: number; y: number; z: number }>;
};

/**
 * 3D: project each planned trajectory into CityViewer scene space
 * (runtime → lng/lat → lon/lat-local meters), mirroring how proximity
 * arrows are projected on the detail page.
 */
export function buildActorTrajectoryScenePaths(
  actors: ReadonlyArray<ScenarioEditorActorDraft> | null | undefined,
  asset: MapAsset | null,
  originLon: number,
  originLat: number,
): SceneTrajectory[] {
  if (!asset) return [];
  const trajectories = actorPlannedTrajectories(actors);
  const out: SceneTrajectory[] = [];
  for (const traj of trajectories) {
    const scenePoints = traj.points
      .map((p) => runtimePointToLngLat(p, asset))
      .filter((c): c is [number, number] => c != null)
      .map(([lng, lat]) => lonLatToScene(lng, lat, originLon, originLat, 0));
    if (scenePoints.length < 2) continue;
    out.push({ id: traj.id, color: traj.color, points: scenePoints });
  }
  return out;
}
