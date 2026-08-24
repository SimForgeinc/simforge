/**
 * Anchor-lift sanity.
 *
 * The bar: a record's road anchor must round-trip. Take the anchor's `(rsl, s,
 * offsetM)`, evaluate it against the lane graph, and you must land back where
 * the record says it is — within centimetres. Everything downstream (spawn
 * poses, `LanePosition` export, runway checks) assumes exactly that, and a
 * quiet sign error in the lateral offset would not show up anywhere else until
 * a car spawned in oncoming traffic.
 */

import { describe, expect, it } from 'vitest';

import { buildMapIntel } from '../build/build.js';
import { anchorOnLane, liftAnchor, qualityForDistance } from '../build/anchor-lift.js';
import { createBuildContext } from '../build/context.js';
import { headingToBearingDeg } from '../geometry/vec.js';
import { miniYaleSources } from './helpers.js';

const sources = miniYaleSources();
const ctx = createBuildContext(sources);
const build = buildMapIntel(miniYaleSources());

describe('quality bands', () => {
  it('classifies by distance', () => {
    expect(qualityForDistance(0)).toBe('exact');
    expect(qualityForDistance(2)).toBe('exact');
    expect(qualityForDistance(2.01)).toBe('projected');
    expect(qualityForDistance(25)).toBe('projected');
    expect(qualityForDistance(25.01)).toBe('inferred');
    expect(qualityForDistance(150.01)).toBe('unanchored');
  });
});

describe('lifting a point onto the lane graph', () => {
  it('finds the lane a lane point sits on, at the right arc length', () => {
    const lane = ctx.graph.allLanes().find((l) => l.laneType === 'driving' && l.lengthM > 8);
    expect(lane).toBeDefined();
    if (!lane) return;
    const target = lane.lengthM / 2;
    const pose = ctx.graph.poseAt(lane.rsl as string, target);
    expect(pose).toBeDefined();
    if (!pose) return;

    const lift = liftAnchor(ctx, pose.point, { laneTypes: ['driving'] });
    expect(lift.quality).toBe('exact');
    expect(lift.anchor.road).not.toBeNull();
    expect(lift.anchor.road?.distanceM).toBeLessThan(0.05);
    // The nearest lane may be a parallel same-geometry lane only if it is
    // literally coincident; arc length must match regardless.
    expect(lift.anchor.road?.s ?? -1).toBeCloseTo(target, 1);
  });

  it('signs the lateral offset left-positive', () => {
    const lane = ctx.graph.allLanes().find((l) => l.laneType === 'driving' && l.lengthM > 20);
    expect(lane).toBeDefined();
    if (!lane) return;
    const pose = ctx.graph.poseAt(lane.rsl as string, 10);
    if (!pose) return;
    // Step 1 m to the lane's left.
    const left = {
      x: pose.point.x - Math.sin(pose.headingRad),
      y: pose.point.y + Math.cos(pose.headingRad),
    };
    const lift = liftAnchor(ctx, left, { onlyRsls: new Set([lane.rsl as string]) });
    expect(lift.anchor.road?.offsetM ?? 0).toBeGreaterThan(0.9);

    const right = {
      x: pose.point.x + Math.sin(pose.headingRad),
      y: pose.point.y - Math.cos(pose.headingRad),
    };
    const liftRight = liftAnchor(ctx, right, { onlyRsls: new Set([lane.rsl as string]) });
    expect(liftRight.anchor.road?.offsetM ?? 0).toBeLessThan(-0.9);
  });

  it('reports `unanchored` far from any road', () => {
    const lift = liftAnchor(ctx, { x: 1_000_000, y: 1_000_000 });
    expect(lift.quality).toBe('unanchored');
    expect(lift.anchor.road).toBeNull();
  });

  it('round-trips anchorOnLane', () => {
    const lane = ctx.graph.allLanes().find((l) => l.lengthM > 10);
    if (!lane) return;
    const lift = anchorOnLane(ctx, lane.rsl as string, 5, 1.25);
    expect(lift).not.toBeNull();
    expect(lift?.anchor.road?.rsl).toBe(lane.rsl);
    expect(lift?.anchor.road?.s).toBeCloseTo(5, 3);
    expect(lift?.anchor.road?.offsetM).toBeCloseTo(1.25, 3);
    expect(lift?.quality).toBe('exact');
  });
});

