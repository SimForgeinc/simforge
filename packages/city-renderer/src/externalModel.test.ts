import { afterEach, describe, expect, it, vi } from 'vitest';
import { AnimationClip, Box3, BoxGeometry, Group, Mesh, MeshBasicMaterial, Vector3 } from 'three';
import {
  disposeExternalModels,
  externalModelClips,
  externalModelScene,
  externalModelState,
  onExternalModelChange,
  requestExternalModel,
  setExternalModelLoader,
} from './externalModel';
interface TestGltf {
  readonly scene: Group;
  readonly animations: readonly AnimationClip[];
}

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason?: unknown) => void;
} {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function model(): { gltf: TestGltf; scene: Group; clip: AnimationClip } {
  const scene = new Group();
  const mesh = new Mesh(new BoxGeometry(2, 4, 6), new MeshBasicMaterial());
  mesh.position.set(5, 7, -3);
  scene.add(mesh);
  const clip = new AnimationClip('idle', 2, []);
  return {
    scene,
    clip,
    gltf: { scene, animations: [clip] },
  };
}

afterEach(() => {
  disposeExternalModels();
});

describe('external GLB model cache', () => {
  it('ignores proxy bindings without fetching or leaving idle state', async () => {
    const loader = vi.fn(async () => model().gltf);
    setExternalModelLoader(loader);

    requestExternalModel({ kind: 'proxy', tint: '#e87822' });
    await Promise.resolve();

    expect(loader).not.toHaveBeenCalled();
    expect(externalModelState('proxy')).toBe('idle');
  });

  it('normalises once, transitions idle to loading to ready, and dedupes listeners and loads', async () => {
    const hash = 'a'.repeat(64);
    const loaded = model();
    const pending = deferred<TestGltf>();
    const loader = vi.fn(() => pending.promise);
    setExternalModelLoader(loader);
    const listener = vi.fn();
    const unsubscribe = onExternalModelChange(listener);
    const binding = {
      kind: 'glb' as const,
      url: 'https://assets.example/model.glb',
      contentHash: hash,
      scale: 0.5,
      yawRad: Math.PI / 2,
    };

    expect(externalModelState(hash)).toBe('idle');
    expect(requestExternalModel(binding)).toBeUndefined();
    expect(externalModelState(hash)).toBe('loading');
    requestExternalModel(binding);
    await Promise.resolve();
    expect(loader).toHaveBeenCalledOnce();

    pending.resolve(loaded.gltf);
    await vi.waitFor(() => expect(externalModelState(hash)).toBe('ready'));

    const scene = externalModelScene(hash);
    expect(scene).toBe(loaded.scene);
    const bounds = new Box3().setFromObject(scene!);
    const centre = bounds.getCenter(new Vector3());
    const size = bounds.getSize(new Vector3());
    expect(bounds.min.y).toBeCloseTo(0);
    expect(centre.x).toBeCloseTo(0);
    expect(centre.z).toBeCloseTo(0);
    expect(size.x).toBeCloseTo(3);
    expect(size.y).toBeCloseTo(2);
    expect(size.z).toBeCloseTo(1);
    expect(externalModelClips(hash)).toEqual([loaded.clip]);
    expect(listener).toHaveBeenCalledOnce();
    expect(listener).toHaveBeenCalledWith(hash);

    requestExternalModel({ ...binding, url: 'https://assets.example/rotated-url.glb' });
    await Promise.resolve();
    expect(loader).toHaveBeenCalledOnce();
    expect(listener).toHaveBeenCalledOnce();
    unsubscribe();
  });

  it('caps concurrent GLB fetches at four', async () => {
    const pending = Array.from({ length: 5 }, () => deferred<TestGltf>());
    let active = 0;
    let peakActive = 0;
    const loader = vi.fn((_url: string) => {
      const current = pending[loader.mock.calls.length - 1]!;
      active++;
      peakActive = Math.max(peakActive, active);
      return current.promise.finally(() => {
        active--;
      });
    });
    setExternalModelLoader(loader);

    for (let index = 0; index < 5; index++) {
      requestExternalModel({
        kind: 'glb',
        url: `https://assets.example/${index}.glb`,
        contentHash: index.toString().repeat(64),
      });
    }
    await vi.waitFor(() => expect(loader).toHaveBeenCalledTimes(4));
    expect(peakActive).toBe(4);

    pending[0]!.resolve(model().gltf);
    await vi.waitFor(() => expect(loader).toHaveBeenCalledTimes(5));
    expect(peakActive).toBe(4);
    for (let index = 1; index < pending.length; index++) {
      pending[index]!.resolve(model().gltf);
    }
    await vi.waitFor(() => expect(active).toBe(0));
  });

  it('records a rejecting loader as failed without throwing', async () => {
    const hash = 'b'.repeat(64);
    const listener = vi.fn();
    const unsubscribe = onExternalModelChange(listener);
    setExternalModelLoader(async () => {
      throw new Error('network unavailable');
    });

    expect(() => requestExternalModel({
      kind: 'glb',
      url: 'https://assets.example/missing.glb',
      contentHash: hash,
    })).not.toThrow();
    await vi.waitFor(() => expect(externalModelState(hash)).toBe('failed'));
    expect(externalModelScene(hash)).toBeNull();
    expect(externalModelClips(hash)).toEqual([]);
    expect(listener).toHaveBeenCalledOnce();
    expect(listener).toHaveBeenCalledWith(hash);
    unsubscribe();
  });
});
