/**
 * Schema-level accept/reject for v2: every verb, every trigger, every role
 * kind, every clause family.
 *
 * These tests are about what the *shape* rules let through. Semantic checks
 * (references resolve, one axis one owner) live in `v2-validate.test.ts`.
 */

import { describe, expect, it } from 'vitest';

import { ScenarioValidationError } from '../errors.js';
import { LogicalAnchorSchema } from '../schema/v2/anchor.js';
import { RangeSchema, rangeContains } from '../schema/v2/common.js';
import {
  ConditionSchema,
  DynamicsSchema,
  InteractionSchema,
  TriggerSchema,
  VERBS,
  interactionAxis,
} from '../schema/v2/interactions.js';
import { InvariantSchema } from '../schema/v2/invariants.js';
import { ParamDeclSchema, paramDefault } from '../schema/v2/params.js';
import { PropPlacementSchema } from '../schema/v2/props.js';
import { RoleBindingSchema, roleDims } from '../schema/v2/roles.js';
import { TrafficControlSchema } from '../schema/v2/traffic-controls.js';
import {
  SET_KEY_REGISTRY,
  SetKeyRegistrySchema,
  checkSetValue,
  lookupSetKey,
} from '../schema/v2/set-keys.js';
import { ScenarioTemplateV2Schema } from '../schema/v2/template.js';
import { VariantSchema } from '../schema/v2/variants.js';
import { parseTemplate, serializeTemplate } from '../serialize.js';
import { validateTemplate } from '../validate/index.js';
import { interaction, ltapTemplate, ltapTemplateInput } from './v2-fixtures.js';

