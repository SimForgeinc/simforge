/**
 * Camera-fit bounds + target for a highlighted AI-proposed scenario.
 *
 * Companion to `scenario-trajectories.ts`, `scenario-collision-point.ts`,
 * and `scenario-actor-spawns.ts`: same input (`ScenarioEditorActorDraft[]`,
 * map asset, optional 3D origin), different output — the camera-fit
 * primitives the 2D MapLibre map (`fitBounds`) and the 3D CityViewer
 * (`focusTarget`) consume.
 *
 * Bounds are computed over the union of:
 *   - every actor's spawn point,
 *   - every trajectory waypoint,
 *   - the derived collision point (when present).
 *
 * Mirrors how `resolvePlaceHighlight` produces a bounds + focusTarget for
 * a clicked POI, so the click-to-focus UX for scenario drafts matches the
 * existing POI flow rather than feeling like a separate concept.
 */

import type { MapAsset, ScenarioEditorActorDraft } from "@simforge/studio-shared";
import { runtimePointToLngLat } from "@/app/lib/editor-map/coordinates";
import { lonLatToScene } from "@/app/components/city-viewer/geo-utils";
import { actorPlannedTrajectories } from "./scenario-trajectories";
import { actorPlannedSpawns } from "./scenario-actor-spawns";
import { deriveCollisionPoint } from "./scenario-collision-point";

/** Min / max orbit radius — kept in sync with `geo-utils.ts` so the 3D
 *  fly-to behaves the same way as a POI click. */
const MIN_ORBIT_RADIUS_M = 50;
const MAX_ORBIT_RADIUS_M = 500;
/** Padding factor applied to the bounding-radius before clamping. Gives
 *  the camera some breathing room around the outermost actor / endpoint. */
const FOCUS_RADIUS_PADDING = 1.35;

/**
 * Smallest span the 2D fit will frame, in metres.
 *
 * A new scenario is a single starter subject standing on one lane, so its raw
 * bounds are a POINT. Framing that literally asks MapLibre for its maximum
 * zoom; framing it with the old ~11 m halo does the same.
 *
 * 40 m was picked by measuring, not by feel: with the ~110 px of edge padding
 * `fitToBounds` adds, a 1138 × 692 map canvas lands at zoom ~19.2, showing
 * ~100 m × 60 m of ground with the car ~50 px long — about 4.5% of the map
 * width, which matches the framing the editor was asked for. 60 m measured
 * ~150 m × 91 m and read as too far out.
 */
const MIN_FOCUS_SPAN_METERS = 40;
const METERS_PER_DEGREE_LAT = 111_320;

/** Grow a degenerate or very tight axis to `minSpan`, keeping its centre. */
function expandToMinimumSpan(
  min: number,
  max: number,
  minSpan: number,
): [number, number] {
  if (max - min >= minSpan) return [min, max];
  const center = (min + max) / 2;
  return [center - minSpan / 2, center + minSpan / 2];
}

export interface ScenarioFocus2D {
  /** Closed `[[minLng, minLat], [maxLng, maxLat]]` bbox the 2D map can
   *  hand straight to `fitBounds`. */
  bounds: [[number, number], [number, number]];
}

export interface ScenarioFocus3D {
  /** Scene-space centroid the 3D camera orbits around. */
  position: { x: number; y: number; z: number };
  /** Orbit radius in metres. Clamped to the same band the POI focus uses. */
  radius: number;
}

interface RuntimePoint {
  x: number;
  y: number;
}

/**
 * Collect the runtime-meter points the camera should frame for a
 * scenario: every actor's spawn, every trajectory waypoint, and the
 * derived collision point. Returns an empty array when nothing useful
 * is present so callers can early-out cleanly.
 */
function collectScenarioPoints(
  actors: ReadonlyArray<ScenarioEditorActorDraft> | null | undefined,
): RuntimePoint[] {
  const points: RuntimePoint[] = [];
  if (!actors?.length) return points;
  for (const spawn of actorPlannedSpawns(actors)) {
    points.push({ x: spawn.point.x, y: spawn.point.y });
  }
  for (const traj of actorPlannedTrajectories(actors)) {
    for (const p of traj.points) points.push({ x: p.x, y: p.y });
  }
  const collision = deriveCollisionPoint(actors);
  if (collision) {
    points.push({ x: collision.point.x, y: collision.point.y });
  }
  return points;
}

/**
 * Compute a 2D `fitBounds` target framing every actor + trajectory +
 * the collision point. Returns null when the scenario has no
 * resolvable points OR the asset can't project them.
 */
