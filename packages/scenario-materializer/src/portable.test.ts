import { describe, expect, it } from 'vitest';

import {
  deriveMapIndexFromTopology,
  matchAnchor,
  type RawTopologyIndex,
  type RawTopologyLane,
} from '@uniscenarios/anchor-matcher';
import { ScenarioTemplateV2Schema, type ScenarioTemplateV2 } from '@uniscenarios/scenario-model';

import { adaptTemplate } from './adapt.js';
import { bindPortableVariation, liftMapBoundTemplate } from './portable.js';

const line = (x0: number, y0: number, x1: number, y1: number) => [
  { x: x0, y: y0 }, { x: (x0 + x1) / 2, y: (y0 + y1) / 2 }, { x: x1, y: y1 },
];

function lane(rsl: string, polyline: Array<{ x: number; y: number }>, options: Partial<RawTopologyLane> = {}): RawTopologyLane {
  const [roadId, section, laneId] = rsl.split(':').map(Number) as [number, number, number];
  const length = Math.hypot(polyline.at(-1)!.x - polyline[0]!.x, polyline.at(-1)!.y - polyline[0]!.y);
  return {
    rsl, roadId, section, laneId, laneType: 'driving', isJunction: false, junctionId: null,
    predecessors: [], successors: [], speedLimitKph: 50, representativeWidthM: 3.5,
    widthSamples: [{ s: 0, widthM: 3.5 }, { s: length, widthM: 3.5 }],
    adjacentLanes: { left: { laneRsl: null, sameDirection: false }, right: { laneRsl: null, sameDirection: false } },
    laneChangePermissions: [], polyline, ...options,
  };
}

function corridorTopology(lanes = 2): RawTopologyIndex {
  const first = lane('1:0:-1', line(0, 0, 300, 0), {
    adjacentLanes: { left: { laneRsl: null, sameDirection: false }, right: { laneRsl: lanes > 1 ? '1:0:-2' : null, sameDirection: lanes > 1 } },
  });
  const all: Record<string, RawTopologyLane> = { [first.rsl]: first };
  if (lanes > 1) {
    all['1:0:-2'] = lane('1:0:-2', line(0, -3.5, 300, -3.5), {
      adjacentLanes: { left: { laneRsl: '1:0:-1', sameDirection: true }, right: { laneRsl: null, sameDirection: false } },
    });
  }
  return { schemaVersion: 3, lanes: all, gates: [], junctions: {} };
}

function intersectionTopology(reverseGates = false): RawTopologyIndex {
  const lanes: Record<string, RawTopologyLane> = {
    '1:0:-1': lane('1:0:-1', line(-150, 0, -10, 0)),
    '10:0:-1': lane('10:0:-1', line(-10, 0, 10, 0), { isJunction: true, junctionId: 'j' }),
    '2:0:-1': lane('2:0:-1', line(10, 0, 150, 0)),
    '3:0:-1': lane('3:0:-1', line(0, -150, 0, -10)),
    '11:0:-1': lane('11:0:-1', line(0, -10, 0, 10), { isJunction: true, junctionId: 'j' }),
    '4:0:-1': lane('4:0:-1', line(0, 10, 0, 150)),
  };
  lanes['1:0:-1']!.successors = ['10:0:-1']; lanes['10:0:-1']!.predecessors = ['1:0:-1']; lanes['10:0:-1']!.successors = ['2:0:-1']; lanes['2:0:-1']!.predecessors = ['10:0:-1'];
  lanes['3:0:-1']!.successors = ['11:0:-1']; lanes['11:0:-1']!.predecessors = ['3:0:-1']; lanes['11:0:-1']!.successors = ['4:0:-1']; lanes['4:0:-1']!.predecessors = ['11:0:-1'];
  const gates = [
    { id: 'ego-straight', junctionId: 'j', turnRelation: 'Straight', headingChangeRad: 0, approachLaneRsl: '1:0:-1', connectingLaneRsl: '10:0:-1', exitLaneRsls: ['2:0:-1'] },
    { id: 'cross-straight', junctionId: 'j', turnRelation: 'Straight', headingChangeRad: 0, approachLaneRsl: '3:0:-1', connectingLaneRsl: '11:0:-1', exitLaneRsls: ['4:0:-1'] },
  ];
  if (reverseGates) gates.reverse();
  return { schemaVersion: 3, lanes, gates, junctions: { j: { junctionId: 'j', gateIds: gates.map((gate) => gate.id), internalLaneRsls: ['10:0:-1', '11:0:-1'], approachLaneRsls: ['1:0:-1', '3:0:-1'] } } };
}