describe('ScenarioTemplate v2', () => {
  it('round-trips contact-free pedestrian near-miss intent', () => {
    const invariant = InvariantSchema.parse({
      id: 'ped-clearance', kind: 'near_miss', pedestrian: 'challenger', target: 'ego',
      clearanceRangeM: [0.35, 0.65], essentiality: 'required',
    });
    expect(invariant).toEqual({
      id: 'ped-clearance', kind: 'near_miss', pedestrian: 'challenger', target: 'ego',
      clearanceRangeM: [0.35, 0.65], essentiality: 'required',
    });
  });

  it('persists a semantic near-miss route goal instead of a stale scene polyline', () => {
    const parsed = InteractionSchema.parse({
      id: 'ped-near-miss', actor: 'challenger',
      trigger: { kind: 'when', condition: { kind: 'distance', from: 'ego', to: { role: 'challenger' }, measure: 'euclidean', op: '<=', valueM: 25, hysteresisM: 0.5 }, byLatest: 8, ifNever: 'skip' },
      verb: 'route', target: { mode: 'nearMiss', target: 'ego', clearanceM: 0.5, pass: 'auto', minSpeedKph: 1.8, maxSpeedKph: 10.8 },
    });
    expect(parsed.target).toMatchObject({ mode: 'nearMiss', target: 'ego', clearanceM: 0.5, pass: 'auto' });
    expect(parsed.trigger).toMatchObject({ condition: { hysteresisM: 0.5 } });
  });
  it('round-trips lateral maneuver duration and style independently of clip timing', () => {
    const parsed = InteractionSchema.parse({
      id: 'pull-over', actor: 'ego', trigger: { kind: 'at', t: 1 }, until: { kind: 'at', t: 2 },
      verb: 'laneOffset', target: { tFrac: -0.8, reference: 'lane_center' },
      dynamics: { shape: 'sinusoidal', constraint: 'time', value: 6 },
      maneuverDurationS: 6, maneuverStyle: 'cautious',
    });
    expect(parsed).toMatchObject({ maneuverDurationS: 6, maneuverStyle: 'cautious' });
  });

  it('accepts portable executable controls and rejects indication/kind mismatches', () => {
    const laneControl = {
      id: 'reversible-west', kind: 'lane_control' as const,
      pose: { s: 0, laneOffset: 0, tFrac: 0 },
      stopLines: [{ pose: { s: -5, laneOffset: 0, tFrac: 0 } }],
      phases: [
        { indication: 'red_x' as const, durationS: 5 },
        { indication: 'green_arrow' as const, durationS: 15 },
      ],
      loop: false,
    };
    expect(TrafficControlSchema.parse(laneControl).phases).toHaveLength(2);
    expect(() => TrafficControlSchema.parse({
      ...laneControl,
      kind: 'human_director',
    })).toThrow(/not valid for human_director/);

    const base = ltapTemplateInput();
    const parsed = parseTemplate({
      ...base,
      trafficControls: [laneControl],
      choreography: {
        ...base.choreography,
        interactions: [
          ...base.choreography!.interactions!,
          { id: 'open-lane', actor: '@world', trigger: { kind: 'at', t: 5 }, verb: 'set', target: { key: 'control:reversible-west.indication', value: 'green_arrow' } },
        ],
      },
    });
    expect(parsed.trafficControls[0]?.id).toBe('reversible-west');
    expect(validateTemplate(parsed).issues.filter((issue) => issue.path.endsWith('.actor'))).toEqual([]);
  });

  it('accepts the LTAP/OD fixture and materialises defaults', () => {
    const template = ltapTemplate();
    expect(template.scenarioVersion).toBe(2);
    expect(template.choreography.clipSeconds).toBe(20);
    expect(template.choreography.warmupSeconds).toBe(5);
    expect(template.environment.weather).toBe('clear');
    expect(template.anchor.policy.minScore).toBe(0.5);
    expect(template.meta.negativeControl).toBe(false);
  });

  it('normalises string expressions into the stored AST', () => {
    const template = ltapTemplate();
    const ego = template.roles[0]!;
    expect(ego.initialSpeedKph).toEqual({ kind: 'ref', name: 'param.vEgo' });
  });

  it('rejects unknown top-level keys', () => {
    expect(() => parseTemplate({ ...ltapTemplateInput(), entities: [] })).toThrow(
      ScenarioValidationError,
    );
  });

  it('rejects the wrong version', () => {
    expect(() => parseTemplate({ ...ltapTemplateInput(), scenarioVersion: 1 })).toThrow(
      ScenarioValidationError,
    );
  });

  it('rejects duplicate ids in every list', () => {
    const base = ltapTemplateInput();
    const dup = { ...base, roles: [base.roles![0]!, base.roles![0]!] };
    expect(() => parseTemplate(dup)).toThrow(/duplicate roles id/);

    const interactions = base.choreography!.interactions!;
    expect(() =>
      parseTemplate({
        ...base,
        choreography: { ...base.choreography, interactions: [interactions[0]!, interactions[0]!] },
      }),
    ).toThrow(/duplicate interaction id/);
  });

  it('rejects modifiedAt before createdAt', () => {
    const base = ltapTemplateInput();
    expect(() =>
      parseTemplate({ ...base, meta: { ...base.meta!, modifiedAt: '2020-01-01T00:00:00.000Z' } }),
    ).toThrow(/modifiedAt precedes/);
  });

  it('allows compact three-second clips while bounding clipSeconds to 3..120', () => {
    const base = ltapTemplateInput();
    const withClip = (clipSeconds: number) =>
      parseTemplate({ ...base, choreography: { ...base.choreography, clipSeconds } });
    expect(withClip(3).choreography.clipSeconds).toBe(3);
    expect(withClip(120).choreography.clipSeconds).toBe(120);
    expect(() => withClip(2.99)).toThrow(ScenarioValidationError);
    expect(() => withClip(121)).toThrow(ScenarioValidationError);
  });

  it('serializes canonically and re-parses to a fixed point', () => {
    const template = ltapTemplate();
    const text = serializeTemplate(template);
    expect(text.endsWith('\n')).toBe(true);
    expect(serializeTemplate(parseTemplate(JSON.parse(text)))).toBe(text);
  });
});

