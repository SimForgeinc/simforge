/**
 * Determinism properties.
 *
 * > matcher is a pure function of (anchor, derivedIndex)
 * > — `docs/research/retargeting.md` § Determinism rules
 *
 * Two properties are asserted here, both over permuted inputs rather than a
 * single golden run:
 *
 * 1. **Permutation invariance.** Shuffling the key order of `lanes`, the order
 *    of `gates`, the junction table and the segment list must not change a
 *    single byte of the output. This is the property that catches accidental
 *    `Map`/object iteration-order dependence, which is the usual way a matcher
 *    becomes machine-dependent.
 * 2. **Repeatability.** Running twice gives identical output — no clock, no
 *    RNG, no memoised state leaking between runs.
 *
 * Plus the `siteId` contract: it must ignore soft clauses and weights, and
 * change when the map digest, the anchor id or the semantics version changes.
 */

import { describe, expect, it } from 'vitest';

import { deriveMapIndexFromTopology } from '../derive.js';
import { matchAnchor, matchAnchorReport } from '../matcher.js';
import { computeSiteId, quantizeS } from '../site-id.js';
import { MATCH_SEMANTICS_VERSION } from '../version.js';
import type { DerivedMapIndex } from '../types/map-index.js';
import { syntheticSearchIndex, syntheticTopology } from './fixtures/synthetic-map.js';
import { workedExampleAnchor, workedExampleRoles } from './fixtures/anchors.js';

const index = deriveMapIndexFromTopology(syntheticTopology(), {
  mapId: 'synthetic',
  searchIndex: syntheticSearchIndex(),
});

/** Deterministic shuffle — a test that shuffles randomly cannot be replayed. */
function seededShuffle<T>(items: readonly T[], seed: number): T[] {
  const out = [...items];
  let state = seed >>> 0;
  for (let i = out.length - 1; i > 0; i -= 1) {
    state = (state * 1664525 + 1013904223) >>> 0;
    const j = state % (i + 1);
    [out[i], out[j]] = [out[j] as T, out[i] as T];
  }
  return out;
}

function permuteIndex(source: DerivedMapIndex, seed: number): DerivedMapIndex {
  const lanes: DerivedMapIndex['lanes'] = {};
  for (const rsl of seededShuffle(Object.keys(source.lanes), seed)) {
    lanes[rsl] = source.lanes[rsl]!;
  }
  const junctions: DerivedMapIndex['junctions'] = {};
  for (const id of seededShuffle(Object.keys(source.junctions), seed + 1)) {
    junctions[id] = source.junctions[id]!;
  }
  const junctionDescriptors: DerivedMapIndex['junctionDescriptors'] = {};
  for (const id of seededShuffle(Object.keys(source.junctionDescriptors), seed + 2)) {
    const d = source.junctionDescriptors[id]!;
    junctionDescriptors[id] = {
      ...d,
      conflictPairs: seededShuffle(d.conflictPairs, seed + 3),
      approaches: seededShuffle(d.approaches, seed + 4),
      gateIds: seededShuffle(d.gateIds, seed + 5),
    };
  }
  const factIndex = { ...source.factIndex, junctionsByControl: {} as Record<string, string[]> };
  for (const key of seededShuffle(Object.keys(source.factIndex.junctionsByControl), seed + 6)) {
    factIndex.junctionsByControl[key] = seededShuffle(
      source.factIndex.junctionsByControl[key] ?? [],
      seed + 7,
    );
  }
  return {
    ...source,
    lanes,
    junctions,
    junctionDescriptors,
    factIndex,
    gates: seededShuffle(source.gates, seed + 8),
    segments: seededShuffle(source.segments, seed + 9),
  };
}

