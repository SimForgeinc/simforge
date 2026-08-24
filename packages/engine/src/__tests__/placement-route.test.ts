import { describe, expect, it } from 'vitest';

import { buildLaneGraph } from '../map/lane-graph.js';
import {
  buildFollowRoute,
  buildLanePathRoute,
  buildDefaultPlacementRoute,
  retargetToNeighbour,
} from '../map/route.js';
import type { TopologyGate, TopologyIndex, TopologyLane } from '../map/topology.js';

interface TestLane {
  rsl: string;
  x0: number;
  x1: number;
  y?: number;
  predecessors?: string[];
  successors?: string[];
}

function topology(definitions: readonly TestLane[]): TopologyIndex {
  const lanes: Record<string, TopologyLane> = {};
  for (const [index, definition] of definitions.entries()) {
    const laneId = -1 - index;
    const y = definition.y ?? 0;
    lanes[definition.rsl] = {
      rsl: definition.rsl,
      roadId: index + 1,
      section: 0,
      laneId,
      laneType: 'driving',
      isJunction: false,
      junctionId: null,
      predecessors: definition.predecessors ?? [],
      successors: definition.successors ?? [],
      speedLimitKph: 50,
      representativeWidthM: 3.5,
      widthSamples: [
        { s: 0, widthM: 3.5 },
        { s: definition.x1 - definition.x0, widthM: 3.5 },
      ],
      adjacentLanes: {
        left: { side: 'left', laneRsl: null, sameDirection: false, permissionIds: [] },
        right: { side: 'right', laneRsl: null, sameDirection: false, permissionIds: [] },
      },
      laneChangePermissions: [],
      polyline: [
        { x: definition.x0, y },
        { x: definition.x1, y },
      ],
    };
  }
  return {
    schemaVersion: 1,
    mapName: 'placement-route-test',
    source: { xodrSha256: 'placement-route-test' },
    lanes,
    gates: [],
    junctions: {},
  };
}

type Point = { x: number; y: number };
interface JunctionLane {
  rsl: string;
  points: readonly Point[];
  successors?: readonly string[];
  predecessors?: readonly string[];
  junction?: boolean;
  left?: string;
  right?: string;
}

function junctionTopology(includeStraight = true): TopologyIndex {
  const definitions: JunctionLane[] = [
    { rsl: 'approach', points: [{ x: 0, y: 0 }, { x: 10, y: 0 }], successors: includeStraight ? ['straight', 'left', 'right'] : ['left', 'right'], left: 'approach-left' },
    { rsl: 'approach-left', points: [{ x: 0, y: 3.5 }, { x: 10, y: 3.5 }], successors: ['straight-left'], right: 'approach' },
    { rsl: 'straight', points: [{ x: 10, y: 0 }, { x: 20, y: 0 }], predecessors: ['approach'], successors: ['straight-exit'], junction: true },
    { rsl: 'straight-left', points: [{ x: 10, y: 3.5 }, { x: 20, y: 3.5 }], predecessors: ['approach-left'], successors: ['straight-left-exit'], junction: true },
    { rsl: 'left', points: [{ x: 10, y: 0 }, { x: 15, y: 5 }, { x: 10, y: 10 }], predecessors: ['approach'], successors: ['left-exit'], junction: true },
    { rsl: 'right', points: [{ x: 10, y: 0 }, { x: 15, y: -5 }, { x: 10, y: -10 }], predecessors: ['approach'], successors: ['right-exit'], junction: true },
    { rsl: 'straight-exit', points: [{ x: 20, y: 0 }, { x: 50, y: 0 }], predecessors: ['straight'] },
    { rsl: 'straight-left-exit', points: [{ x: 20, y: 3.5 }, { x: 50, y: 3.5 }], predecessors: ['straight-left'] },
    { rsl: 'left-exit', points: [{ x: 10, y: 10 }, { x: 10, y: 40 }], predecessors: ['left'] },
    { rsl: 'right-exit', points: [{ x: 10, y: -10 }, { x: 10, y: -40 }], predecessors: ['right'] },
  ];
  const lanes: Record<string, TopologyLane> = {};
  definitions.forEach((definition, index) => {
    const length = definition.points.slice(1).reduce((sum, point, i) => sum + Math.hypot(point.x - definition.points[i]!.x, point.y - definition.points[i]!.y), 0);
    const adjacency = (side: 'left' | 'right', target: string | undefined) => ({
      side,
      laneRsl: target ?? null,
      sameDirection: Boolean(target),
      permissionIds: target ? [`${definition.rsl}:${side}`] : [],
    });
    lanes[definition.rsl] = {
      rsl: definition.rsl,
      roadId: index + 1,
      section: 0,
      laneId: -1,
      laneType: 'driving',
      isJunction: definition.junction ?? false,
      junctionId: definition.junction ? 'junction' : null,
      predecessors: [...(definition.predecessors ?? [])],
      successors: [...(definition.successors ?? [])],
      speedLimitKph: 50,
      representativeWidthM: 3.5,
      widthSamples: [{ s: 0, widthM: 3.5 }, { s: length, widthM: 3.5 }],
      adjacentLanes: { left: adjacency('left', definition.left), right: adjacency('right', definition.right) },
      laneChangePermissions: [
        ...(definition.left ? [{ id: `${definition.rsl}:left`, side: 'left' as const, startS: 0, endS: length, allowed: true, marking: 'broken', source: 'test' }] : []),
        ...(definition.right ? [{ id: `${definition.rsl}:right`, side: 'right' as const, startS: 0, endS: length, allowed: true, marking: 'broken', source: 'test' }] : []),
      ],
      polyline: [...definition.points],
    };
  });
  const gate = (id: string, approachLaneRsl: string, connectingLaneRsl: string, turnRelation: TopologyGate['turnRelation'], exit: string): TopologyGate => ({
    id, junctionId: 'junction', approachLaneRsl, connectingLaneRsl, turnRelation,
    headingChangeRad: turnRelation === 'Straight' ? 0 : turnRelation === 'Left' ? Math.PI / 2 : -Math.PI / 2,
    exitLaneRsls: [exit],
  });
  const gates = [
    ...(includeStraight ? [gate('straight-gate', 'approach', 'straight', 'Straight', 'straight-exit')] : []),
    gate('straight-left-gate', 'approach-left', 'straight-left', 'Straight', 'straight-left-exit'),
    gate('left-gate', 'approach', 'left', 'Left', 'left-exit'),
    gate('right-gate', 'approach', 'right', 'Right', 'right-exit'),
  ];
  return { schemaVersion: 1, mapName: 'junction-route-test', source: { xodrSha256: 'junction' }, lanes, gates, junctions: {} };
}

