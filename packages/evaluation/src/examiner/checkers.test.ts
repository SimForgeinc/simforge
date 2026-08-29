/**
 * Checker and grader behavior over the committed real-trace corpus.
 *
 * These run the deterministic layer against actual simulated episodes from
 * `examples/*.template.json` × dev-assets maps (recorded by
 * `tools/build-corpus.ts`), so every verdict below is an engine-ground-truth
 * judgment, not a synthetic fixture.
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import type { Claim } from './claims.js';
import { checkClaim, checkClaims } from './checkers.js';
import type { Corpus, CorpusScenario } from './corpus.js';
import { deriveTrueClaims } from './ground-truth.js';
import { grade } from './grader.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CORPUS_FILE = path.join(HERE, '..', '..', 'fixtures-examiner', 'corpus.v1.json');
const corpus = JSON.parse(readFileSync(CORPUS_FILE, 'utf8')) as Corpus;

function scenario(idPrefix: string): CorpusScenario {
  const s = corpus.scenarios.find((x) => x.id.startsWith(idPrefix));
  if (!s) throw new Error(`scenario ${idPrefix} not in corpus`);
  return s;
}

describe('ground-truth derivation on real traces', () => {
  it('derives claims of all four types from every scenario', () => {
    for (const s of corpus.scenarios) {
      const truth = deriveTrueClaims(s);
      const types = new Set(truth.map((c) => c.type));
      expect(truth.length, s.id).toBeGreaterThan(0);
      expect(types.has('visibility') || types.has('spatial'), `${s.id}: no perceptual claims`).toBe(true);
      const eventTS = new Set(
        s.causalChannel.frames.flatMap((f) => [
          ...f.triggers.map((t) => t.tS),
          ...f.conflictGenesis.map(() => f.tS),
        ]),
      );
      if (eventTS.size >= 2) {
        expect(types.has('causal-trigger'), `${s.id}: ${eventTS.size} distinct event ticks but no causal claims`).toBe(true);
      }
      if (s.interactions.length > 0) {
        expect(types.has('intent') || types.has('causal-trigger'), `${s.id}`).toBe(true);
      }
    }
  });

  it('the full true set passes its own checkers on every scenario', () => {
    for (const s of corpus.scenarios) {
      const verdicts = checkClaims(s, deriveTrueClaims(s));
      const failed = verdicts.filter((v) => v.status === 'fail');
      expect(failed, `${s.id}: ${JSON.stringify(failed.slice(0, 3))}`).toHaveLength(0);
    }
  });
});

describe('deterministic checkers catch known corruptions (real trace)', () => {
  const s = corpus.scenarios.find((x) => x.id.startsWith('bus-stop-emergence'))!;

  it('flips a visibility state', () => {
    const truth = deriveTrueClaims(s);
    const vis = truth.find((c): c is Extract<Claim, { type: 'visibility' }> => c.type === 'visibility');
    if (!vis) return; // scenario without evaluated LOS pairs
    const flipped = { ...vis, state: vis.state === 'visible' ? ('occluded' as const) : ('visible' as const) };
    expect(checkClaim(s, flipped).status).toBe('fail');
    expect(checkClaim(s, vis).status).toBe('pass');
  });

  it('rejects unknown actors as hallucinations', () => {
    const verdict = checkClaim(s, {
      schema: 'https://simforge-oss.dev/schemas/claims.v1.json',
      id: 'phantom',
      type: 'visibility',
      actorIds: ['ghost-pedestrian'],
      tickRange: { fromTS: 1, toTS: 2 },
      checkable: 'deterministic',
      state: 'visible',
    });
    expect(verdict.status).toBe('fail');
    expect(verdict.reason).toMatch(/unknown actor/);
  });

  it('marks extracted claims as deferred, never judged', () => {
    const verdict = checkClaim(s, {
      schema: 'https://simforge-oss.dev/schemas/claims.v1.json',
      id: 'x',
      type: 'visibility',
      actorIds: [Object.keys(s.actorKinds)[0]!],
      tickRange: { fromTS: 1, toTS: 2 },
      checkable: 'extracted',
      state: 'visible',
    });
    expect(verdict.status).toBe('deferred');
  });

  it('is deterministic across repeated runs', () => {
    const truth = deriveTrueClaims(s);
    const a = checkClaims(s, truth).map((v) => v.status);
    const b = checkClaims(s, truth).map((v) => v.status);
    expect(a).toEqual(b);
  });
});

describe('grader decomposition (WS7 contract)', () => {
  const s = corpus.scenarios.find((x) => x.id.startsWith('bus-stop-emergence'))!;

  it('scores the true set at 1.0 with full coverage', () => {
    const report = grade(s, deriveTrueClaims(s));
    expect(report.score).toBe(1);
    expect(report.causality).toBe(1);
    expect(report.coverage).toBe(1);
    expect(report.uncoveredTruth).toHaveLength(0);
    expect(report.failedClaimIds).toHaveLength(0);
    expect(report.score).toBeGreaterThanOrEqual(0);
    expect(report.score).toBeLessThanOrEqual(1);
  });

  it('drops causality when an assertion is wrong, coverage when claims are missing', () => {
    const truth = deriveTrueClaims(s);
    const wrong = structuredClone(truth);
    const visIdx = wrong.findIndex((c) => c.type === 'visibility');
    expect(visIdx).toBeGreaterThanOrEqual(0);
    const v = wrong[visIdx]! as Extract<Claim, { type: 'visibility' }>;
    wrong[visIdx] = { ...v, state: v.state === 'visible' ? 'occluded' : 'visible' };
    const report = grade(s, wrong, { trueClaims: truth });
    // A wrong assertion fails its own checker…
    expect(report.causality).toBeLessThan(1);
    // …and no longer matches the true proposition it displaced.
    expect(report.coverage).toBeLessThan(1);

    const thinned = truth.filter((c) => c.type !== 'spatial');
    const thinnedReport = grade(s, thinned, { trueClaims: truth });
    expect(thinnedReport.causality).toBe(1); // nothing asserted wrongly
    expect(thinnedReport.coverage).toBeLessThan(1);
    expect(thinnedReport.uncoveredTruth.length).toBeGreaterThan(0);
  });
});
