import { describe, expect, it } from 'vitest';

import { matchAnchorReport } from '../matcher.js';
import { normalizeDerivedMapIndex } from '../normalize.js';
import { syntheticTopology } from './fixtures/synthetic-map.js';

describe('construction and visibility capability layers', () => {
  it('adopts work-zone and occlusion descriptors with their measured facts', () => {
    const topology = syntheticTopology();
    const index = normalizeDerivedMapIndex(topology, {
      mapId: 'capability-map',
      locations: [
        {
          id: 'work-1', type: 'work_zone_suitable',
          anchor: { road: { rsl: '1:0:-1', s: 60, offsetM: 0 }, scene: { x: -90, y: 0, z: 1.75 } },
          facts: { usable_length_m: 45, has_shoulder_adjacent: true },
        },
        {
          id: 'blind-1', type: 'occlusion_zone',
          anchor: { road: { rsl: '1:0:-1', s: 70, offsetM: -4 }, scene: { x: -80, y: 0, z: 5.75 } },
          facts: { source: 'building_frontage', confidence: 0.82 },
        },
      ],
    });
    expect(index.capabilities).toMatchObject({ workZones: true, occlusionZones: true });
    expect(index.pointFeatures.find((feature) => feature.id === 'work-1')).toMatchObject({
      kind: 'work_zone_suitable', facts: { usable_length_m: 45, has_shoulder_adjacent: true },
    });
    expect(index.pointFeatures.find((feature) => feature.id === 'blind-1')).toMatchObject({
      kind: 'occlusion_zone', facts: { source: 'building_frontage', confidence: 0.82 },
    });
  });

  it('returns a precise missing-capability dependency instead of a false zero-match', () => {
    const index = normalizeDerivedMapIndex(syntheticTopology(), { mapId: 'no-layers' });
    const report = matchAnchorReport({
      id: 'needs-construction',
      features: [{ id: 'work', kind: 'work_zone_suitable', atM: { value: [10, 100], essentiality: 'required' } }],
      policy: { allowMirror: false, maxSitesPerMap: 5, diversity: 'road_direction', minScore: 0.5 },
    }, index);
    expect(report.sites).toHaveLength(0);
    expect(report.warnings).toContain('map index carries no work-zone suitability layer: rebuild locations with work-zone densification');
    expect(report.failureSummary.toLowerCase()).toContain('required');
  });

  it('recenters a work-zone corridor so the adopted catalog feature closes the authored station', () => {
    const index = normalizeDerivedMapIndex(syntheticTopology(), {
      mapId: 'work-zone-frame-map',
      locations: [{
        id: 'work-1', type: 'work_zone_suitable',
        anchor: { road: { rsl: '1:0:-1', s: 60, offsetM: 0 }, scene: { x: -90, y: 0, z: 1.75 } },
        facts: { usable_length_m: 45, has_shoulder_adjacent: true },
      }],
    });
    const report = matchAnchorReport({
      id: 'center-on-work-zone',
      corridor: { throughLanesSameDir: { value: [1, 4], essentiality: 'required' } },
      features: [{
        id: 'work', kind: 'work_zone_suitable',
        atM: { value: [20, 20], essentiality: 'required' },
        sameRoad: { value: true, essentiality: 'required' },
      }],
      policy: { allowMirror: false, maxSitesPerMap: 5, diversity: 'road_direction', minScore: 0.5 },
    }, index);
    const exact = report.sites.find((site) => site.featureMatches.work?.mapFeatureId === 'work-1');
    expect(exact?.featureMatches.work).toMatchObject({ mapFeatureId: 'work-1', s: 20 });
    expect(exact?.frame.sRange[0]).toBeLessThan(0);
    expect(exact?.frame.sRange[1]).toBeGreaterThan(20);
  });
});
