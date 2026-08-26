/**
 * `conflictPairs` sanity — the derived fact everything portable depends on.
 *
 * The anchor assertion is the canonical one: at a signalized four-way, a
 * left-turning movement must be recorded as conflicting with the *opposing*
 * through movement, at a sane crossing angle. Get the relation wrong and a
 * retargeted "oncoming car turns across you" becomes a rear-end on the next
 * map; get the angle wrong and the arrival solver aims the actors at the wrong
 * point.
 */

import path from 'node:path';
import { describe, expect, it } from 'vitest';

import { buildMapIntel, buildMapIntelFromDir } from '../build/build.js';
import { classifyRelation, computeConflictPairs } from '../build/junctions.js';
import { createBuildContext } from '../build/context.js';
import { segmentIntersection } from '../geometry/vec.js';
import { DEV_ASSETS, devAssetsAvailable, fixtureCentreJunctionId, miniYaleSources } from './helpers.js';

const build = buildMapIntel(miniYaleSources());
const ctx = createBuildContext(miniYaleSources());

const toDeg = (rad: number): number => (rad * 180) / Math.PI;

describe('relation classification', () => {
  // Headings are travel headings *into* the junction, xodr-local
  // (0 = +x/east, CCW positive).
  const EAST = 0;
  const WEST = Math.PI;
  const NORTH = Math.PI / 2;
  const SOUTH = -Math.PI / 2;

  it('calls a head-on approach opposing', () => {
    expect(classifyRelation(EAST, WEST)).toBe('opposing');
    expect(classifyRelation(NORTH, SOUTH)).toBe('opposing');
  });

  it('calls a co-directional approach a merge', () => {
    expect(classifyRelation(EAST, EAST + 0.1)).toBe('same_dir_merge');
    expect(classifyRelation(NORTH, NORTH - 0.2)).toBe('same_dir_merge');
  });

  it('decides left/right from the signed heading difference', () => {
    // Ego heads east. A vehicle arriving from ego's left comes from the north
    // travelling south, i.e. heading -90°.
    expect(classifyRelation(EAST, SOUTH)).toBe('from_left');
    // From ego's right: from the south travelling north, heading +90°.
    expect(classifyRelation(EAST, NORTH)).toBe('from_right');
  });

  it('does not flip meaning across the ±180° wrap', () => {
    // Headings 179° and -179° are 2° apart, not 358°.
    expect(classifyRelation((179 * Math.PI) / 180, (-179 * Math.PI) / 180)).toBe('same_dir_merge');
    // And ego at -179° sees a vehicle at +91° on its right, not its left.
    expect(classifyRelation((-179 * Math.PI) / 180, (91 * Math.PI) / 180)).toBe('from_left');
  });

  it('is antisymmetric in left/right', () => {
    for (const [a, b] of [
      [EAST, NORTH],
      [NORTH, WEST],
      [0.3, 1.9],
    ] as const) {
      const forward = classifyRelation(a, b);
      const backward = classifyRelation(b, a);
      if (forward === 'from_left') expect(backward).toBe('from_right');
      if (forward === 'from_right') expect(backward).toBe('from_left');
      if (forward === 'opposing') expect(backward).toBe('opposing');
    }
  });
});

