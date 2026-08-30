import { describe, expect, it } from 'vitest';

import type { JobLeasedResponse } from '@simforge-oss/render';

import { validateClaimedInputs } from './worker.js';

const SHA = 'a'.repeat(64);

function claim(inputIds: string[]): Pick<JobLeasedResponse, 'intent' | 'inputs'> {
  return {
    intent: {
      scenarioRevision: { openScenario: { sha256: SHA, sizeBytes: 42 } },
      assets: [{ assetId: 'map.native-corpus', kind: 'map', sha256: 'b'.repeat(64), sizeBytes: 2048 }],
    } as JobLeasedResponse['intent'],
    inputs: inputIds.map((inputId) => ({
      inputId,
      sha256: inputId === 'scenario.xosc' ? SHA : 'c'.repeat(64),
      sizeBytes: inputId === 'scenario.xosc' ? 42 : 512,
      download: { url: `https://example.test/${inputId}`, headers: {} },
    })),
  };
}

describe('native-corpus lease inputs', () => {
  it('accepts individual map.tile.* members for the aggregate intent asset', () => {
    expect(() => validateClaimedInputs(claim([
      'scenario.xosc',
      'map.tile.000000',
      'map.tile.000001',
    ]))).not.toThrow();
  });

  it('requires at least one individual tile member', () => {
    expect(() => validateClaimedInputs(claim(['scenario.xosc']))).toThrow(
      'invalid missing claimed map.tile.* inputs for map.native-corpus',
    );
  });

  it('rejects unrelated claimed inputs', () => {
    expect(() => validateClaimedInputs(claim(['scenario.xosc', 'map.tile.000000', 'map.browser']))).toThrow(
      'invalid unreferenced claimed input map.browser',
    );
  });
});
