import type { BufferGeometry, Material, Object3D, Texture, WebGLRenderer } from 'three';
import { Mesh } from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { KTX2Loader } from 'three/addons/loaders/KTX2Loader.js';
import { MeshoptDecoder } from 'three/addons/libs/meshopt_decoder.module.js';

let sharedLoader: GLTFLoader | null = null;
let sharedKtx2: KTX2Loader | null = null;
let sharedKtx2Path = '';

/**
 * One GLTFLoader for the whole app.
 *
 * - meshopt decoding runs on a small worker pool (the tiles are all
 *   EXT_meshopt_compression, and decoding LOD0 on the main thread stalls it for
 *   tens of ms).
 * - GLTFLoader picks ImageBitmapLoader on its own when `createImageBitmap`
 *   exists, which moves PNG decode off the main thread. That is the single
 *   biggest hitch source here: a LOD0 tile carries up to 41 x 2048px PNGs.
 */
export function getGLTFLoader(renderer?: WebGLRenderer, ktx2TranscoderPath = ''): GLTFLoader {
  if (!sharedLoader) {
    const loader = new GLTFLoader();
    MeshoptDecoder.useWorkers(Math.min(4, Math.max(1, (navigator.hardwareConcurrency ?? 4) - 2)));
    loader.setMeshoptDecoder(MeshoptDecoder);
    sharedLoader = loader;
  }
  if (renderer && ktx2TranscoderPath && (!sharedKtx2 || sharedKtx2Path !== ktx2TranscoderPath)) {
    sharedKtx2?.dispose();
    sharedKtx2 = new KTX2Loader().setTranscoderPath(ktx2TranscoderPath).detectSupport(renderer);
    sharedKtx2Path = ktx2TranscoderPath;
    sharedLoader.setKTX2Loader(sharedKtx2);
  }
  return sharedLoader;
}

export function disposeSharedLoader(): void {
  sharedKtx2?.dispose();
  sharedKtx2 = null;
  sharedKtx2Path = '';
  sharedLoader = null;
}

export interface AssetResources {
  geometries: BufferGeometry[];
  materials: Material[];
  textures: Texture[];
}

export function collectResources(root: Object3D): AssetResources {
  const geometries = new Set<BufferGeometry>();
  const materials = new Set<Material>();
  const textures = new Set<Texture>();
  root.traverse((obj) => {
    const mesh = obj as Mesh;
    if (!(mesh as unknown as { isMesh?: boolean }).isMesh) return;
    if (mesh.geometry) geometries.add(mesh.geometry);
    const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
    for (const mat of mats) {
      if (!mat) continue;
      materials.add(mat);
      for (const value of Object.values(mat as unknown as Record<string, unknown>)) {
        const tex = value as Texture | null;
        if (tex && (tex as unknown as { isTexture?: boolean }).isTexture) textures.add(tex);
      }
    }
  });
  return {
    geometries: [...geometries],
    materials: [...materials],
    textures: [...textures],
  };
}

function textureBytes(tex: Texture): number {
  const img = tex.image as { width?: number; height?: number } | undefined;
  const w = img?.width ?? 0;
  const h = img?.height ?? 0;
  if (!w || !h) return 0;
  const mip = tex.generateMipmaps ? 4 / 3 : 1;
  return w * h * 4 * mip;
}

function geometryBytes(geo: BufferGeometry): number {
  let bytes = 0;
  for (const attr of Object.values(geo.attributes)) {
    const a = attr as { array?: ArrayBufferView };
    bytes += a.array?.byteLength ?? 0;
  }
  if (geo.index) bytes += geo.index.array.byteLength;
  return bytes;
}

/** Estimated GPU-resident bytes of an asset (textures dominate by ~10x here). */
export function estimateResourceBytes(res: AssetResources): number {
  let bytes = 0;
  for (const geo of res.geometries) bytes += geometryBytes(geo);
  for (const tex of res.textures) bytes += textureBytes(tex);
  return bytes;
}

/**
 * Push one texture to the GPU and drop the CPU-side copy.
 *
 * ImageBitmaps stay resident in the renderer process until explicitly closed,
 * so an un-closed LOD0 tile would cost its texture footprint twice. Nothing in
 * this package sets `needsUpdate` on a streamed texture, so three never re-reads
 * `texture.image` during normal operation.
 *
 * It does re-read it after a lost GPU context: three re-initialises the context
 * on `webglcontextrestored` and re-uploads every texture from `texture.image`,
 * which here is a closed bitmap reporting 0x0 — the tile comes back with black
 * albedo. Losing the CPU copy is still the right trade; the recovery is a
 * refetch, which `CityViewer` performs on restore. Do not treat a closed bitmap
 * as a reason to keep the second copy resident.
 */
export function uploadTexture(renderer: WebGLRenderer, tex: Texture): void {
  renderer.initTexture(tex);
  const data = tex.image as unknown;
  if (typeof ImageBitmap !== 'undefined' && data instanceof ImageBitmap) {
    data.close();
  }
}

export function disposeResources(res: AssetResources): void {
  for (const geo of res.geometries) geo.dispose();
  for (const tex of res.textures) {
    const data = tex.image as unknown;
    if (typeof ImageBitmap !== 'undefined' && data instanceof ImageBitmap) data.close();
    tex.dispose();
  }
  for (const mat of res.materials) mat.dispose();
}
