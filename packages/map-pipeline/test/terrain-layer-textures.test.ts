import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Document, NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS, KHRTextureTransform, type Transform as TextureTransform } from '@gltf-transform/extensions';
import { afterAll, describe, expect, it } from 'vitest';
import { borrowTerrainLayerTextures, collectLibraryDonors, terrainDonorPoolDigest, terrainLayerBase } from '../src/terrain-layer-textures.js';

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

  it('gives an untextured terrain layer its textured sibling from the same master', async () => {
    const document = new Document();
    const albedo = document.createTexture('grass_base').setMimeType('image/png').setImage(PNG_STUB);
    const normal = document.createTexture('grass_normal').setMimeType('image/png').setImage(new Uint8Array([...PNG_STUB, 1]));
    const textured = document.createMaterial('Grass1_Ground_Terrain_Ground_Layer0_5').setBaseColorTexture(albedo).setNormalTexture(normal).setRoughnessFactor(0.8).setMetallicFactor(0);
    textured.getBaseColorTextureInfo()!.setWrapS(10497).setWrapT(10497).setExtension('KHR_texture_transform', document.createExtension(KHRTextureTransform).createTransform().setScale([0.01, 0.02]).setOffset([0.5, 0.25]));
    const flat = document.createMaterial('Grass1_Ground_Terrain_Ground_Layer0_10').setBaseColorFactor([0.16, 0.17, 0.06, 1]);
    const otherFlat = document.createMaterial('Paint_Ground_Terrain_Ground_Layer0_2').setBaseColorFactor([0.5, 0.5, 0.5, 1]);
    const prop = document.createMaterial('MI_Bollard').setBaseColorFactor([0.2, 0.2, 0.2, 1]);
    for (const material of [textured, flat, otherFlat, prop]) quad(document, material);

    const report = borrowTerrainLayerTextures(document);
    expect(report).toEqual({
      retextured: 1,
      byBase: { Grass1_Ground_Terrain_Ground: { donor: 'material:Grass1_Ground_Terrain_Ground_Layer0_5', materials: ['Grass1_Ground_Terrain_Ground_Layer0_10'] } },
      undonated: ['Paint_Ground_Terrain_Ground'],
    });

    expect(flat.getBaseColorFactor()).toEqual([1, 1, 1, 1]);
    expect(flat.getBaseColorTexture()).toBe(albedo);
    expect(flat.getNormalTexture()).toBe(normal);
    // No metallicRoughness texture on the donor: the factors stay authored.
    expect(flat.getRoughnessFactor()).toBe(1);
    const info = flat.getBaseColorTextureInfo()!;
    expect(info.getWrapS()).toBe(10497);
    const transform = info.getExtension<TextureTransform>('KHR_texture_transform');
    expect(transform?.getScale()).toEqual([0.01, 0.02]);
    expect(transform?.getOffset()).toEqual([0.5, 0.25]);
    // No donor for this base, and non-terrain props are never touched.
    expect(otherFlat.getBaseColorTexture()).toBeNull();
    expect(prop.getBaseColorTexture()).toBeNull();
    // Round-trips as a valid GLB with the transform extension declared.
    const written = await io.readBinary(await io.writeBinary(document));
    expect(written.getRoot().listExtensionsUsed().map((e) => e.extensionName)).toContain('KHR_texture_transform');
  });

  it('falls back to another map\'s master for bases the map cannot donate itself', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'simforge-terrain-library-'));
    roots.push(root);
    const library = path.join(root, 'library');
    await mkdir(path.join(library, 'images'), { recursive: true });
    const concreteBytes = new Uint8Array([...PNG_STUB, 7]);
    await writeFile(path.join(library, 'images', 'concrete.png'), concreteBytes);
    await writeFile(path.join(library, 'master.gltf'), JSON.stringify({
      asset: { version: '2.0' },
      images: [{ uri: 'images/concrete.png', mimeType: 'image/png' }],
      samplers: [{ wrapS: 10497, wrapT: 10497 }],
      textures: [{ source: 0, sampler: 0 }],
      materials: [
        { name: 'Concrete1_Ground_Terrain_Ground_Layer0_2', pbrMetallicRoughness: { baseColorTexture: { index: 0, extensions: { KHR_texture_transform: { scale: [0.5, 0.5] } } }, roughnessFactor: 0.7, metallicFactor: 0 } },
        // An untextured layer in the library is never a donor.
        { name: 'Dirt1_Ground_Terrain_Ground_Layer0_9', pbrMetallicRoughness: { baseColorFactor: [0.3, 0.2, 0.1, 1] } },
      ],
    }));

    const document = new Document();
    const concrete = document.createMaterial('Concrete1_Ground_Terrain_Ground_Layer0_5').setBaseColorFactor([0.46, 0.44, 0.42, 1]);
    const dirt = document.createMaterial('Dirt1_Ground_Terrain_Ground_Layer0_1').setBaseColorFactor([0.3, 0.2, 0.1, 1]);
    for (const material of [concrete, dirt]) quad(document, material);

    const bases = new Set(['Concrete1_Ground_Terrain_Ground', 'Dirt1_Ground_Terrain_Ground']);
    const without = await collectLibraryDonors(bases, []);
    expect(without.size).toBe(0);
    const pool = await collectLibraryDonors(bases, [path.join(library, 'master.gltf')]);
    expect([...pool.keys()]).toEqual(['Concrete1_Ground_Terrain_Ground']);
    expect(pool.get('Concrete1_Ground_Terrain_Ground')!.source).toBe(`${path.join(library, 'master.gltf')}#materials/0`);
    expect(terrainDonorPoolDigest(pool)).not.toBe(terrainDonorPoolDigest(without));

    const report = borrowTerrainLayerTextures(document, pool);
    expect(report.retextured).toBe(1);
    expect(report.undonated).toEqual(['Dirt1_Ground_Terrain_Ground']);
    expect(Array.from(concrete.getBaseColorTexture()!.getImage()!)).toEqual(Array.from(concreteBytes));
    expect(concrete.getRoughnessFactor()).toBe(1); // factors follow a donor only with its metallicRoughness texture
    expect(concrete.getBaseColorTextureInfo()!.getExtension<TextureTransform>('KHR_texture_transform')?.getScale()).toEqual([0.5, 0.5]);
    expect(concrete.getBaseColorTextureInfo()!.getWrapS()).toBe(10497);
    expect(dirt.getBaseColorTexture()).toBeNull();
  });
});
