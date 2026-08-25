/**
 * Derived collision-point marker for the scenario editor's map overlay.
 *
 * The AI Search auto-scenario builder validates each draft against the
 * kinematic-v1 simulator, which records the EXACT contact point of the
 * intended pair. The validator output is not persisted on the editor draft
 * today (it lives in the server-side `ScenarioValidationReport` only), so
 * the editor recovers a useful approximation here: the closest-approach
 * point between two actors' planned polylines. When the two paths actually
 * intersect, the closest-approach point IS the intersection — same answer.
 * When they're parallel-but-close (sideswipe / cut-in geometry), the
 * midpoint between the closest segment pair is the natural mark.
 *
 * Diagnostic intent: the marker tells a user reviewing a draft "the planner
 * sent these two actors at this spot in space" — distinct from "the
 * scenario actually produced a collision in CARLA," which only the
 * downstream simulation can confirm. The UI renders it as a red X with no
 * "PASS" implication.
 *
 * Works on any draft with two or more actors carrying explicit timed paths,
 * including hand-authored ones.
 */

import { primaryActor, type MapAsset, type ScenarioEditorActorDraft } from "@simforge/studio-shared";
import { runtimePointToLngLat } from "@/app/lib/editor-map/coordinates";
import { lonLatToScene } from "@/app/components/city-viewer/geo-utils";
import {
  actorPlannedTrajectories,
  type PlannedActorTrajectory,
} from "./scenario-trajectories";

/**
 * Maximum closest-approach distance, in runtime meters, before we treat the
 * actor pair as "didn't meet" and suppress the marker. Picked from the
 * kinematic validator's `collision_in_region` tolerance band — same order
 * of magnitude as a single vehicle footprint plus a small slack, so a
 * genuine sideswipe (parallel lanes ~3.5m apart) registers but two cars
 * passing through a busy junction on independent routes does not.
 */
const MAX_CLOSEST_APPROACH_M = 8;

export type CollisionPointSource = "subject_vs_other" | "pairwise";

export interface DerivedCollisionPoint {
  /** Marker point in runtime-world meters. */
  point: { x: number; y: number };
  /** Closest-approach distance, m. 0 when the paths actually intersect. */
  distanceM: number;
  actorAId: string;
  actorBId: string;
  /** Picked by a subject-vs-other pairing when a sensor vehicle was present,
   *  else pairwise (lowest-distance across all pairs). Useful for explaining
   *  the marker in the debug panel. */
  source: CollisionPointSource;
}

function segmentClosestApproach(
  a1: { x: number; y: number },
  a2: { x: number; y: number },
  b1: { x: number; y: number },
  b2: { x: number; y: number },
): { distance: number; point: { x: number; y: number } } {
  // Parameterise both segments and minimise the squared distance between
  // their points. Closed-form solution (Real-Time Collision Detection §5.1).
  const dax = a2.x - a1.x;
  const day = a2.y - a1.y;
  const dbx = b2.x - b1.x;
  const dby = b2.y - b1.y;
  const rx = a1.x - b1.x;
  const ry = a1.y - b1.y;
  const a = dax * dax + day * day;
  const e = dbx * dbx + dby * dby;
  const f = dbx * rx + dby * ry;

  let s: number;
  let t: number;
  if (a <= 1e-12 && e <= 1e-12) {
    s = 0;
    t = 0;
  } else if (a <= 1e-12) {
    s = 0;
    t = Math.max(0, Math.min(1, f / e));
  } else {
    const c = dax * rx + day * ry;
    if (e <= 1e-12) {
      t = 0;
      s = Math.max(0, Math.min(1, -c / a));
    } else {
      const b = dax * dbx + day * dby;
      const denom = a * e - b * b;
      s =
        denom !== 0
          ? Math.max(0, Math.min(1, (b * f - c * e) / denom))
          : 0;
      t = (b * s + f) / e;
      if (t < 0) {
        t = 0;
        s = Math.max(0, Math.min(1, -c / a));
      } else if (t > 1) {
        t = 1;
        s = Math.max(0, Math.min(1, (b - c) / a));
      }
    }
  }

  const pa = { x: a1.x + dax * s, y: a1.y + day * s };
  const pb = { x: b1.x + dbx * t, y: b1.y + dby * t };
  return {
    distance: Math.hypot(pa.x - pb.x, pa.y - pb.y),
    point: { x: (pa.x + pb.x) / 2, y: (pa.y + pb.y) / 2 },
  };
}

