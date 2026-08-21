import type { ActorRenderer, ActorView } from '@uniscenarios/editor-core';
import { describe, expect, it, vi } from 'vitest';

import type { PlaybackBundle } from '../model';
import { applyRestingHeading, createRestingHeading, withRestingHeading } from '../restingHeading';

function bundle(): PlaybackBundle {
  return {
    trace: {
      ticks: {
        t: [0, 1, 2, 3],
        actors: {
          car: {
            speedMps: [4, 0, 0, 3],
            headingRad: [Math.PI / 2, 0, 0, Math.PI / 2],
          },
          cone: {
            speedMps: [0, 0, 0, 0],
            headingRad: [1.2, 0, 0, 0],
          },
        },
      },
    },
  } as unknown as PlaybackBundle;
}

describe('resting trace heading presentation', () => {
  it('holds the last travelling heading through zero-velocity samples', () => {
    const resting = createRestingHeading(bundle());
    expect(resting.headingAt('car', 1)).toBe(Math.PI / 2);
    expect(resting.headingAt('car', 1.5)).toBe(Math.PI / 2);
    expect(applyRestingHeading({ id: 'car', headingRad: 0, animationTimeS: 2 }, resting))
      .toEqual({ id: 'car', headingRad: Math.PI / 2, animationTimeS: 2 });
  });

  it('leaves actors that never travelled untouched', () => {
    const resting = createRestingHeading(bundle());
    const actor = { id: 'cone', headingRad: 1.2, animationTimeS: 1 };
    expect(resting.headingAt('cone', 1)).toBeNull();
    expect(applyRestingHeading(actor, resting)).toBe(actor);
  });

  it('rewrites only the playback renderer layer', () => {
    const syncLayer = vi.fn();
    const renderer = { syncLayer } as unknown as ActorRenderer;
    const wrapped = withRestingHeading(renderer, createRestingHeading(bundle()));
    const actor = { id: 'car', headingRad: 0, animationTimeS: 1 } as ActorView;

    wrapped.syncLayer('playback', [actor]);
    wrapped.syncLayer('editor', [actor]);

    expect(syncLayer.mock.calls[0]?.[1]?.[0]).toMatchObject({ headingRad: Math.PI / 2 });
    expect(syncLayer.mock.calls[1]?.[1]?.[0]).toBe(actor);
  });
});
