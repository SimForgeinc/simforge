/**
 * The map-intel normalizer seam, against a committed slice of the **real**
 * `topology-derived.json` shape.
 *
 * The fixture deliberately disagrees with our own derivation in the two places
 * the real file does (arm count, conflict-pair relation label), so the policy —
 * *adopt evidence, recompute conventions* — is asserted rather than assumed.
 */

import { describe, expect, it } from 'vitest';

import { detectPolylineOrder, normalizeDerivedMapIndex, pointFeaturesFromLocations } from '../normalize.js';
import { deriveMapIndexFromTopology } from '../derive.js';
import { matchAnchor } from '../matcher.js';
import { syntheticSearchIndex, syntheticTopology } from './fixtures/synthetic-map.js';
import { workedExampleAnchor, workedExampleRoles } from './fixtures/anchors.js';
import mapIntelSample from './fixtures/map-intel-derived.sample.json' with { type: 'json' };

const locations = {
  locations: [
    {
      id: 'loc_crosswalk_north',
      type: 'crosswalk',
      handle: 'crosswalk/synthetic-north-leg',
      anchor: { road: { rsl: '3:0:1', s: 12.5, offsetM: -0.3, junctionId: '100' } },
    },
    {
      id: 'loc_parking_west',
      type: 'parking_space',
      anchor: { road: { rsl: '1:0:-3', s: 40, offsetM: 3.2 } },
    },
    { id: 'loc_address', type: 'address', anchor: { road: { rsl: '1:0:-1', s: 10 } } },
  ],
};

const index = normalizeDerivedMapIndex(mapIntelSample, {
  mapId: 'synthetic',
  topology: syntheticTopology(),
  locations,
});

