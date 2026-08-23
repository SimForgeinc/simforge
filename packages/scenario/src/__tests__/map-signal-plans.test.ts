import { describe, expect, it } from 'vitest';

import { TemplateDocument } from '../template-document.js';
import { ScenarioTemplateV2Schema } from '../schema/v2/template.js';
import type { MapSignalPlan } from '../schema/v2/map-signal-plans.js';

const plan: MapSignalPlan = {
  id: 'junction-j1', version: 1 as const,
  binding: { mapId: 'yale', junctionId: 'j1', controlDigest: 'controls-1' },
  clips: [{
    id: 'green-1', startS: 3, endS: 5,
    reference: { controllerId: 'c1', headId: 'h1' }, indication: 'green' as const,
  }],
};

function input(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    scenarioVersion: 2,
    meta: {
      name: 'signals', description: '', appVersion: 'test',
      createdAt: '2026-01-01T00:00:00.000Z', modifiedAt: '2026-01-01T00:00:00.000Z',
    },
    sourceMap: { mapId: 'yale', mapName: 'Yale' },
    anchor: { features: [], pin: { mapId: 'yale' } },
    choreography: { clipSeconds: 20, warmupSeconds: 2, interactions: [] },
    mapSignalPlans: [plan],
    ...overrides,
  };
}

describe('map signal plan schema and document operations', () => {
  it('parses a bounded normal-signal plan and materializes the optional default', () => {
    expect(ScenarioTemplateV2Schema.parse(input()).mapSignalPlans).toEqual([plan]);
    expect(ScenarioTemplateV2Schema.parse({ ...input(), mapSignalPlans: undefined }).mapSignalPlans).toEqual([]);
  });

  it('rejects overlapping half-open clips, but permits touching boundaries', () => {
    const touching = { ...plan, clips: [plan.clips[0], { ...plan.clips[0], id: 'red-1', startS: 5, endS: 7, indication: 'red' }] };
    expect(ScenarioTemplateV2Schema.safeParse(input({ mapSignalPlans: [touching] })).success).toBe(true);
    const overlap = { ...touching, clips: [touching.clips[0], { ...touching.clips[1], startS: 4.99 }] };
    expect(ScenarioTemplateV2Schema.safeParse(input({ mapSignalPlans: [overlap] })).success).toBe(false);
  });

  it('rejects clips beyond the scenario and duplicate junction ownership', () => {
    expect(ScenarioTemplateV2Schema.safeParse(input({
      mapSignalPlans: [{ ...plan, clips: [{ ...plan.clips[0], endS: 21 }] }],
    })).success).toBe(false);
    expect(ScenarioTemplateV2Schema.safeParse(input({
      mapSignalPlans: [plan, { ...plan, id: 'another' }],
    })).success).toBe(false);
  });

  it('supports undoable add, replace, and remove operations', () => {
    const doc = TemplateDocument.create({ name: 'signals' }, { now: () => '2026-01-01T00:00:00.000Z' });
    doc.setClip(20, 0);
    expect(doc.addMapSignalPlan(plan)).toBe(plan.id);
    expect(doc.mapSignalPlan(plan.id)?.clips[0]?.indication).toBe('green');
    doc.replaceMapSignalPlan(plan.id, { ...plan, clips: [{ ...plan.clips[0]!, indication: 'red' }] });
    expect(doc.mapSignalPlan(plan.id)?.clips[0]?.indication).toBe('red');
    doc.removeMapSignalPlan(plan.id);
    expect(doc.data.mapSignalPlans).toEqual([]);
    expect(doc.undo()).toBe(true);
    expect(doc.mapSignalPlan(plan.id)?.clips[0]?.indication).toBe('red');
  });
});
