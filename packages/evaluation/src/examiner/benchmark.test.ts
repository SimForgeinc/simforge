/**
 * Extraction harness (parsing only) and the perturbation benchmark gate.
 * Network-free: the extractor runs against scripted completions; the
 * benchmark is fully deterministic over the committed corpus.
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { RECOVERY_GATE, runBenchmark } from './benchmark.js';
import type { ClaimSet } from './claims.js';
import { claimSetSchema } from './claims.js';
import type { Corpus } from './corpus.js';
import { extractClaims, ExtractionError, type CompletionFn } from './extractor/extract.js';
import { EXTRACTION_SYSTEM_PROMPT, scenarioContextLine } from './extractor/prompt.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const corpus = JSON.parse(
  readFileSync(path.join(HERE, '..', '..', 'fixtures-examiner', 'corpus.v1.json'), 'utf8'),
) as Corpus;

function scripted(responses: string[]): CompletionFn {
  let i = 0;
  return async () => responses[Math.min(i++, responses.length - 1)]!;
}

const SCENARIO = corpus.scenarios[0]!;
const CONTEXT = scenarioContextLine(SCENARIO);
const DESCRIPTION =
  'The bus is stopped at the curb with its doors open. A pedestrian steps out from in front of the bus into the ego lane.';

function validClaimSet(): ClaimSet {
  return {
    schema: 'https://uniscenarios.dev/schemas/claims.v1.json',
    scenarioId: SCENARIO.id,
    claims: [
      {
        id: 'v1',
        type: 'visibility',
        actorIds: ['ped'],
        tickRange: { fromTS: 1, toTS: 2 },
        checkable: 'deterministic',
        state: 'visible',
      },
    ],
  };
}

describe('extraction harness', () => {
  it('parses a clean completion through the schema boundary', async () => {
    const set = validClaimSet();
    const completion = scripted([JSON.stringify(set)]);
    await expect(extractClaims(completion, DESCRIPTION, { scenarioContext: CONTEXT })).resolves.toEqual(set);
  });

  it('tolerates markdown fences around the JSON', async () => {
    const set = validClaimSet();
    const wrapped = 'Here is the decomposition:\n```json\n' + JSON.stringify(set) + '\n```';
    await expect(extractClaims(scripted([wrapped]), DESCRIPTION, { scenarioContext: CONTEXT })).resolves.toEqual(set);
  });

  it('repairs invalid output in one round-trip', async () => {
    const set = validClaimSet();
    const bad = JSON.stringify({ ...set, claims: [{ id: 'x', type: 'nope' }] });
    const completion = scripted([bad, JSON.stringify(set)]);
    const result = await extractClaims(completion, DESCRIPTION, { scenarioContext: CONTEXT });
    expect(result).toEqual(set);
  });

  it('fails loudly when every attempt violates the schema', async () => {
    const bad = '{"schema":"uniscenarios.claims.v1","scenarioId":"s","claims":[{"id":"x"}]}';
    await expect(
      extractClaims(scripted([bad]), DESCRIPTION, { scenarioContext: CONTEXT, maxRepairs: 1 }),
    ).rejects.toBeInstanceOf(ExtractionError);
  });

  it('the system prompt never asks the model to judge truth', () => {
    expect(EXTRACTION_SYSTEM_PROMPT).toMatch(/never judges truth|Output/i);
    expect(EXTRACTION_SYSTEM_PROMPT.toLowerCase()).not.toContain('you must verify');
  });
});

describe('grader benchmark on known-ground-truth perturbations', () => {
  // The whole benchmark is deterministic and sub-second over the corpus.
  const report = runBenchmark(corpus.scenarios);

  it('meets the WS2 acceptance envelope', () => {
    expect(report.totals.scenarios).toBeGreaterThanOrEqual(5);
    expect(report.totals.injectedErrors).toBeGreaterThanOrEqual(200);
  });

  it('recovers at least 90% of injected errors with perfect precision headroom', () => {
    expect(report.gate.passed).toBe(true);
    expect(report.totals.recall).toBeGreaterThanOrEqual(RECOVERY_GATE);
    expect(report.totals.precision).toBe(1); // zero spurious flags on clean controls
  });

  it('exercises every perturbation operator', () => {
    for (const op of [
      'flip-visibility',
      'reverse-trigger-order',
      'wrong-intent',
      'flip-spatial-relation',
      'delete-actor',
      'insert-phantom-actor',
    ]) {
      expect(report.byOp[op]?.injected ?? 0, op).toBeGreaterThan(0);
    }
  });

  it('clean controls are held out from the recovery ledger', () => {
    expect(report.totals.cleanControls).toBe(report.totals.scenarios);
  });

  it('the persisted report matches a fresh run', () => {
    const persisted = JSON.parse(
      readFileSync(path.join(HERE, '..', '..', 'benchmark-examiner', 'report.v1.json'), 'utf8'),
    ) as ReturnType<typeof runBenchmark>;
    expect(persisted.totals.recall).toBe(report.totals.recall);
    expect(persisted.gate.passed).toBe(true);
  });

  it('claim sets parsed by the harness grade without throwing', async () => {
    const set = claimSetSchema.parse(validClaimSet());
    const scenario = corpus.scenarios.find((s) => s.id === set.scenarioId) ?? SCENARIO;
    expect(() =>
      runBenchmark([scenario]),
    ).not.toThrow();
  });
});
