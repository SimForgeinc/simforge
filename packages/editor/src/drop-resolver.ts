/**
 * The single place road semantics are applied to a *committed* actor position.
 *
 * Drops (release of a direct move), pastes and duplicate commits all resolve
 * through here, and — deliberately — nothing else does. While a gesture is in
 * flight the actor follows the cursor freely; only the commit asks "what does
 * the road say about this point?". The rule:
 *
 * - A road-bound motor vehicle re-resolves the nearest driving lane within
 *   {@link DROP_SNAP_RADIUS_M} and snaps to it: position on the lane, heading
 *   aligned with lane travel, authored lateral offset preserved (clamped to
 *   what the lane can hold).
 * - No lane in range, or no usable runtime route from the lane, places the
 *   actor **free** — never refuses. A free road vehicle is "unanchored": hosts
 *   surface a badge and a one-click re-snap ({@link RESNAP_RADIUS_M}).
 * - Pedestrians and props are always free, ground-height sampled by the caller.
 */

import type { LaneAnchor } from './document';
import type { LaneIndex } from './laneIndex';

/** How far a drop looks for a lane before placing the vehicle free, metres. */
export const DROP_SNAP_RADIUS_M = 8;
/** Deliberate one-click re-snap is generous: the author asked for a lane. */
export const RESNAP_RADIUS_M = 30;

/** Aggregate feedback colour for an in-flight drag. */
export type DropOutcome = 'snapped' | 'free' | 'invalid';

export interface ResolveVehicleDropOptions {
  /** Authored lateral offset to preserve inside the resolved lane, metres. */
  preferredLateralM?: number;
  /** Heading kept when the drop resolves free. */
  fallbackHeadingRad?: number;
  /** Body width, used to clamp the lateral offset inside the lane. */
  bodyWidthM?: number;
  /** Search radius override; defaults to {@link DROP_SNAP_RADIUS_M}. */
  radiusM?: number;
  /** Reject a lane whose anchor cannot start a runtime route. */
  routeUsable?: (anchor: LaneAnchor) => boolean;
}

export interface ResolvedDrop {
  readonly outcome: 'snapped' | 'free';
  readonly x: number;
  readonly z: number;
  readonly headingRad: number;
  readonly laneRef: LaneAnchor | null;
}

/**
 * Resolve a road vehicle's drop point. Total: every input produces a
 * placement — `snapped` onto a usable lane, otherwise `free` at the exact
 * requested point.
 */
export function resolveVehicleDrop(
  laneIndex: LaneIndex,
  x: number,
  z: number,
  options: ResolveVehicleDropOptions = {},
): ResolvedDrop {
  const radius = options.radiusM ?? DROP_SNAP_RADIUS_M;
  const free: ResolvedDrop = {
    outcome: 'free',
    x,
    z,
    headingRad: options.fallbackHeadingRad ?? 0,
    laneRef: null,
  };
  const hit = laneIndex.nearestForVehiclePlacement(x, z, radius);
  if (!hit) return free;
  const limit = laneIndex.lateralLimit(hit.lane, options.bodyWidthM ?? 0);
  const t = Math.max(-limit, Math.min(limit, options.preferredLateralM ?? 0));
  const anchor: LaneAnchor = {
    roadId: hit.lane.roadId,
    section: hit.lane.section,
    laneId: hit.lane.laneId,
    s: hit.s,
    t,
    headingOffsetRad: 0,
  };
  if (options.routeUsable && !options.routeUsable(anchor)) return free;
  const pose = laneIndex.poseAt(hit.lane, hit.s, t);
  return {
    outcome: 'snapped',
    x: pose.x,
    z: pose.z,
    headingRad: pose.headingRad,
    laneRef: anchor,
  };
}
