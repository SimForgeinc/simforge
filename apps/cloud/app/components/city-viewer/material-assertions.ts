import * as THREE from 'three/webgpu';

/**
 * Walk every material in `group` and emit a single warning per distinct
 * material that has a `metalnessMap` bound but no `aoMap`. The pipeline
 * packs ambient occlusion into the same texture as metallic-roughness
 * (AORM) and binds it to both `occlusionTexture` and
 * `metallicRoughnessTexture`; if the dual binding regresses, a
 * `metalnessMap` ends up wired without the matching `aoMap` and surfaces
 * silently lose ambient occlusion. This catches that regression at load
 * time so a developer can see it in the browser console.
 *
 * Pure function over the loaded scene graph — no GPU side effects.
 */
export function assertAormBindings(
  group: THREE.Group,
  logger: (message: string) => void = console.warn,
): void {
  const reported = new Set<THREE.Material>();

  group.traverse((child) => {
    if (!(child instanceof THREE.Mesh)) return;
    const mats = Array.isArray(child.material) ? child.material : [child.material];
    for (const mat of mats) {
      if (!mat) continue;
      const m = mat as THREE.MeshStandardMaterial;
      if (m.metalnessMap && !m.aoMap && !reported.has(mat)) {
        reported.add(mat);
        const matName = mat.name && mat.name.length > 0 ? mat.name : null;
        const meshName = child.name && child.name.length > 0 ? child.name : null;
        const label = matName ?? meshName ?? '(unnamed material)';
        logger(
          `[TileLoader] AORM dual binding broken: material "${label}" has metalnessMap but no aoMap. ` +
            `Pipeline likely failed to bind occlusionTexture alongside metallicRoughnessTexture.`,
        );
      }
    }
  });
}
