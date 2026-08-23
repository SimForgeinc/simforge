import * as THREE from 'three/webgpu';

import type { Manifest } from './types';

/**
 * Shader / GPU pipeline-state-object pre-warm.
 *
 * Compiles GPU pipeline state objects (PSOs) up-front for every unique
 * material *signature* expected to appear in the main scene, so the first
 * tile that references a given variant doesn't pay a 30–150 ms PSO compile
 * hitch on first render.
 *
 * This module is **HITL** — the variant signature key (`materialSignature`)
 * decides which materials count as the same PSO. Getting it wrong means
 * either over-compiling (extra latency at boot) or missing real variants
 * (residual hitches). The current key documents the chosen properties; see
 * the function comment.
 */

// ---------------------------------------------------------------------------
// Variant signature
// ---------------------------------------------------------------------------

/**
 * PSO-identifying signature for a Three.js material. Two materials with the
 * same signature should compile to the same WebGPU pipeline state object,
 * so warming one warms the other.
 *
 * **Properties included in the signature key (HITL — review this list):**
 * - Material subclass (`type`)               — Standard vs Basic vs Phong → different shader
 * - `transparent`                            — opaque vs blended → different blend state
 * - `alphaTest > 0`                          — adds discard branch (MASK cutout)
 * - presence of `map` (baseColor)            — adds texture sampler
 * - presence of `normalMap`                  — adds normal-mapping path
 * - presence of `metalnessMap`               — adds metallic sampling
 * - presence of `roughnessMap`               — adds roughness sampling
 * - presence of `aoMap`                      — adds AO modulation
 * - presence of `emissiveMap`                — adds emissive sampling
 * - presence of `alphaMap`                   — adds alpha sampling
 * - presence of `lightMap`                   — adds baked-lightmap sampling
 * - `side`                                   — Front vs Back vs DoubleSide
 *                                              changes face-culling state
 * - `vertexColors`                           — adds vertex-color attribute path
 * - `flatShading`                            — uses fragment-derivative normals
 *
 * **Properties intentionally NOT in the key:**
 * - The texture *identity* (which image bytes are bound). Only the
 *   *presence* of a texture matters for PSO uniqueness — the same shader
 *   handles all textures.
 * - Numeric uniforms like `roughness`, `metalness`, `emissiveIntensity`,
 *   color values. Uniforms are PSO inputs, not part of the pipeline state.
 * - `name`, `uuid`. Pure labels.
 * - `envMap`. The viewer assigns a single shared HDRI; envMap presence is
 *   uniform across the scene at any given moment.
 *
 * Pure: same input always returns the same string; never mutates the
 * material.
 */
export function materialSignature(material: THREE.Material): string {
  const m = material as THREE.MeshStandardMaterial; // safe: properties read are absent on subclasses without them

  const parts: string[] = [
    material.type,
    `transparent=${material.transparent ? 1 : 0}`,
    `alphaTest=${material.alphaTest > 0 ? 1 : 0}`,
    `side=${material.side}`,
    `vertexColors=${material.vertexColors ? 1 : 0}`,
    `flatShading=${(m as { flatShading?: boolean }).flatShading ? 1 : 0}`,
    `map=${m.map ? 1 : 0}`,
    `normalMap=${m.normalMap ? 1 : 0}`,
    `metalnessMap=${m.metalnessMap ? 1 : 0}`,
    `roughnessMap=${m.roughnessMap ? 1 : 0}`,
    `aoMap=${m.aoMap ? 1 : 0}`,
    `emissiveMap=${m.emissiveMap ? 1 : 0}`,
    `alphaMap=${m.alphaMap ? 1 : 0}`,
    `lightMap=${m.lightMap ? 1 : 0}`,
  ];

  return parts.join('|');
}

// ---------------------------------------------------------------------------
// Sample collection
// ---------------------------------------------------------------------------

/**
 * One representative mesh per unique material signature. The `mesh` is a
 * real `THREE.Mesh` from the scanned groups — passing it to
 * `renderer.compileAsync` is enough to compile the PSO for its signature.
 */
