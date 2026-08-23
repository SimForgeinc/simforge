import { describe, expect, it } from 'vitest';

import { matchAnchorReport } from '../matcher.js';
import { normalizeDerivedMapIndex, pointFeaturesFromLocations } from '../normalize.js';
import { syntheticTopology } from './fixtures/synthetic-map.js';

const required = <T>(value: T) => ({ value, essentiality: 'required' as const });

function crossingAnchor(overrides: Record<string, unknown> = {}) {
  return {
    id: 'strict-crossing',
    features: [{
      id: 'xw', kind: 'crossing' as const,
      atM: required([-1_000, 1_000] as [number, number]),
      crossing: {
        marked: required(true),
        controlled: required(true),
        lengthM: required([12, 20] as [number, number]),
        placement: required('junction_leg' as const),
        ...overrides,
      },
    }],
    policy: { allowMirror: false, maxSitesPerMap: 20, diversity: 'none' as const, minScore: 0 },
  };
}

function indexWith(facts: Record<string, string | number | boolean>, junctionId: string | undefined = '100') {
  return normalizeDerivedMapIndex(syntheticTopology(), {
    mapId: 'crossing-map',
    locations: [{
      id: 'xw-map', type: 'crosswalk',
      anchor: { road: { rsl: '1:0:-1', s: 60, offsetM: 0, ...(junctionId ? { junctionId } : {}) } },
      facts,
    }],
  });
}

describe('crossing predicates', () => {
  it('evaluates marked, controlled, length and junction-leg placement from map facts', () => {
    const report = matchAnchorReport(crossingAnchor(), indexWith({
      is_marked: true, is_signalized: true, crossing_length_m: 16, is_midblock: false,
    }));
    expect(report.sites.length).toBeGreaterThan(0);
    const clauses = report.sites[0]!.clauses.filter((clause) => clause.path.startsWith('features.xw.'));
    expect(clauses).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: 'features.xw.marked', actual: true, supported: true, score: 1 }),
      expect.objectContaining({ path: 'features.xw.controlled', actual: true, supported: true, score: 1 }),
      expect.objectContaining({ path: 'features.xw.lengthM', actual: 16, supported: true, score: 1 }),
      expect.objectContaining({ path: 'features.xw.placement', actual: 'junction_leg', supported: true, score: 1 }),
    ]));
  });

  it('fails closed for false or absent required crossing evidence', () => {
    const falseEvidence = matchAnchorReport(crossingAnchor(), indexWith({
      is_marked: false, is_signalized: true, crossing_length_m: 16, is_midblock: false,
    }));
    expect(falseEvidence.sites).toHaveLength(0);
    expect(falseEvidence.failureSummary).toContain('features.xw.marked');

    const absentEvidence = matchAnchorReport(crossingAnchor(), indexWith({}));
    expect(absentEvidence.sites).toHaveLength(0);
    expect(absentEvidence.rejected.flatMap((site) => site.clauses).find((clause) => clause.path === 'features.xw.controlled')).toMatchObject({
      supported: false, score: 0,
    });
  });

  it('distinguishes midblock placement and preserves an honest zero-match', () => {
    const midblock = indexWith({
      is_marked: true, is_signalized: true, crossing_length_m: 16, is_midblock: true,
    }, undefined);
    expect(matchAnchorReport(crossingAnchor({ placement: required('midblock') }), midblock).sites.length).toBeGreaterThan(0);
    expect(matchAnchorReport(crossingAnchor(), midblock).sites).toHaveLength(0);
  });

  it('derives a deterministic crossing envelope length from catalog extent', () => {
    expect(pointFeaturesFromLocations([{
      id: 'xw', type: 'crosswalk', anchor: { road: { rsl: '1:0:-1', s: 2 } }, extent: { radiusM: 8 },
    }])[0]?.facts?.crossing_length_m).toBe(16);
  });
});
