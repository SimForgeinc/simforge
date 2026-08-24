import * as THREE from 'three/webgpu';
import { loadVisualConfig, type LayerKind, type LayerMultipliers } from './visual-config';

/**
 * Snapshots each `MeshStandardMaterial`'s original PBR values (color,
 * roughness, metalness, normalScale, aoMapIntensity, envMapIntensity) into
 * `material.userData.originalPbr`. Idempotent — calling twice doesn't
 * double-capture; the snapshot stays at the *first* observed values.
 * The companion `applyLayerMaterials` function (issue #04) reads these
 * originals to compose multipliers without losing the glTF-shipped baseline.
 *
 * Called by `tile-loader`, `vegetation-loader`, and the road static-layer
 * loader after GLB parse, paired with the `userData.layerKind` stamp on the
 * loaded root group.
 */

export interface OriginalPbr {
  color: { r: number; g: number; b: number };
  roughness: number;
  metalness: number;
  normalScaleX: number;
  normalScaleY: number;
  aoMapIntensity: number;
  envMapIntensity: number;
}

const ORIGINAL_PBR_KEY = 'originalPbr';

function isMeshStandardLike(
  mat: THREE.Material,
): mat is THREE.MeshStandardMaterial {
  // GLBs produce MeshStandardMaterial; MeshPhysicalMaterial extends it. The
  // duck-type check covers both without forcing a hard import dependency.
  return (
    'isMeshStandardMaterial' in mat &&
    (mat as THREE.MeshStandardMaterial).isMeshStandardMaterial === true
  );
}

export function captureOriginals(root: THREE.Object3D): void {
  root.traverse((child) => {
    if (!(child instanceof THREE.Mesh)) return;
    const materials = Array.isArray(child.material) ? child.material : [child.material];
    for (const mat of materials) {
      if (!mat) continue;
      if (mat.userData[ORIGINAL_PBR_KEY]) continue;
      if (!isMeshStandardLike(mat)) continue;
      const originals: OriginalPbr = {
        color: { r: mat.color.r, g: mat.color.g, b: mat.color.b },
        roughness: mat.roughness,
        metalness: mat.metalness,
        normalScaleX: mat.normalScale?.x ?? 1,
        normalScaleY: mat.normalScale?.y ?? 1,
        aoMapIntensity: mat.aoMapIntensity ?? 1,
        envMapIntensity: mat.envMapIntensity ?? 1,
      };
      mat.userData[ORIGINAL_PBR_KEY] = originals;
    }
  });
}

export const __ORIGINAL_PBR_KEY = ORIGINAL_PBR_KEY;

export interface PerLayerMultipliers {
  asset: LayerMultipliers;
  road: LayerMultipliers;
  vegetation: LayerMultipliers;
}

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

function applyMultipliers(
  mat: THREE.MeshStandardMaterial,
  originals: OriginalPbr,
  m: LayerMultipliers,
): void {
  mat.roughness = clamp01(originals.roughness * m.roughnessMultiplier);
  mat.metalness = clamp01(originals.metalness * m.metalnessMultiplier);
  mat.color.setRGB(
    originals.color.r * m.colorTint.r,
    originals.color.g * m.colorTint.g,
    originals.color.b * m.colorTint.b,
  );
  mat.normalScale.set(
    originals.normalScaleX * m.normalScaleMultiplier,
    originals.normalScaleY * m.normalScaleMultiplier,
  );
  mat.aoMapIntensity = clamp01(originals.aoMapIntensity * m.aoMapIntensityMultiplier);
  // envMapIntensity is intentionally not clamped — three.js allows >1 to
  // boost the environment contribution beyond physical realism, useful for
  // matching art-direction reference shots.
  mat.envMapIntensity = originals.envMapIntensity * m.envMapIntensityMultiplier;
}