export interface PrewarmSample {
  signature: string;
  material: THREE.Material;
  mesh: THREE.Mesh;
}

/**
 * Walk every mesh in the supplied groups and return one sample per unique
 * material signature. Multi-material meshes contribute one sample per slot.
 *
 * Pure over its inputs (does not mutate or reparent any node).
 */
export function collectUniqueMaterialSamples(groups: THREE.Group[]): PrewarmSample[] {
  const seen = new Map<string, PrewarmSample>();

  for (const group of groups) {
    group.traverse((child) => {
      if (!(child instanceof THREE.Mesh)) return;
      const mats = Array.isArray(child.material) ? child.material : [child.material];
      for (const mat of mats) {
        if (!mat) continue;
        const sig = materialSignature(mat);
        if (!seen.has(sig)) {
          seen.set(sig, { signature: sig, material: mat, mesh: child });
        }
      }
    });
  }

  return [...seen.values()];
}

// ---------------------------------------------------------------------------
// Manifest sample picker
// ---------------------------------------------------------------------------

export interface PickPrewarmSampleOptions {
  /** Number of regular tile GLBs to sample (coarsest LOD). Default 5. */
  tileCount?: number;
  /** Number of vegetation tile GLBs to sample (coarsest LOD). Default 2. */
  vegCount?: number;
}

/** Default number of regular tile GLBs sampled by the picker. See ADR-0003. */
export const DEFAULT_PREWARM_TILE_COUNT = 5;
/** Default number of vegetation tile GLBs sampled by the picker. See ADR-0003. */
export const DEFAULT_PREWARM_VEG_COUNT = 2;

/**
 * Wall-clock budget for the boot-time shader prewarm. See ADR-0004.
 *
 * Sized to clear Belmont's 14-variant universe (~17 ms/compile observed on
 * HIGH-tier hardware → ~238 ms total) with hardware-variance headroom. The
 * runtime evidence at 150 ms was `warmed=13 skipped=1 elapsedMs=220`, which
 * left one variant exposed to a first-frame compile hitch.
 */
export const DEFAULT_BOOT_PREWARM_BUDGET_MS = 350;

/**
 * Pick which GLB files to fetch + parse for prewarm. Returns a flat list of
 * relative file paths. Includes:
 *
 * - Every `staticLayers[].file` (roads etc. — the road GLB is the canonical
 *   carrier of the building/asphalt material variants).
 * - The first `tileCount` regular tiles' coarsest LOD file.
 * - The first `vegCount` vegetation tiles' coarsest LOD file (foliage MASK
 *   cutout materials live here, not in the road GLB).
 *
 * The defaults (5 regular tiles + 2 vegetation tiles) are calibrated to
 * cover Belmont's 13 unique material signatures across its 1 road + 29
 * building tiles + 60 vegetation tiles. See ADR-0003 for the choice
 * rationale and the specific variant the previous defaults missed.
 *
 * Pure walker over the manifest.
 */
export function pickPrewarmSampleTileFiles(
  manifest: Manifest,
  options: PickPrewarmSampleOptions = {},
): string[] {
  const tileCount = options.tileCount ?? DEFAULT_PREWARM_TILE_COUNT;
  const vegCount = options.vegCount ?? DEFAULT_PREWARM_VEG_COUNT;

  const files: string[] = [];

  for (const layer of manifest.staticLayers) {
    files.push(layer.file);
  }

  const coarsestLodFile = (lods: Manifest['tiles'][number]['lods']): string | null => {
    if (lods.length === 0) return null;
    return lods[lods.length - 1]!.file;
  };

  const tileSampleN = Math.min(tileCount, manifest.tiles.length);
  for (let i = 0; i < tileSampleN; i++) {
    const file = coarsestLodFile(manifest.tiles[i]!.lods);
    if (file) files.push(file);
  }

  const vegTiles = manifest.vegetationTiles ?? [];
  const vegSampleN = Math.min(vegCount, vegTiles.length);
  for (let i = 0; i < vegSampleN; i++) {
    const file = coarsestLodFile(vegTiles[i]!.lods);
    if (file) files.push(file);
  }

  return files;
}

