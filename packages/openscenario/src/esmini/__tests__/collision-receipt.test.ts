import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { ESMINI_PIN } from '../pin.js';

describe('pinned real collision receipt', () => {
  it('is digest-closed, within one fixed step, and honest about unobservable signal semantics', async () => {
    const receipt = JSON.parse(await readFile(
      new URL('../../../evidence-esmini/esmini-3.6.0-collision-receipt.json', import.meta.url),
      'utf8',
    )) as Record<string, any>;
    expect(receipt.schema).toBe('uniscenarios.esmini-collision-receipt/v1');
    expect(receipt.runner).toMatchObject({
      tag: ESMINI_PIN.tag,
      sourceRevision: ESMINI_PIN.sourceRevision,
      binarySha256: ESMINI_PIN.archives.macosUniversal.binarySha256,
    });
    for (const digest of Object.values(receipt.fixture as Record<string, unknown>)) {
      expect(digest).toMatch(/^[a-f0-9]{64}$/u);
    }
    expect(receipt.execution).toEqual({ durationS: 20, fixedTimestepS: 0.02, externalExitCode: 0 });
    expect(receipt.collision.onsetErrorS).toBeLessThanOrEqual(receipt.collision.toleranceS);
    expect(receipt.comparison).toMatchObject({ verdict: 'pass', actorCount: 2 });
    expect(receipt.unobservable).toEqual({
      trafficSignalEdges: true,
      signalCausedStopLineBehavior: true,
      nativeOpenScenario14: true,
    });
  });
});
