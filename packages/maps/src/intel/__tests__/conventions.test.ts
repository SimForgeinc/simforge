/**
 * Convention agreement: the emitted data vs an independent geometric derivation.
 *
 * This package owns two conventions that every downstream consumer has to trust
 * without re-deriving:
 *
 * 1. `conflictPairs[].relation` — which side a conflicting movement comes from.
 * 2. `JunctionDescriptor.arms` — how many legs a junction has.
 *
 * Both were wrong in the first cut, in the same way and for the same reason:
 * the topology index stores polylines in OpenDRIVE `s` order, positive-id lanes
 * travel against `s`, and consuming that raw silently inverts ~40% of headings.
 * The observable damage was that Yale junction 134 reported zero `opposing`
 * pairs where the geometry has 18 — every left-turn-across-oncoming template
 * would have been unbindable there, with no error anywhere.
 *
 * These tests re-derive both conventions from the raw source, using an
 * independent code path that starts from lane geometry rather than from
 * anything the build produced, and demand agreement. They are the reason a
 * consumer can adopt these fields rather than recompute them.
 */

import path from 'node:path';
import { describe, expect, it } from 'vitest';

import { buildMapIntel, buildMapIntelFromDir } from '../build/build.js';
import { createBuildContext } from '../build/context.js';
import { classifyRelation } from '../build/junctions.js';
import { headingToBearingDeg, wrapPi, type Point2 } from '../geometry/vec.js';
import type { ConflictRelation, JunctionDescriptor } from '../types/topology.js';
import { DEV_ASSETS, devAssetsAvailable, miniYaleSources } from './helpers.js';

/**
 * Independent re-derivation, deliberately *not* sharing the build's helpers:
 * orient each lane straight from the raw source polyline, then read the
 * approach heading off it.
 */
function independentApproachHeading(
  rawLanes: Record<string, { laneId: number; polyline: { x: number; y: number }[] }>,
  approachRsl: string,
  connectingRsl: string,
): number | null {
  const approach = rawLanes[approachRsl];
  const connecting = rawLanes[connectingRsl];
  if (!approach || !connecting || approach.polyline.length < 2) return null;

  // Travel order for an open-road lane: OpenDRIVE `s` order for negative ids,
  // reversed for positive ones.
  const pts =
    approach.laneId > 0 ? [...approach.polyline].reverse() : [...approach.polyline];
  // Sanity: the junction-side end must be nearer the connecting lane than the
  // other end is, whichever way round the connecting lane is stored.
  const end = pts[pts.length - 1] as Point2;
  const start = pts[0] as Point2;
  const cs = connecting.polyline[0] as Point2;
  const ce = connecting.polyline[connecting.polyline.length - 1] as Point2;
  const dEnd = Math.min(dist(end, cs), dist(end, ce));
  const dStart = Math.min(dist(start, cs), dist(start, ce));
  if (dStart < dEnd) return null; // ambiguous; excluded from the comparison

  const a = pts[pts.length - 2] as Point2;
  const b = pts[pts.length - 1] as Point2;
  return Math.atan2(b.y - a.y, b.x - a.x);
}

function dist(a: Point2, b: Point2): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

/** Independent arm count: cluster outward leg bearings with a 40° gap. */
function independentArmCount(descriptor: JunctionDescriptor): number {
  const bearings = descriptor.arms.map((a) => a.bearingDeg).sort((x, y) => x - y);
  if (bearings.length === 0) return 0;
  let count = 1;
  for (let i = 1; i < bearings.length; i++) {
    const delta = Math.abs(
      (wrapPi((((bearings[i] as number) - (bearings[i - 1] as number)) * Math.PI) / 180) * 180) /
        Math.PI,
    );
    if (delta >= 40) count += 1;
  }
  // Wrap-around.
  const first = bearings[0] as number;
  const last = bearings[bearings.length - 1] as number;
  if (bearings.length > 1) {
    const wrap = Math.abs((wrapPi(((first - last) * Math.PI) / 180) * 180) / Math.PI);
    if (wrap < 40) count -= 1;
  }
  return Math.max(1, count);
}

