import * as THREE from 'three/webgpu';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { KTX2Loader } from 'three/addons/loaders/KTX2Loader.js';
import { MeshoptDecoder } from 'three/addons/libs/meshopt_decoder.module.js';
import { assertAormBindings } from '../material-assertions';
import { applyLayerFlags, captureOriginals } from '../layer-material-applier';
import { applyStaticSemantics, type StaticSemantics } from '../static-semantics';
import {
  addTileTextureReferences,
  dedupeGroupTextures,
} from './texture-pool';

const loader = new GLTFLoader();
loader.setMeshoptDecoder(MeshoptDecoder);

/**
 * Shared KTX2 (Basis UASTC) decode support for every GLB loader in the
 * viewer — the pipeline's `variants/ktx2-uastc-v1` GLBs carry
 * KHR_texture_basisu textures which GLTFLoader can only parse with a
 * configured KTX2Loader. `configureKtx2Support` is called by the viewer
 * core once the renderer is initialized and the variant manifest's
 * transcoder assets have been verified reachable; until it succeeds,
 * `isKtx2Ready()` stays false and the tile-manager keeps resolving the
 * authored (uncompressed-texture) GLBs.
 */
let ktx2Loader: KTX2Loader | null = null;

export function isKtx2Ready(): boolean {
  return ktx2Loader !== null;
}

/** Wire the (already-configured) KTX2 loader into a GLTFLoader instance. */
export function applyKtx2Support(target: GLTFLoader): void {
  if (ktx2Loader) target.setKTX2Loader(ktx2Loader);
}

export function configureKtx2Support(
  renderer: THREE.WebGPURenderer,
  transcoderUrl: string,
): boolean {
  try {
    const instance = new KTX2Loader();
    instance.setTranscoderPath(transcoderUrl);
    // three r181+: detectSupport() is correct for an initialized WebGPU (or
    // fallback WebGL) renderer — the viewer awaits renderer.init() before
    // any manifest work.
    instance.detectSupport(renderer as unknown as Parameters<KTX2Loader['detectSupport']>[0]);
    ktx2Loader = instance;
    loader.setKTX2Loader(instance);
    return true;
  } catch (err) {
    console.warn('[TileLoader] KTX2 support unavailable — using authored GLBs:', err);
    ktx2Loader = null;
    return false;
  }
}

export interface LoadedTile {
  group: THREE.Group;
  byteSize: number;
}

/** Yield to the browser for one frame. */
function yieldFrame(): Promise<void> {
  return new Promise((resolve) => requestAnimationFrame(() => resolve()));
}

/**
 * Runtime texture downscaling — resizes any texture whose dimensions exceed
 * maxSize.  Uses an OffscreenCanvas (or fallback canvas) to produce a smaller
 * ImageBitmap, then replaces the texture source in-place.
 *
 * On integrated GPUs textures are stored in shared system RAM.  Downscaling
 * from ~590px (common in LOD3 GLBs) to 256px cuts texture memory by ~5×.
 */
let _maxTextureSize = 0;

export function setMaxTextureSize(size: number): void {
  _maxTextureSize = size;
}

/**
 * Per-texture downscale observer for the audit aggregator (#07). Set to a
 * non-null callback in dev mode (gated by `IS_DEV_HUD_BUILD`) to receive a
 * `{beforeBytes, afterBytes}` event each time a texture is downscaled.
 * The observer is null in production so the runtime cost is one optional-
 * call check per resized texture.
 */
export interface DownscaleEvent {
  beforeBytes: number;
  afterBytes: number;
}

let _downscaleObserver: ((event: DownscaleEvent) => void) | null = null;

export function setDownscaleObserver(
  observer: ((event: DownscaleEvent) => void) | null,
): void {
  _downscaleObserver = observer;
}

/** Estimate raw RGBA byte cost of a texture image of a given pixel size. */
function estimateRgbaBytes(width: number, height: number): number {
  return Math.max(0, width) * Math.max(0, height) * 4;
}

