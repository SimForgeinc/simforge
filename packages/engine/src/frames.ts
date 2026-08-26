/**
 * The one place the two coordinate frames meet.
 *
 * ## The choice
 *
 * The engine computes **entirely in the xodr-local frame**: `x` east, `y`
 * north, `z` up, metres, headings CCW from `+x`. That is the frame the
 * `topology-index.json.gz` lane polylines are already expressed in, so route
 * arc-length, curvature and OBB overlap all happen without a per-tick
 * transform.
 *
 * The **scene frame** (what `@simforge-oss/viewer` and the studio
 * viewport use) is y-up: `scene = (x, z, -y)`. `headingRad` is numerically
 * identical in both frames — a rotation of `+X` about scene `+Y` and a rotation
 * of `+X` about local `+Z` describe the same direction under that mapping
 * (guarded by `frame-convention.test.ts` in `@simforge-oss/scenario`).
 *
 * ## Where each frame appears
 *
 * | Surface | Frame |
 * |---|---|
 * | `SimScenarioInput` poses / points / occluder OBBs | **scene** `{x, z}` |
 * | Everything inside the engine | **xodr-local** `{x, y}` |
 * | `SimTrace.ticks` (`header.frame === 'xodr-local'`) | **xodr-local** `{x, y}` |
 *
 * Inputs are flipped once on ingest; traces are emitted local and flipped by
 * the consumer (`toSceneXZ`) or wholesale via `traceToSceneFrame`.
 */

import type { Vec2 } from './core/math.js';

/** A point in the y-up scene frame, ground plane only. */
export interface SceneXZ {
  readonly x: number;
  readonly z: number;
}

/** scene `{x, z}` → xodr-local `{x, y}`. */
export function localFromScene(p: SceneXZ): Vec2 {
  return { x: p.x, y: -p.z };
}

/** xodr-local `{x, y}` → scene `{x, z}`. */
export function toSceneXZ(p: Vec2): SceneXZ {
  return { x: p.x, z: -p.y };
}

/** Headings are frame-invariant under this mapping; this documents that. */
export function sceneHeading(localHeadingRad: number): number {
  return localHeadingRad;
}
