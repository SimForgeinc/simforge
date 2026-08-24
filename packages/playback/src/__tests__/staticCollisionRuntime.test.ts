import type * as SimEngine from '@simforge/engine';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const createFixedStepSimulation = vi.hoisted(() => vi.fn());
vi.mock('@simforge/engine', async (importOriginal) => ({
  ...await importOriginal<typeof SimEngine>(),
  createFixedStepSimulation,
}));

import { createCollisionAwareFixedStepSimulation } from '../staticMapColliders';

describe('collision-aware fixed-step playback', () => {
  beforeEach(() => createFixedStepSimulation.mockReset());

  it('passes every published map collider into a strict simulation', () => {
    const session = { advance: vi.fn() };
    createFixedStepSimulation.mockReturnValue(session);
    const input = { mapId: 'map-1' };
    const graph = { topologyDigest: 'graph-1' };
    const colliders = [{
      id: 'building-1',
      class: 'building',
      obb: { center: { x: 1, z: 2 }, lengthM: 3, widthM: 4, headingRad: 0 },
    }];

    expect(createCollisionAwareFixedStepSimulation(input as never, graph as never, colliders as never)).toBe(session);
    expect(createFixedStepSimulation).toHaveBeenCalledWith(input, {
      graph,
      guards: 'throw',
      staticColliders: colliders,
    });
  });
});