export function buildScenarioFocus2D(
  actors: ReadonlyArray<ScenarioEditorActorDraft> | null | undefined,
  asset: MapAsset | null,
  /**
   * Already-projected positions to include, for actors whose spawn is not a
   * runtime point. A road-placed actor — every seeded starter subject — carries
   * `spawn_point: null` and an OpenDRIVE `spawn: {road_id, lane_id, ...}`
   * instead, so `collectScenarioPoints` finds nothing for it; the editor
   * resolves those to lng/lat when it places the marker, and passes them here.
   * Without this the fit had nothing to frame on a new scenario and silently
   * did nothing at all.
   */
  extraLngLat: ReadonlyArray<[number, number]> = [],
): ScenarioFocus2D | null {
  if (!asset) return null;
  const points = collectScenarioPoints(actors);
  if (points.length === 0 && extraLngLat.length === 0) return null;

  const projected: Array<[number, number]> = [...extraLngLat];
  for (const p of points) {
    const lngLat = runtimePointToLngLat(p, asset);
    if (lngLat) projected.push(lngLat);
  }
  return focusBoundsFromLngLat(projected);
}

/**
 * Bbox over already-projected points, floored at `MIN_FOCUS_SPAN_METERS`.
 * Exported so callers holding lng/lat (editor actor markers) get exactly the
 * framing `buildScenarioFocus2D` gives runtime points.
 */
export function focusBoundsFromLngLat(
  points: ReadonlyArray<[number, number]>,
): ScenarioFocus2D | null {
  let minLng = Infinity;
  let maxLng = -Infinity;
  let minLat = Infinity;
  let maxLat = -Infinity;
  for (const [lng, lat] of points) {
    if (!Number.isFinite(lng) || !Number.isFinite(lat)) continue;
    if (lng < minLng) minLng = lng;
    if (lng > maxLng) maxLng = lng;
    if (lat < minLat) minLat = lat;
    if (lat > maxLat) maxLat = lat;
  }
  if (!Number.isFinite(minLng) || !Number.isFinite(minLat)) return null;

  // A single actor with no trajectory is a point, and even a short authored
  // path is metres across, so both axes get a floor rather than only the
  // exactly-degenerate case.
  const centerLat = (minLat + maxLat) / 2;
  const minLatSpanDeg = MIN_FOCUS_SPAN_METERS / METERS_PER_DEGREE_LAT;
  const cosLat = Math.max(Math.cos((centerLat * Math.PI) / 180), 0.01);
  const minLngSpanDeg = minLatSpanDeg / cosLat;
  [minLng, maxLng] = expandToMinimumSpan(minLng, maxLng, minLngSpanDeg);
  [minLat, maxLat] = expandToMinimumSpan(minLat, maxLat, minLatSpanDeg);

  return {
    bounds: [
      [minLng, minLat],
      [maxLng, maxLat],
    ],
  };
}

/**
 * Compute a 3D `focusTarget` framing every actor + trajectory + the
 * collision point. Returns null when no points resolve or the asset's
 * coordinate reference is incomplete.
 */
export function buildScenarioFocus3D(
  actors: ReadonlyArray<ScenarioEditorActorDraft> | null | undefined,
  asset: MapAsset | null,
  originLon: number,
  originLat: number,
): ScenarioFocus3D | null {
  if (!asset) return null;
  const points = collectScenarioPoints(actors);
  if (points.length === 0) return null;

  const scenePoints: { x: number; y: number; z: number }[] = [];
  for (const p of points) {
    const lngLat = runtimePointToLngLat(p, asset);
    if (!lngLat) continue;
    scenePoints.push(
      lonLatToScene(lngLat[0], lngLat[1], originLon, originLat, 0),
    );
  }
  if (scenePoints.length === 0) return null;

  let sumX = 0;
  let sumZ = 0;
  for (const sp of scenePoints) {
    sumX += sp.x;
    sumZ += sp.z;
  }
  const centroid = {
    x: sumX / scenePoints.length,
    y: 0, // camera-fit doesn't need a real ground Y; orbit math is XZ-based.
    z: sumZ / scenePoints.length,
  };

  let maxDist = 0;
  for (const sp of scenePoints) {
    const d = Math.hypot(sp.x - centroid.x, sp.z - centroid.z);
    if (d > maxDist) maxDist = d;
  }
  const radius = Math.max(
    MIN_ORBIT_RADIUS_M,
    Math.min(MAX_ORBIT_RADIUS_M, maxDist * FOCUS_RADIUS_PADDING),
  );

  return { position: centroid, radius };
}
