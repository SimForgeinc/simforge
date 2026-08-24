/**
 * Anchor-lift: join an arbitrary point onto the lane graph.
 *
 * This is the step the prior system never took. Its candidates carry lat/lng
 * only, so roughly half of them were searchable but not draftable — an
 * authorability cliff the UI could not hide. Every record in this catalog gets
 * a road anchor or an explicit `unanchored` marker; nothing is silently
 * half-placeable.
 *
 * Quality bands (distance from the subject point to the lane centreline):
 *
 * | band        | distance   | meaning                                            |
 * |-------------|------------|----------------------------------------------------|
 * | `exact`     | ≤ 2 m      | the subject *is* on that lane (or was derived from it) |
 * | `projected` | ≤ 25 m     | a real projection — a frontage across the sidewalk  |
 * | `inferred`  | ≤ 150 m    | a plausible association, e.g. a building set back   |
 * | `unanchored`| beyond     | `road` is `null`; the record stays searchable only  |
 *
 * `exact` is also asserted directly by derivations that *start* from a lane
 * (junction movements, midblock segments) via `forceQuality`.
 */

import { asGateId, asJunctionId, asLaneRef } from '../types/ids.js';
import type { AnchorQuality, LocationAnchor, RoadAnchor } from '../types/location.js';
import type { LaneHit, NearestLaneOptions } from '../geometry/lane-graph.js';
import { headingToBearingDeg, type Point2 } from '../geometry/vec.js';
import type { BuildContext } from './context.js';

/** Distance bands, metres. */
export const ANCHOR_EXACT_M = 2;
/** @see ANCHOR_EXACT_M */
export const ANCHOR_PROJECTED_M = 25;
/** @see ANCHOR_EXACT_M */
export const ANCHOR_INFERRED_M = 150;

/** Options for {@link liftAnchor}. */
export interface LiftOptions extends NearestLaneOptions {
  /** Override the derived quality (for lane-derived locations). */
  forceQuality?: AnchorQuality;
  /** Gate this anchor realises, if any. */
  gateId?: string;
}

/** Classify a lift distance. */
export function qualityForDistance(distanceM: number): AnchorQuality {
  if (distanceM <= ANCHOR_EXACT_M) return 'exact';
  if (distanceM <= ANCHOR_PROJECTED_M) return 'projected';
  if (distanceM <= ANCHOR_INFERRED_M) return 'inferred';
  return 'unanchored';
}

/** Turn a nearest-lane hit into a {@link RoadAnchor}. */
export function anchorFromHit(hit: LaneHit, gateId?: string): RoadAnchor {
  const anchor: RoadAnchor = {
    rsl: asLaneRef(hit.rsl as string),
    s: round(hit.s, 3),
    offsetM: round(hit.offsetM, 3),
    headingRad: round(hit.headingRad, 6),
    laneType: hit.lane.laneType,
    distanceM: round(hit.distanceM, 3),
  };
  if (hit.lane.junctionId) anchor.junctionId = asJunctionId(hit.lane.junctionId as string);
  if (gateId) anchor.gateId = asGateId(gateId);
  if (hit.lane.speedLimitKph != null) anchor.speedLimitKph = hit.lane.speedLimitKph;
  return anchor;
}

/** Result of a lift. */
export interface LiftResult {
  anchor: LocationAnchor;
  quality: AnchorQuality;
}

/**
 * Lift a point in xodr-local metres onto the lane graph and produce the full
 * three-level anchor.
 */
export function liftAnchor(ctx: BuildContext, p: Point2, opts: LiftOptions = {}): LiftResult {
  const hit = ctx.graph.nearestLane(p, {
    maxDistanceM: opts.maxDistanceM ?? ANCHOR_INFERRED_M,
    laneTypes: opts.laneTypes,
    excludeJunctionInternal: opts.excludeJunctionInternal,
    onlyRsls: opts.onlyRsls,
  });
  const road = hit ? anchorFromHit(hit, opts.gateId) : null;
  const quality: AnchorQuality =
    opts.forceQuality ?? (road ? qualityForDistance(road.distanceM) : 'unanchored');
  return {
    anchor: { geo: ctx.toGeo(p), scene: ctx.toScene(p), road },
    quality,
  };
}

/**
 * Lift a point that is *known* to belong to a specific lane — used by every
 * derivation that walks the lane graph itself, where "nearest" would be a
 * needless round trip through geometry we already have.
 */
export function anchorOnLane(
  ctx: BuildContext,
  rsl: string,
  s: number,
  offsetM = 0,
  gateId?: string,
): LiftResult | null {
  const lane = ctx.graph.get(rsl);
  if (!lane) return null;
  const pose = ctx.graph.poseAt(rsl, s);
  if (!pose) return null;
  const point =
    offsetM === 0
      ? pose.point
      : {
          x: pose.point.x - Math.sin(pose.headingRad) * offsetM,
          y: pose.point.y + Math.cos(pose.headingRad) * offsetM,
        };
  const anchor: RoadAnchor = {
    rsl: asLaneRef(rsl),
    s: round(s, 3),
    offsetM: round(offsetM, 3),
    headingRad: round(pose.headingRad, 6),
    laneType: lane.laneType,
    distanceM: Math.abs(round(offsetM, 3)),
  };
  if (lane.junctionId) anchor.junctionId = asJunctionId(lane.junctionId as string);
  if (gateId) anchor.gateId = asGateId(gateId);
  if (lane.speedLimitKph != null) anchor.speedLimitKph = lane.speedLimitKph;
  return {
    anchor: { geo: ctx.toGeo(point), scene: ctx.toScene(point), road: anchor },
    quality: 'exact',
  };
}

/** Facts every anchored location carries, written by this module alone. */
export function anchorFacts(anchor: LocationAnchor): Record<string, number | string> {
  if (!anchor.road) return {};
  return {
    anchor_distance_m: round(anchor.road.distanceM, 2),
    lane_type: anchor.road.laneType,
    anchor_heading_deg: round(headingToBearingDeg(anchor.road.headingRad), 1),
  };
}

/** Round to a fixed number of decimals — keeps emitted JSON byte-stable. */
export function round(value: number, decimals: number): number {
  const f = 10 ** decimals;
  return Math.round(value * f) / f;
}
