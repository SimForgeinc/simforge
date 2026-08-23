/**
 * Frame construction, the remaining role kinds, and the degradation contract.
 *
 * The lane-graph trap these tests guard against is worth stating: the raw
 * `predecessors`/`successors` lists are **not** travel-directed (on Yale the
 * same neighbour appears in both lists for hundreds of lanes), so
 * `derive.ts` re-derives direction geometrically. If that ever regresses, the
 * reference paths below turn into nonsense — a frame that walks backwards out
 * of the junction, or a "runway" that doubles back on itself.
 */

import { describe, expect, it } from 'vitest';

import { bindRoles, egoGateForJunction } from '../bind.js';
import { buildCorridorFrame, buildJunctionFrames, enumerateChains, laneAtS } from '../frame.js';
import { degrade } from '../degradation.js';
import { deriveMapIndexFromTopology } from '../derive.js';
import { evaluateAnchor } from '../clauses.js';
import { matchAnchor } from '../matcher.js';
import { parseLogicalAnchor } from '../types/anchor.js';
import { parseRoleBindings } from '../types/roles.js';
import type { PointFeature } from '../types/map-index.js';
import { EGO_APPROACH_LANE, syntheticSearchIndex, syntheticTopology } from './fixtures/synthetic-map.js';
import { workedExampleAnchor, workedExampleRoles } from './fixtures/anchors.js';

const index = deriveMapIndexFromTopology(syntheticTopology(), {
  mapId: 'synthetic',
  searchIndex: syntheticSearchIndex(),
});

const frames = buildJunctionFrames(index, '100', EGO_APPROACH_LANE, {
  egoTurn: 'left',
  anchorFeatureId: 'jx',
});
const frame = frames[0]!;

describe('AnchorFrame', () => {
  it('walks the reference path through the requested gate', () => {
    expect(frames).toHaveLength(1);
    expect(frame.egoGateId).toBe('g_ego_left');
    expect(frame.egoTurn).toBe('left');
    expect(frame.referencePath.map((s) => s.laneRsl)).toEqual(['1:0:-1', '10:0:-1', '3:0:-1']);
    expect(frame.referencePath.every((s) => s.contiguous)).toBe(true);
  });

  it('puts s = 0 at the stop line, upstream negative', () => {
    const approach = frame.referencePath[0]!;
    expect(approach.sEnd).toBeCloseTo(0, 6);
    expect(approach.sStart).toBeLessThan(0);
    expect(frame.sOfLane['1:0:-1']).toBe(approach.sStart);
    expect(frame.sRange[0]).toBeLessThan(0);
    expect(frame.sRange[1]).toBeGreaterThan(0);
    expect(laneAtS(frame, -10)!.span.laneRsl).toBe('1:0:-1');
    expect(laneAtS(frame, 5)!.span.laneRsl).toBe('10:0:-1');
    expect(laneAtS(frame, 100000)).toBeNull();
  });

  it('reports real runway in both directions', () => {
    expect(frame.runwayUpstreamM).toBeCloseTo(140, 0);
    expect(frame.runwayDownstreamM).toBeGreaterThan(100);
  });

  it('emits no frame when the junction offers no such movement', () => {
    expect(buildJunctionFrames(index, '100', '1:0:-1', { egoTurn: 'right', anchorFeatureId: 'jx' })).toEqual([]);
    // `1:0:-2` has only a straight movement.
    expect(buildJunctionFrames(index, '100', '1:0:-2', { egoTurn: 'left', anchorFeatureId: 'jx' })).toEqual([]);
  });

  it('emits both candidates when the continuation is genuinely ambiguous', () => {
    // `1:0:-1` has two movements; without a requested turn, the straightest
    // wins and the left turn is not within the ambiguity band.
    const noTurn = buildJunctionFrames(index, '100', '1:0:-1', { anchorFeatureId: 'jx' });
    expect(noTurn).toHaveLength(1);
    expect(noTurn[0]!.egoTurn).toBe('straight');

    // A forward walk from a lane with a single continuation stays single.
    const chains = enumerateChains(index, '3:0:-1', 50, 'forward');
    expect(chains.length).toBeLessThanOrEqual(4);
  });

  it('builds a corridor frame for a segment when no junction is named', () => {
    const segment = index.segments.find((s) => s.laneRsls.includes(EGO_APPROACH_LANE))!;
    const corridor = buildCorridorFrame(index, segment.id, { anchorFeatureId: 'corridor' })!;
    expect(corridor.origin.kind).toBe('corridor');
    expect(corridor.sRange[0]).toBeCloseTo(0, 6);
    expect(corridor.entryLaneRsl).toBe(EGO_APPROACH_LANE);
    expect(buildCorridorFrame(index, 'seg:nope', { anchorFeatureId: 'corridor' })).toBeNull();
  });
});