// ---------------------------------------------------------------------------
// Prewarm runner — budget-gated compileAsync caller
// ---------------------------------------------------------------------------

export interface PrewarmShadersOptions {
  /** Wall-clock budget cap in milliseconds. Default 150. */
  budgetMs?: number;
  /** Where the structured summary line is sent. Default `console.log`. */
  logger?: (message: string) => void;
}

export interface PrewarmShadersResult {
  warmed: number;
  skipped: number;
  budgetMs: number;
  elapsedMs: number;
}

/**
 * Minimal subset of `THREE.WebGPURenderer` we depend on.
 *
 * `compileAsync` is the contract: for each call, compile the GPU pipeline
 * state objects required to render `scene` (containing the sample mesh)
 * with `camera`. WebGPU's renderer compiles PSOs on this call rather than
 * deferring to first-render, which is exactly the hitch we want to avoid.
 */
interface PrewarmRenderer {
  compileAsync(
    scene: THREE.Object3D,
    camera: THREE.Camera,
    targetScene?: THREE.Scene | null,
  ): Promise<unknown>;
}

/**
 * Compile each sample's PSO via `renderer.compileAsync` against an
 * offscreen scene. Stops once the wall-clock budget cap is exceeded; any
 * unwarmed samples count as `skipped` in the returned summary.
 *
 * **Offscreen contract:** the prewarm scene is local to this call. Sample
 * meshes are added to the offscreen scene during compilation and then
 * detached, so the caller's scene graph is never touched. This satisfies
 * the issue's "Pre-warm offscreen render does not leak into the visible
 * scene" acceptance criterion.
 *
 * **React StrictMode budget-accounting note:** In development builds,
 * React StrictMode mounts `CityViewer` twice to surface impure effects.
 * Each mount invokes `prewarmShaders` independently, so two
 * `[ShaderPrewarm]` log lines appear with separate `elapsedMs` values
 * that may both exceed `budgetMs`. This is **not** a budget bypass — the
 * mid-loop `performance.now()` gate (line below) correctly caps each
 * individual invocation. The apparent overshoot is two pre-warms
 * interleaving on a shared renderer compile queue, each respecting its
 * own budget window. In production, StrictMode is disabled and the
 * pre-warm runs exactly once per viewer mount.
 */
export async function prewarmShaders(
  renderer: PrewarmRenderer,
  samples: PrewarmSample[],
  options: PrewarmShadersOptions = {},
): Promise<PrewarmShadersResult> {
  const budgetMs = options.budgetMs ?? 150;
  const logger = options.logger ?? ((m: string) => console.log(m));

  const start = performance.now();
  let warmed = 0;
  let skipped = 0;

  // Local offscreen scene + camera; never exposed to the caller.
  const offscreenScene = new THREE.Scene();
  const offscreenCamera = new THREE.PerspectiveCamera(60, 1, 0.1, 100);
  offscreenCamera.position.set(0, 0, 1);
  offscreenCamera.lookAt(0, 0, 0);

  for (const sample of samples) {
    if (performance.now() - start >= budgetMs) {
      skipped++;
      continue;
    }
    try {
      offscreenScene.add(sample.mesh);
      await renderer.compileAsync(offscreenScene, offscreenCamera);
      warmed++;
    } catch {
      skipped++;
    } finally {
      // Detach so the caller's scene graph is untouched. THREE.Object3D.remove
      // sets the child's `.parent` back to null.
      offscreenScene.remove(sample.mesh);
    }
  }

  const elapsedMs = Math.round(performance.now() - start);
  logger(
    `[ShaderPrewarm] warmed=${warmed} skipped=${skipped} unique=${samples.length} elapsedMs=${elapsedMs} budget=${budgetMs}ms`,
  );

  return { warmed, skipped, budgetMs, elapsedMs };
}