export function downscaleTextures(group: THREE.Group): void {
  if (_maxTextureSize <= 0) return;

  const seen = new Set<number>();
  let resized = 0;
  let skipped = 0;
  group.traverse((child) => {
    if (!(child instanceof THREE.Mesh)) return;
    const mats = Array.isArray(child.material) ? child.material : [child.material];
    for (const mat of mats) {
      if (!mat) continue;
      for (const key of Object.keys(mat)) {
        const tex = (mat as Record<string, unknown>)[key];
        if (!(tex instanceof THREE.Texture) || seen.has(tex.id)) continue;
        seen.add(tex.id);
        if (downscaleTexture(tex)) resized++;
        else skipped++;
      }
    }
  });
  if (resized > 0) {
    console.log(`[TileLoader] Downscaled ${resized} textures to max ${_maxTextureSize}px (${skipped} already small enough)`);
  }
}

/** Returns true if the texture was resized. */
function downscaleTexture(tex: THREE.Texture): boolean {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const img = (tex.source as any)?.data ?? tex.image;
  if (!img) return false;

  const w: number = img.width ?? 0;
  const h: number = img.height ?? 0;
  if (w <= _maxTextureSize && h <= _maxTextureSize) return false;

  const scale = _maxTextureSize / Math.max(w, h);
  const nw = Math.max(1, Math.round(w * scale));
  const nh = Math.max(1, Math.round(h * scale));

  try {
    // Create a canvas at the target size and draw the image scaled down
    const canvas = document.createElement('canvas');
    canvas.width = nw;
    canvas.height = nh;

    const ctx = canvas.getContext('2d');
    if (!ctx) return false;

    ctx.drawImage(img as CanvasImageSource, 0, 0, nw, nh);

    // Replace the texture image with the smaller canvas
    tex.image = canvas;
    tex.needsUpdate = true;

    if (_downscaleObserver) {
      _downscaleObserver({
        beforeBytes: estimateRgbaBytes(w, h),
        afterBytes: estimateRgbaBytes(nw, nh),
      });
    }
    return true;
  } catch (err) {
    console.warn('[TileLoader] Texture downscale failed:', err);
    return false;
  }
}

/**
 * Deep-dispose a tile group's GPU resources. Mirrors `TileCache.disposeEntry`
 * for groups that were loaded for sampling/inspection only and never added
 * to the cache (e.g. shader-prewarm's transient picker fetches).
 */
export function disposeTileGroup(group: THREE.Group): void {
  group.traverse((obj) => {
    if (!(obj instanceof THREE.Mesh)) return;
    obj.geometry?.dispose();
    const mats = Array.isArray(obj.material) ? obj.material : [obj.material];
    for (const m of mats) {
      if (!m) continue;
      for (const value of Object.values(m)) {
        if (value instanceof THREE.Texture) value.dispose();
      }
      m.dispose();
    }
  });
}

/**
 * Sanitize a single mesh's geometry to prevent WebGPU validation errors.
 */
