/**
 * Line of sight against the coarse occluder set.
 *
 * Occluders are the L3 "temporary modifications" layer — parked rows, a
 * double-parked truck, a hedge — supplied as OBBs on `SimScenarioInput`. This
 * is deliberately a *2-D* test on the ground plane: heights are carried but not
 * used, because the metric that matters (reveal-to-conflict) is dominated by
 * plan-view geometry and a 3-D test would need render meshes the engine
 * refuses to depend on.
 *
 * `visible(a, to: b)` is true when the segment between the two actors' centres
 * clears every occluder. Actors do not occlude each other (a queue of cars is
 * modelled by placing occluder boxes, which is what the prop layer emits).
 */

import { obbCorners, segmentIntersection, type Obb, type Vec2 } from '../core/math.js';
import { localFromScene } from '../frames.js';
import type { Occluder } from '../schema/input.js';

export interface OccluderShape {
  readonly id: string;
  readonly groupId?: string;
  readonly obb: Obb;
  readonly heightM: number;
  readonly corners: readonly Vec2[];
}

/** Convert scene-frame occluders from the input into local-frame shapes. */
export function buildOccluders(occluders: readonly Occluder[]): OccluderShape[] {
  return [...occluders]
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
    .map((o) => {
      const obb: Obb = {
        center: localFromScene(o.obb.center),
        lengthM: o.obb.lengthM,
        widthM: o.obb.widthM,
        headingRad: o.obb.headingRad,
      };
      return { id: o.id, ...(o.groupId === undefined ? {} : { groupId: o.groupId }), obb, heightM: o.obb.heightM, corners: obbCorners(obb) };
    });
}

/** `true` when the segment `a → b` is not blocked by any occluder. */
export function hasLineOfSight(
  a: Vec2,
  b: Vec2,
  occluders: readonly OccluderShape[],
  maxRangeM = Infinity,
): boolean {
  if (Math.hypot(b.x - a.x, b.y - a.y) > maxRangeM) return false;
  for (const occ of occluders) {
    const c = occ.corners;
    for (let i = 0; i < c.length; i++) {
      const p = c[i]!;
      const q = c[(i + 1) % c.length]!;
      if (segmentIntersection(a, b, p, q) !== null) return false;
    }
  }
  return true;
}

/** The blocking occluder id, or `null` — used for explainability in the UI. */
export function blockingOccluder(
  a: Vec2,
  b: Vec2,
  occluders: readonly OccluderShape[],
): string | null {
  let best: { id: string; t: number } | null = null;
  for (const occ of occluders) {
    const c = occ.corners;
    for (let i = 0; i < c.length; i++) {
      const t = segmentIntersection(a, b, c[i]!, c[(i + 1) % c.length]!);
      if (t !== null && (best === null || t < best.t)) best = { id: occ.id, t };
    }
  }
  return best?.id ?? null;
}
