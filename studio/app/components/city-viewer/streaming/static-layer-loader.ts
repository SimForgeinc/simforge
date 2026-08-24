/**
 * Static-layer loading helper extracted from TileManager to keep that file
 * under 1,000 lines. Called by TileManager.loadStaticLayer().
 */

import * as THREE from 'three/webgpu';
import { fetchMapAsset } from '@/app/lib/maps/frontend/map-asset-cache';
import { sanitizeGeometryAsync, downscaleTextures, applyKtx2Support } from './tile-loader';
import { applyLayerFlags, captureOriginals } from '../layer-material-applier';
import type { BudgetLedger } from './budget-ledger';
import { applyStaticSemantics, type StaticSemantics } from '../static-semantics';

export interface StaticLayerContext {
  signal: AbortSignal;
  /** Called with each progress chunk: (bytesTotal, bytesChunk). */
  onBytesTotal: (bytes: number) => void;
  onBytesChunk: (bytes: number) => void;
  onStaticProgress: ((loaded: number, total: number) => void) | null;
  /** Returns the current running totals for the progress callback. */
  getBytesLoaded: () => number;
  getBytesTotal: () => number;
  renderer: THREE.WebGPURenderer | null;
  camera: THREE.PerspectiveCamera;
  scene: THREE.Scene;
  staticContainer: THREE.Group;
  ledger: BudgetLedger | null;
  semantics: StaticSemantics | null;
  /** Called when one layer completes (success or failure). */
  onLayerComplete: () => void;
}

/**
 * Load a single static layer GLB (roads etc.), parse it, and add it to the
 * static container. Mirrors the original TileManager.loadStaticLayer() logic
 * exactly; extracted here to reduce TileManager's line count.
 */
export async function loadStaticLayer(
  url: string,
  fileSize: number,
  ctx: StaticLayerContext,
): Promise<void> {
  const t0 = performance.now();
  try {
    const response = await fetchMapAsset(url, { signal: ctx.signal });
    if (!response.ok) throw new Error(`Static layer fetch failed (${response.status}).`);
    const buffer = await response.arrayBuffer();
    const totalBytes = Number(response.headers.get('content-length')) || fileSize || buffer.byteLength;
    ctx.onBytesTotal(totalBytes);
    ctx.onBytesChunk(buffer.byteLength);
    ctx.onStaticProgress?.(ctx.getBytesLoaded(), ctx.getBytesTotal());

    const tFetch = performance.now();
    console.log(`[StaticLayer] Fetched ${url} (${(buffer.byteLength / 1024 / 1024).toFixed(1)} MB) in ${((tFetch - t0) / 1000).toFixed(1)}s`);

    if (ctx.signal.aborted) return;

    const { GLTFLoader } = await import('three/addons/loaders/GLTFLoader.js');
    const { MeshoptDecoder } = await import('three/addons/libs/meshopt_decoder.module.js');
    const staticLoader = new GLTFLoader();
    staticLoader.setMeshoptDecoder(MeshoptDecoder);
    // The road GLB may resolve to its KTX2 variant — parse needs the shared
    // Basis transcoder when the viewer enabled it.
    applyKtx2Support(staticLoader);

    const gltf = await staticLoader.parseAsync(buffer, '');
    const tParse = performance.now();
    console.log(`[StaticLayer] Parsed in ${((tParse - tFetch) / 1000).toFixed(1)}s`);

    const group = gltf.scene as THREE.Group;
    await sanitizeGeometryAsync(group);
    applyStaticSemantics(group, ctx.semantics);
    downscaleTextures(group);
    group.userData.layerKind = 'road';
    captureOriginals(group);
    applyLayerFlags(group, 'road');
    const tProcess = performance.now();
    console.log(`[StaticLayer] Sanitized + downscaled in ${((tProcess - tParse) / 1000).toFixed(1)}s`);

    group.name = 'static';
    ctx.staticContainer.add(group);
    ctx.ledger?.registerStaticAllocation(`static:${url}`, buffer.byteLength, 'static');
    ctx.onLayerComplete();

    const total = ((performance.now() - t0) / 1000).toFixed(1);
    console.log(
      `%c[StaticLayer] Added to scene — total ${total}s`,
      'color: #3fb950; font-weight: bold',
    );

    requestAnimationFrame(() => {
      console.log(
        `%c[StaticLayer] First frame rendered — ${(((performance.now() - t0) / 1000)).toFixed(1)}s after load started`,
        'color: #3fb950; font-weight: bold',
      );
    });
  } catch (err) {
    ctx.onLayerComplete();
    if (err instanceof Error && err.name === 'AbortError') return;
    console.error(`[StaticLayer] Failed to load ${url} after ${((performance.now() - t0) / 1000).toFixed(1)}s:`, err);
  }
}
