/**
 * Per-cell seeding.
 *
 * The property that makes a 500-cell batch trustworthy is that a cell's draw is
 * a pure function of its coordinates — not of the order the batch visited it,
 * not of the machine, and not of parameters declared next to it.
 */

import { describe, expect, it } from 'vitest';

import { ScenarioTemplateV2Schema, type ScenarioTemplateV2 } from '@simforge/scenario';

import { cellSeed, discreteValues, paramsVersion, resolveParams, templateId } from '../params.js';

function template(overrides: Record<string, unknown> = {}): ScenarioTemplateV2 {
  return ScenarioTemplateV2Schema.parse({
    scenarioVersion: 2,
    meta: {
      name: 'seed fixture',
      createdAt: '2026-08-01T00:00:00.000Z',
      modifiedAt: '2026-08-01T00:00:00.000Z',
      appVersion: 'test',
    },
    anchor: { id: 'seed-fixture', features: [] },
    params: {
      declarations: [
        { id: 'ttc', type: 'continuous', range: [1.2, 2.5], tier: 1 },
        { id: 'gapM', type: 'discrete', values: [10, 20, 30], tier: 2 },
        { id: 'weather', type: 'categorical', values: ['clear', 'rain'], tier: 3 },
        { id: 'closing', type: 'derived', expr: 'param.ttc * 10' },
      ],
    },
    ...overrides,
  });
}

describe('cellSeed', () => {
  it('is a pure function of (template, params, site, draw)', () => {
    const a = cellSeed('t', 'v', 'site-1', 0);
    expect(cellSeed('t', 'v', 'site-1', 0)).toBe(a);
    expect(cellSeed('t', 'v', 'site-1', 1)).not.toBe(a);
    expect(cellSeed('t', 'v', 'site-2', 0)).not.toBe(a);
    expect(cellSeed('t', 'w', 'site-1', 0)).not.toBe(a);
    expect(cellSeed('u', 'v', 'site-1', 0)).not.toBe(a);
  });

  it('is a 64-hex sha256', () => {
    expect(cellSeed('t', 'v', 's', 0)).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('paramsVersion', () => {
  it('moves when a declaration changes and not when the rest of the document does', () => {
    const base = template();
    const renamed = template({ meta: { ...base.meta, name: 'something else' } });
    expect(paramsVersion(renamed)).toBe(paramsVersion(base));

    const widened = template({
      params: {
        declarations: [
          { id: 'ttc', type: 'continuous', range: [1.0, 3.0], tier: 1 },
          { id: 'gapM', type: 'discrete', values: [10, 20, 30], tier: 2 },
          { id: 'weather', type: 'categorical', values: ['clear', 'rain'], tier: 3 },
          { id: 'closing', type: 'derived', expr: 'param.ttc * 10' },
        ],
      },
    });
    expect(paramsVersion(widened)).not.toBe(paramsVersion(base));
  });
});

describe('resolveParams', () => {
  const doc = template();

  it('reproduces a cell exactly', () => {
    const a = resolveParams(doc, { siteId: 'site-1', drawIndex: 3 });
    const b = resolveParams(doc, { siteId: 'site-1', drawIndex: 3 });
    expect(b).toEqual(a);
    expect(a.paramSeed).toBe(cellSeed(templateId(doc), paramsVersion(doc), 'site-1', 3));
  });

  it('gives different cells different draws', () => {
    const a = resolveParams(doc, { siteId: 'site-1', drawIndex: 0 });
    const b = resolveParams(doc, { siteId: 'site-1', drawIndex: 1 });
    const c = resolveParams(doc, { siteId: 'site-2', drawIndex: 0 });
    expect(a.values['ttc']).not.toBe(b.values['ttc']);
    expect(a.values['ttc']).not.toBe(c.values['ttc']);
  });

  it('keeps every draw inside its declared range', () => {
    for (let draw = 0; draw < 64; draw += 1) {
      const r = resolveParams(doc, { siteId: 'site-1', drawIndex: draw });
      expect(r.values['ttc']).toBeGreaterThanOrEqual(1.2);
      expect(r.values['ttc']).toBeLessThanOrEqual(2.5);
      expect([10, 20, 30]).toContain(r.values['gapM']);
      expect(['clear', 'rain']).toContain(r.categorical['weather']);
      expect(r.values['closing']).toBeCloseTo((r.values['ttc'] as number) * 10, 9);
    }
  });

  it('draws each parameter from its own stream, so inserting one does not shift the others', () => {
    // Same declarations, plus one *inserted first*. `ttc` must not move: it
    // draws from `rng.fork('ttc')`, not from a shared sequence.
    const withExtra = ScenarioTemplateV2Schema.parse({
      ...JSON.parse(JSON.stringify(doc)),
      params: {
        declarations: [
          { id: 'inserted', type: 'continuous', range: [0, 1], tier: 3 },
          ...JSON.parse(JSON.stringify(doc.params.declarations)),
        ],
        constraints: [],
      },
    });
    const seed = cellSeed(templateId(doc), paramsVersion(doc), 'site-1', 7);
    const a = resolveParams(doc, { siteId: 'site-1', drawIndex: 7, seedOverride: seed });
    const b = resolveParams(withExtra, { siteId: 'site-1', drawIndex: 7, seedOverride: seed });
    expect(b.values['ttc']).toBe(a.values['ttc']);
    expect(b.values['gapM']).toBe(a.values['gapM']);
  });

  it('drawIndex < 0 means "use the declared defaults", not "draw with seed -1"', () => {
    const r = resolveParams(doc, { siteId: 'site-1', drawIndex: -1 });
    // No `default` was declared, so a continuous param falls back to its midpoint.
    expect(r.values['ttc']).toBeCloseTo(1.85, 9);
    expect(r.values['gapM']).toBe(10);
    expect(r.categorical['weather']).toBe('clear');
  });

  it('reports constraint rejections instead of silently resampling', () => {
    const constrained = ScenarioTemplateV2Schema.parse({
      ...JSON.parse(JSON.stringify(doc)),
      params: {
        declarations: [{ id: 'ttc', type: 'continuous', range: [1.2, 2.5], tier: 1 }],
        constraints: [{ left: 'param.ttc', op: '>', right: 99, message: 'impossible on purpose' }],
      },
    });
    const r = resolveParams(constrained, { siteId: 's', drawIndex: 0 });
    expect(r.rejectedConstraints).toEqual(['impossible on purpose']);
  });
});

describe('discreteValues', () => {
  it('walks a range with integer indexing, so the last value is never lost to float drift', () => {
    const decl = { id: 'x', type: 'discrete' as const, range: [0.2, 0.9] as [number, number], step: 0.1, tier: 2 as const };
    const values = discreteValues(decl);
    expect(values).toHaveLength(8);
    expect(values[values.length - 1]).toBeCloseTo(0.9, 9);
  });
});
