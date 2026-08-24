/**
 * Densification: places a work zone could plausibly be staged.
 *
 * Criteria, per `docs/research/location-catalog.md`: **straight + flat +
 * ≥2 lanes same direction + shoulder + no junction within 80 m**. These are
 * point properties, evaluated on a stride along each corridor, and *all* of
 * them must hold — "worst value over the interval, not mean". `usable_length_m`
 * then reports the contiguous run around the point over which they continue to
 * hold, which is what a consumer actually needs in order to decide whether a
 * taper plus a closed lane will fit.
 *
 * **Data reality check.** The 80 m junction clearance is severe on these maps:
 * they are dense urban and campus grids where a corridor crosses a junction
 * every 50–100 m, and the measured longest 80 m-clear *run* is 30 m on Yale and
 * zero on the other four. Read as a run constraint the criterion yields an
 * empty layer everywhere; read as the point constraint the doc actually states,
 * it yields a small, genuinely-selective set. Both thresholds are exported
 * constants so a consumer can re-derive with its own numbers rather than
 * discovering ours by surprise.
 *
 * Grade is the one criterion the topology index cannot answer (its lane
 * polylines are 2D). It is taken from the search index's `grade_pct` on the
 * nearest object when available, and treated as satisfied otherwise rather than
 * silently rejecting every candidate on maps whose search index omits it.
 */

import { asLocationId } from '../../types/ids.js';
import type { Affordance, FactValue, LocationType } from '../../types/location.js';
import type { Segment } from '../../types/topology.js';
import { anchorFacts, anchorOnLane } from '../anchor-lift.js';
import { type BuildContext, roadNameFor } from '../context.js';
import type { LocationDraft } from '../draft.js';
import { makeLocationIdString } from '../hash.js';
import { crossSectionAt, distanceToJunctionM, poseAlongSegment } from '../segments.js';
import { slugify } from '../slug.js';

const TYPE: LocationType = 'work_zone_suitable';

/** Thresholds. Exported so consumers can re-derive with their own numbers. */
export const WORK_ZONE_MAX_CURVATURE_DEG_PER_10M = 2;
/** @see WORK_ZONE_MAX_CURVATURE_DEG_PER_10M */
export const WORK_ZONE_MIN_LANES_SAME_DIR = 2;
/** @see WORK_ZONE_MAX_CURVATURE_DEG_PER_10M */
export const WORK_ZONE_JUNCTION_CLEARANCE_M = 80;
/** @see WORK_ZONE_MAX_CURVATURE_DEG_PER_10M */
export const WORK_ZONE_MAX_GRADE_PCT = 4;
/** Stride between work-zone candidate points, metres. */
export const WORK_ZONE_STRIDE_M = 25;

/** Lattice used for both candidacy and the `usable_length_m` run measurement. */
const LATTICE_M = 5;