describe('conflict pairs on the fixture junction', () => {
  const centreId = fixtureCentreJunctionId();
  const junction = build.derived.junctions.find((j) => (j.junctionId as string) === centreId);

  it('describes the centre junction as a signalized four-way', () => {
    expect(junction).toBeDefined();
    expect(junction?.control).toBe('signalized');
    expect(junction?.armCount).toBe(4);
    expect(junction?.controlEvidence.some((e) => e.startsWith('traffic_light='))).toBe(true);
  });

  it('yields opposing through × left-turn crossings', () => {
    const opposing = (junction?.conflictPairs ?? []).filter((p) => p.relation === 'opposing');
    expect(opposing.length).toBeGreaterThan(0);

    const throughVsLeft = opposing.filter(
      (p) =>
        (p.turnA === 'Straight' && p.turnB === 'Left') ||
        (p.turnA === 'Left' && p.turnB === 'Straight'),
    );
    expect(throughVsLeft.length).toBeGreaterThan(0);

    for (const pair of throughVsLeft) {
      // A left turn crossing the opposing through path meets it obliquely —
      // never a glancing near-parallel graze, never a perfect head-on.
      const deg = toDeg(pair.crossingAngleRad);
      expect(deg).toBeGreaterThan(45);
      expect(deg).toBeLessThan(160);
    }
  });

  it('places the crossing point on both connecting lanes', () => {
    for (const pair of junction?.conflictPairs ?? []) {
      const a = ctx.sources.topology.gates.find((g) => g.id === (pair.gateA as string));
      const b = ctx.sources.topology.gates.find((g) => g.id === (pair.gateB as string));
      expect(a).toBeDefined();
      expect(b).toBeDefined();
      const laneA = ctx.graph.get(a?.connectingLaneRsl ?? '');
      const laneB = ctx.graph.get(b?.connectingLaneRsl ?? '');
      expect(laneA).toBeDefined();
      expect(laneB).toBeDefined();
      if (!laneA || !laneB) continue;

      expect(pair.sOnA).toBeGreaterThanOrEqual(0);
      expect(pair.sOnA).toBeLessThanOrEqual(laneA.lengthM + 0.01);
      expect(pair.sOnB).toBeGreaterThanOrEqual(0);
      expect(pair.sOnB).toBeLessThanOrEqual(laneB.lengthM + 0.01);

      const poseA = ctx.graph.poseAt(laneA.rsl as string, pair.sOnA);
      const poseB = ctx.graph.poseAt(laneB.rsl as string, pair.sOnB);
      expect(poseA).toBeDefined();
      expect(poseB).toBeDefined();
      if (!poseA || !poseB) continue;
      // Both arc lengths must resolve to the recorded crossing point. Merges
      // are recorded at the midpoint of two converging endpoints, so they get
      // a looser bound than a true crossing.
      const tol = pair.kind === 'merge' ? 4.5 : 0.5;
      expect(Math.hypot(poseA.point.x - pair.pointXY[0], poseA.point.y - pair.pointXY[1])).toBeLessThan(tol);
      expect(Math.hypot(poseB.point.x - pair.pointXY[0], poseB.point.y - pair.pointXY[1])).toBeLessThan(tol);
    }
  });

  it('never pairs two movements from the same approach lane', () => {
    for (const j of build.derived.junctions) {
      for (const pair of j.conflictPairs) {
        const a = ctx.sources.topology.gates.find((g) => g.id === (pair.gateA as string));
        const b = ctx.sources.topology.gates.find((g) => g.id === (pair.gateB as string));
        expect(a?.approachLaneRsl).not.toBe(b?.approachLaneRsl);
      }
    }
  });

  it('emits pairs in a deterministic, canonical order', () => {
    for (const j of build.derived.junctions) {
      const keys = j.conflictPairs.map((p) => `${p.gateA}|${p.gateB}`);
      expect(keys).toEqual([...keys].sort());
      expect(new Set(keys).size).toBe(keys.length);
    }
  });

  it('keeps every crossing angle inside [0, PI]', () => {
    for (const j of build.derived.junctions) {
      for (const pair of j.conflictPairs) {
        expect(pair.crossingAngleRad).toBeGreaterThanOrEqual(0);
        expect(pair.crossingAngleRad).toBeLessThanOrEqual(Math.PI + 1e-9);
      }
    }
  });

  it('agrees with a direct geometric recomputation', () => {
    const centreJunction = ctx.sources.topology.junctions[centreId];
    expect(centreJunction).toBeDefined();
    // Deliberately fed in a *different* order than the builder used: the
    // function must depend on the set of gates, not on how they arrived.
    const gates = ctx.sources.topology.gates
      .filter((g) => g.junctionId === centreId)
      .reverse();
    const recomputed = computeConflictPairs(ctx, gates, {
      x: junction?.centerXY[0] ?? 0,
      y: junction?.centerXY[1] ?? 0,
    });
    expect(recomputed.map((p) => `${p.gateA}|${p.gateB}`)).toEqual(
      (junction?.conflictPairs ?? []).map((p) => `${p.gateA}|${p.gateB}`),
    );
  });

  it('surfaces the conflict count on the movement records', () => {
    const movements = build.catalog.locations.filter((l) => l.type === 'junction_movement');
    const unprotected = movements.filter((m) => m.facts['is_protected'] === false);
    expect(unprotected.length).toBeGreaterThan(0);
    for (const m of unprotected) {
      expect(m.facts['conflicting_movement_count']).toBeGreaterThan(0);
      expect(m.affordances).toContain('conflictPoint');
    }
    for (const m of movements.filter((x) => x.facts['is_protected'] === true)) {
      expect(m.facts['conflicting_movement_count']).toBe(0);
    }
  });
});

