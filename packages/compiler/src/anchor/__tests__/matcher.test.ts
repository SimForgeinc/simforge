import { describe, expect, it } from 'vitest';

import { deriveMapIndexFromTopology } from '../derive.js';
import { matchAnchor, matchAnchorReport } from '../matcher.js';
import { parseLogicalAnchor } from '../types/anchor.js';
import { parseRoleBindings } from '../types/roles.js';
import {
  EGO_APPROACH_LANE,
  SYNTHETIC_JUNCTION_ID,
  syntheticSearchIndex,
  syntheticTopology,
} from './fixtures/synthetic-map.js';
import { impossibleAnchor, workedExampleAnchor, workedExampleRoles } from './fixtures/anchors.js';

const signalizedIndex = deriveMapIndexFromTopology(syntheticTopology(), {
  mapId: 'synthetic',
  searchIndex: syntheticSearchIndex('traffic_light'),
});
const allWayStopIndex = deriveMapIndexFromTopology(syntheticTopology(), {
  mapId: 'synthetic',
  searchIndex: syntheticSearchIndex('stop', true),
});

describe('matchAnchor — the worked example', () => {
  const sites = matchAnchor(workedExampleAnchor(), signalizedIndex, { roles: workedExampleRoles() });

  it('finds the signalized four-way and enters on the arterial', () => {
    expect(sites).toHaveLength(1);
    const site = sites[0]!;
    expect(site.frame.origin.mapFeatureId).toBe(`junction:${SYNTHETIC_JUNCTION_ID}`);
    expect(site.frame.entryLaneRsl).toBe(EGO_APPROACH_LANE);
    expect(site.frame.egoTurn).toBe('left');
    expect(site.degradation.verdict).toBe('exact');
    expect(site.score).toBe(1);
  });

  it('builds a frame whose reference path turns left through the junction', () => {
    const frame = sites[0]!.frame;
    expect(frame.referencePath.map((s) => s.laneRsl)).toEqual(['1:0:-1', '10:0:-1', '3:0:-1']);
    // s = 0 at the stop line: the approach lane occupies negative s.
    expect(frame.sOfLane['1:0:-1']).toBeCloseTo(-140, 0);
    expect(frame.sOfLane['10:0:-1']).toBeCloseTo(0, 6);
    expect(frame.runwayUpstreamM).toBeCloseTo(140, 0);
    expect(frame.lateralLanes[0]).toBe('1:0:-1');
    expect(frame.lateralLanes[-1]).toBe('1:0:-2');
    expect(frame.lateralLanes[-2]).toBe('1:0:-3');
    expect(frame.opposingLanes[0]).toBe('1:0:1');
    expect(frame.mirrored).toBe(false);
    expect(frame.handedness).toBe('right');
  });

  it('binds the conflicting gate with a conflict point and a route for the solver', () => {
    const challenger = sites[0]!.bindings.find((b) => b.role === 'challenger')!;
    expect(challenger.status).toBe('bound');
    expect(challenger.conflict?.gateId).toBe('g_opp_straight');
    expect(challenger.conflict?.egoGateId).toBe('g_ego_left');
    expect(challenger.conflict?.relation).toBe('opposing');
    expect(challenger.conflict?.point.y).toBeCloseTo(1.75, 0);
    // The solver needs `s` on both routes plus the arrival invariant.
    expect(challenger.conflict!.sOnEgo).toBeGreaterThan(0);
    expect(challenger.conflict!.sOnActor).toBeGreaterThan(0);
    expect(challenger.arrival).toEqual({ relativeTo: 'ego', deltaT: -0.5 });
    expect(challenger.routeLaneChain).toEqual(['2:0:1', '14:0:-1', '1:0:1']);
    // Spawned upstream of its own stop line, on its own approach.
    expect(challenger.pose!.s).toBeLessThan(0);
  });

  it('explains every clause it evaluated', () => {
    const site = sites[0]!;
    const paths = site.clauses.map((c) => c.path);
    expect(paths).toContain('corridor.throughLanesSameDir');
    expect(paths).toContain('corridor.runwayUpstreamM');
    expect(paths).toContain('features.jx.junction.control');
    expect(paths).toContain('features.jx.junction.conflictingApproach');
    for (const clause of site.clauses) {
      expect(clause.reason.length).toBeGreaterThan(0);
      expect(clause.score).toBeGreaterThanOrEqual(0);
      expect(clause.score).toBeLessThanOrEqual(1);
    }
    const lanes = site.clauses.find((c) => c.path === 'corridor.throughLanesSameDir')!;
    expect(lanes.actual).toBe(3);
    expect(lanes.slack).toBe(0);
    expect(site.matchedReasons.length).toBeGreaterThan(0);
  });

  it('binds point features on laterally adjacent lanes, such as roadside bus stops', () => {
    const withRoadsideStop = {
      ...signalizedIndex,
      pointFeatures: [
        ...signalizedIndex.pointFeatures,
        { id: 'bus-stop:adjacent', kind: 'bus_stop' as const, laneRsl: '1:0:-2', s: 50, point: { x: -100, y: -5.25 } },
      ],
      factIndex: {
        ...signalizedIndex.factIndex,
        pointFeaturesByKind: {
          ...signalizedIndex.factIndex.pointFeaturesByKind,
          bus_stop: ['bus-stop:adjacent'],
        },
      },
    };
    const base = workedExampleAnchor();
    const anchor = parseLogicalAnchor({
      ...base,
      id: 'worked-example-with-roadside-stop',
      features: [
        ...base.features,
        { id: 'stop', kind: 'bus_stop', atM: { value: [-95, -85], essentiality: 'required' } },
      ],
    });

    const [site] = matchAnchor(anchor, withRoadsideStop);
    expect(site).toBeDefined();
    expect(site!.featureMatches.stop?.mapFeatureId).toBe('bus-stop:adjacent');
    expect(site!.clauses.find((c) => c.path === 'features.stop.atM')?.reason).toContain('same-road station');
  });

  it('hard-rejects a mapped stop beyond the authored lateral proximity', () => {
    const withFarStop = {
      ...signalizedIndex,
      pointFeatures: [
        ...signalizedIndex.pointFeatures,
        { id: 'bus-stop:far-kerb', kind: 'bus_stop' as const, laneRsl: '1:0:-2', s: 50, point: { x: -100, y: -14 } },
      ],
      factIndex: {
        ...signalizedIndex.factIndex,
        pointFeaturesByKind: {
          ...signalizedIndex.factIndex.pointFeaturesByKind,
          bus_stop: ['bus-stop:far-kerb'],
        },
      },
    };
    const base = workedExampleAnchor();
    const anchor = parseLogicalAnchor({
      ...base,
      id: 'worked-example-with-far-stop',
      features: [
        ...base.features,
        {
          id: 'stop',
          kind: 'bus_stop',
          atM: { value: [-95, -85], essentiality: 'required' },
          lateralDistanceM: { value: [0, 7], essentiality: 'required' },
        },
      ],
    });

    const report = matchAnchorReport(anchor, withFarStop);
    expect(report.sites).toEqual([]);
    expect(report.rejected.some((site) => site.clauses.some((clause) =>
      clause.path === 'features.stop.lateralDistanceM' &&
      typeof clause.actual === 'number' && clause.actual > 7,
    ))).toBe(true);
  });

  it('hard-rejects a proximity-only stop when same-road association is required', () => {
    const withNearbyStop = {
      ...signalizedIndex,
      pointFeatures: [
        ...signalizedIndex.pointFeatures,
        { id: 'bus-stop:nearby-only', kind: 'bus_stop' as const, laneRsl: 'missing:0:1', s: 50, point: { x: -100, y: -2 } },
      ],
      factIndex: {
        ...signalizedIndex.factIndex,
        pointFeaturesByKind: {
          ...signalizedIndex.factIndex.pointFeaturesByKind,
          bus_stop: ['bus-stop:nearby-only'],
        },
      },
    };
    const base = workedExampleAnchor();
    const anchor = parseLogicalAnchor({
      ...base,
      id: 'worked-example-with-proximity-only-stop',
      features: [
        ...base.features,
        {
          id: 'stop',
          kind: 'bus_stop',
          atM: { value: [-95, -85], essentiality: 'required' },
          lateralDistanceM: { value: [0, 7], essentiality: 'required' },
          sameRoad: { value: true, essentiality: 'required' },
        },
      ],
    });

    const report = matchAnchorReport(anchor, withNearbyStop);
    expect(report.sites).toEqual([]);
    expect(report.rejected.some((site) => site.clauses.some((clause) =>
      clause.path === 'features.stop.sameRoad' && clause.actual === false,
    ))).toBe(true);
  });

  it('stamps map, digest and semantics version onto the site', () => {
    const site = sites[0]!;
    expect(site.mapId).toBe('synthetic');
    expect(site.topologyDigest).toBe(signalizedIndex.topologyDigest);
    expect(site.matchSemanticsVersion).toBe('1.0.0');
    expect(site.siteId).toMatch(/^[0-9a-f]{16}$/);
  });
});