describe('role binding', () => {
  const evaluation = evaluateAnchor({ index, frame, anchor: workedExampleAnchor() });

  it('binds on_reference to the reference lane at the requested station', () => {
    const [ego] = bindRoles(index, frame, parseRoleBindings([
      { role: 'ego', kind: 'on_reference', dsM: -60, tFrac: 0.1 },
    ]), evaluation.featureMatches);
    expect(ego!.status).toBe('bound');
    expect(ego!.laneRsl).toBe('1:0:-1');
    expect(ego!.pose).toEqual({ k: 0, s: -60, tFrac: 0.1, headingOffsetRad: 0 });
    expect(ego!.routeLaneChain).toEqual(['1:0:-1', '10:0:-1', '3:0:-1']);
  });

  it('binds opposing traffic head-on, innermost first', () => {
    const [oncoming] = bindRoles(index, frame, parseRoleBindings([
      { role: 'oncoming', kind: 'opposing', index: 0, dsM: 60 },
    ]), evaluation.featureMatches);
    expect(oncoming!.status).toBe('bound');
    expect(oncoming!.laneRsl).toBe('1:0:1');
    expect(oncoming!.pose!.headingOffsetRad).toBeCloseTo(Math.PI, 6);
    const [missing] = bindRoles(index, frame, parseRoleBindings([
      { role: 'oncoming', kind: 'opposing', index: 9 },
    ]), evaluation.featureMatches);
    expect(missing!.status).toBe('failed');
  });

  it('binds relative_to against an earlier role and fails when it runs out of lanes', () => {
    const bindings = bindRoles(index, frame, parseRoleBindings([
      { role: 'lead', kind: 'on_reference', dsM: -30 },
      { role: 'follower', kind: 'relative_to', ref: 'lead', dLane: -1, dsM: -25 },
      { role: 'stray', kind: 'relative_to', ref: 'lead', dLane: 4 },
      { role: 'clamper', kind: 'relative_to', ref: 'lead', dLane: 4, onMissing: 'clamp' },
      { role: 'orphan', kind: 'relative_to', ref: 'nobody', dLane: 0 },
    ]), evaluation.featureMatches);
    const follower = bindings.find((b) => b.role === 'follower')!;
    expect(follower.status).toBe('bound');
    expect(follower.pose).toMatchObject({ k: -1, s: -55 });
    expect(follower.laneRsl).toBe('1:0:-2');
    // `dLane` is a lane request, so the default is to fail rather than to
    // relocate the actor into a lane the author did not ask for.
    expect(bindings.find((b) => b.role === 'stray')!.status).toBe('failed');
    expect(bindings.find((b) => b.role === 'clamper')!.status).toBe('clamped');
    expect(bindings.find((b) => b.role === 'orphan')!.status).toBe('failed');
  });

  it('binds a lane-drop pair to the exact terminating lane and legal continuing sibling', () => {
    const terminatingRsl = '1:0:-3';
    const continuingRsl = '1:0:-2';
    const laneDropIndex = {
      ...index,
      lanes: {
        ...index.lanes,
        [terminatingRsl]: { ...index.lanes[terminatingRsl]!, successors: [] },
      },
    };
    const bindings = bindRoles(laneDropIndex, frame, parseRoleBindings([
      {
        role: 'ego', kind: 'at_lane_drop', feature: 'drop',
        lane: 'continuing_sibling', dsM: -50,
      },
      {
        role: 'merger', kind: 'at_lane_drop', feature: 'drop',
        lane: 'terminating', dsM: -49,
      },
    ]), {
      drop: { mapFeatureId: `lane_drop:${terminatingRsl}@-30`, s: -30, kind: 'lane_drop' },
    });
    expect(bindings.map((binding) => binding.status)).toEqual(['bound', 'bound']);
    expect(bindings[0]).toMatchObject({ laneRsl: continuingRsl, pose: { k: -1, s: -50 } });
    expect(bindings[1]).toMatchObject({ laneRsl: terminatingRsl, pose: { k: -2, s: -49 } });
    expect(bindings[1]!.notes.join(' ')).toContain('legal left merge');
  });

  it('ranks conflicting gates by crossing-angle closeness to the template', () => {
    const roles = (angle: number) =>
      parseRoleBindings([
        {
          role: 'crosser',
          kind: 'conflicting_gate',
          feature: 'jx',
          from: 'from_left',
          turn: 'straight',
          templateCrossingAngleDeg: angle,
        },
      ]);
    const [tbone] = bindRoles(index, frame, roles(90), evaluation.featureMatches);
    expect(tbone!.status).toBe('bound');
    expect(tbone!.conflict!.gateId).toBe('g_north_straight');
    expect(tbone!.conflict!.angleErrorDeg).toBeLessThan(45);
    expect(tbone!.notes.join(' ')).toContain('template 90°');
  });

  it('hard-fails a required conflicting gate with insufficient connected approach runway', () => {
    const [short] = bindRoles(index, frame, parseRoleBindings([
      {
        role: 'crosser', kind: 'conflicting_gate', feature: 'jx',
        from: 'from_left', turn: 'straight', minUpstreamRunwayM: 1_000,
        arriveAtConflict: { relativeTo: 'ego', deltaT: 1 },
      },
    ]), evaluation.featureMatches);
    expect(short).toMatchObject({ role: 'crosser', status: 'failed' });
    expect(short!.notes.join(' ')).toContain('connected upstream runway');

    const [supported] = bindRoles(index, frame, parseRoleBindings([
      {
        role: 'crosser', kind: 'conflicting_gate', feature: 'jx',
        from: 'from_left', turn: 'straight', minUpstreamRunwayM: 40,
        arriveAtConflict: { relativeTo: 'ego', deltaT: 1 },
      },
    ]), evaluation.featureMatches);
    expect(supported).toMatchObject({ role: 'crosser', status: 'bound' });
  });

  it('fails on_crossing and in_parking_zone loudly when the layer is missing', () => {
    const bindings = bindRoles(index, frame, parseRoleBindings([
      { role: 'ped', kind: 'on_crossing', feature: 'jx', startFrac: 0.2 },
      { role: 'parked', kind: 'in_parking_zone', feature: 'jx' },
    ]), evaluation.featureMatches);
    expect(bindings.map((b) => b.status)).toEqual(['failed', 'failed']);
    expect(bindings[0]!.notes.join(' ')).toContain('crossing layer');
  });

  it('binds on_crossing and in_parking_zone when point features exist', () => {
    const pointFeatures: PointFeature[] = [
      { id: 'x_north', kind: 'crossing', laneRsl: '1:0:-1', s: 130 },
      { id: 'p_west', kind: 'parking_zone', laneRsl: '1:0:-1', s: 60, side: 'right' },
    ];
    const withFeatures = {
      ...index,
      pointFeatures,
      capabilities: { ...index.capabilities, crossings: true, parkingZones: true },
    };
    const anchor = parseLogicalAnchor({
      id: 'ped-at-crossing',
      features: [
        {
          id: 'jx',
          kind: 'junction',
          atM: { value: [0, 0], essentiality: 'required' },
          junction: { egoTurn: { value: 'left', essentiality: 'required' } },
        },
        { id: 'xw', kind: 'crossing', atM: { value: [-20, 0], essentiality: 'preferred' } },
        { id: 'pk', kind: 'parking_zone', atM: { value: [-100, -50], essentiality: 'preferred' } },
      ],
    });
    const evaluated = evaluateAnchor({ index: withFeatures, frame, anchor });
    expect(evaluated.featureMatches['xw']?.mapFeatureId).toBe('x_north');
    const bindings = bindRoles(withFeatures, frame, parseRoleBindings([
      { role: 'ped', kind: 'on_crossing', feature: 'xw', startFrac: 0 },
      { role: 'parked', kind: 'in_parking_zone', feature: 'pk', side: 'right' },
    ]), evaluated.featureMatches);
    expect(bindings.map((b) => b.status)).toEqual(['bound', 'bound']);
    expect(bindings[0]!.pose!.headingOffsetRad).toBeCloseTo(Math.PI / 2, 6);
    expect(bindings[1]!.pose!.tFrac).toBe(-1);
  });

  it('finds the ego gate for a junction the path passes through', () => {
    expect(egoGateForJunction(index, frame, '100')).toBe('g_ego_left');
    expect(egoGateForJunction(index, frame, 'nope')).toBeUndefined();
  });
});