describe('normalizeDerivedMapIndex — map-intel shape', () => {
  it('recognises a descriptor array under `junctions` and keeps the spine from the topology', () => {
    expect(index.provenance.source).toBe('map-intel');
    expect(Object.keys(index.lanes).length).toBeGreaterThan(20);
    expect(index.gates.length).toBe(10);
    expect(index.junctions['100']!.gateIds).toContain('g_ego_left');
    expect(index.junctionDescriptors['100']).toBeDefined();
  });

  it('adopts the producer digest and junction control', () => {
    expect(index.topologyDigest).toBe(mapIntelSample.topologyDigest);
    // No search index was passed: `signalized` can only have come from the file.
    expect(index.junctionDescriptors['100']!.control).toBe('signalized');
    expect(index.capabilities.junctionControl).toBe(true);
  });

  it('adopts the producer arm count, which now agrees with the local derivation', () => {
    expect(mapIntelSample.junctions[0]!.armCount).toBe(4);
    expect(index.junctionDescriptors['100']!.arms).toBe(4);
  });

  it('records an adopted arm count that disagrees, rather than hiding it', () => {
    const drifted = structuredClone(mapIntelSample) as typeof mapIntelSample;
    drifted.junctions[0]!.armCount = 6;
    const out = normalizeDerivedMapIndex(drifted, {
      mapId: 'synthetic',
      topology: syntheticTopology(),
    });
    expect(out.junctionDescriptors['100']!.arms).toBe(6);
    expect(out.provenance.notes.join(' ')).toContain('adopted the external arm count at 1 junction');
  });

  it('converts pointXY/radians and adopts the relation label and arc lengths', () => {
    const pair = index.junctionDescriptors['100']!.conflictPairs.find(
      (p) => p.gateA === 'g_ego_left' && p.gateB === 'g_opp_straight',
    )!;
    expect(pair.point).toEqual({ x: -0.6774691358024688, y: 1.75 });
    expect(pair.crossingAngleDeg).toBeCloseTo(127.87498365, 4);
    expect(pair.relation).toBe('opposing');
    // Adopted verbatim — the producer measures arc length the same way we do.
    expect(pair.sOnA).toBeCloseTo(10.294256462, 6);
    expect(pair.sOnB).toBeCloseTo(10.677469136, 6);
    expect(index.provenance.notes.join(' ')).toContain('adopted 2 conflict pair(s)');
  });

  it('flags a relation label and an arc length that drifted from the geometry', () => {
    // The fixture's first pair says `same_dir_merge` where the two approaches
    // are 114° apart, and `sOnA: 999` on a 19 m lane.
    const notes = index.provenance.notes.join(' ');
    expect(notes).toContain('1 relation label(s)');
    expect(notes).toContain('WARNING');
    expect(notes).toContain('drifted on the approach-relation convention');
    expect(notes).toContain('conflict arc length(s) are more than 1 m from their reprojection');
    // Adoption still happened: the seam reports drift, it does not silently
    // paper over it with a value the producer never emitted.
    const pair = index.junctionDescriptors['100']!.conflictPairs.find(
      (p) => p.gateB === 'g_north_left',
    )!;
    expect(pair.relation).toBe('merge');
    expect(pair.sOnA).toBe(999);
  });

  it('adopts segment ids, because corridor site ids embed them', () => {
    const segment = index.segments.find((s) => s.id === 'seg_9c1af0e2b7d34518');
    expect(segment).toBeDefined();
    expect(segment!.laneRsls).toEqual(['1:0:-1']);
    expect(segment!.minThroughLanesSameDir).toBe(3);
    // The fact index is rebuilt over the adopted facts, not copied.
    expect(index.factIndex.segmentsByLaneCount['3']).toContain('seg_9c1af0e2b7d34518');
    expect(index.factIndex.segmentIdsByLane['1:0:-1']).toBe('seg_9c1af0e2b7d34518');
  });

  it('turns the location catalog into bindable point features', () => {
    const kinds = index.pointFeatures.map((p) => p.kind).sort();
    expect(kinds).toEqual(['crossing', 'parking_zone']);
    const crossing = index.pointFeatures.find((p) => p.kind === 'crossing')!;
    expect(crossing.laneRsl).toBe('3:0:1');
    expect(crossing.s).toBe(12.5);
    expect(crossing.side).toBe('right');
    expect(index.capabilities.crossings).toBe(true);
    expect(index.capabilities.parkingZones).toBe(true);
  });

  it('ignores catalog entries with no lane anchor or no matcher meaning', () => {
    expect(pointFeaturesFromLocations([{ id: 'x', type: 'crosswalk' }])).toEqual([]);
    expect(
      pointFeaturesFromLocations([{ id: 'x', type: 'address', anchor: { road: { rsl: '1:0:-1' } } }]),
    ).toEqual([]);
  });

  it('adopts a school-zone catalog anchor as a first-class point feature', () => {
    expect(pointFeaturesFromLocations([{
      id: 'school:frontage',
      type: 'school_zone',
      anchor: { road: { rsl: '1:0:-1', s: 42, offsetM: -2 } },
    }])).toEqual([expect.objectContaining({
      id: 'school:frontage', kind: 'school_zone', laneRsl: '1:0:-1', s: 42, side: 'right',
    })]);
  });

  it('matches the worked example identically to the self-derived index', () => {
    const self = deriveMapIndexFromTopology(syntheticTopology(), {
      mapId: 'synthetic',
      searchIndex: syntheticSearchIndex(),
    });
    const viaSeam = matchAnchor(workedExampleAnchor(), index, { roles: workedExampleRoles() });
    const viaSelf = matchAnchor(workedExampleAnchor(), self, { roles: workedExampleRoles() });
    expect(viaSeam.map((s) => s.frame.entryLaneRsl)).toEqual(
      viaSelf.map((s) => s.frame.entryLaneRsl),
    );
    // Site ids differ only because the digests do — that is the contract.
    expect(viaSeam[0]!.siteId).not.toBe(viaSelf[0]!.siteId);
    expect(viaSeam[0]!.topologyDigest).toBe(mapIntelSample.topologyDigest);
  });

  it('accepts a raw topology index directly', () => {
    const raw = normalizeDerivedMapIndex(syntheticTopology(), { mapId: 'synthetic' });
    expect(raw.provenance.source).toBe('self-derived');
    expect(Object.keys(raw.junctionDescriptors)).toEqual(['100']);
    expect(raw.junctionDescriptors['100']!.conflictPairs.length).toBeGreaterThan(0);
  });

  it('rejects a non-object', () => {
    expect(() => normalizeDerivedMapIndex(null)).toThrow(TypeError);
  });
});

describe('detectPolylineOrder', () => {
  const topology = syntheticTopology();
  const lanes = Object.fromEntries(
    Object.entries(topology.lanes).map(([rsl, l]) => [rsl, { laneId: l.laneId, polyline: l.polyline }]),
  );

  it('detects OpenDRIVE `s` order in the raw index', () => {
    expect(detectPolylineOrder(lanes, topology.gates)).toBe('odr');
  });

  it('detects travel order when a producer has already normalized', () => {
    const flipped = Object.fromEntries(
      Object.entries(lanes).map(([rsl, l]) => [
        rsl,
        { laneId: l.laneId, polyline: l.laneId > 0 ? [...l.polyline].reverse() : l.polyline },
      ]),
    );
    expect(detectPolylineOrder(flipped, topology.gates)).toBe('travel');
  });

  it('normalizes a travel-ordered producer back to one convention', () => {
    const travelOrdered = {
      ...syntheticTopology(),
      lanes: Object.fromEntries(
        Object.entries(topology.lanes).map(([rsl, l]) => [
          rsl,
          { ...l, polyline: l.laneId > 0 ? [...l.polyline].reverse() : l.polyline },
        ]),
      ),
    };
    const normalized = normalizeDerivedMapIndex(travelOrdered, { mapId: 'synthetic' });
    const reference = deriveMapIndexFromTopology(syntheticTopology(), { mapId: 'synthetic' });
    const a = normalized.lanes['2:0:1']!;
    const b = reference.lanes['2:0:1']!;
    expect(a.polyline[0]).toEqual(b.polyline[0]);
    expect(normalized.provenance.notes.join(' ')).toContain('polyline order detected: travel');
  });
});
