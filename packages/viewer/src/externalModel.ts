import type { ExternalModelBinding } from '@simforge/asset-catalog';
import {
  AnimationClip,
  Box3,
  Group,
  Material,
  Mesh,
  Texture,
  Vector3,
  type BufferGeometry,
} from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';

export type ExternalModelState = 'idle' | 'loading' | 'ready' | 'failed';

interface ExternalModelAsset {
  readonly scene: Group;
  readonly animations: readonly AnimationClip[];
}

type ExternalModelLoader = (url: string) => Promise<ExternalModelAsset>;

interface LoadedExternalModel {
  state: 'ready';
  scene: Group;
  clips: readonly AnimationClip[];
  extents: Readonly<{ l: number; w: number; h: number }>;
}

interface PendingExternalModel {
  state: 'loading' | 'failed';
}

type ExternalModelRecord = LoadedExternalModel | PendingExternalModel;

type ExternalGlbModelBinding = Extract<ExternalModelBinding, { readonly kind: 'glb' }>;

interface QueuedLoad {
  binding: ExternalGlbModelBinding;
  generation: number;
}

const MAX_CONCURRENT_LOADS = 4;
const records = new Map<string, ExternalModelRecord>();
const listeners = new Set<(contentHash: string) => void>();
const queue: QueuedLoad[] = [];
let activeLoads = 0;
let generation = 0;

const defaultLoader: ExternalModelLoader = async (url) => new GLTFLoader().loadAsync(url);
let loadExternalModel: ExternalModelLoader = defaultLoader;

export function externalModelState(contentHash: string): ExternalModelState {
  return records.get(contentHash)?.state ?? 'idle';
}

export function requestExternalModel(binding: ExternalModelBinding): void {
  if (binding.kind === 'proxy') return;
  if (records.has(binding.contentHash)) return;
  records.set(binding.contentHash, { state: 'loading' });
  queue.push({ binding, generation });
  pumpQueue();
}

export function externalModelScene(contentHash: string): Group | null {
  const record = records.get(contentHash);
  return record?.state === 'ready' ? record.scene : null;
}

export function externalModelClips(contentHash: string): readonly AnimationClip[] {
  const record = records.get(contentHash);
  return record?.state === 'ready' ? record.clips : [];
}

export function onExternalModelChange(listener: (contentHash: string) => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function disposeExternalModels(): void {
  generation++;
  queue.length = 0;
  for (const record of records.values()) {
    if (record.state === 'ready') disposeScene(record.scene);
  }
  records.clear();
}

export function setExternalModelLoader(load: ExternalModelLoader): void {
  loadExternalModel = load;
}

function pumpQueue(): void {
  while (activeLoads < MAX_CONCURRENT_LOADS) {
    const queued = queue.shift();
    if (!queued) return;
    activeLoads++;
    void performLoad(queued).finally(() => {
      activeLoads--;
      pumpQueue();
    });
  }
}

async function performLoad({ binding, generation: loadGeneration }: QueuedLoad): Promise<void> {
  let gltf: ExternalModelAsset;
  try {
    gltf = await Promise.resolve().then(() => loadExternalModel(binding.url));
  } catch {
    if (loadGeneration !== generation) return;
    records.set(binding.contentHash, { state: 'failed' });
    emitChange(binding.contentHash);
    return;
  }

  if (loadGeneration !== generation) {
    disposeScene(gltf.scene);
    return;
  }

  try {
    const extents = normaliseScene(gltf.scene, binding.scale ?? 1, binding.yawRad ?? 0);
    records.set(binding.contentHash, {
      state: 'ready',
      scene: gltf.scene,
      clips: [...gltf.animations],
      extents,
    });
  } catch {
    disposeScene(gltf.scene);
    records.set(binding.contentHash, { state: 'failed' });
  }
  emitChange(binding.contentHash);
}

function normaliseScene(
  scene: Group,
  scale: number,
  yawRad: number,
): Readonly<{ l: number; w: number; h: number }> {
  scene.scale.multiplyScalar(scale);
  scene.rotateY(yawRad);
  scene.updateMatrixWorld(true);

  const bounds = new Box3().setFromObject(scene);
  if (bounds.isEmpty()) throw new Error('External model has no measurable geometry');
  const centre = bounds.getCenter(new Vector3());
  scene.position.x -= centre.x;
  scene.position.y -= bounds.min.y;
  scene.position.z -= centre.z;
  scene.updateMatrixWorld(true);

  const size = new Box3().setFromObject(scene).getSize(new Vector3());
  return { l: size.x, w: size.z, h: size.y };
}

function emitChange(contentHash: string): void {
  for (const listener of [...listeners]) {
    try {
      listener(contentHash);
    } catch {
      // One host listener must not prevent other renderers from observing completion.
    }
  }
}

function disposeScene(scene: Group): void {
  const geometries = new Set<BufferGeometry>();
  const materials = new Set<Material>();
  const textures = new Set<Texture>();
  scene.traverse((object) => {
    const mesh = object as Mesh;
    if (!mesh.isMesh) return;
    geometries.add(mesh.geometry);
    for (const material of Array.isArray(mesh.material) ? mesh.material : [mesh.material]) {
      materials.add(material);
      for (const value of Object.values(material)) {
        if (value instanceof Texture) textures.add(value);
      }
    }
  });
  for (const geometry of geometries) geometry.dispose();
  for (const material of materials) material.dispose();
  for (const texture of textures) texture.dispose();
}