function template(roles: ScenarioTemplateV2['roles'], mapId = 'source'): ScenarioTemplateV2 {
  return ScenarioTemplateV2Schema.parse({
    scenarioVersion: 2,
    meta: { name: 'portable lift', description: '', createdAt: '2026-08-01T00:00:00.000Z', modifiedAt: '2026-08-01T00:00:00.000Z', appVersion: 'test', tags: [] },
    sourceMap: { mapId, mapName: mapId },
    anchor: { id: 'portableLift', pin: { mapId }, features: [], policy: { allowMirror: true } },
    roles,
    props: [{ id: 'cones', catalogId: 'traffic-cone', pose: { laneOffset: 1, s: 12, tFrac: 0.4, headingOffsetRad: 0 }, repeat: { count: 4, spacingM: 3 } }],
    choreography: { clipSeconds: 20, warmupSeconds: 0, interactions: [{ id: 'brake', actor: 'ego', trigger: { kind: 'at', t: 5 }, verb: 'speed', target: { mode: 'stop' }, dynamics: { shape: 'linear', constraint: 'time', value: 2 } }] },
    invariants: [], variants: [], metricSubject: 'ego',
  });
}

const absolute = (id: string, rsl: string | undefined, x: number, z: number, headingRad = 0): ScenarioTemplateV2['roles'][number] => {
  const [roadId, section, laneId] = rsl?.split(':') ?? [];
  return {
    id, kind: 'scene_absolute', actor: { class: 'car', catalogId: `vehicle-${id}`, static: false, sensors: [] },
    pose: { position: { x, y: 0, z }, headingRad }, initialSpeedKph: 30, essentiality: 'required',
    ...(rsl ? { laneRef: { roadId: roadId!, section: Number(section), laneId: Number(laneId), s: Math.max(0, x), t: 0, headingOffsetRad: 0 } } : {}),
  };
};

