import { describe, expect, it, vi } from 'vitest';
import type { ActorRenderer, ActorView } from '@simforge-oss/viewer';
import { parseSimScenarioInput } from '@simforge-oss/engine';
import {
  CollisionActorOverrides,
  withBoundedSpeedCruiseRestoration,
  withCollisionActorOverrides,
  withStableHighSpeedWorldRoutes,
} from '../runtimeRefinements';

function actor(id: string, x: number): ActorView {
  return {
    id,
    catalogId: 'vehicle.sedan',
    kind: 'car',
    x,
    y: 0,
    z: 0,
    headingRad: 0,
    speedMps: 4,
    dims: { l: 4.5, w: 1.8, h: 1.5 },
  };
}

describe('runtime refinements', () => {
  it('restores cruise speed after a bounded speed interaction', () => {
    const input = parseSimScenarioInput({
      mapId: 'test',
      clipSeconds: 5,
      actors: [{
        id: 'car',
        kind: 'car',
        dims: { l: 4.5, w: 1.8, h: 1.5 },
        initial: { pose: { x: 0, z: 0, headingRad: 0 }, speedMps: 8 },
        behavior: {
          cruiseSpeedMps: 8,
          route: { kind: 'polyline', points: [{ x: 0, z: 0 }, { x: 50, z: 0 }] },
        },
        tags: [],
      }],
      interactions: [{
        id: 'slow',
        actorId: 'car',
        trigger: { kind: 'at', t: 1 },
        window: { startS: 1, endS: 2 },
        verb: 'speed',
        target: { mode: 'absolute', value: 0 },
        dynamics: { shape: 'linear', constraint: 'rate', value: 3 },
      }],
    });
    const restored = withBoundedSpeedCruiseRestoration(input);
    expect(restored.interactions).toContainEqual(expect.objectContaining({
      id: 'restore-cruise-slow',
      trigger: { kind: 'at', t: 2 },
      target: { mode: 'absolute', value: 8 },
    }));
  });

  it('applies speed-feasible yaw limits to high-speed world routes', () => {
    const input = parseSimScenarioInput({
      mapId: 'test',
      clipSeconds: 3,
      physics: { mode: 'dynamic-v1' },
      actors: [{
        id: 'car',
        kind: 'car',
        dims: { l: 4.5, w: 1.8, h: 1.5 },
        initial: { pose: { x: 0, z: 0, headingRad: 0 }, speedMps: 40 },
        behavior: {
          cruiseSpeedMps: 40,
          route: { kind: 'polyline', points: [{ x: 0, z: 0 }, { x: 100, z: 0 }] },
        },
        tags: [],
      }],
      interactions: [{
        id: 'route',
        actorId: 'car',
        trigger: { kind: 'at', t: 0.5 },
        verb: 'route',
        target: { kind: 'polyline', points: [{ x: 10, z: 0 }, { x: 100, z: -20 }] },
        joinFromCurrentPose: true,
        bestEffortWorldPath: true,
      }],
    });
    const stable = withStableHighSpeedWorldRoutes(input);
    expect(stable.physics?.vehicleProfiles?.car?.maxYawRateRadps).toBeCloseTo(7 / 40);
    expect(stable.interactions[0]).toEqual(expect.objectContaining({ joinFromCurrentPose: false }));
  });

  it('replaces playback actors without changing other renderer layers', () => {
    const syncLayer = vi.fn();
    const renderer = { syncLayer } as unknown as ActorRenderer;
    const overrides = new CollisionActorOverrides();
    overrides.replace([actor('ego', 8)]);
    const wrapped = withCollisionActorOverrides(renderer, overrides);

    wrapped.syncLayer('playback', [actor('ego', 100), actor('other', 5)]);
    wrapped.syncLayer('sumo-traffic', [actor('ego', 20)]);

    expect(syncLayer.mock.calls[0]?.[1]).toEqual([actor('ego', 8), actor('other', 5)]);
    expect(syncLayer.mock.calls[1]?.[1]).toEqual([actor('ego', 20)]);
  });
});
