import { CompressedTexture, Mesh, MeshStandardMaterial, PlaneGeometry, RGBA_S3TC_DXT1_Format, Group } from 'three';
import { afterEach, describe, expect, it } from 'vitest';

import { collectResources, disposeResources, estimateResourceBytes, resourceDirectory, sharedTextures } from './gltf';

function decoded(bytes: number): CompressedTexture {
  const texture = new CompressedTexture([{ data: new Uint8Array(bytes), width: 4, height: 4 }], 4, 4, RGBA_S3TC_DXT1_Format);
  texture.needsUpdate = true;
  return texture;
}

function cellWith(texture: CompressedTexture): Group {
  const group = new Group();
  const material = new MeshStandardMaterial({ map: texture });
  group.add(new Mesh(new PlaneGeometry(1, 1), material));
  return group;
}

afterEach(() => sharedTextures.clear());

describe('shared KTX2 texture cache', () => {
  it('decodes a URL once and hands every requester a clone that shares the source', async () => {
    let fetches = 0;
    const fetchTexture = async () => {
      fetches += 1;
      return decoded(64);
    };
    const first = await sharedTextures.acquire('images/a.ktx2', fetchTexture);
    const second = await sharedTextures.acquire('images/a.ktx2', fetchTexture);
    expect(fetches).toBe(1);
    expect(first).not.toBe(second);
    expect(first.source).toBe(second.source);
    expect(sharedTextures.stats()).toMatchObject({ textures: 1, refs: 2, bytes: 64, hits: 1, misses: 1 });
  });

  it('keeps the decoded texture until the last cell holding it is disposed', async () => {
    const original = decoded(64);
    let disposed = 0;
    original.addEventListener('dispose', () => { disposed += 1; });
    const fetchTexture = async () => original;
    const cellA = cellWith(await sharedTextures.acquire('images/a.ktx2', fetchTexture));
    const cellB = cellWith(await sharedTextures.acquire('images/a.ktx2', fetchTexture));
    const resourcesA = collectResources(cellA);
    const resourcesB = collectResources(cellB);
    // Fair share while both cells hold it; the full size once one is gone.
    expect(estimateResourceBytes(resourcesA)).toBe(32 + estimateResourceBytes({ geometries: resourcesA.geometries, materials: [], textures: [] }));
    disposeResources(resourcesA);
    expect(disposed).toBe(0);
    expect(sharedTextures.stats()).toMatchObject({ textures: 1, refs: 1 });
    expect(estimateResourceBytes(resourcesB)).toBe(64 + estimateResourceBytes({ geometries: resourcesB.geometries, materials: [], textures: [] }));
    disposeResources(resourcesB);
    expect(disposed).toBe(1);
    expect(sharedTextures.stats()).toMatchObject({ textures: 0, refs: 0 });
  });

  it('releases a source once per asset even when the asset holds several clones of it', async () => {
    const fetchTexture = async () => decoded(16);
    const clone = await sharedTextures.acquire('images/a.ktx2', fetchTexture);
    const transformed = clone.clone(); // KHR_texture_transform clones inside GLTFLoader
    const group = new Group();
    group.add(new Mesh(new PlaneGeometry(1, 1), new MeshStandardMaterial({ map: clone, normalMap: transformed })));
    const other = cellWith(await sharedTextures.acquire('images/a.ktx2', fetchTexture));
    disposeResources(collectResources(group));
    expect(sharedTextures.stats()).toMatchObject({ textures: 1, refs: 1 });
    disposeResources(collectResources(other));
    expect(sharedTextures.stats()).toMatchObject({ textures: 0, refs: 0 });
  });

  it('forgets a failed fetch so the next requester retries', async () => {
    await expect(sharedTextures.acquire('images/bad.ktx2', async () => { throw new Error('404'); })).rejects.toThrow('404');
    expect(sharedTextures.stats()).toMatchObject({ textures: 0, refs: 0 });
    const texture = await sharedTextures.acquire('images/bad.ktx2', async () => decoded(8));
    expect(texture.source).toBeDefined();
    expect(sharedTextures.stats()).toMatchObject({ textures: 1, refs: 1, misses: 2 });
  });
});

describe('resourceDirectory', () => {
  it('yields the directory URL GLTFLoader resolves ../../images/<sha>.ktx2 against', () => {
    expect(resourceDirectory('http://h/maps/el-camino/3d/tiles/tile_3_2.lod0.glb')).toBe('http://h/maps/el-camino/3d/tiles/');
    expect(resourceDirectory('file:///x/3d/tiles/road.glb?v=1')).toBe('file:///x/3d/tiles/');
    expect(new URL('../../images/abc.ktx2', resourceDirectory('http://h/maps/el-camino/3d/tiles/road.glb')).href).toBe('http://h/maps/el-camino/images/abc.ktx2');
  });
});