describe('buildDefaultPlacementRoute', () => {
  it('returns the same connected route for repeated planning', () => {
    const graph = buildLaneGraph(topology([
      { rsl: '1:0:-1', x0: 0, x1: 10, successors: ['2:0:-1', '3:0:-1'] },
      { rsl: '2:0:-1', x0: 10, x1: 30, predecessors: ['1:0:-1'] },
      { rsl: '3:0:-1', x0: 10, x1: 30, predecessors: ['1:0:-1'] },
    ]));
    const options = {
      startRsl: '1:0:-1',
      startStorageS: 5,
      requiredDownstreamM: 15,
    };

    const first = buildDefaultPlacementRoute(graph, options);
    const second = buildDefaultPlacementRoute(graph, options);

    expect(first).toEqual(second);
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    expect(first.lanes).toHaveLength(2);
    expect(first.route.legs.map((leg) => leg.rsl)).toEqual(first.lanes);
    expect(first.downstreamM).toBeGreaterThanOrEqual(options.requiredDownstreamM);
  });

  it('chooses the topology-labelled straight movement for every placement', () => {
    const graph = buildLaneGraph(junctionTopology());
    const branches = new Set<string>();
    for (const requiredDownstreamM of Array.from({ length: 64 }, () => 35)) {
      const result = buildDefaultPlacementRoute(graph, {
        startRsl: 'approach',
        startStorageS: 5,
        requiredDownstreamM,
      });
      expect(result.ok).toBe(true);
      if (result.ok) branches.add(result.lanes[1]!);
    }
    expect(branches).toEqual(new Set(['straight']));
  });

  it('does not turn merely to obtain more runway when the straightest branch is short', () => {
    const graph = buildLaneGraph(topology([
      { rsl: '1:0:-1', x0: 0, x1: 10, successors: ['2:0:-1', '3:0:-1'] },
      { rsl: '2:0:-1', x0: 10, x1: 15, predecessors: ['1:0:-1'] },
      { rsl: '3:0:-1', x0: 10, x1: 20, predecessors: ['1:0:-1'], successors: ['4:0:-1'] },
      { rsl: '4:0:-1', x0: 20, x1: 50, predecessors: ['3:0:-1'] },
    ]));

    const result = buildDefaultPlacementRoute(graph, {
      startRsl: '1:0:-1',
      startStorageS: 9,
      requiredDownstreamM: 35,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.lanes).toEqual(['1:0:-1', '2:0:-1']);
    expect(result.downstreamM).toBeCloseTo(6);
  });

  it('takes a deterministic legal turn only when no straight continuation exists', () => {
    const graph = buildLaneGraph(junctionTopology(false));
    const result = buildDefaultPlacementRoute(graph, {
      startRsl: 'approach', startStorageS: 5, requiredDownstreamM: 35,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(['left', 'right']).toContain(result.lanes[1]);
    expect(result.lanes).not.toContain('straight');
  });

  it.each([
    ['Left' as const, 'left'],
    ['Right' as const, 'right'],
  ])('lets an explicit %s route request override the straight default', (turn, expectedLane) => {
    const result = buildFollowRoute(buildLaneGraph(junctionTopology()), 'approach', [turn], 35);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.route.legs.map((leg) => leg.rsl)).toContain(expectedLane);
    expect(result.route.legs.map((leg) => leg.rsl)).not.toContain('straight');
  });

  it('completes an explicit gate chain when the approach alone exceeds the route preview', () => {
    const index = junctionTopology();
    for (const rsl of ['approach', 'approach-left']) {
      const lane = index.lanes[rsl]!;
      const first = lane.polyline[0] as { x: number; y: number };
      index.lanes[rsl] = { ...lane, polyline: [{ x: -100, y: first.y }, ...lane.polyline.slice(1)] };
    }
    const result = buildFollowRoute(buildLaneGraph(index), 'approach', ['Right'], 35);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.route.legs.map((leg) => leg.rsl)).toEqual(['approach', 'right', 'right-exit']);
  });

  it('uses the smallest legal heading deflection for ambiguous same-relation movements', () => {
    const index = junctionTopology();
    const left = index.gates.find((gate) => gate.id === 'left-gate')!;
    index.gates.push({ ...left, id: '000-wide-right', turnRelation: 'Right', headingChangeRad: -2.4 });
    const result = buildFollowRoute(buildLaneGraph(index), 'approach', ['Right'], 35);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.route.legs.map((leg) => leg.rsl)).toEqual(['approach', 'right', 'right-exit']);
  });

  it('does not duplicate an identical gate alternative in the route', () => {
    const index = junctionTopology();
    const right = index.gates.find((gate) => gate.id === 'right-gate')!;
    index.gates.push({ ...right, id: 'right-gate-duplicate' });
    const result = buildFollowRoute(buildLaneGraph(index), 'approach', ['Right'], 35);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.route.legs.map((leg) => leg.rsl)).toEqual(['approach', 'right', 'right-exit']);
  });

  it.each([
    ['left' as const, ['approach', 'straight', 'straight-exit'], ['approach-left', 'straight-left', 'straight-left-exit']],
    ['right' as const, ['approach-left', 'straight-left', 'straight-left-exit'], ['approach', 'straight', 'straight-exit']],
  ])('a %s lane change preserves the downstream straight route intent', (side, sourceLanes, expectedLanes) => {
    const graph = buildLaneGraph(junctionTopology());
    const source = buildLanePathRoute(graph, sourceLanes);
    expect(source.ok).toBe(true);
    if (!source.ok) return;
    const changed = retargetToNeighbour(graph, source.route, 5, side, { legalOnly: true });
    expect(changed).not.toBeNull();
    expect(changed?.route.legs.map((leg) => leg.rsl)).toEqual(expectedLanes);
  });

  it('is stable across repeated planning and replay preparation', () => {
    const graph = buildLaneGraph(junctionTopology());
    const options = { startRsl: 'approach', startStorageS: 2, requiredDownstreamM: 40 };
    const snapshots = Array.from({ length: 10 }, () => buildDefaultPlacementRoute(graph, options));
    expect(snapshots.every((snapshot) => JSON.stringify(snapshot) === JSON.stringify(snapshots[0]))).toBe(true);
  });

  it('persists a meaningful connected continuation when the starting lane alone is long enough', () => {
    const graph = buildLaneGraph(topology([
      { rsl: '1:0:-1', x0: 0, x1: 200, successors: ['2:0:-1'] },
      { rsl: '2:0:-1', x0: 200, x1: 220, predecessors: ['1:0:-1'] },
    ]));

    const result = buildDefaultPlacementRoute(graph, {
      startRsl: '1:0:-1', startStorageS: 10, requiredDownstreamM: 100,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.lanes).toEqual(['1:0:-1', '2:0:-1']);
    expect(result.route.legs.map((leg) => leg.rsl)).toEqual(result.lanes);
  });

  it('accepts the longest connected route when available runway is shorter than requested', () => {
    const graph = buildLaneGraph(topology([
      { rsl: '1:0:-1', x0: 0, x1: 10, successors: ['2:0:-1'] },
      { rsl: '2:0:-1', x0: 10, x1: 15, predecessors: ['1:0:-1'] },
    ]));

    const result = buildDefaultPlacementRoute(graph, {
      startRsl: '1:0:-1',
      startStorageS: 9,
      requiredDownstreamM: 20,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.lanes).toEqual(['1:0:-1', '2:0:-1']);
    expect(result.downstreamM).toBeCloseTo(6);
  });

  it('accepts an isolated terminal driving lane and stops at its end', () => {
    const graph = buildLaneGraph(topology([
      { rsl: '1:0:-1', x0: 0, x1: 10 },
    ]));

    const result = buildDefaultPlacementRoute(graph, {
      startRsl: '1:0:-1',
      startStorageS: 8,
      requiredDownstreamM: 100,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.lanes).toEqual(['1:0:-1']);
    expect(result.downstreamM).toBeCloseTo(2);
  });
});