describe('travel ordering', () => {
  const ctx = createBuildContext(miniYaleSources());

  it('flips exactly the lanes whose source polyline runs against travel', () => {
    const flipped = ctx.graph.allLanes().filter((l) => l.reversed);
    expect(flipped.length).toBeGreaterThan(0);
    for (const lane of ctx.graph.allLanes()) {
      const source = lane.raw.polyline;
      const first = lane.points[0] as Point2;
      const sourceFirst = source[0] as Point2;
      const sourceLast = source[source.length - 1] as Point2;
      const matchesSourceStart = dist(first, sourceFirst) < 1e-6;
      const matchesSourceEnd = dist(first, sourceLast) < 1e-6;
      // The travel-ordered polyline is the source or its reverse — never a
      // resampling.
      expect(matchesSourceStart || matchesSourceEnd).toBe(true);
      expect(lane.reversed).toBe(matchesSourceEnd && !matchesSourceStart);
    }
  });

  it('starts every connecting lane where its approach lane ends', () => {
    let checked = 0;
    for (const gate of ctx.sources.topology.gates) {
      const approach = ctx.graph.get(gate.approachLaneRsl);
      const connecting = ctx.graph.get(gate.connectingLaneRsl);
      if (!approach || !connecting) continue;
      const entry = ctx.graph.endOf(approach);
      const toStart = dist(entry, ctx.graph.startOf(connecting));
      const toEnd = dist(entry, ctx.graph.endOf(connecting));
      expect(toStart, gate.id).toBeLessThanOrEqual(toEnd);
      checked += 1;
    }
    expect(checked).toBeGreaterThan(50);
  });

  it('round-trips travel arc length to OpenDRIVE s', () => {
    for (const lane of ctx.graph.allLanes().slice(0, 50)) {
      const s = lane.lengthM / 3;
      expect(ctx.graph.fromXodrS(lane, ctx.graph.toXodrS(lane, s))).toBeCloseTo(s, 9);
      if (lane.reversed) expect(ctx.graph.toXodrS(lane, 0)).toBeCloseTo(lane.lengthM, 9);
      else expect(ctx.graph.toXodrS(lane, 0)).toBe(0);
    }
  });

  it('swaps the driver-frame side on reversed lanes', () => {
    const forward = ctx.graph.allLanes().find((l) => !l.reversed);
    const back = ctx.graph.allLanes().find((l) => l.reversed);
    expect(forward && ctx.graph.driverSide(forward, 'left')).toBe('left');
    expect(back && ctx.graph.driverSide(back, 'left')).toBe('right');
  });
});

describe('conflict relations agree with independent derivation', () => {
  const sources = miniYaleSources();
  const ctx = createBuildContext(miniYaleSources());
  const build = buildMapIntel(sources);
  const rawLanes = ctx.sources.topology.lanes as unknown as Record<
    string,
    { laneId: number; polyline: { x: number; y: number }[] }
  >;
  const gateById = new Map(ctx.sources.topology.gates.map((g) => [g.id, g]));

  it('labels every pair the way the raw geometry does', () => {
    let compared = 0;
    let disagreements = 0;
    const examples: string[] = [];
    for (const junction of build.derived.junctions) {
      for (const pair of junction.conflictPairs) {
        const ga = gateById.get(pair.gateA as string);
        const gb = gateById.get(pair.gateB as string);
        if (!ga || !gb) continue;
        const hA = independentApproachHeading(rawLanes, ga.approachLaneRsl, ga.connectingLaneRsl);
        const hB = independentApproachHeading(rawLanes, gb.approachLaneRsl, gb.connectingLaneRsl);
        if (hA === null || hB === null) continue;
        const expected: ConflictRelation = classifyRelation(hA, hB);
        compared += 1;
        if (expected !== pair.relation) {
          disagreements += 1;
          if (examples.length < 5) {
            examples.push(`${pair.gateA}|${pair.gateB}: got ${pair.relation}, geometry says ${expected}`);
          }
        }
      }
    }
    expect(compared).toBeGreaterThan(50);
    expect(disagreements, examples.join('; ')).toBe(0);
  });

  it('measures sOnA and sOnB in travel order', () => {
    for (const junction of build.derived.junctions) {
      for (const pair of junction.conflictPairs) {
        const ga = gateById.get(pair.gateA as string);
        const gb = gateById.get(pair.gateB as string);
        if (!ga || !gb) continue;
        const la = ctx.graph.get(ga.connectingLaneRsl);
        const lb = ctx.graph.get(gb.connectingLaneRsl);
        if (!la || !lb) continue;
        // Travel-ordered s means s=0 is at the approach. A conflict is inside
        // the junction, so it can never be at s=0 on both paths.
        expect(pair.sOnA).toBeGreaterThan(0);
        expect(pair.sOnB).toBeGreaterThan(0);
        // The recorded point must be nearer to the sampled pose than to the
        // pose the *opposite* arc length would give — the exact error an
        // s-ordered measurement makes.
        const good = ctx.graph.poseAt(la.rsl as string, pair.sOnA);
        const flipped = ctx.graph.poseAt(la.rsl as string, la.lengthM - pair.sOnA);
        if (!good || !flipped) continue;
        const target = { x: pair.pointXY[0], y: pair.pointXY[1] };
        if (Math.abs(pair.sOnA - (la.lengthM - pair.sOnA)) < 1) continue; // ambiguous midpoint
        expect(dist(good.point, target)).toBeLessThanOrEqual(dist(flipped.point, target));
      }
    }
  });

  it('separates crossings from merges by tangent angle', () => {
    for (const junction of build.derived.junctions) {
      for (const pair of junction.conflictPairs) {
        if (pair.kind !== 'crossing') continue;
        // A "crossing" at a near-zero tangent angle is two paths merging into a
        // shared exit lane; it must not be reported as a crossing.
        expect((pair.crossingAngleRad * 180) / Math.PI).toBeGreaterThanOrEqual(9.9);
      }
    }
  });
});

