import { describe, expect, it } from 'vitest';

import { combinedEvaluationVerdict } from '../commands/evaluate.js';
import type { IntentEvaluation } from '@simforge-oss/engine';

function intent(verdict: 'accept' | 'reject'): IntentEvaluation {
  return {
    version: 1,
    intentId: 'stationary-yield',
    verdict,
    counts: { pass: verdict === 'accept' ? 1 : 0, fail: verdict === 'reject' ? 1 : 0, unchecked: 0, unsupported: 0 },
    criteria: [],
    behaviorSummary: {
      version: 1,
      trace: { inputHash: 'x', mapId: 'm', clipSeconds: 20, dt: 0.02, actorCount: 1 },
      actors: [], events: [],
      metrics: { collisions: 0, minTTC: null, minPathTTC: null, minPET: null, triggerNeverFired: [], declaredOcclusion: [] },
      truncated: { actors: false, events: false, occlusions: false },
    },
  };
}

describe('combined generic + intent verdict', () => {
  it('accepts intent-proven stationary behavior despite generic no-interaction', () => {
    expect(combinedEvaluationVerdict({ verdict: 'reject', findings: [{ code: 'no_interaction' }] }, intent('accept'))).toBe('accept');
  });

  it('does not let intent suppress hard safety or execution failures', () => {
    for (const code of ['collision', 'physically_unavoidable', 'never_fired', 'occlusion_unproven']) {
      expect(combinedEvaluationVerdict({ verdict: 'reject', findings: [{ code }] }, intent('accept'))).toBe('reject');
    }
  });

  it('rejects failed intent even when generic criticality accepts', () => {
    expect(combinedEvaluationVerdict({ verdict: 'accept', findings: [] }, intent('reject'))).toBe('reject');
  });
});