describe('matchAnchor — impossible anchors', () => {
  it('returns no sites and a useful failure report', () => {
    const report = matchAnchorReport(impossibleAnchor(), signalizedIndex);
    expect(report.sites).toEqual([]);
    expect(report.failureSummary.length).toBeGreaterThan(20);
    expect(report.failureSummary.toLowerCase()).toContain('no');
    // Nothing on the map is a roundabout, so candidate generation is empty.
    expect(report.stats.candidatesConsidered).toBe(0);
  });

  it('reports "no frame could be built" when no approach offers the movement', () => {
    const anchor = parseLogicalAnchor({
      id: 'needs-a-uturn',
      features: [
        {
          id: 'jx',
          kind: 'junction',
          atM: { value: [0, 0], essentiality: 'required' },
          junction: {
            control: { value: ['signalized'], essentiality: 'preferred' },
            egoTurn: { value: 'uturn', essentiality: 'required' },
          },
        },
      ],
    });
    // Drop the turn-option selector so the junction *is* considered and the
    // failure has to be found during frame construction.
    const index = {
      ...signalizedIndex,
      factIndex: {
        ...signalizedIndex.factIndex,
        junctionsByTurnOption: {
          ...signalizedIndex.factIndex.junctionsByTurnOption,
          uturn: [SYNTHETIC_JUNCTION_ID],
        },
      },
    };
    const report = matchAnchorReport(anchor, index);
    expect(report.sites).toEqual([]);
    expect(report.stats.candidatesConsidered).toBe(1);
    expect(report.stats.framesBuilt).toBe(0);
    expect(report.failureSummary).toContain('no approach offers the requested ego movement');
  });

  it('explains a failure that only shows up after the clauses are evaluated', () => {
    const anchor = parseLogicalAnchor({
      id: 'right-turn-conflict-that-does-not-exist',
      features: [
        {
          id: 'jx',
          kind: 'junction',
          atM: { value: [0, 0], essentiality: 'required' },
          junction: {
            control: { value: ['signalized'], essentiality: 'required' },
            egoTurn: { value: 'right', essentiality: 'required' },
            conflictingApproach: {
              value: { from: 'from_left', turn: 'straight' },
              essentiality: 'required',
            },
          },
        },
      ],
    });
    const report = matchAnchorReport(anchor, signalizedIndex);
    expect(report.sites).toEqual([]);
    expect(report.stats.framesBuilt).toBeGreaterThan(0);
    expect(report.rejected[0]!.degradation.verdict).toBe('infeasible');
    expect(report.failureSummary).toContain('features.jx.junction.conflictingApproach');
  });
});