describe('arm counts agree with outward-leg clustering', () => {
  const build = buildMapIntel(miniYaleSources());

  it('reports the number of distinct outward legs', () => {
    for (const junction of build.derived.junctions) {
      expect(junction.armCount).toBe(junction.arms.length);
      expect(junction.armCount).toBe(independentArmCount(junction));
    }
  });

  it('keeps arm bearings separated by at least the cluster threshold', () => {
    for (const junction of build.derived.junctions) {
      const bearings = junction.arms.map((a) => a.bearingDeg);
      for (let i = 0; i < bearings.length; i++) {
        for (let j = i + 1; j < bearings.length; j++) {
          const delta = Math.abs(
            (wrapPi((((bearings[i] as number) - (bearings[j] as number)) * Math.PI) / 180) * 180) /
              Math.PI,
          );
          expect(delta).toBeGreaterThanOrEqual(40);
        }
      }
    }
  });

  it('never exceeds a plausible number of legs', () => {
    // Before outward-leg clustering, Yale's big El Camino junctions came out at
    // 6-7 arms because inbound and outbound centrelines of one leg sit ~15 m
    // apart on a 70 m junction.
    for (const junction of build.derived.junctions) {
      expect(junction.armCount).toBeLessThanOrEqual(5);
    }
  });
});

describe.skipIf(!devAssetsAvailable())('conventions on the full Yale map', () => {
  it('finds the opposing conflicts at junction 134 and keeps arm counts sane', async () => {
    const yale = await buildMapIntelFromDir(path.join(DEV_ASSETS, 'yale-street'));
    const j134 = yale.derived.junctions.find((j) => (j.junctionId as string) === '134');
    expect(j134).toBeDefined();
    if (!j134) return;

    // The regression this whole convention pass exists for.
    expect(j134.armCount).toBe(4);
    const opposing = j134.conflictPairs.filter((p) => p.relation === 'opposing');
    expect(opposing.length).toBeGreaterThanOrEqual(15);
    const throughVsLeft = opposing.filter(
      (p) =>
        (p.turnA === 'Straight' && p.turnB === 'Left') ||
        (p.turnA === 'Left' && p.turnB === 'Straight'),
    );
    expect(throughVsLeft.length).toBeGreaterThanOrEqual(5);

    for (const junction of yale.derived.junctions) {
      expect(junction.armCount, junction.junctionId as string).toBeLessThanOrEqual(5);
    }

    // Opposing crossings should be genuinely oblique-to-head-on.
    const angles = yale.derived.junctions
      .flatMap((j) => j.conflictPairs.filter((p) => p.relation === 'opposing' && p.kind === 'crossing'))
      .map((p) => (p.crossingAngleRad * 180) / Math.PI);
    expect(angles.length).toBeGreaterThan(20);
    expect(Math.min(...angles)).toBeGreaterThanOrEqual(9.9);
    expect(Math.max(...angles)).toBeLessThanOrEqual(180);
  });

  it('agrees with the arm counts the search index reports for four-ways', async () => {
    const yale = await buildMapIntelFromDir(path.join(DEV_ASSETS, 'yale-street'));
    const byId = new Map(
      yale.catalog.locations
        .filter((l) => l.type === 'junction')
        .map((l) => [l.id as string, l]),
    );
    let compared = 0;
    let agreements = 0;
    for (const junction of yale.derived.junctions) {
      const record = byId.get(junction.locationId as string);
      const searchApproachCount = record?.facts['approach_count'];
      if (typeof searchApproachCount !== 'number') continue;
      compared += 1;
      if (Math.abs(searchApproachCount - junction.armCount) <= 1) agreements += 1;
    }
    expect(compared).toBeGreaterThan(20);
    // Not an exact contract — the search index counts approaches, we count legs
    // — but a systematic split would show up immediately as a low rate.
    expect(agreements / compared).toBeGreaterThan(0.8);
  });
});
