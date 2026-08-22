import { describe, expect, it } from 'vitest';

import {
  ABILITY_SPECS,
  APPEARANCE_SHIFT_VARIANT,
  SUITE_NAMESPACE,
  buildSuite,
  canonicalJson,
  computeSuiteHash,
  countExcluded,
  deriveSeed,
  isHeldOut,
} from '../suite.js';
import type { CatalogSlotView, SuiteEntry, TrainingEpisodeSpec } from '../suite.js';
function slot(overrides: Partial<CatalogSlotView>): CatalogSlotView {
  return {
    identity: 'identity',
    seed: 'seed-0',
    mapId: 'yale-street',
    matcherSiteId: 'aaaa1111bbbb2222',
    templateSource: 'examples/queue-tail.template.json',
    variant: {
      id: 'weekday-clear',
      title: 'Weekday clear daylight',
      weather: 'clear',
      timeOfDay: 'day',
      traffic: 'moderate',
      visibility: 'unrestricted except authored occluders',
    },
    ...overrides,
  };
}

const TRAINING_BANKS: TrainingEpisodeSpec[] = [
  {
    source: 'scripts/rl/episodes/dartout-yale-street-4783ce656e89ff59-train.json',
    template: '../../../examples/cpnco-parked-row.template.json',
    map: 'yale-street',
    site: '4783ce656e89ff59',
    seeds: ['2000', '2001', '2002', '2003', '2004'],
  },
];

