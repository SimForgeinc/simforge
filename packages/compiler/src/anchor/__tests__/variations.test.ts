import { describe, expect, it } from 'vitest';

import { deriveMapIndexFromTopology } from '../derive.js';
import { matchAnchor } from '../matcher.js';
import {
  compareBehaviorSignatures,
  finalizeVariationAcceptance,
  inferPortableSitePattern,
  reportSiteEquivalence,
  searchScenarioVariations,
} from '../variations.js';
import { syntheticSearchIndex, syntheticTopology } from './fixtures/synthetic-map.js';
import { workedExampleAnchor, workedExampleRoles } from './fixtures/anchors.js';

const sourceIndex = deriveMapIndexFromTopology(syntheticTopology(), {
  mapId: 'source-map',
  searchIndex: syntheticSearchIndex('traffic_light'),
});

function copyIndex(mapId: string, control: 'traffic_light' | 'stop' = 'traffic_light') {
  return deriveMapIndexFromTopology(syntheticTopology(), {
    mapId,
    searchIndex: syntheticSearchIndex(control, control === 'stop'),
  });
}

describe('portable scenario variations', () => {
  const sourceSite = matchAnchor(workedExampleAnchor(), sourceIndex, { roles: workedExampleRoles() })[0]!;

  it('infers structural requirements from an accepted concrete site without world coordinates', () => {
    const pattern = inferPortableSitePattern(sourceSite, sourceIndex, { requiredRoles: ['ego', 'challenger'] });
    expect(pattern.anchor.pin).toBeUndefined();
    expect(pattern.anchor.corridor?.throughLanesSameDir).toMatchObject({ value: [1, 3], essentiality: 'required' });
    expect(pattern.sourceSignature).toMatchObject({
      approachThroughLanesSameDir: 3,
      approachThroughLanesOpposing: 3,
      egoTurn: 'left',
      junctionArms: 4,
      junctionControl: 'signalized',
    });
    expect(pattern.anchor.features[0]).toMatchObject({
      kind: 'junction',
      junction: {
        arms: { value: [4, 4], essentiality: 'required' },
        control: { value: ['signalized'], essentiality: 'required' },
        egoTurn: { value: 'left', essentiality: 'required' },
        conflictingApproach: { value: { from: 'opposing', turn: 'straight' }, essentiality: 'required' },
      },
    });
    expect(JSON.stringify(pattern.anchor)).not.toContain(sourceSite.frame.entryLaneRsl);
    expect(pattern.cacheKey).toHaveLength(64);
  });

  it('searches maps deterministically and rejects a control-class mismatch with a repair dependency', () => {
    const pattern = inferPortableSitePattern(sourceSite, sourceIndex);
    const equivalent = copyIndex('equivalent-map');
    const wrongControl = copyIndex('stop-map', 'stop');
    const first = searchScenarioVariations(pattern, [wrongControl, equivalent], { roles: workedExampleRoles(), requiredRoles: ['ego', 'challenger'] });
    const second = searchScenarioVariations(pattern, [equivalent, wrongControl], { roles: workedExampleRoles(), requiredRoles: ['ego', 'challenger'] });
    expect(first.resumeToken).toBe(second.resumeToken);
    expect(first.candidates[0]?.mapId).toBe('equivalent-map');
    expect(first.candidates[0]?.equivalence.verdict).toBe('equivalent');
    expect(first.candidates[0]?.equivalence.acceptance).toBe('pending_validation');
    expect(first.reportsByMap['stop-map']?.sites).toHaveLength(0);
    const rejected = first.reportsByMap['stop-map']?.rejected[0];
    expect(rejected?.degradation.failedRequiredClauses).toContain('features.jx.junction.control');
  });

  it('returns zero matches honestly for a structurally impossible transfer', () => {
    const pattern = inferPortableSitePattern(sourceSite, sourceIndex);
    const impossible = {
      ...pattern,
      anchor: {
        ...pattern.anchor,
        corridor: {
          ...pattern.anchor.corridor!,
          throughLanesSameDir: { value: [20, 20] as [number, number], essentiality: 'required' as const, tolerance: 0 },
        },
      },
    };
    const search = searchScenarioVariations(impossible, [copyIndex('simple-map')], { roles: workedExampleRoles() });
    expect(search.candidates).toHaveLength(0);
    expect(search.reportsByMap['simple-map']?.sites).toHaveLength(0);
    expect(search.reportsByMap['simple-map']?.failureSummary).not.toBe('');
  });

  it('preserves authored crossing semantics through a simple transfer and rejects an unsupported target', () => {
    const sourceAnchor = workedExampleAnchor();
    const authoredAnchor = {
      ...sourceAnchor,
      features: [...sourceAnchor.features, {
        id: 'xw', kind: 'crossing' as const,
        atM: { value: [-1_000, 1_000] as [number, number], essentiality: 'required' as const },
        crossing: {
          marked: { value: true, essentiality: 'required' as const },
          controlled: { value: true, essentiality: 'required' as const },
          lengthM: { value: [12, 20] as [number, number], essentiality: 'required' as const },
          placement: { value: 'junction_leg' as const, essentiality: 'required' as const },
        },
      }],
    };
    const pattern = inferPortableSitePattern(sourceSite, sourceIndex, { authoredAnchor });
    expect(pattern.anchor.features.find((feature) => feature.id === 'xw')?.crossing).toEqual(
      authoredAnchor.features[1]!.crossing,
    );

    const withCrossing = (mapId: string, facts: Record<string, string | number | boolean>) => {
      const base = copyIndex(mapId);
      const lanes = Object.values(base.lanes).filter((lane) => !lane.isJunction);
      return {
        ...base,
        pointFeatures: lanes.map((lane, index) => ({
          id: `xw-${index}`, kind: 'crossing' as const, laneRsl: lane.rsl,
          s: lane.lengthM / 2, junctionId: '100', facts,
        })),
        capabilities: { ...base.capabilities, crossings: true },
      };
    };
    const accepted = searchScenarioVariations(pattern, [withCrossing('crossing-target', {
      is_marked: true, is_signalized: true, crossing_length_m: 16, is_midblock: false,
    })], { roles: workedExampleRoles(), requiredRoles: ['ego', 'challenger'] });
    expect(accepted.candidates.length).toBeGreaterThan(0);

    const unsupported = searchScenarioVariations(pattern, [withCrossing('unknown-crossing-target', {})], {
      roles: workedExampleRoles(), requiredRoles: ['ego', 'challenger'],
    });
    expect(unsupported.candidates).toHaveLength(0);
    expect(unsupported.reportsByMap['unknown-crossing-target']?.failureSummary).toContain('features.xw');
  });

  it('marks a stale source topology and changes the resume token when topology changes', () => {
    const stale = { ...sourceSite, topologyDigest: 'obsolete-topology' };
    const pattern = inferPortableSitePattern(stale, sourceIndex);
    expect(pattern.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'source_topology_stale', retryable: true }),
    ]));
    const first = searchScenarioVariations(pattern, [copyIndex('target-map')], { roles: workedExampleRoles() });
    const changed = { ...copyIndex('target-map'), topologyDigest: 'changed-topology' };
    const resumed = searchScenarioVariations(pattern, [changed], { roles: workedExampleRoles() });
    expect(resumed.resumeToken).not.toBe(first.resumeToken);
  });

  it('makes unbound roles and ambiguous frame permutations explicit', () => {
    const site = { ...sourceSite, alternateFrames: 2, bindings: sourceSite.bindings.filter((binding) => binding.role !== 'challenger') };
    const report = reportSiteEquivalence(site, ['ego', 'challenger']);
    expect(report.verdict).toBe('rejected');
    expect(report.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'required_role_unbound', path: 'roles.challenger', retryable: true }),
      expect.objectContaining({ code: 'ambiguous_permutation' }),
      expect.objectContaining({ code: 'materialization_required', stage: 'materialize' }),
    ]));
  });

  it('compares behavior semantically rather than by world coordinates', () => {
    const source = {
      durationS: 20,
      actors: { ego: { routeClass: 'left', distanceM: 80, finalSpeedMps: 8, interactionOrder: ['brake', 'turn'] } },
      minTtcS: 1.5,
      collisions: 0,
      invariantFailures: [],
    };
    expect(compareBehaviorSignatures(source, {
      ...source,
      actors: { ego: { ...source.actors.ego, distanceM: 84 } },
      minTtcS: 1.6,
    }).verdict).toBe('equivalent');
    const mismatch = compareBehaviorSignatures(source, {
      ...source,
      actors: { ego: { ...source.actors.ego, routeClass: 'straight' } },
      collisions: 1,
    });
    expect(mismatch.verdict).toBe('rejected');
    expect(mismatch.issues.map((issue) => issue.path)).toEqual(expect.arrayContaining(['actors.ego.routeClass', 'collisions']));

    const pattern = inferPortableSitePattern(sourceSite, sourceIndex);
    const search = searchScenarioVariations(pattern, [copyIndex('accepted-map')], { roles: workedExampleRoles() });
    const candidate = search.candidates[0]!;
    expect(finalizeVariationAcceptance({
      candidate,
      materializationSucceeded: true,
      sourceBehavior: source,
      candidateBehavior: { ...source, actors: { ego: { ...source.actors.ego, distanceM: 84 } }, minTtcS: 1.6 },
      requiredChecksPassed: true,
    }).status).toBe('accepted');
    expect(finalizeVariationAcceptance({ candidate, materializationSucceeded: true }).status).toBe('pending_simulation');
  });
});
