/**
 * Ghost signal heads for armed intersection-control placement (plan 2026-07-26,
 * section 6.1).
 *
 * The preview a candidate gets in 3D is the REAL geometry at the REAL poses,
 * rendered translucent and lit with the tableau placement would actually write.
 * That is why this module builds its heads by calling `buildMap3DSignalHeads`
 * with an empty plan list rather than by re-deriving poses: the entire pose
 * pipeline — the stop-line facing, the `light_boxes` lamp count, the height
 * clamp — is shared with the real heads by construction, so a ghost cannot
 * stand anywhere a real head would not, and a ghost solidifying on placement
 * does not move.
 *
 * An empty plan list resolves every head to `{ state: "green", authored: false }`
 * (`resolveHeadLampState`), which is exactly the forced-green seed placement
 * writes (`seedForcedGreenProgram`). The ghost therefore shows the truth, not a
 * decoration.
 *
 * ## Where this lives
 *
 * In `signals/` rather than `map-3d/` because it is the CANDIDATE half of the
 * seam: candidates in, instances out. The renderer half — the
 * `signal:ghost:<role>` shared material set and the ghost-aware reconciliation
 * signature — lives in `layers/map-3d-scene.ts` and reads the `ghost`/`hovered`
 * flags this module sets.
 */

import {
  buildMap3DSignalHeads,
  type Map3DSignalHead,
  type Map3DSignalHeadSource,
} from "@/app/lib/scenario-editor/map-3d/signal-head-model";
import type { IntersectionCandidate } from "./intersection-candidates";

/** A ghost is a `Map3DSignalHead` with `ghost` pinned on. */
export type CandidateGhostHead = Map3DSignalHead & { ghost: true };

export type BuildCandidateGhostHeadsInput = {
  candidates: readonly IntersectionCandidate[];
  /** Junction currently hovered, or null. Its ghosts light brighter. */
  hoveredJunctionId: string | null;
  /** Runtime-frame centre ghosts are ranked against; beyond `radiusM` they drop. */
  center: { x: number; y: number } | null;
  radiusM: number;
  /**
   * The head budget LEFT OVER after the real heads have taken theirs. Real heads
   * keep priority within `MAP_3D_MAX_SIGNAL_HEADS`; ghosts fill the remainder,
   * so the worst case is a distant candidate showing a 2D badge and no ghost —
   * degraded, not broken (risk R2).
   */
  maxHeads?: number;
};

const DEFAULT_GHOST_HEAD_BUDGET = 120;

/**
 * Ghost heads for the armed candidate set, nearest-first within `radiusM`.
 *
 * Already-controlled candidates are skipped: their heads are drawn for real by
 * `buildMap3DSignalHeads` off their authored plan, and drawing a ghost on top
 * would double the geometry at one pose.
 *
 * The hovered junction's ghosts are admitted ahead of everything else, so
 * pointing at a candidate always lights it even when the budget is exhausted —
 * hover is the identity affordance, and a hover that does nothing is worse than
 * a distant candidate that never renders.
 */
export function buildCandidateGhostHeads({
  candidates,
  hoveredJunctionId,
  center,
  radiusM,
  maxHeads = DEFAULT_GHOST_HEAD_BUDGET,
}: BuildCandidateGhostHeadsInput): CandidateGhostHead[] {
  if (maxHeads <= 0) return [];

  const radiusSquared = radiusM * radiusM;
  const ranked: Array<{ head: CandidateGhostHead; hovered: boolean; distanceSquared: number }> =
    [];

  for (const candidate of candidates) {
    if (candidate.controlled) continue;
    if (candidate.lights.length === 0) continue;
    const dx = center ? candidate.center.x - center.x : 0;
    const dy = center ? candidate.center.y - center.y : 0;
    const distanceSquared = dx * dx + dy * dy;
    const hovered = candidate.junctionId === hoveredJunctionId;
    if (center && !hovered && distanceSquared > radiusSquared) continue;

    // `center: null` disables the builder's own distance filter — the candidate
    // has already been accepted or rejected as a whole, and splitting one
    // junction's heads across the radius boundary would draw half an
    // intersection.
    const heads = buildMap3DSignalHeads({
      sources: candidate.lights.map(
        (light) => light.source as Map3DSignalHeadSource,
      ),
      plans: [],
      timestampSeconds: 0,
      center: null,
      radiusM: Number.POSITIVE_INFINITY,
      maxHeads: candidate.lights.length,
    });
    for (const head of heads) {
      ranked.push({
        hovered,
        distanceSquared,
        head: {
          ...head,
          key: `ghost-${candidate.junctionId}-${head.key}`,
          junctionId: candidate.junctionId,
          ghost: true,
          hovered,
        },
      });
    }
  }

  ranked.sort(
    (left, right) =>
      Number(right.hovered) - Number(left.hovered) ||
      left.distanceSquared - right.distanceSquared,
  );
  return ranked.slice(0, maxHeads).map((entry) => entry.head);
}