/** One draft per qualifying point along a corridor. */
export function densifyWorkZones(ctx: BuildContext, segments: readonly Segment[]): LocationDraft[] {
  const mapId = ctx.sources.mapId as string;
  const out: LocationDraft[] = [];
  const seen = new Set<string>();

  for (const segment of segments) {
    if (!segment.hasShoulderAdjacent) continue;
    if (segment.maxLanesSameDir < WORK_ZONE_MIN_LANES_SAME_DIR) continue;

    const qualifies = (s: number): boolean => {
      if (distanceToJunctionM(segment, s) < WORK_ZONE_JUNCTION_CLEARANCE_M) return false;
      const sample = nearestProfileSample(segment, s);
      if (!sample) return false;
      if (sample.curvatureDegPer10m > WORK_ZONE_MAX_CURVATURE_DEG_PER_10M) return false;
      if (sample.lanesSameDir < WORK_ZONE_MIN_LANES_SAME_DIR) return false;
      return true;
    };

    for (let s = WORK_ZONE_STRIDE_M / 2; s < segment.lengthM; s += WORK_ZONE_STRIDE_M) {
      if (!qualifies(s)) continue;
      const pose = poseAlongSegment(ctx, segment, s);
      if (!pose || pose.isJunction) continue;
      const lane = ctx.graph.get(pose.rsl as string);
      if (!lane) continue;

      const grade = nearestGradePct(ctx, pose.x, pose.y);
      if (grade !== null && Math.abs(grade) > WORK_ZONE_MAX_GRADE_PCT) continue;

      const identityKey = `${pose.rsl}@${Math.round(pose.localS)}`;
      if (seen.has(identityKey)) continue;
      seen.add(identityKey);

      const lift = anchorOnLane(ctx, pose.rsl as string, pose.localS);
      if (!lift) continue;

      const cross = crossSectionAt(ctx, lane);
      const roadName = roadNameFor(ctx, pose.rsl as string);
      const usableLength = contiguousRunM(segment, s, qualifies);
      const clearance = distanceToJunctionM(segment, s);

      const facts: Record<string, FactValue> = {
        usable_length_m: Math.round(usableLength * 10) / 10,
        lanes_same_dir: cross.sameDir,
        lanes_opposing: cross.opposing,
        speed_limit_kph: lane.speedLimitKph ?? 0,
        lane_width_m: Math.round(ctx.graph.widthAt(lane, pose.localS) * 100) / 100,
        curvature_deg_per_10m:
          Math.round(ctx.graph.curvatureDegPer10mAt(lane, pose.localS) * 100) / 100,
        distance_to_junction_m: Number.isFinite(clearance) ? Math.round(clearance) : -1,
        has_shoulder_adjacent: true,
        has_parking_adjacent: cross.parking,
        has_bike_adjacent: cross.biking,
        has_sidewalk_adjacent: cross.sidewalk,
        is_one_way: cross.opposing === 0,
        road_name: roadName,
        segment_length_m: segment.lengthM,
        ...anchorFacts(lift.anchor),
      };
      if (grade !== null) facts['grade_pct'] = grade;

      const affordances: Affordance[] = ['propPlacement', 'route', 'vehicleSpawn'];

      out.push({
        id: asLocationId(makeLocationIdString(mapId, TYPE, identityKey)),
        name: roadName ? `Work-zone-suitable stretch on ${roadName}` : 'Work-zone-suitable stretch',
        type: TYPE,
        tags: ['WORK_ZONE_SUITABLE', 'STRAIGHT', 'MULTILANE', 'SHOULDER_PRESENT'].sort(),
        anchor: lift.anchor,
        affordances: affordances.sort(),
        facts,
        provenance: [{ source: 'topology-index', ref: segment.id as string, confidence: 0.85 }],
        quality: { anchor: 'exact', confidence: 0.85 },
        naming: {
          stems: [slugify(roadName ? `${roadName}-work-zone` : 'work-zone')],
          roadNames: roadName ? [roadName] : [],
        },
        identityKey,
      });
    }
  }
  return out;
}

/** Profile sample nearest a given arc length. */
function nearestProfileSample(
  segment: Segment,
  s: number,
): Segment['profile'][number] | undefined {
  let best: Segment['profile'][number] | undefined;
  let bestD = Infinity;
  for (const sample of segment.profile) {
    const d = Math.abs(sample.s - s);
    if (d < bestD) {
      bestD = d;
      best = sample;
    }
  }
  return bestD <= PROFILE_NEAREST_TOLERANCE_M ? best : undefined;
}

/** How far a profile sample may be from the query point to be representative. */
const PROFILE_NEAREST_TOLERANCE_M = 12;

/** Length of the contiguous qualifying run containing `s`. */
function contiguousRunM(
  segment: Segment,
  s: number,
  qualifies: (s: number) => boolean,
): number {
  let lo = s;
  while (lo - LATTICE_M >= 0 && qualifies(lo - LATTICE_M)) lo -= LATTICE_M;
  let hi = s;
  while (hi + LATTICE_M <= segment.lengthM && qualifies(hi + LATTICE_M)) hi += LATTICE_M;
  return hi - lo;
}

/** Grade at a point, from whichever search-index object carries one nearby. */
function nearestGradePct(ctx: BuildContext, x: number, y: number): number | null {
  const objects = ctx.sources.searchIndex?.objects;
  if (!objects) return null;
  let best: number | null = null;
  let bestD = 120;
  for (const key of Object.keys(objects).sort()) {
    const obj = objects[key];
    if (!obj) continue;
    const grade = obj.facts?.['grade_pct'];
    if (typeof grade !== 'number') continue;
    const local = ctx.toLocal(obj.centroid[0], obj.centroid[1]);
    const d = Math.hypot(local.x - x, local.y - y);
    if (d < bestD) {
      bestD = d;
      best = grade;
    }
  }
  return best;
}
