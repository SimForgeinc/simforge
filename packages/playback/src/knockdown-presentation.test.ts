import { describe, expect, it } from 'vitest';

import { KNOCKDOWN_FALL_S, knockdownProgress } from './model.js';

describe('knockdown presentation', () => {
  it('stays upright until the recorded fall time', () => {
    expect(knockdownProgress(undefined, 5)).toBe(0);
    expect(knockdownProgress(2, 1.9)).toBe(0);
    expect(knockdownProgress(2, 2)).toBe(0);
  });

  it('reaches flat after one fall duration and stays there', () => {
    expect(knockdownProgress(2, 2 + KNOCKDOWN_FALL_S / 2)).toBeCloseTo(0.5, 6);
    expect(knockdownProgress(2, 2 + KNOCKDOWN_FALL_S)).toBe(1);
    // Nothing in a planar engine stands a body back up, so it never returns.
    expect(knockdownProgress(2, 60)).toBe(1);
  });

  it('is a pure function of clip time, so scrubbing is reversible', () => {
    // Playback scrubs backwards as well as forwards; deriving the pose from the
    // timestamp rather than accumulating it means rewinding past the impact
    // puts the body back on its feet instead of leaving it stuck down.
    const forwards = [1.8, 2.0, 2.2, 2.5].map((t) => knockdownProgress(2, t));
    const backwards = [2.5, 2.2, 2.0, 1.8].map((t) => knockdownProgress(2, t));
    expect(backwards).toEqual([...forwards].reverse());
    expect(forwards[0]).toBe(0);
  });
});