describe('matchAnchor — near-miss substitution', () => {
  it('is infeasible when a required signalized junction meets an all-way stop', () => {
    const report = matchAnchorReport(workedExampleAnchor(), allWayStopIndex, {
      roles: workedExampleRoles(),
    });
    expect(report.sites).toEqual([]);
    const rejected = report.rejected[0]!;
    expect(rejected.degradation.verdict).toBe('infeasible');
    expect(rejected.degradation.intentPreserved).toBe(false);
    expect(rejected.degradation.failedRequiredClauses).toContain(
      'features.jx.junction.control',
    );
    const control = rejected.clauses.find((c) => c.path === 'features.jx.junction.control')!;
    expect(control.actual).toBe('all_way_stop');
    expect(control.score).toBeCloseTo(0.6, 6);
  });

  it('degrades — with the 0.6 near-miss score — when the class is only preferred', () => {
    const anchor = workedExampleAnchor({ controlEssentiality: 'preferred' });
    const report = matchAnchorReport(anchor, allWayStopIndex, { roles: workedExampleRoles() });
    expect(report.sites).toHaveLength(1);
    const site = report.sites[0]!;
    expect(site.degradation.verdict).toBe('degraded');
    expect(site.degradation.intentPreserved).toBe(true);
    const control = site.clauses.find((c) => c.path === 'features.jx.junction.control')!;
    expect(control.score).toBeCloseTo(0.6, 6);
    const repair = site.degradation.repairs.find((r) => r.kind === 'junction_class_substitute');
    expect(repair).toBeDefined();
    expect(repair!.touchesRequired).toBe(false);
    expect(site.degradation.summary).toContain('all_way_stop');
  });
});

