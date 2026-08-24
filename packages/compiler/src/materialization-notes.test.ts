import { describe, expect, it } from 'vitest';

import { materializationSemanticLosses } from './materialize.js';

describe('materialization note impact', () => {
  it('allows evidence-only notes while retaining real semantic losses', () => {
    const occlusionEvidence = {
      path: 'props.excavator',
      reason: 'occlusion is preserved and reveal-to-conflict is reported by the engine',
      impact: 'informational' as const,
    };
    const droppedInteraction = {
      path: 'choreography.interactions.turn',
      reason: 'interaction dropped',
    };

    expect(materializationSemanticLosses([occlusionEvidence])).toEqual([]);
    expect(materializationSemanticLosses([occlusionEvidence, droppedInteraction])).toEqual([
      droppedInteraction,
    ]);
  });
});
