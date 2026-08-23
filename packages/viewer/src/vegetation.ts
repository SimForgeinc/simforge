import { Group, InstancedMesh, Matrix4, Mesh, Object3D } from 'three';
import type { VegetationInstanceFile } from './types';

export interface VegPrototypeGroup {
  name: string;
  meshes: InstancedMesh[];
  /** Instances to draw per density band, coarse index last. */
  keepPerBand: number[];
}

export interface VegetationBuildResult {
  object: Group;
  prototypes: VegPrototypeGroup[];
  instances: number;
}

const _instanceMatrix = new Matrix4();
const _protoMatrix = new Matrix4();
const _final = new Matrix4();

/**
 * Turns a vegetation prototype GLB plus its `*.instances.json` into one
 * InstancedMesh per prototype primitive.
 *
 * Matrix layout (verified against the Yale Street data, do not change without
 * re-deriving): `transforms` is 16 floats per instance in **column-major**
 * order — translation lands at offsets 12/13/14, which is exactly
 * `Matrix4.fromArray`. The scale part is tiny (median ~0.075, min 8e-4, max
 * 3.2) because it is *relative to the prototype node's own transform*, which is
 * where the quantized (KHR_mesh_quantization, +/-32767) geometry gets its real
 * size: e.g. `SM_Maple_M` sits on a node scaled 438.8. Composing
 * `instance * nodeWorld` puts bushes at 0.5-1.9 m and trees at 2-16 m against a
 * city whose buildings are ~29 m — applying either factor alone gives
 * millimetre or kilometre trees.
 */
export function buildVegetation(
  source: Object3D,
  data: VegetationInstanceFile,
  /** `lodKeepCounts` row to use for each distance band, near to far. */
  bandKeepRows: number[],
): VegetationBuildResult {
  source.updateMatrixWorld(true);
  const byName = new Map<string, Object3D>();
  source.traverse((obj) => {
    if (obj.name && !byName.has(obj.name)) byName.set(obj.name, obj);
  });

  const object = new Group();
  object.name = 'vegetation-tile';
  const prototypes: VegPrototypeGroup[] = [];
  let offset = 0;
  let instances = 0;

  for (let p = 0; p < data.prototypes.length; p++) {
    const name = data.prototypes[p] ?? '';
    const count = data.counts[p] ?? 0;
    const node = byName.get(name);
    const start = offset;
    offset += count;
    if (!node || count === 0) continue;

    const sourceMeshes: Mesh[] = [];
    node.traverse((obj) => {
      if ((obj as Mesh).isMesh) sourceMeshes.push(obj as Mesh);
    });
    if (sourceMeshes.length === 0) continue;

    const keepPerBand = bandKeepRows.map((row) =>
      Math.max(1, Math.min(count, data.lodKeepCounts?.[row]?.[p] ?? count)),
    );

    const group: VegPrototypeGroup = { name, meshes: [], keepPerBand };
    for (const sourceMesh of sourceMeshes) {
      const instanced = new InstancedMesh(sourceMesh.geometry, sourceMesh.material, count);
      instanced.name = sourceMesh.name ? `${sourceMesh.name}_instanced` : `${name}_instanced`;
      instanced.castShadow = false;
      instanced.receiveShadow = false;
      for (let i = 0; i < count; i++) {
        _instanceMatrix.fromArray(data.transforms, (start + i) * 16);
        _protoMatrix.copy(sourceMesh.matrixWorld);
        _final.multiplyMatrices(_instanceMatrix, _protoMatrix);
        instanced.setMatrixAt(i, _final);
      }
      instanced.instanceMatrix.needsUpdate = true;
      instanced.computeBoundingSphere();
      instanced.computeBoundingBox();
      instanced.matrixAutoUpdate = false;
      group.meshes.push(instanced);
      object.add(instanced);
    }
    instances += count;
    prototypes.push(group);
  }

  return { object, prototypes, instances };
}