describe('anchors on built records', () => {
  it('round-trips every anchored record to its own coordinates', () => {
    let checked = 0;
    for (const loc of build.catalog.locations) {
      const road = loc.anchor.road;
      if (!road) continue;
      const pose = ctx.graph.poseAt(road.rsl as string, road.s);
      expect(pose).toBeDefined();
      if (!pose) continue;
      const expected = {
        x: pose.point.x - Math.sin(pose.headingRad) * road.offsetM,
        y: pose.point.y + Math.cos(pose.headingRad) * road.offsetM,
      };
      const actual = ctx.toLocal(loc.anchor.geo.lng, loc.anchor.geo.lat);
      // The lift stores the *subject's* point, and `offsetM` is the lateral
      // component of the vector from the lane to it, so the reconstruction is
      // exact for lane-derived records and within the projection residual for
      // lifted ones. Both are bounded by the recorded distance.
      const residual = Math.hypot(actual.x - expected.x, actual.y - expected.y);
      expect(residual).toBeLessThanOrEqual(Math.max(0.25, road.distanceM * 1.01));
      checked += 1;
    }
    expect(checked).toBeGreaterThan(100);
  });

  it('anchors every junction movement exactly, on a junction-internal lane', () => {
    const movements = build.catalog.locations.filter((l) => l.type === 'junction_movement');
    expect(movements.length).toBeGreaterThan(20);
    for (const m of movements) {
      expect(m.quality.anchor).toBe('exact');
      expect(m.anchor.road).not.toBeNull();
      expect(m.anchor.road?.junctionId).toBeDefined();
      expect(m.anchor.road?.gateId).toBeDefined();
      const lane = ctx.graph.get(m.anchor.road?.rsl as string);
      expect(lane?.isJunction).toBe(true);
    }
  });

  it('anchors every midblock sample on a non-junction driving lane', () => {
    const midblocks = build.catalog.locations.filter((l) => l.type === 'midblock_segment');
    expect(midblocks.length).toBeGreaterThan(0);
    for (const m of midblocks) {
      expect(m.quality.anchor).toBe('exact');
      const lane = ctx.graph.get(m.anchor.road?.rsl as string);
      expect(lane?.isJunction).toBe(false);
      expect(lane?.laneType).toBe('driving');
    }
  });

  it('strips spawn affordances from unplaceable records', () => {
    for (const loc of build.catalog.locations) {
      if (loc.anchor.road) continue;
      expect(loc.affordances).not.toContain('vehicleSpawn');
      expect(loc.quality.anchor).toBe('unanchored');
    }
  });

  it('publishes the anchor heading as a compass bearing', () => {
    for (const loc of build.catalog.locations) {
      const road = loc.anchor.road;
      if (!road) continue;
      expect(loc.facts['anchor_heading_deg']).toBeCloseTo(
        Math.round(headingToBearingDeg(road.headingRad) * 10) / 10,
        1,
      );
    }
  });

  it('places scene coordinates in the y-up frame with sampled ground height', () => {
    const anchored = build.catalog.locations.filter((l) => l.anchor.road);
    expect(anchored.length).toBeGreaterThan(0);
    for (const loc of anchored.slice(0, 50)) {
      const local = ctx.toLocal(loc.anchor.geo.lng, loc.anchor.geo.lat);
      expect(loc.anchor.scene.x).toBeCloseTo(local.x, 2);
      expect(loc.anchor.scene.z).toBeCloseTo(-local.y, 2);
      // Yale sits around 10–30 m elevation; a zero would mean the elevation
      // field never got populated.
      expect(loc.anchor.scene.y).toBeGreaterThan(1);
    }
  });
});
