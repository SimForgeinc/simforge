import { describe, expect, it } from 'vitest';

import type { ExprScope, ScenarioTemplateV2 } from '@simforge/scenario';
import type { SimTrace } from '@simforge/engine';

import { checkInvariants } from '../invariants.js';

function template(kind: 'pet' | 'path_ttc', range: [number | null, number | null]): ScenarioTemplateV2 {
  return {
    invariants: [{ id: `required-${kind}`, kind, of: 'ego', to: 'crossing', range, essentiality: 'required' }],
  } as unknown as ScenarioTemplateV2;
}

function trace(): SimTrace {
  return {
    header: { clipSeconds: 12 },
    ticks: { t: [], actors: {} },
    events: [],
    metrics: {
      minTTC: null,
      minPathTTC: {
        value: 0.8,
        t: 4,
        pair: ['ego', 'crossing'],
        conflictPoint: { x: 10, y: 2 },
      },
      minPET: {
        value: 1.1,
        t: 3,
        pair: ['crossing', 'ego'],
        conflictPoint: { x: 10, y: 2 },
        firstActor: 'crossing',
        secondActor: 'ego',
      },
      minDistance: [],
      requiredDecelMax: {},
      collisions: [],
      triggerNeverFired: [],
      clippedCriticality: false,
      ticksSimulated: 0,
    },
  } as unknown as SimTrace;
}

function evaluate(kind: 'pet' | 'path_ttc', range: [number | null, number | null], input = trace()) {
  return checkInvariants({
    template: template(kind, range),
    trace: input,
    scope: {} as ExprScope,
    arrival: [],
    speedLimitKph: null,
  })[0]!;
}

describe('route-aware crossing invariants', () => {
  it('evaluates required PET against the matching unordered actor pair', () => {
    expect(evaluate('pet', [0.2, 2])).toMatchObject({
      kind: 'pet',
      essentiality: 'required',
      status: 'held',
      achieved: 1.1,
      method: 'metrics.minPET',
    });
    expect(evaluate('pet', [0.2, 0.9])).toMatchObject({ status: 'violated', residual: 0.2 });
  });

  it('evaluates required path TTC independently of circle TTC', () => {
    expect(evaluate('path_ttc', [0.2, 1.5])).toMatchObject({
      kind: 'path_ttc',
      essentiality: 'required',
      status: 'held',
      achieved: 0.8,
      method: 'metrics.minPathTTC',
    });
  });

  it('leaves missing or wrong-pair evidence unchecked so hard eligibility rejects it', () => {
    const missing = trace();
    const metrics = { ...missing.metrics, minPET: null };
    expect(evaluate('pet', [0.2, 2], { ...missing, metrics })).toMatchObject({
      status: 'unchecked',
      method: 'none',
    });
  });

  it('uses matching PET evidence inside the authored window instead of the global minimum', () => {
    const input = trace();
    const scopedTemplate = {
      ...template('pet', [0.2, 2]),
      invariants: [{
        id: 'required-pet', kind: 'pet', of: 'ego', to: 'crossing', range: [0.2, 2],
        window: [4, 8], essentiality: 'required',
      }],
    } as unknown as ScenarioTemplateV2;
    const metrics = {
      ...input.metrics,
      criticalitySamples: {
        ttc: [], pathTTC: [], pet: [{
          pair: ['crossing', 'ego'] as [string, string], t: [3, 6], value: [1.1, 0.9],
          conflictX: [10, 10], conflictY: [2, 2], firstActor: ['crossing', 'crossing'], secondActor: ['ego', 'ego'],
        }, {
          pair: ['ego', 'other'] as [string, string], t: [6], value: [0.1],
          conflictX: [10], conflictY: [2], firstActor: ['other'], secondActor: ['ego'],
        }],
      },
    };
    const result = checkInvariants({
      template: scopedTemplate,
      trace: { ...input, metrics },
      scope: {} as ExprScope,
      arrival: [],
      speedLimitKph: null,
    })[0]!;
    expect(result).toMatchObject({ status: 'held', achieved: 0.9, method: 'metrics.minPET' });
    expect(result.reason).toContain('t=6.00 s');
  });
});