describe('determinism', () => {
  const run = (idx: DerivedMapIndex) =>
    matchAnchor(workedExampleAnchor({ minScore: 0 }), idx, { roles: workedExampleRoles() });

  it('is repeatable', () => {
    expect(JSON.stringify(run(index))).toBe(JSON.stringify(run(index)));
  });

  it('is invariant under input permutation', () => {
    const baseline = JSON.stringify(run(index));
    for (const seed of [1, 7, 99, 12345]) {
      expect(JSON.stringify(run(permuteIndex(index, seed)))).toBe(baseline);
    }
  });

  it('produces stable site ids across permutations', () => {
    const ids = run(index).map((s) => s.siteId);
    for (const seed of [2, 3, 5]) {
      expect(run(permuteIndex(index, seed)).map((s) => s.siteId)).toEqual(ids);
    }
  });

  it('keeps `rejected` and `stats` permutation-invariant too', () => {
    const a = matchAnchorReport(workedExampleAnchor({ minScore: 0 }), index, {
      roles: workedExampleRoles(),
    });
    const b = matchAnchorReport(workedExampleAnchor({ minScore: 0 }), permuteIndex(index, 42), {
      roles: workedExampleRoles(),
    });
    expect(JSON.stringify(b.stats)).toBe(JSON.stringify(a.stats));
    expect(b.rejected.map((s) => s.siteId)).toEqual(a.rejected.map((s) => s.siteId));
    expect(b.failureSummary).toBe(a.failureSummary);
  });

  it('uses no wall clock or randomness', () => {
    const now = Date.now;
    const random = Math.random;
    Date.now = () => {
      throw new Error('matcher read the wall clock');
    };
    Math.random = () => {
      throw new Error('matcher used Math.random');
    };
    try {
      expect(run(index).length).toBeGreaterThan(0);
    } finally {
      Date.now = now;
      Math.random = random;
    }
  });
});

describe('siteId', () => {
  const base = {
    anchorId: 'a1',
    mapId: 'yale-st-palo-alto-ca',
    topologyDigest: 'digest-1',
    originFeatureId: 'junction:115',
    entryLaneRsl: '27:0:-2',
    originS: 13.24,
  };

  it('is 16 hex characters', () => {
    expect(computeSiteId(base)).toMatch(/^[0-9a-f]{16}$/);
  });

  it('quantizes s to half a metre', () => {
    // 13.24 and 13.1 both quantize to 13.0; 14.1 lands in the next bucket.
    expect(computeSiteId({ ...base, originS: 13.24 })).toBe(
      computeSiteId({ ...base, originS: 13.1 }),
    );
    expect(computeSiteId({ ...base, originS: 13.24 })).not.toBe(
      computeSiteId({ ...base, originS: 14.1 }),
    );
    expect(quantizeS(-0.1)).toBe('0.0');
    expect(quantizeS(-0.4)).toBe('-0.5');
  });

  it('changes with every member of the narrow tuple', () => {
    const id = computeSiteId(base);
    expect(computeSiteId({ ...base, anchorId: 'a2' })).not.toBe(id);
    expect(computeSiteId({ ...base, mapId: 'other' })).not.toBe(id);
    expect(computeSiteId({ ...base, topologyDigest: 'digest-2' })).not.toBe(id);
    expect(computeSiteId({ ...base, originFeatureId: 'junction:116' })).not.toBe(id);
    expect(computeSiteId({ ...base, entryLaneRsl: '27:0:-3' })).not.toBe(id);
  });

  it('ignores soft clauses and weights, so preference tuning never orphans a binding', () => {
    const strict = workedExampleAnchor();
    const tuned = {
      ...strict,
      corridor: {
        ...strict.corridor,
        speedLimitKph: { value: [10, 130] as [number, number], essentiality: 'cosmetic' as const, weight: 9 },
        throughLanesSameDir: {
          value: [1, 9] as [number, number],
          essentiality: 'preferred' as const,
          weight: 0.1,
        },
      },
      policy: { ...strict.policy, minScore: 0, diversity: 'none' as const },
    };
    // Re-weighting changes which sites *win*, but never the identity of a site
    // that both runs produce: that is the whole point of the narrow tuple.
    const before = matchAnchor(strict, index, { roles: workedExampleRoles() });
    const after = matchAnchor(tuned, index, { roles: workedExampleRoles() });
    expect(before.length).toBeGreaterThan(0);
    for (const site of before) {
      expect(after.map((s) => s.siteId)).toContain(site.siteId);
    }
  });

  it('is stamped with the match-semantics version', () => {
    expect(MATCH_SEMANTICS_VERSION).toMatch(/^\d+\.\d+\.\d+$/);
    const sites = matchAnchor(workedExampleAnchor(), index, { roles: workedExampleRoles() });
    expect(sites[0]!.matchSemanticsVersion).toBe(MATCH_SEMANTICS_VERSION);
  });
});