describe('scene-absolute to portable variation lift', () => {
  it('drops the concrete initial lane chain when lifting to a portable role', () => {
    const source = deriveMapIndexFromTopology(corridorTopology(2), { mapId: 'source' });
    const ego = absolute('ego', '1:0:-1', 80, 0);
    if (ego.kind !== 'scene_absolute') throw new Error('test actor must be scene_absolute');
    ego.initialRoute = { mode: 'lanePath', lanes: ['1:0:-1'] };
    const lifted = liftMapBoundTemplate(template([ego]), source, { origin: 'corridor' });
    expect(lifted.ok, JSON.stringify(lifted.issues)).toBe(true);
    expect(JSON.stringify(lifted.template!.roles)).not.toContain('initialRoute');
    expect(JSON.stringify(lifted.template!.roles)).not.toContain('1:0:-1');
  });

  it('round-trips corridor-relative positions while preserving ids, choreography, and props', () => {
    const source = deriveMapIndexFromTopology(corridorTopology(2), { mapId: 'source' });
    for (const delta of [-25, 0, 17, 60]) {
      const authored = template([
        absolute('ego', '1:0:-1', 80, 0),
        absolute('lead', '1:0:-1', 80 + delta, 0),
        absolute('adjacent', '1:0:-2', 95, 3.5),
      ]);
      const result = liftMapBoundTemplate(authored, source, { origin: 'corridor' });
      expect(result.ok, JSON.stringify(result.issues)).toBe(true);
      expect(result.template!.roles.map((role) => role.id)).toEqual(['ego', 'lead', 'adjacent']);
      expect(result.template!.roles.every((role) => role.kind !== 'scene_absolute')).toBe(true);
      const ego = result.template!.roles.find((role) => role.id === 'ego')!;
      const lead = result.template!.roles.find((role) => role.id === 'lead')!;
      expect((lead.kind === 'on_reference' ? Number(lead.pose.s) : 0) - (ego.kind === 'on_reference' ? Number(ego.pose.s) : 0)).toBeCloseTo(delta, 4);
      expect(result.template!.choreography).toEqual(authored.choreography);
      expect(result.template!.props).toEqual(authored.props);
      expect(JSON.stringify(result.template!.roles)).not.toContain('laneRef');
      expect(JSON.stringify(result.template!.roles)).not.toContain('1:0:-1');
    }
  });

  it('lifts an intersection conflict and rebinds it after gate permutation without source coordinates', () => {
    const source = deriveMapIndexFromTopology(intersectionTopology(), { mapId: 'source' });
    const target = deriveMapIndexFromTopology(intersectionTopology(true), { mapId: 'target', handedness: 'left' });
    const authored = template([
      absolute('ego', '1:0:-1', -70, 0),
      absolute('challenger', '3:0:-1', 0, 70, Math.PI / 2),
    ]);
    const lifted = liftMapBoundTemplate(authored, source, { origin: 'junction', allowMirror: true });
    expect(lifted.ok, JSON.stringify(lifted.issues)).toBe(true);
    expect(lifted.template!.roles.find((role) => role.id === 'challenger')).toMatchObject({ kind: 'conflicting_gate', from: 'from_right', turn: 'straight', tFrac: 0 });
    const adapted = adaptTemplate(lifted.template!);
    const sites = matchAnchor(adapted.anchor, target, { roles: adapted.roles, scope: adapted.scope });
    expect(sites.length).toBeGreaterThan(0);
    const bound = bindPortableVariation(lifted.template!, sites[0]!);
    expect(bound.template.roles).toEqual(lifted.template!.roles);
    expect(bound.template.anchor.pin).toBeUndefined();
    expect(JSON.stringify(bound.template)).not.toContain('1:0:-1');
    expect(JSON.stringify(bound.template)).not.toContain('ego-straight');
  });

  it('reports deliberate zero-match and missing-anchor cases as retryable dependencies', () => {
    const source = deriveMapIndexFromTopology(corridorTopology(2), { mapId: 'source' });
    const oneLane = deriveMapIndexFromTopology(corridorTopology(1), { mapId: 'one-lane' });
    const lifted = liftMapBoundTemplate(template([absolute('ego', '1:0:-1', 80, 0), absolute('adjacent', '1:0:-2', 90, 3.5)]), source, { origin: 'corridor' });
    const adapted = adaptTemplate(lifted.template!);
    expect(matchAnchor(adapted.anchor, oneLane, { roles: adapted.roles, scope: adapted.scope })).toHaveLength(0);
    const failed = liftMapBoundTemplate(template([absolute('ego', undefined, 80, 0)]), source);
    expect(failed.ok).toBe(false);
    expect(failed.issues[0]).toMatchObject({ code: 'reference_lane_anchor_missing', retryable: true });
  });

  it('requires explicit signal semantics and rewrites map handles to feature-relative controls', () => {
    const source = deriveMapIndexFromTopology(intersectionTopology(), { mapId: 'source' });
    const base = template([absolute('ego', '1:0:-1', -70, 0)]);
    const signaled = ScenarioTemplateV2Schema.parse({
      ...base,
      choreography: {
        ...base.choreography,
        interactions: [
          ...base.choreography.interactions,
          { id: 'waitGreen', actor: 'ego', trigger: { kind: 'when', condition: { kind: 'signal', signal: { handle: 'source-head-7' }, phase: 'green' }, byLatest: 10 }, verb: 'speed', target: { mode: 'resume' }, dynamics: { shape: 'step', constraint: 'time', value: 0.1 } },
          { id: 'forceRed', actor: '@world', trigger: { kind: 'at', t: 2 }, verb: 'set', target: { key: 'signal:source-head-7.phase', value: 'red' } },
        ],
      },
    });
    const blocked = liftMapBoundTemplate(signaled, source, { origin: 'junction' });
    expect(blocked.ok).toBe(false);
    expect(blocked.issues).toEqual(expect.arrayContaining([expect.objectContaining({ retryable: true, dependency: expect.stringContaining('signalApproaches') })]));
    const lifted = liftMapBoundTemplate(signaled, source, { origin: 'junction', signalApproaches: { 'source-head-7': 'ego' } });
    expect(lifted.ok, JSON.stringify(lifted.issues)).toBe(true);
    expect(JSON.stringify(lifted.template!.choreography)).not.toContain('source-head-7');
    expect(JSON.stringify(lifted.template!.choreography)).toContain('signal:feature:transferOrigin:ego.phase');
    expect(JSON.stringify(lifted.template!.choreography)).toContain('"feature":"transferOrigin","approach":"ego"');
  });

  it('uses anchored crossing evidence for pedestrian transfer instead of a guessed offset', () => {
    const source = deriveMapIndexFromTopology(corridorTopology(1), { mapId: 'source' });
    source.pointFeatures.push({ id: 'crosswalk-source-17', kind: 'crossing', laneRsl: '1:0:-1', s: 100, point: { x: 100, y: 5 } });
    source.capabilities.crossings = true;
    const pedestrian = absolute('walker', '1:0:-1', 100, -5, Math.PI / 2);
    pedestrian.actor = { class: 'pedestrian', catalogId: 'pedestrian-walker', static: false, sensors: [] };
    const lifted = liftMapBoundTemplate(template([absolute('ego', '1:0:-1', 80, 0), pedestrian]), source, { origin: 'corridor' });
    expect(lifted.ok, JSON.stringify(lifted.issues)).toBe(true);
    expect(lifted.template!.roles.find((role) => role.id === 'walker')).toMatchObject({ kind: 'on_crossing', feature: 'crossing_walker' });
    expect(lifted.template!.anchor.features).toEqual(expect.arrayContaining([expect.objectContaining({ id: 'crossing_walker', kind: 'crossing' })]));
    expect(JSON.stringify(lifted.template)).not.toContain('crosswalk-source-17');
  });
});