describe('matchAnchor — mirroring', () => {
  const mirrorAnchorSpec = (allowMirror: boolean) =>
    parseLogicalAnchor({
      id: 'right-turn-across-a-from-right-through',
      corridor: { throughLanesSameDir: { value: [3, 3], essentiality: 'required' } },
      features: [
        {
          id: 'jx',
          kind: 'junction',
          atM: { value: [0, 0], essentiality: 'required' },
          junction: {
            control: { value: ['signalized'], essentiality: 'required' },
            egoTurn: { value: 'right', essentiality: 'required' },
            conflictingApproach: {
              value: { from: 'from_right', turn: 'straight' },
              essentiality: 'required',
            },
          },
        },
      ],
      policy: { allowMirror, minScore: 0.3 },
    });

  it('finds nothing without allowMirror', () => {
    expect(matchAnchor(mirrorAnchorSpec(false), signalizedIndex)).toEqual([]);
  });

  it('matches the mirrored rendition when the policy allows it', () => {
    const roles = parseRoleBindings([
      { role: 'ego', kind: 'on_reference' },
      { role: 'buddy', kind: 'lane_offset', k: 1, onMissing: 'clamp' },
      {
        role: 'crosser',
        kind: 'conflicting_gate',
        feature: 'jx',
        from: 'from_right',
        turn: 'straight',
      },
    ]);
    const sites = matchAnchor(mirrorAnchorSpec(true), signalizedIndex, { roles });
    expect(sites).toHaveLength(1);
    const site = sites[0]!;
    expect(site.frame.mirrored).toBe(true);
    expect(site.frame.egoTurn).toBe('left');
    // Mirroring is applied to the anchor and the roles, once: the frame, the
    // lane map and the poses all stay in map space.
    expect(site.frame.lateralLanes[-1]).toBe('1:0:-2');
    expect(site.frame.entryLaneRsl).toBe(EGO_APPROACH_LANE);
    expect(site.matchedReasons).toContain('matched in mirror (policy.allowMirror)');
    const crosser = site.bindings.find((b) => b.role === 'crosser')!;
    expect(crosser.status).toBe('bound');
    expect(crosser.conflict?.gateId).toBe('g_north_straight');
    // The role's lane offset was mirrored too, so it binds rather than clamps.
    expect(site.bindings.find((b) => b.role === 'buddy')!.status).toBe('bound');
  });
});

