import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Document, NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS, KHRTextureTransform, type Transform as TextureTransform } from '@gltf-transform/extensions';
import { afterAll, describe, expect, it } from 'vitest';
import { borrowTerrainLayerTextures, collectTerrainLayerDonors, terrainDonorPoolDigest, terrainLayerBase } from '../src/terrain-layer-textures.js';

const PNG_STUB = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const io = new NodeIO().registerExtensions(ALL_EXTENSIONS);
const roots: string[] = [];
afterAll(async () => {
  for (const root of roots) await rm(root, { recursive: true, force: true });
});

function quad(document: Document, material: ReturnType<Document['createMaterial']>) {
  const buffer = document.getRoot().listBuffers()[0] ?? document.createBuffer();
  const position = document.createAccessor().setType('VEC3').setBuffer(buffer).setArray(new Float32Array([0, 0, 0, 1, 0, 0, 0, 0, 1]));
  const uv = document.createAccessor().setType('VEC2').setBuffer(buffer).setArray(new Float32Array([0, 0, 100, 0, 0, 100]));
  const primitive = document.createPrimitive().setAttribute('POSITION', position).setAttribute('TEXCOORD_0', uv).setMaterial(material);
  const node = document.createNode(material.getName()).setMesh(document.createMesh().addPrimitive(primitive));
  (document.getRoot().listScenes()[0] ?? document.createScene()).addChild(node);
}

