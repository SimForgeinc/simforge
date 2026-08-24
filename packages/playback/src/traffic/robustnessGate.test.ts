import { describe, expect, it } from 'vitest';
import { ambientRobustnessGate } from './robustnessGate';

describe('ambient robustness intent gate', () => {
  it('is incomplete and never accepted when no authored rubric was evaluated', () => {
    expect(ambientRobustnessGate(true, null)).toEqual({ accepted: false, overall: 'incomplete' });
  });

  it('accepts only when generic robustness and every rubric evaluation accept', () => {
    expect(ambientRobustnessGate(true, { baseline: 'accept', cases: { off: 'accept', light: 'accept', moderate: 'accept' } })).toEqual({ accepted: true, overall: 'accepted' });
    expect(ambientRobustnessGate(true, { baseline: 'accept', cases: { off: 'accept', light: 'reject' } })).toEqual({ accepted: false, overall: 'rejected' });
    expect(ambientRobustnessGate(false, { baseline: 'accept', cases: { off: 'accept' } })).toEqual({ accepted: false, overall: 'rejected' });
  });
});