describe('ranges and clauses', () => {
  it('accepts open ends but not an empty or vacuous range', () => {
    expect(RangeSchema.parse([null, 60])).toEqual([null, 60]);
    expect(RangeSchema.parse([20, null])).toEqual([20, null]);
    expect(RangeSchema.safeParse([60, 20]).success).toBe(false);
    expect(RangeSchema.safeParse([null, null]).success).toBe(false);
  });

  it('tests containment with open ends', () => {
    expect(rangeContains([null, 60], -100)).toBe(true);
    expect(rangeContains([20, null], 1e6)).toBe(true);
    expect(rangeContains([20, 60], 19.9)).toBe(false);
  });

  it('defaults clause essentiality to required and bounds the weight', () => {
    const anchor = LogicalAnchorSchema.parse({
      corridor: { laneWidthM: { value: [3, 4] } },
    });
    expect(anchor.corridor?.laneWidthM?.essentiality).toBe('required');
    expect(
      LogicalAnchorSchema.safeParse({ corridor: { laneWidthM: { value: [3, 4], weight: 101 } } })
        .success,
    ).toBe(false);
  });

  it('rejects a coordinate or road id anywhere in an anchor', () => {
    for (const bad of [
      { corridor: { roadId: '17' } },
      { features: [{ id: 'j', kind: 'junction', x: 12, z: -40 }] },
      { mapId: 'yale-street' },
    ]) {
      expect(LogicalAnchorSchema.safeParse(bad).success, JSON.stringify(bad)).toBe(false);
    }
  });

  it('accepts every feature kind and rejects unknown ones', () => {
    const kinds = [
      { id: 'a', kind: 'junction', arms: { value: [3, 4] } },
      { id: 'b', kind: 'crossing', controlled: { value: true } },
      { id: 'c', kind: 'parking_zone', occupancy: { value: [0.6, 1] } },
      { id: 'd', kind: 'merge' },
      { id: 'e', kind: 'crest' },
    ];
    expect(LogicalAnchorSchema.parse({ features: kinds }).features).toHaveLength(5);
    expect(LogicalAnchorSchema.safeParse({ features: [{ id: 'f', kind: 'wormhole' }] }).success).toBe(
      false,
    );
  });

  it('accepts a pin with and without a site id', () => {
    expect(LogicalAnchorSchema.parse({ pin: { mapId: 'm' } }).pin?.siteId).toBeUndefined();
    expect(LogicalAnchorSchema.parse({ pin: { mapId: 'm', siteId: 's' } }).pin?.siteId).toBe('s');
  });
});

describe('role bindings', () => {
  const actor = { class: 'car' as const };

  it('accepts all ten kinds, including route-aware crossing criticality', () => {
    const roles = [
      { id: 'a', kind: 'on_reference', actor, pose: { s: 0 } },
      { id: 'b', kind: 'lane_offset', actor, k: -1, pose: { s: 10 }, onMissing: 'clamp' },
      { id: 'drop', kind: 'at_lane_drop', actor, feature: 'ld', lane: 'terminating', pose: { s: -20 } },
      { id: 'c', kind: 'opposing', actor, k: 0, pose: { s: 40 } },
      { id: 'd', kind: 'conflicting_gate', actor, feature: 'jx', from: 'opposing', turn: 'left' },
      { id: 'e', kind: 'on_crossing', actor: { class: 'pedestrian' }, feature: 'cx', startFrac: 0.1 },
      { id: 'f', kind: 'in_parking_zone', actor, feature: 'pz', slot: 'first' },
      { id: 'g', kind: 'relative_to', actor, ref: 'a', dLane: 1, dsM: -12 },
      {
        id: 'h',
        kind: 'scene_absolute',
        actor,
        pose: { position: { x: 1, y: 0, z: 2 }, headingRad: 0 },
      },
    ];
    for (const role of roles) {
      expect(RoleBindingSchema.safeParse(role).success, role.kind).toBe(true);
    }
  });

  it('rejects an unknown role kind and stray keys', () => {
    expect(RoleBindingSchema.safeParse({ id: 'a', kind: 'somewhere', actor }).success).toBe(false);
    expect(
      RoleBindingSchema.safeParse({ id: 'a', kind: 'on_reference', actor, pose: { s: 0 }, x: 1 })
        .success,
    ).toBe(false);
  });

  it('defaults the frame pose and bounds tFrac to fractions of lane width', () => {
    const role = RoleBindingSchema.parse({ id: 'a', kind: 'on_reference', actor, pose: { s: 5 } });
    expect(role.kind === 'on_reference' && role.pose).toEqual({
      laneOffset: 0,
      s: 5,
      tFrac: 0,
      headingOffsetRad: 0,
    });
    expect(
      RoleBindingSchema.safeParse({
        id: 'a',
        kind: 'on_reference',
        actor,
        pose: { s: 5, tFrac: 1.4 },
      }).success,
    ).toBe(false);
  });

  it('accepts expressions for frame pose s and tFrac', () => {
    const role = RoleBindingSchema.parse({
      id: 'a',
      kind: 'on_reference',
      actor,
      pose: { s: '-2 * junction.sizeM', tFrac: 'param.lateralBias' },
    });
    expect(role.kind === 'on_reference' && typeof role.pose.s).toBe('object');
    expect(role.kind === 'on_reference' && typeof role.pose.tFrac).toBe('object');
  });

  it('falls back to class dimensions when none are given', () => {
    const role = RoleBindingSchema.parse({
      id: 'a',
      kind: 'on_reference',
      actor: { class: 'bus' },
      pose: { s: 0 },
    });
    expect(roleDims(role).length).toBe(12);
    const explicit = RoleBindingSchema.parse({
      id: 'a',
      kind: 'on_reference',
      actor: { class: 'bus', dims: { length: 8, width: 2, height: 3 } },
      pose: { s: 0 },
    });
    expect(roleDims(explicit).length).toBe(8);
  });
});

