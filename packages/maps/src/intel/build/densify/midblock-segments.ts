/**
 * Densification: a location every 50 m along every driving segment.
 *
 * The reason this exists at all: xodr roads on these maps average ~13 m, so the
 * search index's `street` objects are 13 m stubs — useless as "somewhere along
 * this road to put a car". Striding the *chains* at 50 m gives an evenly spaced,
 * content-addressed set of places that an anchor matcher and an LLM can both
 * reason about ("300 m of straight two-lane road with parking on the right").
 *
 * Identity is `rsl@round(s)` on the lane the sample lands on, not the sample's
 * ordinal, so adding a stride point or re-chaining a road does not renumber the
 * ones either side of it.
 */

import { asLocationId } from '../../types/ids.js';
import type { Affordance, FactValue, LocationType } from '../../types/location.js';
import type { Segment } from '../../types/topology.js';
import { anchorFacts, anchorOnLane } from '../anchor-lift.js';
import { type BuildContext, roadNameFor } from '../context.js';
import type { LocationDraft } from '../draft.js';
import { makeLocationIdString } from '../hash.js';
import { crossSectionAt, distanceToJunctionM, poseAlongSegment } from '../segments.js';
import { compass8, slugify } from '../slug.js';

const TYPE: LocationType = 'midblock_segment';

/** Stride between midblock samples, metres. */
export const MIDBLOCK_STRIDE_M = 50;

/** Segments shorter than this get a single sample at their midpoint. */
const MIN_SEGMENT_LENGTH_M = 12;

/** One draft per 50 m of every driving chain. */
export function densifyMidblockSegments(
  ctx: BuildContext,
  segments: readonly Segment[],
): LocationDraft[] {
  const mapId = ctx.sources.mapId as string;
  const out: LocationDraft[] = [];
  const seen = new Set<string>();

  for (const segment of segments) {
    if (segment.lengthM < MIN_SEGMENT_LENGTH_M) continue;
    const offsets = strideOffsets(segment.lengthM);
    for (const s of offsets) {
      const pose = poseAlongSegment(ctx, segment, s);
      if (!pose) continue;
      // A point inside a junction is a movement, not a midblock location.
      if (pose.isJunction) continue;
      const lane = ctx.graph.get(pose.rsl as string);
      if (!lane) continue;

      // Identity is the lane + quantised arc length, never the ordinal.
      const identityKey = `${pose.rsl}@${Math.round(pose.localS)}`;
      if (seen.has(identityKey)) continue;
      seen.add(identityKey);

      const lift = anchorOnLane(ctx, pose.rsl as string, pose.localS);
      if (!lift) continue;

      const cross = crossSectionAt(ctx, lane);
      const roadName = roadNameFor(ctx, pose.rsl as string);
      const toEntry = s;
      const toExit = segment.lengthM - s;
      const distanceToJunction = distanceToJunctionM(segment, s);

      const facts: Record<string, FactValue> = {
        lanes_same_dir: cross.sameDir,
        lanes_opposing: cross.opposing,
        speed_limit_kph: lane.speedLimitKph ?? 0,
        lane_width_m: Math.round(ctx.graph.widthAt(lane, pose.localS) * 100) / 100,
        curvature_deg_per_10m:
          Math.round(ctx.graph.curvatureDegPer10mAt(lane, pose.localS) * 100) / 100,
        distance_to_junction_m: Number.isFinite(distanceToJunction)
          ? Math.round(distanceToJunction * 10) / 10
          : -1,
        has_parking_adjacent: cross.parking,
        has_bike_adjacent: cross.biking,
        has_sidewalk_adjacent: cross.sidewalk,
        has_shoulder_adjacent: cross.shoulder,
        is_one_way: cross.opposing === 0,
        road_name: roadName,
        segment_length_m: segment.lengthM,
        runway_upstream_m: Math.round(toEntry * 10) / 10,
        runway_downstream_m: Math.round(toExit * 10) / 10,
        ...anchorFacts(lift.anchor),
      };

      const tags = ['MIDBLOCK'];
      if (cross.parking) tags.push('MIDBLOCK_WITH_PARKING');
      if (cross.opposing === 0) tags.push('ONE_WAY');
      if (cross.sameDir >= 2) tags.push('MULTILANE');
      if ((facts['curvature_deg_per_10m'] as number) < 1) tags.push('STRAIGHT');

      const affordances: Affordance[] = ['route', 'vehicleSpawn', 'propPlacement'];
      if (cross.biking) affordances.push('cyclistSpawn');
      if (cross.sidewalk) affordances.push('pedestrianSpawn');

      const bearing = anchorFacts(lift.anchor)['anchor_heading_deg'] as number;
      out.push({
        id: asLocationId(makeLocationIdString(mapId, TYPE, identityKey)),
        name: roadName
          ? `${roadName} midblock (${compass8(bearing)}bound)`
          : `Midblock segment ${identityKey}`,
        type: TYPE,
        tags: tags.sort(),
        anchor: lift.anchor,
        affordances: [...new Set(affordances)].sort(),
        facts,
        provenance: [{ source: 'topology-index', ref: pose.rsl as string, confidence: 1 }],
        quality: { anchor: 'exact', confidence: 1 },
        naming: {
          stems: [slugify(roadName ? `${roadName}-${compass8(bearing)}` : `midblock-${identityKey}`)],
          roadNames: roadName ? [roadName] : [],
        },
        identityKey,
      });
    }
  }
  return out;
}

/** Sample offsets along a chain: 50 m stride, biased to sit off the endpoints. */
function strideOffsets(lengthM: number): number[] {
  if (lengthM < MIDBLOCK_STRIDE_M) return [lengthM / 2];
  const n = Math.floor(lengthM / MIDBLOCK_STRIDE_M);
  const out: number[] = [];
  for (let i = 0; i < n; i++) out.push(MIDBLOCK_STRIDE_M / 2 + i * MIDBLOCK_STRIDE_M);
  return out;
}