/**
 * Apply per-layer PBR multipliers over the captured originals. Walks every
 * mesh under `root`, finds the closest ancestor with `userData.layerKind`,
 * and composes that layer's multipliers against the original values stamped
 * on each material by `captureOriginals`.
 *
 * LIVE-only: `forceFlatShading` (RELOAD via #05) is ignored here. Vegetation
 * `density` and `castShadows` (also RELOAD) are not part of the material
 * multipliers and live on the vegetation loader / `tileManager` paths.
 *
 * Materials without captured originals are skipped — `applyLayerMaterials`
 * runs against the live scene during streaming, so freshly-spawned tile
 * groups whose `captureOriginals` pass hasn't completed yet must be a no-op,
 * not an exception.
 */
export function applyLayerMaterials(
  root: THREE.Object3D,
  perLayer: PerLayerMultipliers,
): void {
  const seenMaterials = new Set<THREE.Material>();
  const visit = (obj: THREE.Object3D, currentKind: LayerKind | null): void => {
    const tag = obj.userData?.['layerKind'];
    const kind: LayerKind | null =
      tag === 'asset' || tag === 'road' || tag === 'vegetation'
        ? tag
        : currentKind;
    if (kind && obj instanceof THREE.Mesh) {
      const mults = perLayer[kind];
      const materials = Array.isArray(obj.material) ? obj.material : [obj.material];
      for (const mat of materials) {
        if (!mat) continue;
        if (seenMaterials.has(mat)) continue;
        if (!isMeshStandardLike(mat)) continue;
        const originals = mat.userData[ORIGINAL_PBR_KEY] as OriginalPbr | undefined;
        if (!originals) continue;
        seenMaterials.add(mat);
        applyMultipliers(mat, originals, mults);
      }
    }
    for (const child of obj.children) visit(child, kind);
  };
  visit(root, null);
}

/**
 * Apply per-layer RELOAD-only material flags from `loadVisualConfig()`. Walks
 * every mesh under `root` and:
 *  - sets `material.flatShading` from `layers[kind].forceFlatShading`,
 *    bumping `material.needsUpdate` (i.e. `mat.version`) only when the value
 *    actually changes;
 *  - for `kind === 'vegetation'`, sets `mesh.castShadow` from
 *    `layers.vegetation.castShadows`.
 *
 * Called by the asset, road, and vegetation loaders right after
 * `captureOriginals` so freshly-streamed tiles inherit the user's saved RELOAD
 * config without depending on a one-shot post-load broadcast — which only
 * fires once at boot. RELOAD-gating: changing the flag in the HUD won't take
 * effect on already-loaded tiles (those need a render-target rebuild via
 * shader recompile); the user clicks "Apply (reload)" to pick up the new
 * value at the next renderer init.
 *
 * Defensive guards mirror `applyLayerMaterials`: skip non-MeshStandardMaterial-
 * like materials, dedupe via a `seen` set so an array-of-materials mesh
 * doesn't double-bump the shader version, no-op on missing materials.
 */
export function applyLayerFlags(
  root: THREE.Object3D,
  kind: LayerKind,
): void {
  const cfg = loadVisualConfig();
  const layer = cfg.layers[kind];
  const seen = new Set<THREE.Material>();
  root.traverse((obj) => {
    if (!(obj instanceof THREE.Mesh)) return;
    if (kind === 'vegetation') {
      obj.castShadow = cfg.layers.vegetation.castShadows;
    }
    const materials = Array.isArray(obj.material) ? obj.material : [obj.material];
    for (const mat of materials) {
      if (!mat) continue;
      if (seen.has(mat)) continue;
      if (!isMeshStandardLike(mat)) continue;
      seen.add(mat);
      if (mat.flatShading !== layer.forceFlatShading) {
        mat.flatShading = layer.forceFlatShading;
        // `needsUpdate` is a setter; reading it returns undefined. Setting
        // true bumps `mat.version`, which the renderer compares against the
        // PSO cache to recompile.
        mat.needsUpdate = true;
      }
    }
  });
}
