import { Box3, Group, Scene, Vector3 } from 'three';
import type { WebGLRenderer } from 'three';
import { describe, expect, it, vi } from 'vitest';
import { TileStreamLayer, type PreparedAsset } from './streaming';

const emptyAsset = (): PreparedAsset => ({
  object: new Group(),
  resources: { geometries: [], materials: [], textures: [] },
  bytes: 1,
  pendingTextures: [],
});

describe('essential streaming assets', () => {
  it('does not refetch a decoded asset while it waits for upload and shader compilation', async () => {
    let resolveBuild!: (asset: PreparedAsset) => void;
    const build = vi.fn(() => new Promise<PreparedAsset>((resolve) => { resolveBuild = resolve; }));
    const layer = new TileStreamLayer({
      name: 'deduplicated-layer',
      renderer: { compileAsync: async () => undefined } as never,
      scene: new Scene(),
      defs: [{
        id: 'tile', box: new Box3(new Vector3(-1, -1, -1), new Vector3(1, 1, 1)),
        lods: [{ level: 0, file: 'tile.glb', triangles: 1, fileSize: 1, geometricError: 0 }],
      }],
      build, maxConcurrent: 2,
      memory: { admit: () => true, maxAssetBytes: () => 100 },
      pinCoarsest: true,
    });

    layer.update(new Vector3(), 1, 9999);
    expect(build).toHaveBeenCalledOnce();
    resolveBuild(emptyAsset());
    await Promise.resolve();
    // Before the queued asset has reached the scene, repeated render ticks must
    // not issue the same request again.
    layer.update(new Vector3(), 1, 9999);
    layer.update(new Vector3(), 1, 9999);
    expect(build).toHaveBeenCalledOnce();
    layer.pumpUploads(performance.now() + 100, { remaining: 1 }, {} as never);
    await layer.whenCompilationIdle();
    expect(build).toHaveBeenCalledOnce();
    layer.dispose();
  });

  it('does not report an unaffordable optional LOD as endlessly queued', () => {
    const build = vi.fn(async () => emptyAsset());
    const layer = new TileStreamLayer({
      name: 'budget-bounded-layer',
      renderer: { compileAsync: async () => undefined } as never,
      scene: new Scene(),
      defs: [{
        id: 'tile', box: new Box3(new Vector3(-1, -1, -1), new Vector3(1, 1, 1)),
        lods: [{ level: 0, file: 'tile.glb', triangles: 1, fileSize: 1000, geometricError: 0 }],
      }],
      build, maxConcurrent: 1,
      memory: { admit: () => false, maxAssetBytes: () => 100 },
      pinCoarsest: false,
    });

    layer.update(new Vector3(), 1, 9999);
    layer.update(new Vector3(), 1, 9999);
    expect(build).not.toHaveBeenCalled();
    expect(layer.stats().queued).toBe(0);
    layer.dispose();
  });

  it('starts the pinned road/ground load even when the optional-detail budget refuses it', async () => {
    const build = vi.fn(async () => emptyAsset());
    const layer = new TileStreamLayer({
      name: 'road-layer',
      renderer: { compileAsync: async () => undefined } as never,
      scene: new Scene(),
      defs: [{
        id: 'road',
        box: new Box3(new Vector3(-1, -1, -1), new Vector3(1, 1, 1)),
        lods: [{ level: 0, file: 'road.glb', triangles: 1, fileSize: 1000, geometricError: 0 }],
      }],
      build,
      maxConcurrent: 1,
      memory: { admit: () => false, maxAssetBytes: () => 0 },
      pinCoarsest: true,
      essentialCoarsest: true,
    });
    layer.update(new Vector3(), 1, 9999);
    await Promise.resolve();
    expect(build).toHaveBeenCalledOnce();
    layer.dispose();
  });

  it('does not fetch an excluded layer and never reuses disposed assets after a mode reset', async () => {
    let wanted = false;
    const assets: PreparedAsset[] = [];
    const disposals: ReturnType<typeof vi.fn>[] = [];
    const build = vi.fn(async () => {
      const asset = emptyAsset();
      const dispose = vi.fn();
      asset.dispose = dispose;
      assets.push(asset);
      disposals.push(dispose);
      return asset;
    });
    const layer = new TileStreamLayer({
      name: 'optional-city-layer',
      renderer: { compileAsync: async () => undefined } as never,
      scene: new Scene(),
      defs: [{
        id: 'city', box: new Box3(new Vector3(-1, -1, -1), new Vector3(1, 1, 1)),
        lods: [{ level: 0, file: 'city.glb', triangles: 1, fileSize: 1, geometricError: 0 }],
      }],
      build, maxConcurrent: 1,
      memory: { admit: () => true, maxAssetBytes: () => 100 },
      pinCoarsest: false,
      want: () => wanted,
    });

    layer.update(new Vector3(), 1, 9999);
    expect(build).not.toHaveBeenCalled();
    wanted = true;
    layer.update(new Vector3(), 1, 9999);
    await Promise.resolve();
    layer.pumpUploads(performance.now() + 100, { remaining: 1 }, {} as never);
    await layer.whenCompilationIdle();
    expect(build).toHaveBeenCalledOnce();
    await layer.resetAssets();
    expect(disposals[0]).toHaveBeenCalledOnce();

    layer.update(new Vector3(), 1, 9999);
    await Promise.resolve();
    expect(build).toHaveBeenCalledTimes(2);
    expect(assets[1]).not.toBe(assets[0]);
    layer.dispose();
  });

  it('keeps compilation observable through disposal so the renderer can be torn down afterward', async () => {
    let resolveCompile!: () => void;
    const compile = new Promise<void>((resolve) => { resolveCompile = resolve; });
    const compileAsync = vi.fn(() => compile);
    const renderer = { compileAsync } as unknown as WebGLRenderer;
    const asset = emptyAsset();
    const disposeAsset = vi.fn();
    asset.dispose = disposeAsset;
    const layer = new TileStreamLayer({
      name: 'cross-map-layer',
      renderer,
      scene: new Scene(),
      defs: [{
        id: 'cross-map-tile',
        box: new Box3(new Vector3(-1, -1, -1), new Vector3(1, 1, 1)),
        lods: [{ level: 0, file: 'tile.glb', triangles: 1, fileSize: 1, geometricError: 0 }],
      }],
      build: vi.fn(async () => asset),
      maxConcurrent: 1,
      memory: { admit: () => true, maxAssetBytes: () => 100 },
      pinCoarsest: true,
    });

    layer.update(new Vector3(), 1, 9999);
    await Promise.resolve();
    layer.pumpUploads(performance.now() + 100, { remaining: 1 }, {} as never);
    expect(compileAsync).toHaveBeenCalledOnce();

    layer.dispose();
    let idle = false;
    const settled = layer.whenCompilationIdle().then(() => { idle = true; });
    await Promise.resolve();
    expect(idle).toBe(false);
    expect(disposeAsset).not.toHaveBeenCalled();

    resolveCompile();
    await settled;
    expect(idle).toBe(true);
    expect(disposeAsset).toHaveBeenCalledOnce();
  });
});