describe('the seven verbs', () => {
  it('has exactly seven, mapped onto five axes', () => {
    expect(VERBS).toHaveLength(7);
    const parse = (o: Record<string, unknown>) => InteractionSchema.parse(interaction(o));
    expect(interactionAxis(parse({}))).toBe('longitudinal');
    expect(
      interactionAxis(
        parse({ verb: 'gap', target: { role: 'lead', value: 1.8, unit: 'time' } }),
      ),
    ).toBe('longitudinal');
    expect(
      interactionAxis(parse({ verb: 'changeLane', target: { mode: 'relative', dk: 1 } })),
    ).toBe('lateral');
    expect(interactionAxis(parse({ verb: 'laneOffset', target: { tFrac: 0.4 } }))).toBe('lateral');
    expect(
      interactionAxis(
        parse({ verb: 'route', target: { mode: 'turn', feature: 'jx', turn: 'left' }, dynamics: undefined }),
      ),
    ).toBe('topology');
    expect(
      interactionAxis(parse({ verb: 'exist', target: { state: 'absent' }, dynamics: undefined })),
    ).toBe('existence');
    expect(
      interactionAxis(
        parse({
          verb: 'set',
          target: { key: 'lights.indicator', value: 'left' },
          dynamics: undefined,
        }),
      ),
    ).toBe('state:lights.indicator');
  });

  it('accepts every speed target mode', () => {
    for (const target of [
      { mode: 'absolute', valueKph: 50 },
      { mode: 'absolute', valueKph: 'clamp(lane.speedLimitKph, 20, 60)' },
      { mode: 'delta', deltaKph: -20 },
      { mode: 'factor', factor: 0.5 },
      { mode: 'match', role: 'lead', offsetKph: -5 },
      { mode: 'stop' },
      { mode: 'resume' },
    ]) {
      expect(InteractionSchema.safeParse(interaction({ target })).success, JSON.stringify(target)).toBe(
        true,
      );
    }
    expect(InteractionSchema.safeParse(interaction({ target: { mode: 'vibes' } })).success).toBe(
      false,
    );
  });

  it('rejects dynamics on the discrete verbs', () => {
    const bad = interaction({
      verb: 'exist',
      target: { state: 'present' },
      dynamics: { shape: 'linear', constraint: 'time', value: 1 },
    });
    expect(InteractionSchema.safeParse(bad).success).toBe(false);
  });

  it('accepts a missing dynamics at schema level (the validator requires it)', () => {
    const parsed = InteractionSchema.safeParse(interaction({ dynamics: undefined }));
    expect(parsed.success).toBe(true);
  });

  it('accepts every dynamics shape and constraint', () => {
    for (const shape of ['step', 'linear', 'sinusoidal', 'cubic']) {
      for (const constraint of ['rate', 'time', 'distance']) {
        expect(DynamicsSchema.safeParse({ shape, constraint, value: 1 }).success).toBe(true);
      }
    }
    expect(DynamicsSchema.safeParse({ shape: 'bezier', constraint: 'time', value: 1 }).success).toBe(
      false,
    );
  });

  it('accepts every route target mode', () => {
    for (const target of [
      { mode: 'turn', feature: 'jx', turn: 'right' },
      { mode: 'toFeature', feature: 'jx' },
      { mode: 'crossing', feature: 'cx', fromFrac: 0, toFrac: 1 },
      { mode: 'polyline', points: [{ s: 0 }, { s: 10, tFrac: 0.5 }] },
      { mode: 'acquire', pose: { s: 30 } },
    ]) {
      expect(
        InteractionSchema.safeParse(interaction({ verb: 'route', target, dynamics: undefined }))
          .success,
        JSON.stringify(target),
      ).toBe(true);
    }
  });
});