describe('matchAnchor — lane_offset onMissing semantics', () => {
  const roleFor = (onMissing: 'clamp' | 'drop' | 'fail', k = 2) =>
    parseRoleBindings([
      { role: 'ego', kind: 'on_reference' },
      { role: 'buddy', kind: 'lane_offset', k, onMissing },
    ]);

  it('binds when the lane exists', () => {
    const sites = matchAnchor(workedExampleAnchor(), signalizedIndex, {
      roles: roleFor('clamp', -2),
    });
    const buddy = sites[0]!.bindings.find((b) => b.role === 'buddy')!;
    expect(buddy.status).toBe('bound');
    expect(buddy.laneRsl).toBe('1:0:-3');
    expect(sites[0]!.degradation.verdict).toBe('exact');
  });

  it('clamps to the nearest lane and reports a repair', () => {
    const sites = matchAnchor(workedExampleAnchor(), signalizedIndex, { roles: roleFor('clamp') });
    const site = sites[0]!;
    const buddy = site.bindings.find((b) => b.role === 'buddy')!;
    expect(buddy.status).toBe('clamped');
    expect(buddy.pose!.k).toBe(0);
    expect(site.degradation.verdict).toBe('degraded');
    const repair = site.degradation.repairs.find((r) => r.kind === 'lane_offset_clamp')!;
    expect(repair.touchesRequired).toBe(false);
    expect(site.degradation.intentPreserved).toBe(true);
  });

  it('drops the actor when the author asked for a drop', () => {
    const sites = matchAnchor(workedExampleAnchor(), signalizedIndex, { roles: roleFor('drop') });
    const site = sites[0]!;
    expect(site.bindings.find((b) => b.role === 'buddy')!.status).toBe('dropped');
    expect(site.degradation.verdict).toBe('degraded');
    expect(site.degradation.repairs.some((r) => r.kind === 'actor_drop')).toBe(true);
  });

  it('makes the site infeasible when the author asked to fail', () => {
    const report = matchAnchorReport(workedExampleAnchor(), signalizedIndex, {
      roles: roleFor('fail'),
    });
    expect(report.sites).toEqual([]);
    const rejected = report.rejected[0]!;
    expect(rejected.degradation.verdict).toBe('infeasible');
    expect(rejected.degradation.failedRequiredClauses).toContain('roles.buddy');
    expect(rejected.degradation.intentPreserved).toBe(false);
  });
});

describe('matchAnchor — policy', () => {
  it('keeps one site per junction by default and more with diversity: none', () => {
    const wide = parseLogicalAnchor({
      id: 'any-signalized-approach',
      features: [
        {
          id: 'jx',
          kind: 'junction',
          atM: { value: [0, 0], essentiality: 'required' },
          junction: { control: { value: ['signalized'], essentiality: 'required' } },
        },
      ],
      policy: { diversity: 'junction', minScore: 0 },
    });
    const perJunction = matchAnchor(wide, signalizedIndex);
    expect(perJunction).toHaveLength(1);

    const perLane = matchAnchor(
      { ...wide, policy: { ...wide.policy, diversity: 'none' } },
      signalizedIndex,
    );
    expect(perLane.length).toBeGreaterThan(1);
    // Stable ordering: (-score, siteId).
    const keys = perLane.map((s) => [-s.score, s.siteId] as const);
    const sorted = [...keys].sort((a, b) => a[0] - b[0] || (a[1] < b[1] ? -1 : 1));
    expect(keys).toEqual(sorted);
  });

  it('honours maxSitesPerMap and minScore', () => {
    const anchor = parseLogicalAnchor({
      id: 'capped',
      features: [
        {
          id: 'jx',
          kind: 'junction',
          atM: { value: [0, 0], essentiality: 'required' },
          junction: { control: { value: ['signalized'], essentiality: 'required' } },
        },
      ],
      policy: { diversity: 'none', maxSitesPerMap: 2, minScore: 0 },
    });
    expect(matchAnchor(anchor, signalizedIndex)).toHaveLength(2);

    const strict = { ...anchor, policy: { ...anchor.policy, minScore: 1.01 } };
    expect(matchAnchor(strict, signalizedIndex)).toEqual([]);
  });

  it('resolves a pin to exactly one site', () => {
    const base = workedExampleAnchor();
    const site = matchAnchor(base, signalizedIndex)[0]!;
    const pinned = { ...base, pin: { mapId: 'synthetic', siteId: site.siteId } };
    const sites = matchAnchor(pinned, signalizedIndex);
    expect(sites).toHaveLength(1);
    expect(sites[0]!.siteId).toBe(site.siteId);

    const wrongMap = { ...base, pin: { mapId: 'other-map', siteId: site.siteId } };
    const report = matchAnchorReport(wrongMap, signalizedIndex);
    expect(report.sites).toEqual([]);
    expect(report.warnings.join(' ')).toContain('pinned to map');
  });
});

