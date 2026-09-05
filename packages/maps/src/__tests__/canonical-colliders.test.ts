import { expect, it } from 'vitest';
import { buildStaticColliderArtifact } from '../ingest/static-colliders.mjs';

it('retains separate world-space obstacles when the browser tier instances a shared mesh', () => {
  const master = {
    asset: { version: '2.0' }, scene: 0, scenes: [{ nodes: [0] }],
    nodes: [
      { translation: [10, 0, 20], children: [1, 2] },
      { name: 'Building_A', mesh: 0 },
      { name: 'Building_B', mesh: 0, translation: [30, 0, 0] },
    ],
    meshes: [{ primitives: [{ attributes: { POSITION: 0 } }] }],
    accessors: [{ type: 'VEC3', componentType: 5126, count: 2, min: [-2, 0, -2], max: [2, 6, 2] }],
  };
  const artifact = buildStaticColliderArtifact({
    mapId: 'shared-mesh-map', sourceManifestSha256: 'a'.repeat(64),
    manifest: { tiles: [{ id: 'instanced', lods: [{ level: 0, file: 'instanced.glb' }] }] },
    topology: { lanes: {} },
    canonicalGltf: { file: 'master.gltf', bytes: Buffer.from(JSON.stringify(master)) },
  });
  expect(artifact.colliders.map(({ obb }) => obb)).toEqual([
    { center: { x: 10, z: 20 }, lengthM: 4, widthM: 4, headingRad: 0 },
    { center: { x: 40, z: 20 }, lengthM: 4, widthM: 4, headingRad: 0 },
  ]);
});