describe('triggers', () => {
  it('accepts all four kinds', () => {
    const triggers = [
      { kind: 'at', t: 3 },
      { kind: 'after', of: 'ego-cruise', delayS: 1.5 },
      {
        kind: 'when',
        condition: { kind: 'speed', of: 'ego', op: '>', valueKph: 30 },
        byLatest: 8,
        ifNever: 'fire',
      },
      { kind: 'arrival', of: 'challenger', at: { feature: 'jx' }, syncWith: 'ego', ttc: 1.5 },
      { kind: 'arrival', of: 'challenger', at: { role: 'ego' }, syncWith: 'ego', deltaT: 0.5 },
    ];
    for (const trigger of triggers) {
      expect(TriggerSchema.safeParse(trigger).success, JSON.stringify(trigger)).toBe(true);
    }
  });

  it('requires exactly one of ttc / deltaT on arrival', () => {
    const base = { kind: 'arrival', of: 'a', at: { feature: 'jx' }, syncWith: 'b' };
    expect(TriggerSchema.safeParse(base).success).toBe(false);
    expect(TriggerSchema.safeParse({ ...base, ttc: 1.5, deltaT: 0.2 }).success).toBe(false);
    expect(TriggerSchema.safeParse({ ...base, ttc: 1.5 }).success).toBe(true);
  });

  it('accepts every leaf condition', () => {
    const conditions = [
      { kind: 'distance', from: 'a', to: { role: 'b' }, op: '<', valueM: 30 },
      { kind: 'distance', from: 'a', to: { feature: 'jx', at: 'entry' }, op: '<=', valueM: 10 },
      { kind: 'ttc', of: 'a', to: 'b', op: '<', valueS: 2 },
      { kind: 'headway', of: 'a', to: 'b', op: '<', valueS: 1.2 },
      { kind: 'reaches', of: 'a', region: { pose: { s: 20 } }, toleranceM: 2 },
      { kind: 'speed', of: 'a', op: '>=', valueKph: 40 },
      { kind: 'signal', signal: { handle: 'sig-1' }, phase: 'green', minDurationS: 1 },
      { kind: 'signal', signal: { feature: 'jx', approach: 'subject' }, phase: 'red' },
      { kind: 'visible', of: 'ped', to: 'ego', visible: false, minFraction: 0.2 },
      { kind: 'standstill', of: 'a', forS: 2 },
      { kind: 'collision', of: 'a', with: 'b' },
    ];
    for (const condition of conditions) {
      expect(ConditionSchema.safeParse(condition).success, JSON.stringify(condition)).toBe(true);
    }
  });

  it('normalizes the persisted signal approach to the subject approach', () => {
    const parsed = ConditionSchema.parse({
      kind: 'signal', signal: { feature: 'jx', approach: 'ego' }, phase: 'red',
    });
    expect(parsed).toMatchObject({ signal: { feature: 'jx', approach: 'subject' } });
  });

  it('allows one level of and/or/not and rejects nesting', () => {
    const leaf = { kind: 'ttc', of: 'a', to: 'b', op: '<', valueS: 2 };
    expect(ConditionSchema.safeParse({ kind: 'and', operands: [leaf, leaf] }).success).toBe(true);
    expect(ConditionSchema.safeParse({ kind: 'not', operand: leaf }).success).toBe(true);
    expect(
      ConditionSchema.safeParse({
        kind: 'and',
        operands: [leaf, { kind: 'or', operands: [leaf, leaf] }],
      }).success,
    ).toBe(false);
    expect(ConditionSchema.safeParse({ kind: 'and', operands: [leaf] }).success).toBe(false);
  });

  it('accepts a when-trigger without byLatest at schema level', () => {
    expect(
      TriggerSchema.safeParse({
        kind: 'when',
        condition: { kind: 'standstill', of: 'a', forS: 1 },
      }).success,
    ).toBe(true);
  });
});

