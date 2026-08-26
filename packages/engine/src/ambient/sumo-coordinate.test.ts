import { describe, expect, it } from 'vitest';
import {
  sumoNetworkHeadingToScene,
  sumoNetworkToScene,
  sumoSceneHeadingToNetwork,
  sumoSceneToNetwork,
  type SumoNetworkWorldTransform,
} from './sumo.js';

const maps: Record<string, SumoNetworkWorldTransform> = {
  // Generated sidecar registrations. Yale's large negative northing is the
  // coordinate range that exposed the former CLI-only double reflection.
  'yale-st-palo-alto-ca': {
    translationX: 352.19,
    translationY: -1482.44,
    rotationDegrees: 0,
    scale: 1,
    invertY: true,
  },
  'belmont-office-park-belmont-ca': {
    translationX: -248.57,
    translationY: 304.62,
    rotationDegrees: 0,
    scale: 1,
    invertY: true,
  },
};

describe('provider-neutral SUMO scene coordinate contract', () => {
  for (const [mapId, transform] of Object.entries(maps)) {
    it(`round-trips lane and authored-proxy points on ${mapId}`, () => {
      for (const networkPoint of [{ x: 0, y: 0 }, { x: 120.5, y: 240.25 }, { x: 500, y: 400 }]) {
        const scene = sumoNetworkToScene(networkPoint, transform);
        const restored = sumoSceneToNetwork(scene, transform);
        expect(restored.x).toBeCloseTo(networkPoint.x, 9);
        expect(restored.y).toBeCloseTo(networkPoint.y, 9);

        // This is the exact conversion used when an authored scene actor is
        // mirrored as an external SUMO obstacle. No caller-side z negation.
        const proxyScene = sumoNetworkToScene(restored, transform);
        expect(proxyScene).toEqual(scene);
      }
    });
  }

  it('keeps Yale scene z in the same negative range for output and proxies', () => {
    const transform = maps['yale-st-palo-alto-ca']!;
    const scene = sumoNetworkToScene({ x: 200, y: 100 }, transform);
    expect(scene).toEqual({ x: 552.19, z: -1582.44 });
    const restored = sumoSceneToNetwork(scene, transform);
    expect(restored.x).toBeCloseTo(200, 9);
    expect(restored.y).toBeCloseTo(100, 9);
  });

  it('round-trips headings with reflection and rotation exactly once', () => {
    const transform = { ...maps['yale-st-palo-alto-ca']!, rotationDegrees: 17 };
    for (const heading of [0, 45, 90, 180, 315]) {
      expect(sumoSceneHeadingToNetwork(sumoNetworkHeadingToScene(heading, transform), transform))
        .toBeCloseTo(heading, 9);
    }
  });

  it('rejects a degenerate sidecar registration', () => {
    expect(() => sumoNetworkToScene({ x: 0, y: 0 }, { ...maps['yale-st-palo-alto-ca']!, scale: 0 }))
      .toThrow(/scale/);
  });
});
