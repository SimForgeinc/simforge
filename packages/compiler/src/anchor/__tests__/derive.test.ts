import { describe, expect, it } from 'vitest';

import { deriveMapIndexFromTopology } from '../derive.js';
import { crossSectionAt } from '../cross-section.js';
import {
  EGO_APPROACH_LANE,
  OPPOSING_APPROACH_LANE,
  SYNTHETIC_JUNCTION_ID,
  syntheticSearchIndex,
  syntheticTopology,
} from './fixtures/synthetic-map.js';

const index = deriveMapIndexFromTopology(syntheticTopology(), {
  mapId: 'synthetic',
  searchIndex: syntheticSearchIndex(),
});

describe('deriveMapIndexFromTopology', () => {
  it('normalizes polylines into travel order', () => {
    // `2:0:1` runs westbound: stored east-to-west in `s` order, so travel order
    // must start at the eastern end and finish at the junction.
    const lane = index.lanes[OPPOSING_APPROACH_LANE]!;
    expect(lane.polyline[0]!.x).toBeGreaterThan(100);
    expect(lane.polyline[lane.polyline.length - 1]!.x).toBeCloseTo(10, 1);
  });

  it('flips width samples and lane-change permissions for reversed lanes', () => {
    const forward = index.lanes['1:0:-1']!;
    const reversed = index.lanes['2:0:1']!;
    expect(forward.widthSamples.map((w) => w.s)).toEqual(
      [...forward.widthSamples.map((w) => w.s)].sort((a, b) => a - b),
    );
    expect(reversed.widthSamples.map((w) => w.s)).toEqual(
      [...reversed.widthSamples.map((w) => w.s)].sort((a, b) => a - b),
    );
    // Road 1's eastbound lanes declare both sides legal over the whole lane.
    expect(forward.laneChangePermissions).toHaveLength(2);
  });

  it('derives directed, geometry-verified links from undirected raw lists', () => {
    const approach = index.lanes[EGO_APPROACH_LANE]!;
    expect(approach.successors).toContain('10:0:-1');
    expect(approach.successors).toContain('11:0:-1');
    expect(approach.predecessors).toHaveLength(0);
    // The connecting lane leads onward, never back into the approach.
    expect(index.lanes['10:0:-1']!.successors).toEqual(['3:0:-1']);
  });

  it('counts arms from outward leg directions', () => {
    expect(index.junctionDescriptors[SYNTHETIC_JUNCTION_ID]!.arms).toBe(4);
  });

  it('reads junction control from the search index', () => {
    expect(index.junctionDescriptors[SYNTHETIC_JUNCTION_ID]!.control).toBe('signalized');
    expect(index.capabilities.junctionControl).toBe(true);
    const stops = deriveMapIndexFromTopology(syntheticTopology(), {
      mapId: 'synthetic',
      searchIndex: syntheticSearchIndex('stop', true),
    });
    expect(stops.junctionDescriptors[SYNTHETIC_JUNCTION_ID]!.control).toBe('all_way_stop');
    const bare = deriveMapIndexFromTopology(syntheticTopology(), { mapId: 'synthetic' });
    expect(bare.junctionDescriptors[SYNTHETIC_JUNCTION_ID]!.control).toBe('unknown');
    expect(bare.capabilities.junctionControl).toBe(false);
  });

  it('precomputes the ego-left / opposing-straight conflict pair', () => {
    const descriptor = index.junctionDescriptors[SYNTHETIC_JUNCTION_ID]!;
    const pair = descriptor.conflictPairs.find(
      (p) =>
        (p.gateA === 'g_ego_left' && p.gateB === 'g_opp_straight') ||
        (p.gateB === 'g_ego_left' && p.gateA === 'g_opp_straight'),
    );
    expect(pair).toBeDefined();
    expect(pair!.relation).toBe('opposing');
    // The paths cross north-east of the junction centre.
    expect(pair!.point.y).toBeCloseTo(1.75, 0);
    expect(pair!.crossingAngleDeg).toBeGreaterThan(30);
    expect(pair!.crossingAngleDeg).toBeLessThan(180);
  });

  it('labels a southbound conflict as coming from the ego left', () => {
    const descriptor = index.junctionDescriptors[SYNTHETIC_JUNCTION_ID]!;
    const pair = descriptor.conflictPairs.find(
      (p) => p.gateA === 'g_ego_left' && p.gateB === 'g_north_straight',
    );
    expect(pair?.relation).toBe('from_left');
  });

  it('reports the three-lane cross-section from geometry, not adjacency labels', () => {
    // `1:0:-1` declares only a right neighbour; the chain has to find the rest.
    const cs = crossSectionAt(index.lanes, EGO_APPROACH_LANE, 100)!;
    expect(cs.sameDirDriving.size).toBe(3);
    expect(cs.sameDirDriving.get(-1)).toBe('1:0:-2');
    expect(cs.sameDirDriving.get(-2)).toBe('1:0:-3');
    // Westbound lanes are opposing, innermost first, and are not counted as k.
    expect(cs.opposingDriving[0]).toBe('1:0:1');
    expect(cs.sameDirDriving.get(1)).toBeUndefined();
  });

  it('builds segments with lane-count profiles and a fact index', () => {
    const segment = index.segments.find((s) => s.laneRsls.includes(EGO_APPROACH_LANE));
    expect(segment).toBeDefined();
    expect(segment!.maxThroughLanesSameDir).toBe(3);
    expect(index.factIndex.segmentsByLaneCount['3']).toContain(segment!.id);
    expect(index.factIndex.junctionsByControl['signalized']).toEqual([SYNTHETIC_JUNCTION_ID]);
    expect(index.factIndex.junctionsByTurnOption['left']).toEqual([SYNTHETIC_JUNCTION_ID]);
  });

  it('is a pure function of its input', () => {
    const again = deriveMapIndexFromTopology(syntheticTopology(), {
      mapId: 'synthetic',
      searchIndex: syntheticSearchIndex(),
    });
    expect(again.topologyDigest).toBe(index.topologyDigest);
    expect(JSON.stringify(again.junctionDescriptors)).toBe(JSON.stringify(index.junctionDescriptors));
  });
});