describe('matchAnchor — corridor-only anchors', () => {
  it('matches segments when the anchor names no junction', () => {
    const anchor = parseLogicalAnchor({
      id: 'three-lane-straightaway',
      corridor: {
        throughLanesSameDir: { value: [3, 3], essentiality: 'required' },
        curvatureDegPer10m: { value: [0, 2], essentiality: 'preferred' },
        runwayDownstreamM: { value: 100, essentiality: 'required' },
      },
      policy: { diversity: 'none', minScore: 0.3 },
    });
    const sites = matchAnchor(anchor, signalizedIndex);
    expect(sites.length).toBeGreaterThan(0);
    const site = sites[0]!;
    expect(site.frame.origin.kind).toBe('corridor');
    expect(site.frame.origin.mapFeatureId).toMatch(/^seg:/);
    expect(site.clauses.find((c) => c.path === 'corridor.throughLanesSameDir')!.actual).toBe(3);
  });

  it('places featureless corridor zero after the required approach runway', () => {
    const anchor = parseLogicalAnchor({
      id: 'featureless-with-approach',
      corridor: {
        throughLanesSameDir: { value: [3, 3], essentiality: 'required' },
        runwayUpstreamM: { value: 40, essentiality: 'required' },
        runwayDownstreamM: { value: 120, essentiality: 'required' },
      },
      policy: { diversity: 'none', minScore: 0 },
    });
    const roles = parseRoleBindings([
      { role: 'ego', kind: 'on_reference', dsM: -30, tFrac: 0 },
    ]);
    const sites = matchAnchor(anchor, signalizedIndex, { roles });
    expect(sites.length).toBeGreaterThan(0);
    expect(sites[0]!.frame.runwayUpstreamM).toBe(40);
    expect(sites[0]!.frame.runwayDownstreamM).toBeGreaterThanOrEqual(120);
    expect(sites[0]!.bindings[0]).toMatchObject({ role: 'ego', status: 'bound' });
    expect(sites[0]!.bindings[0]!.pose!.s).toBe(-30);
  });

  it('fails a required clause the index cannot answer, loudly', () => {
    const anchor = parseLogicalAnchor({
      id: 'needs-grade',
      corridor: {
        throughLanesSameDir: { value: [3, 3], essentiality: 'required' },
        gradePct: { value: [4, 8], essentiality: 'required' },
      },
      policy: { diversity: 'none', minScore: 0 },
    });
    const report = matchAnchorReport(anchor, signalizedIndex);
    expect(report.sites).toEqual([]);
    const grade = report.rejected[0]!.clauses.find((c) => c.path === 'corridor.gradePct')!;
    expect(grade.supported).toBe(false);
    expect(grade.score).toBe(0);
    expect(report.rejected[0]!.degradation.summary).toContain('gradePct');
  });
});
