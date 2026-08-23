/**
 * Segment (corridor) chaining.
 *
 * The single most important property: **every link in a chain must be
 * geometrically contiguous**. The topology index's `predecessors`/`successors`
 * are not travel-directed — lanes routinely list the same neighbour in both
 * arrays, and list lanes that are nowhere near their endpoints — so a chain
 * built by trusting those lists would produce corridors that teleport. Every
 * consumer of `runwayDownstreamM` depends on this being real.
 */

import { describe, expect, it } from 'vitest';

import { buildMapIntel } from '../build/build.js';
import { createBuildContext } from '../build/context.js';
import { buildSegments, CHAIN_GAP_TOLERANCE_M, distanceToJunctionM } from '../build/segments.js';
import { miniYaleSources } from './helpers.js';

const ctx = createBuildContext(miniYaleSources());
const segments = buildSegments(ctx);
const build = buildMapIntel(miniYaleSources());

describe('segment chaining', () => {
  it('produces corridors', () => {
    expect(segments.length).toBeGreaterThan(0);
    expect(Math.max(...segments.map((s) => s.lengthM))).toBeGreaterThan(50);
  });

  it('links only geometrically contiguous lanes', () => {
    for (const segment of segments) {
      for (let i = 0; i + 1 < segment.laneRefs.length; i++) {
        const a = ctx.graph.get(segment.laneRefs[i] as string);
        const b = ctx.graph.get(segment.laneRefs[i + 1] as string);
        expect(a).toBeDefined();
        expect(b).toBeDefined();
        if (!a || !b) continue;
        const end = ctx.graph.endOf(a);
        const start = ctx.graph.startOf(b);
        expect(Math.hypot(end.x - start.x, end.y - start.y)).toBeLessThanOrEqual(
          CHAIN_GAP_TOLERANCE_M,
        );
      }
    }
  });

  it('assigns each lane to exactly one segment', () => {
    const seen = new Set<string>();
    for (const segment of segments) {
      for (const lane of segment.laneRefs) {
        expect(seen.has(lane as string)).toBe(false);
        seen.add(lane as string);
      }
    }
  });

  it('keeps laneStartS consistent with the lane lengths', () => {
    for (const segment of segments) {
      expect(segment.laneStartS.length).toBe(segment.laneRefs.length);
      expect(segment.laneStartS[0]).toBe(0);
      let acc = 0;
      for (let i = 0; i < segment.laneRefs.length; i++) {
        expect(segment.laneStartS[i]).toBeCloseTo(acc, 2);
        acc += ctx.graph.get(segment.laneRefs[i] as string)?.lengthM ?? 0;
      }
      expect(segment.lengthM).toBeCloseTo(acc, 1);
    }
  });

  it('only traverses junctions via straight-through movements', () => {
    const straightConnecting = new Set(
      ctx.sources.topology.gates
        .filter((g) => g.turnRelation === 'Straight')
        .map((g) => g.connectingLaneRsl),
    );
    for (const segment of segments) {
      for (const lane of segment.junctionLaneRefs) {
        expect(straightConnecting.has(lane as string)).toBe(true);
      }
      // A chain made only of junction lanes is a movement, not a corridor.
      expect(segment.junctionLaneRefs.length).toBeLessThan(segment.laneRefs.length);
    }
  });

  it('records where along the chain each junction sits', () => {
    for (const segment of segments) {
      for (const interval of segment.junctionIntervals) {
        expect(interval.endS).toBeGreaterThan(interval.startS);
        expect(interval.startS).toBeGreaterThanOrEqual(0);
        expect(interval.endS).toBeLessThanOrEqual(segment.lengthM + 0.5);
        expect(distanceToJunctionM(segment, (interval.startS + interval.endS) / 2)).toBe(0);
      }
      const withJunctions = segment.junctionIntervals.length;
      expect(segment.junctionLaneRefs.length === 0 ? withJunctions === 0 : withJunctions > 0).toBe(true);
    }
  });

  it('profiles only the open-road parts of a chain', () => {
    for (const segment of segments) {
      for (const sample of segment.profile) {
        const inJunction = segment.junctionIntervals.some(
          (iv) => sample.s >= iv.startS && sample.s <= iv.endS,
        );
        expect(inJunction).toBe(false);
        expect(sample.lanesSameDir).toBeGreaterThanOrEqual(1);
        // Zero is legal at a taper: OpenDRIVE lanes narrow to nothing at drops
        // and merges, and the width samples record that honestly.
        expect(sample.laneWidthM).toBeGreaterThanOrEqual(0);
        expect(sample.curvatureDegPer10m).toBeGreaterThanOrEqual(0);
      }
      // ...but a corridor whose *every* sample is zero-width is only acceptable
      // when the source itself declines to give those lanes a width. Yale has
      // exactly three such driving lanes (`representativeWidthM: null`, empty
      // `widthSamples`); fabricating a plausible width for them would be worse
      // than reporting zero.
      if (segment.profile.length > 0 && Math.max(...segment.profile.map((p) => p.laneWidthM)) === 0) {
        for (const ref of segment.laneRefs) {
          const raw = ctx.graph.get(ref as string)?.raw;
          expect(raw?.representativeWidthM ?? 0, ref as string).toBe(0);
          expect(raw?.widthSamples ?? [], ref as string).toHaveLength(0);
        }
      }
      const ss = segment.profile.map((p) => p.s);
      expect(ss).toEqual([...ss].sort((a, b) => a - b));
    }
  });

  it('summarises the profile consistently', () => {
    for (const segment of segments) {
      if (segment.profile.length === 0) continue;
      expect(segment.minLanesSameDir).toBe(Math.min(...segment.profile.map((p) => p.lanesSameDir)));
      expect(segment.maxLanesSameDir).toBe(Math.max(...segment.profile.map((p) => p.lanesSameDir)));
      expect(segment.maxCurvatureDegPer10m).toBeCloseTo(
        Math.max(...segment.profile.map((p) => p.curvatureDegPer10m)),
        2,
      );
      if (segment.isOneWay) {
        expect(Math.max(...segment.profile.map((p) => p.lanesOpposing))).toBe(0);
      }
    }
  });

  it('reconstructs adjacency the topology index does not report', () => {
    // `adjacentLanes` only names *drivable* neighbours, so parking / bike /
    // sidewalk adjacency has to come from the lane row. If that reconstruction
    // were broken, every one of these flags would be uniformly false.
    const flags = segments.filter(
      (s) => s.hasParkingAdjacent || s.hasBikeAdjacent || s.hasSidewalkAdjacent || s.hasShoulderAdjacent,
    );
    expect(flags.length).toBeGreaterThan(0);
  });

  it('is deterministic and canonically ordered', () => {
    const again = buildSegments(createBuildContext(miniYaleSources()));
    expect(JSON.stringify(again)).toBe(JSON.stringify(segments));
    const ids = segments.map((s) => s.id as string);
    expect(ids).toEqual([...ids].sort());
  });
});

describe('midblock densification', () => {
  const midblocks = build.catalog.locations.filter((l) => l.type === 'midblock_segment');

  it('places samples along open road', () => {
    expect(midblocks.length).toBeGreaterThan(0);
    for (const m of midblocks) {
      expect(m.facts['road_name']).toBeTypeOf('string');
      expect(m.facts['lanes_same_dir'] as number).toBeGreaterThanOrEqual(1);
      expect(m.facts['runway_upstream_m'] as number).toBeGreaterThanOrEqual(0);
      expect(m.facts['runway_downstream_m'] as number).toBeGreaterThanOrEqual(0);
      expect(m.affordances).toContain('vehicleSpawn');
    }
  });

  it('keys identity on `rsl@s`, not on the sample ordinal', () => {
    // Two samples on the same lane at the same rounded arc length would collide;
    // the build de-duplicates them, so ids must be unique per (lane, s).
    const ids = midblocks.map((m) => m.id as string);
    expect(new Set(ids).size).toBe(ids.length);
  });
});
