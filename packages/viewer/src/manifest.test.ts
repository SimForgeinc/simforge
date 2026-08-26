import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { BufferGeometry, Float32BufferAttribute, Matrix4, Mesh, MeshBasicMaterial, Object3D, Vector3 } from 'three';
import { boundsToBox3, estimateLodBytes, normalizeLods, resolveUrl } from './manifest';
import { buildVegetation } from './vegetation';
import type { CityManifest } from './types';

const manifest = JSON.parse(
  readFileSync(path.resolve(__dirname, '../../../fixtures/scene-3d-manifest.json'), 'utf8'),
) as CityManifest;

describe('manifest', () => {
  it('sorts LODs coarse-first', () => {
    const tile = manifest.tiles[0];
    expect(tile).toBeDefined();
    const lods = normalizeLods(tile!.lods);
    expect(lods[0]!.geometricError).toBeGreaterThan(lods[lods.length - 1]!.geometricError);
    expect(lods[lods.length - 1]!.geometricError).toBe(0);
  });

  it('collapses vegetation LOD0/LOD1, which ship as identical payloads', () => {
    const veg = manifest.vegetationTiles?.[0];
    expect(veg).toBeDefined();
    const raw = veg!.lods;
    expect(raw).toHaveLength(4);
    // The duplicate pair is what motivates the collapse.
    expect(raw[0]!.fileSize).toBe(raw[1]!.fileSize);
    const lods = normalizeLods(raw);
    expect(lods).toHaveLength(3);
    // The survivor is the coarser entry: same payload, larger error, so it wins
    // the selector at greater distance and is never re-fetched under LOD0's URL.
    expect(lods[lods.length - 1]!.geometricError).toBe(raw[1]!.geometricError);
  });

  it('reproduces every tile bound from origin + grid * cellSize', () => {
    const [cx, cz] = manifest.scene.cellSize as [number, number];
    const [ox, , oz] = manifest.scene.origin as [number, number, number];
    for (const tile of manifest.tiles) {
      const box = boundsToBox3(tile.bounds);
      expect(box.min.x).toBeCloseTo(ox + tile.gridX * cx, 6);
      expect(box.min.z).toBeCloseTo(oz + tile.gridZ * cz, 6);
    }
  });

  it('estimates larger GPU footprints for finer LODs', () => {
    const lods = manifest.tiles[0]!.lods;
    expect(estimateLodBytes(lods[0]!)).toBeGreaterThan(estimateLodBytes(lods[3]!));
  });

  it('resolves manifest-relative asset paths', () => {
    expect(resolveUrl('/dev-assets/yale/3d/', 'tiles/a.glb')).toBe('/dev-assets/yale/3d/tiles/a.glb');
    expect(resolveUrl('/dev-assets/yale/3d', 'tiles/a.glb')).toBe('/dev-assets/yale/3d/tiles/a.glb');
    expect(resolveUrl('/base/', 'https://cdn/a.glb')).toBe('https://cdn/a.glb');
  });
});

describe('vegetation instancing', () => {
  it('reads column-major instance matrices and composes them onto the prototype node', () => {
    // Prototype node as the veg GLBs ship them: quantized geometry scaled up by
    // the node (here 400x), with the instance matrix carrying the small factor.
    const proto = new Object3D();
    proto.name = 'SM_Maple_M_LOD0';
    const geometry = new BufferGeometry();
    geometry.setAttribute('position', new Float32BufferAttribute([0, 0, 0, 1, 0, 0, 0, 1, 0], 3));
    const mesh = new Mesh(geometry, new MeshBasicMaterial());
    mesh.name = 'SM_Maple_M_LOD0_prim';
    proto.add(mesh);
    proto.scale.setScalar(400);
    const root = new Object3D();
    root.add(proto);

    const instance = new Matrix4().makeScale(0.005, 0.005, 0.005).setPosition(10, 20, 30);
    const result = buildVegetation(
      root,
      {
        prototypes: ['SM_Maple_M_LOD0'],
        counts: [1],
        transforms: [...instance.elements],
        lodKeepCounts: [[1], [1], [1], [1]],
      },
      [0, 2, 3],
    );

    expect(result.instances).toBe(1);
    const instanced = result.prototypes[0]!.meshes[0]!;
    const composed = new Matrix4();
    instanced.getMatrixAt(0, composed);
    const position = new Vector3().setFromMatrixPosition(composed);
    // Translation lives at elements 12/13/14 — column-major, straight into
    // Matrix4.fromArray.
    expect(position.toArray()).toEqual([10, 20, 30]);
    // 400 (node) * 0.005 (instance) = 2 world units per unit of quantized mesh.
    expect(new Vector3().setFromMatrixScale(composed).x).toBeCloseTo(2, 6);
  });
});