describe('segment intersection primitive', () => {
  it('finds a proper crossing', () => {
    const hit = segmentIntersection({ x: -1, y: 0 }, { x: 1, y: 0 }, { x: 0, y: -1 }, { x: 0, y: 1 });
    expect(hit?.point.x).toBeCloseTo(0, 9);
    expect(hit?.point.y).toBeCloseTo(0, 9);
    expect(hit?.tA).toBeCloseTo(0.5, 9);
  });

  it('rejects endpoint touches and parallels', () => {
    // Two movements meeting at a shared endpoint are a merge, not a crossing.
    expect(segmentIntersection({ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 1, y: 0 }, { x: 2, y: 1 })).toBeNull();
    expect(segmentIntersection({ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 0, y: 1 }, { x: 1, y: 1 })).toBeNull();
  });
});

describe.skipIf(!devAssetsAvailable())('conflict pairs on the full Yale map', () => {
  it('gives a signalized four-way opposing through × left crossings', async () => {
    const yale = await buildMapIntelFromDir(path.join(DEV_ASSETS, 'yale-st-palo-alto-ca'));
    const signalizedFourWays = yale.derived.junctions.filter(
      (j) => j.control === 'signalized' && j.armCount === 4,
    );
    expect(signalizedFourWays.length).toBeGreaterThan(0);

    const withOpposingThroughLeft = signalizedFourWays.filter((j) =>
      j.conflictPairs.some(
        (p) =>
          p.relation === 'opposing' &&
          ((p.turnA === 'Straight' && p.turnB === 'Left') ||
            (p.turnA === 'Left' && p.turnB === 'Straight')),
      ),
    );
    expect(withOpposingThroughLeft.length).toBeGreaterThan(0);

    for (const j of withOpposingThroughLeft) {
      // Scoped to real crossings: a `merge` pair is recorded at the point of
      // closest approach, where two converging paths are nearly parallel, so a
      // small angle there is correct rather than suspicious.
      for (const p of j.conflictPairs.filter((x) => x.relation === 'opposing' && x.kind === 'crossing')) {
        // The documented floor for a crossing (below it, converging paths are
        // classified as merges instead).
        const deg = toDeg(p.crossingAngleRad);
        expect(deg).toBeGreaterThanOrEqual(9.9);
        expect(deg).toBeLessThan(180);
      }
    }

    // Every relation in the vocabulary should actually occur somewhere.
    const relations = new Set(yale.derived.junctions.flatMap((j) => j.conflictPairs.map((p) => p.relation)));
    expect([...relations].sort()).toEqual(['from_left', 'from_right', 'opposing', 'same_dir_merge']);
  });
});
