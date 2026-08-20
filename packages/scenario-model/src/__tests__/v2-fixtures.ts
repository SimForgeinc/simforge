/**
 * Shared v2 test material: a complete, valid LTAP/OD template plus builders.
 *
 * The fixture is deliberately a *real* archetype (C3 left-turn-across-path,
 * opposite direction — the highest-value urban scenario in the taxonomy) rather
 * than a minimal stub, so that every test which mutates one field is mutating
 * something inside a document that otherwise means what it says.
 */

import type { ScenarioTemplateV2, ScenarioTemplateV2Input } from '../schema/v2/template.js';
import { parseTemplate } from '../serialize.js';
import { createFakeMapContext } from '../validate/fake-map-context.js';
import type { MapContext } from '../validate/map-context.js';

export const T0 = '2026-07-31T12:00:00.000Z';

/** A complete, valid LTAP/OD template as authored (strings, defaults omitted). */
export function ltapTemplateInput(): ScenarioTemplateV2Input {
  return {
    scenarioVersion: 2,
    meta: {
      name: 'LTAP/OD at a signalised four-way',
      createdAt: T0,
      modifiedAt: T0,
      appVersion: '0.0.1',
      archetype: 'C3.ltap-od',
      tags: ['intersection', 'critical'],
    },
    params: {
      declarations: [
        { id: 'vEgo', type: 'continuous', range: [30, 55], default: 45, unit: 'kph', tier: 1 },
        { id: 'arrivalDeltaT', type: 'continuous', range: [-1.5, 1.5], default: 0.4, unit: 's', tier: 1 },
        { id: 'gapS', type: 'discrete', values: [1.2, 1.8, 2.4], default: 1.8, unit: 's', tier: 1 },
      ],
      constraints: [{ left: 'param.vEgo', op: '<=', right: 60, message: 'ego stays under 60 kph' }],
    },
    environment: { weather: 'clear', timeOfDay: 'afternoon' },
    anchor: {
      corridor: {
        throughLanesSameDir: { value: [1, 2] },
        speedLimitKph: { value: [30, 60], essentiality: 'preferred', weight: 2 },
        runwayDownstreamM: { value: [180, null] },
      },
      features: [
        {
          id: 'jx',
          kind: 'junction',
          atM: { value: [0, 0] },
          arms: { value: [4, 4] },
          control: { value: ['signalized'] },
          egoTurn: { value: ['straight'] },
          conflictingApproach: { value: { from: 'opposing', turn: 'left' } },
        },
      ],
    },
    roles: [
      {
        id: 'ego',
        kind: 'on_reference',
        actor: { class: 'car', catalogId: 'sedan.generic' },
        pose: { s: -80 },
        initialSpeedKph: 'param.vEgo',
      },
      {
        id: 'challenger',
        kind: 'conflicting_gate',
        actor: { class: 'car', catalogId: 'suv.generic' },
        feature: 'jx',
        from: 'opposing',
        turn: 'left',
        arriveAtConflict: { relativeTo: 'ego', deltaT: 'param.arrivalDeltaT' },
        initialSpeedKph: 'clamp(0.6 * lane.speedLimitKph, 15, 40)',
      },
    ],
    props: [],
    choreography: {
      clipSeconds: 20,
      interactions: [
        {
          id: 'ego-cruise',
          actor: 'ego',
          verb: 'speed',
          trigger: { kind: 'at', t: 0 },
          target: { mode: 'absolute', valueKph: 'param.vEgo' },
          dynamics: { shape: 'linear', constraint: 'rate', value: 1.5 },
        },
        {
          id: 'challenger-commits',
          actor: 'challenger',
          verb: 'set',
          trigger: { kind: 'at', t: 0 },
          target: { key: 'rules.collisionAvoidance', value: false },
        },
        {
          id: 'challenger-turns',
          actor: 'challenger',
          verb: 'route',
          trigger: {
            kind: 'when',
            condition: { kind: 'ttc', of: 'challenger', to: 'ego', op: '<', valueS: 2.2 },
            byLatest: 12,
          },
          target: { mode: 'turn', feature: 'jx', turn: 'left' },
        },
      ],
    },
    invariants: [
      { id: 'critical-ttc', kind: 'ttc', of: 'ego', to: 'challenger', range: [1.2, 2.5] },
      {
        id: 'arrival',
        kind: 'arrival',
        of: 'challenger',
        at: { feature: 'jx' },
        syncWith: 'ego',
        deltaTRange: [-1.5, 1.5],
      },
      { id: 'ego-comfort', kind: 'decel_budget', of: 'ego', maxMps2: 5.5 },
    ],
    metricSubject: 'ego',
  };
}

/** The same template, parsed (defaults materialised, expressions as ASTs). */
export function ltapTemplate(): ScenarioTemplateV2 {
  return parseTemplate(ltapTemplateInput());
}

/** Parse an input template with one top-level block replaced. */
export function templateWith(overrides: Partial<ScenarioTemplateV2Input>): ScenarioTemplateV2 {
  return parseTemplate({ ...ltapTemplateInput(), ...overrides });
}

/** A minimal but valid interaction, for verb/trigger permutation tests. */
export function interaction(
  overrides: Record<string, unknown>,
): Record<string, unknown> {
  const merged: Record<string, unknown> = {
    id: 'x1',
    actor: 'ego',
    trigger: { kind: 'at', t: 1 },
    verb: 'speed',
    target: { mode: 'stop' },
    dynamics: { shape: 'linear', constraint: 'time', value: 2 },
    ...overrides,
  };
  // A key set to `undefined` is still a key, and every v2 object is strict —
  // so drop them rather than tripping "unrecognized key" in tests that mean
  // "omit this field".
  for (const [key, value] of Object.entries(merged)) {
    if (value === undefined) delete merged[key];
  }
  return merged;
}

/** Build a template whose timeline is exactly `interactions`. */
export function templateWithInteractions(
  interactions: Array<Record<string, unknown>>,
  extra: Partial<ScenarioTemplateV2Input> = {},
): ScenarioTemplateV2 {
  const base = ltapTemplateInput();
  return parseTemplate({
    ...base,
    choreography: { clipSeconds: 20, interactions } as never,
    invariants: [],
    ...extra,
  });
}

/**
 * A fake site for the LTAP fixture: a two-lane corridor from −200 m to +200 m
 * with a sidewalk on k = 2, and the junction movements the template names.
 */
export function ltapMapContext(overrides: Partial<Parameters<typeof createFakeMapContext>[0]> = {}): MapContext {
  return createFakeMapContext({
    mapId: 'yale-street',
    lanes: [
      { k: 0, extentM: [-200, 200], speedLimitKph: 50 },
      { k: 1, extentM: [-200, 200], speedLimitKph: 50 },
      { k: 2, extentM: [-200, 200], type: 'sidewalk', speedLimitKph: null },
    ],
    gates: {
      'jx/opposing/left': { conflictS: 6, crossingAngleDeg: 105 },
      'jx/same/straight': { conflictS: 6 },
      'jx/same/left': { conflictS: 4 },
    },
    signals: { 'jx:subject': ['green', 'yellow', 'red'] },
    features: { jx: { kind: 'junction', atM: 0, sizeM: 26 } },
    ...overrides,
  });
}