function polylineClosestApproach(
  polyA: PlannedActorTrajectory["points"],
  polyB: PlannedActorTrajectory["points"],
): { distance: number; point: { x: number; y: number } } | null {
  if (polyA.length < 2 || polyB.length < 2) return null;
  let best: { distance: number; point: { x: number; y: number } } | null = null;
  for (let i = 1; i < polyA.length; i++) {
    for (let j = 1; j < polyB.length; j++) {
      const hit = segmentClosestApproach(
        polyA[i - 1]!,
        polyA[i]!,
        polyB[j - 1]!,
        polyB[j]!,
      );
      if (!best || hit.distance < best.distance) best = hit;
    }
  }
  return best;
}

/**
 * Pick a single diagnostic collision-point marker from the actors' planned
 * trajectories, or null when no pair comes within `MAX_CLOSEST_APPROACH_M`.
 *
 * Selection rule:
 *   1. If a sensor-carrying vehicle has a planned trajectory, evaluate it
 *      against every other trajectory and pick the lowest-distance pair. A
 *      reviewer debugging whether the camera vehicle met the conflicting actor
 *      cares about this measurement-centred answer.
 *   2. Otherwise evaluate every pair and pick the lowest-distance pair, which
 *      remains useful for incomplete and hand-authored drafts.
 */
export function deriveCollisionPoint(
  actors: ReadonlyArray<ScenarioEditorActorDraft> | null | undefined,
): DerivedCollisionPoint | null {
  if (!actors?.length) return null;
  const trajectories = actorPlannedTrajectories(actors);
  if (trajectories.length < 2) return null;

  const subjectActor = primaryActor(actors);
  const subjectTraj = subjectActor
    ? trajectories.find((trajectory) => trajectory.id === subjectActor.id)
    : undefined;

  let bestPair: { a: PlannedActorTrajectory; b: PlannedActorTrajectory; distance: number; point: { x: number; y: number } } | null = null;
  let source: CollisionPointSource = "pairwise";

  if (subjectTraj) {
    for (const other of trajectories) {
      if (other.id === subjectTraj.id) continue;
      const hit = polylineClosestApproach(subjectTraj.points, other.points);
      if (!hit) continue;
      if (!bestPair || hit.distance < bestPair.distance) {
        bestPair = { a: subjectTraj, b: other, ...hit };
        source = "subject_vs_other";
      }
    }
  }
  if (!bestPair) {
    for (let i = 0; i < trajectories.length; i++) {
      for (let j = i + 1; j < trajectories.length; j++) {
        const a = trajectories[i]!;
        const b = trajectories[j]!;
        const hit = polylineClosestApproach(a.points, b.points);
        if (!hit) continue;
        if (!bestPair || hit.distance < bestPair.distance) {
          bestPair = { a, b, ...hit };
          source = "pairwise";
        }
      }
    }
  }

  if (!bestPair) return null;
  if (bestPair.distance > MAX_CLOSEST_APPROACH_M) return null;
  return {
    point: bestPair.point,
    distanceM: bestPair.distance,
    actorAId: bestPair.a.id,
    actorBId: bestPair.b.id,
    source,
  };
}

/**
 * Project a derived collision point into lng/lat for the 2D MapLibre
 * overlay. Returns null when the point can't be projected (no map asset
 * frame).
 */
export function deriveCollisionPointLngLat(
  actors: ReadonlyArray<ScenarioEditorActorDraft> | null | undefined,
  asset: MapAsset | null,
): { lng: number; lat: number; distanceM: number } | null {
  if (!asset) return null;
  const derived = deriveCollisionPoint(actors);
  if (!derived) return null;
  const coords = runtimePointToLngLat(derived.point, asset);
  if (!coords) return null;
  return { lng: coords[0], lat: coords[1], distanceM: derived.distanceM };
}

/**
 * Project a derived collision point into 3D scene coordinates for the
 * CityViewer. Y is a placeholder; the viewer snaps to ground via
 * `sampleGroundY` just like proximity arrows + actor trajectories.
 */
export function deriveCollisionPointScene(
  actors: ReadonlyArray<ScenarioEditorActorDraft> | null | undefined,
  asset: MapAsset | null,
  originLon: number,
  originLat: number,
): { x: number; y: number; z: number; distanceM: number } | null {
  if (!asset) return null;
  const derived = deriveCollisionPoint(actors);
  if (!derived) return null;
  const coords = runtimePointToLngLat(derived.point, asset);
  if (!coords) return null;
  const scene = lonLatToScene(coords[0], coords[1], originLon, originLat, 0);
  return { x: scene.x, y: scene.y, z: scene.z, distanceM: derived.distanceM };
}