function sanitizeMesh(child: THREE.Mesh): void {
  const geo = child.geometry as THREE.BufferGeometry;
  if (!geo) return;

  child.frustumCulled = true;
  child.receiveShadow = true;

  const position = geo.getAttribute('position');
  if (!position || position.count === 0) {
    child.visible = false;
    return;
  }

  const index = geo.index;
  if (!index) return;

  const vertexCount = position.count;
  const srcArray = index.array;
  const safeCount = Math.min(index.count, srcArray.length);

  // Find valid triangles (all 3 indices within vertex buffer bounds)
  let validCount = 0;
  for (let i = 0; i + 2 < safeCount; i += 3) {
    if (srcArray[i]! < vertexCount &&
        srcArray[i + 1]! < vertexCount &&
        srcArray[i + 2]! < vertexCount) {
      if (validCount !== i) {
        srcArray[validCount] = srcArray[i]!;
        srcArray[validCount + 1] = srcArray[i + 1]!;
        srcArray[validCount + 2] = srcArray[i + 2]!;
      }
      validCount += 3;
    }
  }

  if (validCount === 0) {
    child.visible = false;
    return;
  }

  // Rebuild as Uint32 in a fresh ArrayBuffer to prevent the Three.js
  // WebGPU Uint16→Uint32 promotion bug.
  const cleanArray = new Uint32Array(validCount);
  for (let i = 0; i < validCount; i++) {
    cleanArray[i] = srcArray[i]!;
  }
  geo.setIndex(new THREE.BufferAttribute(cleanArray, 1));

  if (geo.groups.length > 0) {
    geo.clearGroups();
  }

  // Rebuild vertex attributes that share ArrayBuffers
  for (const attrName of Object.keys(geo.attributes)) {
    const attr = geo.getAttribute(attrName);
    if (!attr || !attr.array) continue;
    const arr = attr.array;
    if (arr.byteOffset !== 0 || arr.buffer.byteLength !== arr.byteLength) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- typed array constructor reflection
      const AttrType = arr.constructor as any;
      const clean = new AttrType(arr.length);
      clean.set(arr);
      geo.setAttribute(attrName, new THREE.BufferAttribute(clean, attr.itemSize, attr.normalized));
    }
  }

  geo.computeBoundingBox();
  geo.computeBoundingSphere();
}

/**
 * Async sanitize — processes meshes in batches, yielding a frame between
 * each batch so the render loop stays smooth.
 */
const MESHES_PER_BATCH = 5;

export async function sanitizeGeometryAsync(group: THREE.Group): Promise<void> {
  const meshes: THREE.Mesh[] = [];
  group.traverse((child) => {
    if (child instanceof THREE.Mesh) meshes.push(child);
  });

  for (let i = 0; i < meshes.length; i += MESHES_PER_BATCH) {
    const end = Math.min(i + MESHES_PER_BATCH, meshes.length);
    for (let j = i; j < end; j++) {
      sanitizeMesh(meshes[j]!);
    }
    if (end < meshes.length) {
      await yieldFrame();
    }
  }
}

/**
 * Parse queue — serializes GLB parse + sanitize so only one runs at a time.
 */
const parseQueue: Array<{
  buffer: ArrayBuffer;
  resolve: (v: LoadedTile) => void;
  reject: (e: unknown) => void;
  signal: AbortSignal;
  semantics: StaticSemantics | null;
}> = [];
let parseRunning = false;

/**
 * Release the module-level state that survives `CityViewerCore.dispose()`.
 * Drains the parse queue (rejecting pending items with `AbortError`) so
 * lingering ArrayBuffers (a single in-flight GLB can be 5–30 MB) are not
 * pinned across viewer remount cycles, and flushes the global Three.js
 * `Cache` keyed map (the `GLTFLoader` singleton above writes to it when a
 * GLTF references external resources).
 *
 * The `GLTFLoader` and `MeshoptDecoder` instances themselves are stateless
 * across calls and intentionally not re-created — re-instantiating them
 * would also drop the decoder's WASM module which is already pinned by V8
 * and pays no per-cycle retention cost.
 *
 * ABH-106 wires this into the viewer's dispose chain so module-scope
 * caches share the same lifetime contract as `clearTexturePool` and
 * `clearVegetationInstanceCache`.
 */
export function resetTileLoader(): void {
  while (parseQueue.length > 0) {
    const item = parseQueue.shift()!;
    try {
      item.reject(new DOMException("Aborted", "AbortError"));
    } catch {
      // ignore — caller's reject handler may throw; we still want to drain.
    }
  }
  // Terminate the Basis transcoder workers with the viewer. The next mount
  // reconfigures against its own renderer via `configureKtx2Support`.
  if (ktx2Loader) {
    try {
      ktx2Loader.dispose();
    } catch {
      // worker teardown is best-effort
    }
    ktx2Loader = null;
  }
  THREE.Cache.clear();
}