describe('the set-key registry', () => {
  it('validates itself', () => {
    expect(SetKeyRegistrySchema.safeParse(SET_KEY_REGISTRY).success).toBe(true);
  });

  it('covers every typed state namespace', () => {
    const namespaces = new Set(
      SET_KEY_REGISTRY.map((d) => d.key.startsWith('signal:') ? 'signal' : d.key.startsWith('control:') ? 'control' : d.key.split('.')[0]),
    );
    expect([...namespaces].sort()).toEqual(['audio', 'control', 'doors', 'env', 'lights', 'motion', 'pose', 'rules', 'signal']);
  });

  it('ships the make-or-break switch', () => {
    expect(lookupSetKey('rules.collisionAvoidance')?.valueType).toBe('boolean');
    expect(checkSetValue('rules.collisionAvoidance', false)).toEqual({ ok: true });
  });

  it('matches wildcard signal keys by pattern', () => {
    expect(lookupSetKey('signal:el-camino-at-cambridge.phase')?.appliesTo).toBe('world');
    expect(checkSetValue('signal:el-camino-at-cambridge.phase', 'green')).toEqual({ ok: true });
    expect(checkSetValue('signal:el-camino-at-cambridge.phase', 'purple').ok).toBe(false);
  });

  it('rejects unknown keys with a suggestion', () => {
    const result = checkSetValue('rules.collisionAvoidence', false);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe('unknown_set_key');
      expect(result.message).toMatch(/did you mean "rules.collisionAvoidance"/);
    }
  });

  it('type-checks and range-checks values', () => {
    expect(checkSetValue('rules.aggression', 0.7)).toEqual({ ok: true });
    expect(checkSetValue('rules.aggression', 1.7)).toMatchObject({ code: 'set_value_range' });
    expect(checkSetValue('rules.aggression', 'high')).toMatchObject({ code: 'set_value_type' });
    expect(checkSetValue('lights.indicator', 'left')).toEqual({ ok: true });
    expect(checkSetValue('audio.horn', true)).toEqual({ ok: true });
    expect(checkSetValue('audio.horn', 'loud')).toMatchObject({ code: 'set_value_type' });
    expect(checkSetValue('lights.indicator', 'sideways')).toMatchObject({ code: 'set_value_type' });
    expect(checkSetValue('doors.left', 'opening')).toEqual({ ok: true });
    expect(checkSetValue('pose.stopArm', 'extended')).toEqual({ ok: true });
    expect(checkSetValue('env.frictionScale', 0.4)).toEqual({ ok: true });
  });
});

describe('invariants', () => {
  it('accepts all eight kinds', () => {
    const invariants = [
      { id: 'a', kind: 'headway', of: 'x', to: 'y', range: [0.6, 4] },
      { id: 'b', kind: 'gap', of: 'x', to: 'y', unit: 'distance', range: [5, null] },
      { id: 'c', kind: 'ttc', of: 'x', to: 'y', range: [1.2, 2.5], mode: 'min' },
      { id: 'pt', kind: 'path_ttc', of: 'x', to: 'y', range: [0.2, 2.5] },
      { id: 'p', kind: 'pet', of: 'x', to: 'y', range: [0.2, 3] },
      { id: 'd', kind: 'arrival', of: 'x', at: { feature: 'jx' }, syncWith: 'y', deltaTRange: [-1, 1] },
      { id: 'e', kind: 'closing_speed', of: 'x', to: 'y', rangeKph: [20, 60] },
      { id: 'f', kind: 'speed_rel_limit', of: 'x', rangeFrac: [0.85, 1.05] },
      { id: 'g', kind: 'event_order', events: ['i1', 'i2'] },
      { id: 'h', kind: 'decel_budget', of: 'x', maxMps2: 5.5 },
    ];
    for (const invariant of invariants) {
      expect(InvariantSchema.safeParse(invariant).success, invariant.kind).toBe(true);
    }
  });

  it('rejects a repeated event in an order', () => {
    expect(
      InvariantSchema.safeParse({ id: 'g', kind: 'event_order', events: ['i1', 'i1'] }).success,
    ).toBe(false);
  });
});