describe('terrain layer texture donors', () => {
  it('derives the base name only for terrain layer materials', () => {
    expect(terrainLayerBase('Grass1_Ground_Terrain_Ground_Layer0_10')).toBe('Grass1_Ground_Terrain_Ground');
    expect(terrainLayerBase('Grass1_Ground_Terrain_Ground_Layer0')).toBe('Grass1_Ground_Terrain_Ground');
    expect(terrainLayerBase('Concrete1_Sidewalk_Roads_Sidewalk_Layer0_3')).toBeNull();
    expect(terrainLayerBase('MI_Wall_Brick')).toBeNull();
  });

  it('gives an untextured terrain layer its textured sibling from another tile', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'simforge-terrain-donor-'));
    roots.push(root);
    const tiles = path.join(root, '3d', 'tiles');
    await mkdir(tiles, { recursive: true });

    const donorDoc = new Document();
    const albedo = donorDoc.createTexture('grass_base').setMimeType('image/png').setImage(PNG_STUB);
    const normal = donorDoc.createTexture('grass_normal').setMimeType('image/png').setImage(new Uint8Array([...PNG_STUB, 1]));
    const textured = donorDoc.createMaterial('Grass1_Ground_Terrain_Ground_Layer0_5').setBaseColorTexture(albedo).setNormalTexture(normal).setRoughnessFactor(0.8).setMetallicFactor(0);
    textured.getBaseColorTextureInfo()!.setWrapS(10497).setWrapT(10497).setExtension('KHR_texture_transform', donorDoc.createExtension(KHRTextureTransform).createTransform().setScale([0.01, 0.02]).setOffset([0.5, 0.25]));
    quad(donorDoc, textured);
    await io.write(path.join(tiles, 'veg_0_4.lod0.glb'), donorDoc);

    const targetDoc = new Document();
    const flat = targetDoc.createMaterial('Grass1_Ground_Terrain_Ground_Layer0_10').setBaseColorFactor([0.16, 0.17, 0.06, 1]);
    const otherFlat = targetDoc.createMaterial('Paint_Ground_Terrain_Ground_Layer0_2').setBaseColorFactor([0.5, 0.5, 0.5, 1]);
    const prop = targetDoc.createMaterial('MI_Bollard').setBaseColorFactor([0.2, 0.2, 0.2, 1]);
    for (const material of [flat, otherFlat, prop]) quad(targetDoc, material);
    await io.write(path.join(tiles, 'veg_11_10.lod0.glb'), targetDoc);

    const pool = await collectTerrainLayerDonors(root, []);
    expect([...pool.keys()]).toEqual(['Grass1_Ground_Terrain_Ground']);
    expect(pool.get('Grass1_Ground_Terrain_Ground')!.source).toBe(path.join(tiles, 'veg_0_4.lod0.glb'));

    const document = await io.read(path.join(tiles, 'veg_11_10.lod0.glb'));
    const report = borrowTerrainLayerTextures(document, pool);
    expect(report).toEqual({ retextured: 1, byBase: { Grass1_Ground_Terrain_Ground: 1 } });

    const materials = Object.fromEntries(document.getRoot().listMaterials().map((m) => [m.getName(), m]));
    const grass = materials['Grass1_Ground_Terrain_Ground_Layer0_10']!;
    expect(grass.getBaseColorFactor()).toEqual([1, 1, 1, 1]);
    expect(Array.from(grass.getBaseColorTexture()!.getImage()!)).toEqual(Array.from(PNG_STUB));
    expect(Array.from(grass.getNormalTexture()!.getImage()!)).toEqual([...PNG_STUB, 1]);
    expect(grass.getRoughnessFactor()).toBe(1); // no metallicRoughness texture on the donor: factors untouched
    const info = grass.getBaseColorTextureInfo()!;
    expect(info.getWrapS()).toBe(10497);
    const transform = info.getExtension<TextureTransform>('KHR_texture_transform');
    expect(transform?.getScale()).toEqual([0.01, 0.02]);
    expect(transform?.getOffset()).toEqual([0.5, 0.25]);
    // No donor for this base, and non-terrain props are never touched.
    expect(materials['Paint_Ground_Terrain_Ground_Layer0_2']!.getBaseColorTexture()).toBeNull();
    expect(materials['MI_Bollard']!.getBaseColorTexture()).toBeNull();
    // Round-trips as a valid GLB with the transform extension declared.
    const written = await io.readBinary(await io.writeBinary(document));
    expect(written.getRoot().listExtensionsUsed().map((e) => e.extensionName)).toContain('KHR_texture_transform');
  });

  it('falls back to a library directory for bases the map cannot donate itself', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'simforge-terrain-library-'));
    roots.push(root);
    const tiles = path.join(root, 'map', '3d', 'tiles');
    const library = path.join(root, 'library');
    await mkdir(tiles, { recursive: true });
    await mkdir(library, { recursive: true });

    const libraryDoc = new Document();
    const concrete = libraryDoc.createTexture('concrete').setMimeType('image/png').setImage(new Uint8Array([...PNG_STUB, 7]));
    quad(libraryDoc, libraryDoc.createMaterial('Concrete1_Ground_Terrain_Ground_Layer0_2').setBaseColorTexture(concrete));
    // The library also carries an untextured layer: library gaps never count as demand.
    quad(libraryDoc, libraryDoc.createMaterial('Dirt1_Ground_Terrain_Ground_Layer0_9').setBaseColorFactor([0.3, 0.2, 0.1, 1]));
    await io.write(path.join(library, 'other-map-tile.glb'), libraryDoc);

    const mapDoc = new Document();
    quad(mapDoc, mapDoc.createMaterial('Concrete1_Ground_Terrain_Ground_Layer0_5').setBaseColorFactor([0.46, 0.44, 0.42, 1]));
    await io.write(path.join(tiles, 'veg_0_0.lod0.glb'), mapDoc);

    const without = await collectTerrainLayerDonors(path.join(root, 'map'), []);
    expect(without.size).toBe(0);
    const pool = await collectTerrainLayerDonors(path.join(root, 'map'), [library]);
    expect([...pool.keys()]).toEqual(['Concrete1_Ground_Terrain_Ground']);
    expect(pool.get('Concrete1_Ground_Terrain_Ground')!.source).toBe(path.join(library, 'other-map-tile.glb'));
    expect(terrainDonorPoolDigest(pool)).not.toBe(terrainDonorPoolDigest(without));

    const document = await io.read(path.join(tiles, 'veg_0_0.lod0.glb'));
    expect(borrowTerrainLayerTextures(document, pool).retextured).toBe(1);
    expect(Array.from(document.getRoot().listMaterials()[0]!.getBaseColorTexture()!.getImage()!)).toEqual([...PNG_STUB, 7]);
  });
});