async function drainParseQueue(): Promise<void> {
  if (parseRunning) return;
  parseRunning = true;

  while (parseQueue.length > 0) {
    // Yield a frame BEFORE each parse so the render loop can paint.
    // Without this, loader.parseAsync blocks the main thread and
    // nothing else renders until the entire queue drains.
    await yieldFrame();

    const item = parseQueue.shift()!;

    if (item.signal.aborted) {
      item.reject(new DOMException('Aborted', 'AbortError'));
      continue;
    }

    try {
      const gltf = await loader.parseAsync(item.buffer, '');
      const group = gltf.scene as THREE.Group;
      applyStaticSemantics(group, item.semantics);
      await sanitizeGeometryAsync(group);
      // Dedupe before downscale: cross-tile shared textures get rewritten to
      // a single canonical instance, freeing the just-uploaded redundant
      // copies before downscale touches them.
      const deduped = dedupeGroupTextures(group);
      if (deduped.deduped > 0) {
        console.debug(
          `[TileLoader] deduped ${deduped.deduped} cross-tile textures (${deduped.adopted} new in pool)`,
        );
      }
      // ABH-112: count THIS tile as one reference per distinct pooled
      // texture it ends up using. Paired with the cache's
      // disposeSubtree → releaseTileTextureReferences seam so the pool's
      // per-texture refcount stays balanced across the tile's full
      // lifecycle. Must run AFTER dedupe (every redundant slot has been
      // rewritten to a canonical instance) and BEFORE downscale (downscale
      // only mutates `tex.image`, leaving the reverse-lookup intact, but
      // running before downscale keeps the increment adjacent to the
      // pool-adoption call site that produced the canonical).
      addTileTextureReferences(group);
      downscaleTextures(group);
      assertAormBindings(group);
      // Tag the loaded root so the visual-config HUD's per-layer multipliers
      // (issue #04) can scope material mutations to assets only, and snapshot
      // each material's PBR baseline so multipliers compose with the original
      // glTF values rather than overwriting them.
      group.userData.layerKind = 'asset';
      captureOriginals(group);
      // RELOAD-knob propagation (#05) — apply saved `forceFlatShading` to
      // every material before the tile is added to the scene so mid-session
      // streamed tiles match the user's last "Apply (reload)" choice.
      applyLayerFlags(group, 'asset');
      item.resolve({ group, byteSize: item.buffer.byteLength });
    } catch (err) {
      item.reject(err);
    }
  }

  parseRunning = false;
}

/** Fetch timeout — prevents hung requests from blocking the queue forever */
const FETCH_TIMEOUT_MS = 30_000;
/** Static layers (roads) are large files — give them a longer timeout */
const PRIORITY_FETCH_TIMEOUT_MS = 300_000; // 5 min

export async function loadTileGLB(
  url: string,
  signal: AbortSignal,
  /** Use longer timeout and prioritise in parse queue — used for static layers */
  priority = false,
  semantics: StaticSemantics | null = null,
): Promise<LoadedTile> {
  const timeoutMs = priority ? PRIORITY_FETCH_TIMEOUT_MS : FETCH_TIMEOUT_MS;
  const timeout = AbortSignal.timeout(timeoutMs);
  const fetchSignal = AbortSignal.any([signal, timeout]);

  const response = await fetch(url, { signal: fetchSignal });
  if (!response.ok) {
    throw new Error(`Tile fetch failed: HTTP ${response.status} ${url}`);
  }
  const buffer = await response.arrayBuffer();

  if (signal.aborted) throw new DOMException('Aborted', 'AbortError');

  return new Promise<LoadedTile>((resolve, reject) => {
    const item = { buffer, resolve, reject, signal, semantics };
    if (priority) {
      // Static layers jump to the front — don't wait behind 50+ tile parses
      parseQueue.unshift(item);
    } else {
      parseQueue.push(item);
    }
    drainParseQueue();
  });
}