describe('params', () => {
  it('accepts the four kinds and computes defaults', () => {
    const continuous = ParamDeclSchema.parse({ id: 'v', type: 'continuous', range: [10, 30] });
    expect(paramDefault(continuous)).toBe(20);
    const discrete = ParamDeclSchema.parse({ id: 'g', type: 'discrete', values: [1, 2] });
    expect(paramDefault(discrete)).toBe(1);
    const walked = ParamDeclSchema.parse({ id: 'w', type: 'discrete', range: [0, 1], step: 0.25 });
    expect(paramDefault(walked)).toBe(0);
    const categorical = ParamDeclSchema.parse({
      id: 'c',
      type: 'categorical',
      values: ['a', 'b'],
      default: 'b',
    });
    expect(paramDefault(categorical)).toBeUndefined();
    const derived = ParamDeclSchema.parse({ id: 'd', type: 'derived', expr: 'param.v * 2' });
    expect(paramDefault(derived)).toBeUndefined();
  });

  it('rejects an open continuous range and half-specified discrete walks', () => {
    expect(ParamDeclSchema.safeParse({ id: 'v', type: 'continuous', range: [10, null] }).success).toBe(
      false,
    );
    expect(ParamDeclSchema.safeParse({ id: 'v', type: 'discrete', range: [0, 1] }).success).toBe(
      false,
    );
    expect(
      ParamDeclSchema.safeParse({ id: 'v', type: 'discrete', values: [1], step: 1, range: [0, 1] })
        .success,
    ).toBe(false);
  });

  it('rejects a categorical default that is not one of the values', () => {
    expect(
      ParamDeclSchema.safeParse({ id: 'c', type: 'categorical', values: ['a'], default: 'b' })
        .success,
    ).toBe(false);
  });
});

describe('props and variants', () => {
  it('accepts an occluder with a reveal target and a repeat run', () => {
    const prop = PropPlacementSchema.parse({
      id: 'parked-row',
      catalogId: 'vehicle.parked.van',
      pose: { s: -20, tFrac: 0.9 },
      occludes: { observer: 'ego', target: 'ped' },
      targetRevealToConflictS: 0.9,
      repeat: { count: 8, spacingM: 6, tFracStep: 'param.taperStep' },
    });
    expect(prop.essentiality).toBe('preferred');
    expect(prop.scale).toBe(1);
  });

  it('accepts a rigid actor-local carried prop attachment', () => {
    const prop = PropPlacementSchema.parse({
      id: 'worker-pipe',
      catalogId: 'construction.long_pipe',
      pose: { s: 0, tFrac: 0 },
      attachment: { role: 'worker', lateralM: 0.2, heightM: 1.1 },
    });
    expect(prop.attachment).toEqual({
      role: 'worker', longitudinalM: 0, lateralM: 0.2, heightM: 1.1, headingOffsetRad: 0,
    });
  });

  it('accepts a variant keyed on a site fact', () => {
    const variant = VariantSchema.parse({
      id: 'narrow',
      when: [{ left: 'lane.widthM', op: '<', right: 3 }],
      overrides: [{ path: 'roles#challenger.initialSpeedKph', value: 20 }],
    });
    expect(variant.overrides[0]!.op).toBe('set');
  });

  it('rejects an override path outside the allowed roots, and a valueless set', () => {
    expect(
      VariantSchema.safeParse({
        id: 'v',
        when: [{ left: 1, op: '<', right: 2 }],
        overrides: [{ path: 'meta.name', value: 'x' }],
      }).success,
    ).toBe(false);
    expect(
      VariantSchema.safeParse({
        id: 'v',
        when: [{ left: 1, op: '<', right: 2 }],
        overrides: [{ path: 'roles#a.k' }],
      }).success,
    ).toBe(false);
    expect(
      VariantSchema.safeParse({
        id: 'v',
        when: [{ left: 1, op: '<', right: 2 }],
        overrides: [{ path: 'roles#a.k', op: 'remove', value: 1 }],
      }).success,
    ).toBe(false);
  });
});

describe('template-level rejections that protect the LLM contract', () => {
  it('rejects an interaction whose verb is not one of the seven', () => {
    expect(
      ScenarioTemplateV2Schema.safeParse({
        ...ltapTemplateInput(),
        choreography: { interactions: [interaction({ verb: 'overtake' })] },
      }).success,
    ).toBe(false);
  });

  it('rejects a role id with characters that break references', () => {
    const base = ltapTemplateInput();
    expect(
      ScenarioTemplateV2Schema.safeParse({
        ...base,
        roles: [{ ...(base.roles![0] as object), id: 'ego.1' }],
      }).success,
    ).toBe(false);
  });
});
