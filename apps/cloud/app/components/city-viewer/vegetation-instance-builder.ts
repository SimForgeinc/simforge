import * as THREE from "three/webgpu";

import { isHeavyTwinDetail } from "./twin-detail-mode";

/**
 * Per-tile sidecar (`*.instances.json`) shape from manifest v1.2.0.
 *
 * - `transforms` is a flat array of column-major 4×4 matrices (16 floats per
 *   instance), grouped by prototype in the same order as `prototypes`. The
 *   pipeline Morton-sorts the within-prototype run so that truncating to the
 *   first N entries gives a spatially uniform subset.
 * - `lodKeepCounts[lod][protoIdx]` is how many instances to draw for that
 *   prototype at that LOD; always ≤ `counts[protoIdx]`.
 */
export interface InstanceData {
  prototypes: string[];
  counts: number[];
  transforms: number[];
  lodKeepCounts: number[][];
}

/**
 * One geometry/material pair extracted from the vegetation GLB for a given
 * prototype name. A prototype may have multiple meshes (e.g. trunk + leaves);
 * each becomes its own InstancedMesh sharing the same instance transforms.
 */
export interface PrototypeMesh {
  geometry: THREE.BufferGeometry;
  material: THREE.Material | THREE.Material[];
  /**
   * Optional node-local matrix to compose with each per-instance transform.
   * Captures the local transform of the prototype's parent node in the GLB.
   */
  nodeMatrix?: THREE.Matrix4;
  /** Original mesh name from the GLB; used for InstancedMesh.name. */
  name?: string;
}

const _identity = new THREE.Matrix4();
const _tempMatrix = new THREE.Matrix4();

/**
 * Build per-prototype `InstancedMesh` objects from a parsed instances sidecar.
 *
 * Contract:
 * - For every prototype `p` resolved in `prototypeMeshes`, emits one
 *   `InstancedMesh` per child mesh with capacity `instances.counts[p]` (LOD0)
 *   and `mesh.count = clamp(lodKeepCounts[lodLevel][p], 0..counts[p])`.
 * - The full LOD0 instance buffer is uploaded; varying `lodLevel` only changes
 *   `mesh.count`, so the buffer contents are identical across LOD selections.
 *   Switching LOD on a live mesh is a single integer write.
 * - Prototypes whose mesh entry is missing or empty are skipped with a warning.
 *
 * Known limitation: the pipeline thins by truncating Morton-sorted runs, which
 * leaves a faint density gradient at LOD3 (one corner of a tile keeps more
 * instances than the other). Accepted per PRD; the fix, if visual QA flags it,
 * is per-LOD `InstancedMesh` objects with stride-sampled transforms — a
 * localised change to this module.
 */
export function buildInstancedMeshes(
  instances: InstanceData,
  prototypeMeshes: Map<string, PrototypeMesh[]>,
  lodLevel: number,
): THREE.InstancedMesh[] {
  const out: THREE.InstancedMesh[] = [];
  const lodCounts = instances.lodKeepCounts[lodLevel];

  let transformOffset = 0;
  for (let pi = 0; pi < instances.prototypes.length; pi++) {
    const protoName = instances.prototypes[pi]!;
    const totalCount = instances.counts[pi]!;
    const meshes = prototypeMeshes.get(protoName);

    if (!meshes || meshes.length === 0) {
      console.warn(
        `[VegetationInstanceBuilder] no mesh found for prototype "${protoName}"`,
      );
      transformOffset += totalCount * 16;
      continue;
    }

    const requestedCount = lodCounts?.[pi] ?? totalCount;
    const drawCount = Math.max(0, Math.min(requestedCount, totalCount));

    for (const proto of meshes) {
      const im = new THREE.InstancedMesh(proto.geometry, proto.material, totalCount);
      im.name = proto.name ? `${proto.name}_instanced` : `${protoName}_instanced`;
      im.receiveShadow = true;

      const nodeMatrix = proto.nodeMatrix;
      const hasNode = nodeMatrix != null && !nodeMatrix.equals(_identity);

      for (let i = 0; i < totalCount; i++) {
        _tempMatrix.fromArray(instances.transforms, transformOffset + i * 16);
        if (hasNode) _tempMatrix.multiply(nodeMatrix!);
        im.setMatrixAt(i, _tempMatrix);
      }
      im.instanceMatrix.needsUpdate = true;
      im.count = drawCount;

      // Cull vegetation against the frustum. This was previously disabled, so
      // every vegetation mesh in the map was submitted every frame regardless
      // of where the camera looked — and vegetation is ~99% of the scene's
      // triangles, so it dominated the frame no matter the view.
      //
      // Bounds must be computed here rather than left to three's lazy path:
      // `computeBoundingSphere` unions the geometry sphere over the first
      // `count` instance matrices, so it has to run after the matrices are
      // uploaded, and it caches. The matrices never change afterwards, and a
      // later `count` reduction (LOD or the density slider) only makes the
      // cached sphere conservative, which is safe — it can over-draw, never
      // wrongly cull.
      // `heavy` mode restores the previous behaviour, where vegetation was
      // never culled and the whole map's plants were submitted every frame.
      im.frustumCulled = !isHeavyTwinDetail();
      if (im.frustumCulled) im.computeBoundingSphere();

      out.push(im);
    }

    transformOffset += totalCount * 16;
  }

  return out;
}