describe('canonicalJson + suite hash', () => {
  it('is order-independent for object keys and order-sensitive for arrays', () => {
    const a = canonicalJson({ b: 1, a: [1, 2] });
    const b = canonicalJson({ a: [1, 2], b: 1 });
    expect(a).toBe(b);
    expect(canonicalJson({ a: [1, 2] })).not.toBe(canonicalJson({ a: [2, 1] }));
  });

  it('pins the protocol: any semantic change moves the suite hash', () => {
    const base = {
      kind: 'policy-eval-suite' as const,
      suiteVersion: 1 as const,
      name: 'policy-eval-suite.v1',
      decisionHz: 5,
      reward: {} as Record<string, unknown>,
      trainingExclusions: { sources: [], templates: [], excludedSlotCount: 0, candidateSlotsConsidered: 0 },
      abilities: {},
      appearanceShiftVariant: APPEARANCE_SHIFT_VARIANT,
      entries: [],
    };
    const h1 = computeSuiteHash(base);
    const h2 = computeSuiteHash({ ...base, decisionHz: 10 });
    expect(h1).not.toBe(h2);
    // Provenance-only fields must NOT move the hash.
    const withExclusions = computeSuiteHash({
      ...base,
      trainingExclusions: { sources: ['x'], templates: ['y'], excludedSlotCount: 3, candidateSlotsConsidered: 500 },
      abilities: { a: { title: 't', templateSource: 's' } },
    });
    expect(withExclusions).toBe(h1);
  });

  it('derives stable shift seeds distinct from their inputs', () => {
    expect(deriveSeed(SUITE_NAMESPACE, 'a')).toBe(deriveSeed(SUITE_NAMESPACE, 'a'));
    expect(deriveSeed(SUITE_NAMESPACE, 'a')).not.toBe(deriveSeed(SUITE_NAMESPACE, 'b'));
    expect(deriveSeed(SUITE_NAMESPACE, 'a')).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('training exclusion (held-out rule)', () => {
  it('excludes slots materialized by a rl bank at the same site+seed', () => {
    const trained = slot({
      templateSource: 'examples/cpnco-parked-row.template.json',
      mapId: 'yale-street',
      matcherSiteId: '4783ce656e89ff59',
      seed: '2003',
    });
    expect(isHeldOut(trained, TRAINING_BANKS)).toBe(false);
  });

  it('keeps same-template slots on unseen sites or seeds', () => {
    const freshSite = slot({ templateSource: 'examples/cpnco-parked-row.template.json', matcherSiteId: 'ffff0000ffff0000' });
    const freshSeed = slot({
      templateSource: 'examples/cpnco-parked-row.template.json',
      matcherSiteId: '4783ce656e89ff59',
      seed: '9999',
    });
    expect(isHeldOut(freshSite, TRAINING_BANKS)).toBe(true);
    expect(isHeldOut(freshSeed, TRAINING_BANKS)).toBe(true);
    expect(countExcluded([freshSite, freshSeed], TRAINING_BANKS)).toBe(0);
  });
});

describe('suite construction', () => {
  const banks: TrainingEpisodeSpec[] = [
    {
      source: 'scripts/rl/episodes/dartout-yale-street-4783ce656e89ff59-train.json',
      template: '../../../examples/cpnco-parked-row.template.json',
      map: 'yale-street',
      site: '4783ce656e89ff59',
      seeds: ['2000'],
    },
  ];

  function catalog(): CatalogSlotView[] {
    const out: CatalogSlotView[] = [];
    out.push(
      slot({ identity: 'c1', templateSource: 'examples/mechanisms/corridor/cut-in-brake.template.json', mapId: 'yale-street' }),
      slot({ identity: 'c2', templateSource: 'examples/mechanisms/corridor/cut-in-brake.template.json', mapId: 'belmont-research-center' }),
    );
    out.push(
      slot({ identity: 'q1', templateSource: 'examples/mechanisms/corridor/queue-tail.template.json', mapId: 'belmont-research-center' }),
      slot({ identity: 'q2', templateSource: 'examples/mechanisms/corridor/queue-tail.template.json', mapId: 'el-camino-road' }),
    );
    // cut-in: single slot only → layout shift must skip gracefully.
    out.push(slot({ identity: 'c1', templateSource: 'examples/mechanisms/corridor/cut-in-brake.template.json', mapId: 'yale-street' }));
    return out;
  }

  it('emits base + three paired shifts per ability with consistent pairing', async () => {
    const { suite, skipped } = await buildSuite({ slots: catalog(), banks });
    const byAbility = new Map<string, SuiteEntry[]>();
    expect(
      skipped.filter((s) => s.ability === 'queue-navigation' || s.ability === 'cut-in-response'),
    ).toEqual([]);
    for (const e of suite.entries) {
      const list = byAbility.get(e.ability) ?? [];
      list.push(e);
      byAbility.set(e.ability, list);
    }
    const queue = byAbility.get('queue-navigation')!;
    expect(queue.map((e) => e.shift).sort()).toEqual(['appearance', 'base', 'behavioral', 'layout']);
    for (const e of queue) expect(e.pairedWith).toBe('queue-navigation|base');

    const base = queue.find((e) => e.shift === 'base')!;
    const appearance = queue.find((e) => e.shift === 'appearance')!;
    const behavioral = queue.find((e) => e.shift === 'behavioral')!;
    const layout = queue.find((e) => e.shift === 'layout')!;

    // Appearance rides the exact base world; only operational conditions move.
    expect(appearance.seed).toBe(base.seed);
    expect(appearance.matcherSiteId).toBe(base.matcherSiteId);
    expect(appearance.variant).toEqual(APPEARANCE_SHIFT_VARIANT);
    // Behavioral pins authored in-range overrides on the same world.
    expect(behavioral.seed).toBe(base.seed);
    expect(behavioral.paramOverrides).toEqual(
      expect.objectContaining(ABILITY_SPECS.find((a) => a.id === 'queue-navigation')!.paramOverrides),
    );
    // Layout changes the concrete site and re-seeds deterministically.
    expect(layout.mapId).not.toBe(base.mapId);
    expect(layout.seed).toMatch(/^[0-9a-f]{64}$/);
    expect(computeSuiteHash(suite)).toBe(suite.suiteHash);
  });

  it('never emits a base route that fails the validation probe, and skips abilities without partners', async () => {
    const slots = [
      slot({ identity: 'bad', templateSource: 'examples/mechanisms/corridor/queue-tail.template.json', mapId: 'belmont-research-center' }),
      slot({ identity: 'good', templateSource: 'examples/mechanisms/corridor/queue-tail.template.json', mapId: 'el-camino-road' }),
      slot({ identity: 'good2', templateSource: 'examples/mechanisms/corridor/queue-tail.template.json', mapId: 'yale-street' }),
    ];
    const { suite, skipped } = await buildSuite({
      slots,
      banks,
      validate: async (entry) => entry.catalogIdentity !== 'bad',
    });
    expect(suite.entries.filter((e) => e.ability === 'queue-navigation').every((e) => e.catalogIdentity !== 'bad')).toBe(true);
    // cut-in has no second site anywhere → ability skipped entirely rather
    // than emitting an unpaired route.
    expect(suite.entries.some((e) => e.ability === 'cut-in-response')).toBe(false);
    expect(skipped).toContainEqual(expect.objectContaining({ ability: 'cut-in-response' }));
  });
});