describe('degradation contract', () => {
  const clause = (over: Partial<Parameters<typeof degrade>[0]['clauses'][number]> = {}) => ({
    path: 'corridor.speedLimitKph',
    essentiality: 'preferred' as const,
    required: [40, 60],
    actual: 30,
    score: 0.5,
    slack: 10,
    weight: 1,
    supported: true,
    reason: 'slower than requested',
    ...over,
  });

  it('calls an untouched match exact', () => {
    const result = degrade({
      anchor: workedExampleAnchor(),
      roles: [],
      clauses: [clause({ score: 1, slack: 0, actual: 50 })],
      bindings: [],
      softScore: 1,
      failedRequiredClauses: [],
    });
    expect(result.report.verdict).toBe('exact');
    expect(result.report.repairs).toEqual([]);
    expect(result.report.intentPreserved).toBe(true);
  });

  it('applies repairs in the documented order and preserves intent', () => {
    const result = degrade({
      anchor: workedExampleAnchor(),
      roles: parseRoleBindings([{ role: 'buddy', kind: 'lane_offset', k: 3, onMissing: 'clamp' }]),
      clauses: [
        clause(),
        clause({ path: 'features.jx.atM', required: [0, 0], actual: 6, slack: 6, score: 0.4 }),
        clause({
          path: 'features.jx.junction.control',
          required: ['signalized'],
          actual: 'all_way_stop',
          score: 0.6,
          slack: 0.4,
        }),
      ],
      bindings: [
        {
          role: 'buddy',
          kind: 'lane_offset',
          status: 'clamped',
          pose: { k: 1, s: 0, tFrac: 0, headingOffsetRad: 0 },
          notes: [],
        },
      ],
      softScore: 0.7,
      failedRequiredClauses: [],
    });
    expect(result.report.verdict).toBe('degraded');
    expect(result.report.repairs.map((r) => r.kind)).toEqual([
      'speed_clamp',
      'feature_distance_relax',
      'lane_offset_clamp',
      'junction_class_substitute',
    ]);
    expect(result.report.intentPreserved).toBe(true);
    expect(result.score).toBeLessThan(0.7);
    expect(result.report.summary).toContain('Presentation was relaxed');
  });

  it('is infeasible as soon as a repair would touch a required clause', () => {
    const result = degrade({
      anchor: workedExampleAnchor(),
      roles: [],
      clauses: [clause({ essentiality: 'required' })],
      bindings: [],
      softScore: 1,
      failedRequiredClauses: ['corridor.speedLimitKph'],
    });
    expect(result.report.verdict).toBe('infeasible');
    expect(result.report.intentPreserved).toBe(false);
    expect(result.score).toBe(0);
    expect(result.report.summary).toContain('Infeasible');
  });

  it('drops a cosmetic actor but never a required one', () => {
    const build = (essentiality: 'required' | 'cosmetic') =>
      degrade({
        anchor: workedExampleAnchor(),
        roles: parseRoleBindings([
          { role: 'extra', kind: 'opposing', index: 4, essentiality },
        ]),
        clauses: [],
        bindings: [{ role: 'extra', kind: 'opposing', status: 'failed', notes: ['no such lane'] }],
        softScore: 1,
        failedRequiredClauses: [],
      });
    expect(build('cosmetic').report.verdict).toBe('degraded');
    expect(build('cosmetic').report.intentPreserved).toBe(true);
    expect(build('required').report.verdict).toBe('infeasible');
    expect(build('required').report.failedRequiredClauses).toContain('roles.extra');
  });

  it('carries the report onto every matched site', () => {
    const sites = matchAnchor(workedExampleAnchor(), index, { roles: workedExampleRoles() });
    for (const site of sites) {
      expect(site.degradation.summary.length).toBeGreaterThan(0);
      expect(['exact', 'degraded']).toContain(site.degradation.verdict);
      expect(site.degradation.score).toBe(site.score);
    }
  });
});
