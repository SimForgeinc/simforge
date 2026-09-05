import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  alignLegacyStaticCollidersToScene,
  loadStaticMapColliders,
  requireReadyStaticColliderBundle,
  resetStaticColliderCacheForTests,
  type StaticColliderBundle,
} from '../staticMapColliders';

const SOURCE_BYTES = new TextEncoder().encode('{"map":"test"}\n');
const SOURCE_HASH = createHash('sha256').update(SOURCE_BYTES).digest('hex');
const DIGEST = `sha256-${'b'.repeat(64)}`;

function artifact(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schema: 'simforge.static-map-colliders/v1',
    mapId: 'test-map',
    sourceManifestSha256: SOURCE_HASH,
    sources: [{ id: 'tile-0', file: 'tile.glb', declaredBytes: 1234 }],
    colliders: [{
      id: 'tile-0/1',
      class: 'building',
      obb: { center: { x: 10, z: 20 }, lengthM: 8, widthM: 6, headingRad: 0 },
    }],
    statistics: {
      sourceTiles: 1,
      accepted: 1,
      rejectedRoadOverlap: 0,
      ignored: 2,
      classes: { building: 1, wall: 0, barrier: 0, prop: 0, 'road-boundary': 0 },
    },
    digest: DIGEST,
    ...overrides,
  };
}

function fixtureFetcher(value: Record<string, unknown>, calls: string[]): typeof fetch {
  const bytes = new TextEncoder().encode(`${JSON.stringify(value)}\n`);
  const outputSha256 = createHash('sha256').update(bytes).digest('hex');
  return (async (input: string | URL | Request) => {
    const url = String(input);
    calls.push(url);
    if (url.endsWith('/3d/manifest.json')) return new Response(SOURCE_BYTES);
    if (url.endsWith('/variants/manifest.json')) return Response.json({
      sourceManifestSha256: SOURCE_HASH,
      variants: { 'static-colliders': { schemaVersion: 1, file: 'static-colliders-v1.json', digest: DIGEST, outputSha256 } },
    });
    return new Response(bytes);
  }) as typeof fetch;
}

describe('precomputed static map colliders', () => {
  it('loads and validates one compact artifact, then reuses the map cache', async () => {
    resetStaticColliderCacheForTests();
    const calls: string[] = [];
    const fetcher = fixtureFetcher(artifact(), calls);
    const first = await loadStaticMapColliders('/dev-assets/test-map/3d/manifest.json', fetcher);
    const second = await loadStaticMapColliders('/dev-assets/test-map/3d/manifest.json', fetcher);

    expect(first).toBe(second);
    expect(first.colliders).toEqual([{
      id: 'tile-0/1', class: 'building',
      obb: { center: { x: 10, z: 20 }, lengthM: 8, widthM: 6, headingRad: 0 },
    }]);
    expect(first.diagnostics).toMatchObject({ status: 'ready', accepted: 1, sourceTiles: 1, digest: DIGEST });
    expect(calls).toHaveLength(3);
    expect(calls.every((url) => !url.endsWith('.glb'))).toBe(true);
  });

  it('fails immediately with diagnostics when the derivative is absent', async () => {
    resetStaticColliderCacheForTests();
    const result = await loadStaticMapColliders('/dev-assets/missing/3d/manifest.json', (async () => new Response('', { status: 404 })) as typeof fetch);
    expect(result.colliders).toEqual([]);
    expect(result.diagnostics).toMatchObject({ status: 'unavailable', warning: expect.stringContaining('(404)') });
  });

  it('rejects malformed and map-mismatched artifacts without GLB fallback', async () => {
    resetStaticColliderCacheForTests();
    const calls: string[] = [];
    const malformed = artifact({ sourceManifestSha256: 'd'.repeat(64) });
    const result = await loadStaticMapColliders('/dev-assets/test-map/3d/manifest.json', fixtureFetcher(malformed, calls));
    expect(result.colliders).toEqual([]);
    expect(result.diagnostics.warning).toContain('different map bundle');
    expect(calls).toHaveLength(3);
  });
});

describe('legacy static map collider runtime', () => {
  const readyBundle = {
    colliders: [{
      id: 'building-1',
      class: 'building',
      obb: { center: { x: 12, z: 4 }, lengthM: 10, widthM: 8, headingRad: 0 },
    }],
    diagnostics: {
      digest: 'sha256-ready',
      status: 'ready',
      sourceTiles: 1,
      accepted: 1,
      rejectedRoadOverlap: 0,
      ignored: 0,
      classes: { building: 1, wall: 0, barrier: 0, prop: 0, 'road-boundary': 0 },
    },
  } satisfies StaticColliderBundle;

  it('fails closed when verified collision data is unavailable', () => {
    const unavailable = {
      colliders: [],
      diagnostics: {
        ...readyBundle.diagnostics,
        status: 'unavailable',
        warning: 'Static collision derivative is not published for this map',
        accepted: 0,
        classes: { building: 0, wall: 0, barrier: 0, prop: 0, 'road-boundary': 0 },
      },
    } satisfies StaticColliderBundle;
    expect(() => requireReadyStaticColliderBundle(unavailable, {} as never)).toThrow(
      'Static map collision data is unavailable: Static collision derivative is not published for this map',
    );
  });

  it('repairs the legacy scene axis and carves coarse proxies off travel lanes', () => {
    const bundle = {
      ...readyBundle,
      colliders: [{
        id: 'building-1',
        class: 'building',
        obb: { center: { x: 0, z: 10 }, lengthM: 40, widthM: 20, headingRad: 0 },
      }],
    } satisfies StaticColliderBundle;
    const graph = {
      laneRsls: () => ['lane-1'],
      geometry: () => ({
        points: [-20, -10, 0, 10, 20].map((x) => ({ x, y: 10 })),
        widthM: 4,
        lane: { laneType: 'driving' },
      }),
    };

    const repaired = alignLegacyStaticCollidersToScene(bundle, graph as never);
    expect(repaired.colliders.length).toBeGreaterThan(0);
    expect(repaired.colliders.every((collider) => collider.id.startsWith('building-1#'))).toBe(true);
    for (const collider of repaired.colliders) {
      expect(Math.abs(collider.obb.center.z + 10)).toBeGreaterThan(collider.obb.widthM / 2 + 2.75);
    }
  });
});
