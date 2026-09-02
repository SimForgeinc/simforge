import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { Document, NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS, KHRMaterialsClearcoat, KHRMaterialsEmissiveStrength, KHRMaterialsIOR, KHRMaterialsSpecular, KHRTextureTransform } from '@gltf-transform/extensions';
import type { Clearcoat, EmissiveStrength, IOR, Specular, Transform as TextureTransform } from '@gltf-transform/extensions';
import { MeshoptDecoder } from 'meshoptimizer';
import sharp from 'sharp';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { gltfToTiles, runMapPipeline } from '../src/index.js';
import type { GltfTilingReport } from '../src/index.js';

const KTX_BIN_DIR = '/home/path/simforge-assets/tools/KTX-Software-4.4.2-Linux-x86_64/bin';
const temporaryRoots: string[] = [];
let sourceDir: string;
let albedoPng: Buffer;
let normalPng: Buffer;
let previousDefaultSky: string | undefined;

function quad(document: Document, buffer: ReturnType<Document['createBuffer']>, uvScale: number) {
  const position = document.createAccessor().setType('VEC3').setBuffer(buffer)
    .setArray(new Float32Array([0, 0, 0, 10, 0, 0, 10, 0, 10, 0, 0, 10]));
  const normal = document.createAccessor().setType('VEC3').setBuffer(buffer)
    .setArray(new Float32Array([0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0]));
  const uv0 = document.createAccessor().setType('VEC2').setBuffer(buffer)
    .setArray(new Float32Array([0, 0, 1, 0, 1, 1, 0, 1]));
  const uv2 = document.createAccessor().setType('VEC2').setBuffer(buffer)
    .setArray(new Float32Array([0, 0, uvScale, 0, uvScale, uvScale, 0, uvScale]));
  const indices = document.createAccessor().setType('SCALAR').setBuffer(buffer)
    .setArray(new Uint16Array([0, 1, 2, 0, 2, 3]));
  return document.createPrimitive()
    .setAttribute('POSITION', position)
    .setAttribute('NORMAL', normal)
    .setAttribute('TEXCOORD_0', uv0)
    .setAttribute('TEXCOORD_1', uv0)
    .setAttribute('TEXCOORD_2', uv2)
    .setIndices(indices);
}

async function writeSyntheticSource(directory: string): Promise<void> {
  const document = new Document();
  const buffer = document.createBuffer();
  const specularExt = document.createExtension(KHRMaterialsSpecular);
  const clearcoatExt = document.createExtension(KHRMaterialsClearcoat);
  const iorExt = document.createExtension(KHRMaterialsIOR);
  const emissiveExt = document.createExtension(KHRMaterialsEmissiveStrength);
  const transformExt = document.createExtension(KHRTextureTransform);

  const albedo = document.createTexture('albedo').setImage(albedoPng).setMimeType('image/png');
  const normalMap = document.createTexture('normal').setImage(normalPng).setMimeType('image/png');
  const occlusion = document.createTexture('occlusion').setImage(albedoPng).setMimeType('image/png');

  const facade = document.createMaterial('Facade_Brick')
    .setBaseColorTexture(albedo)
    .setNormalTexture(normalMap)
    .setOcclusionTexture(occlusion)
    .setRoughnessFactor(0.6)
    .setEmissiveFactor([0.2, 0.1, 0])
    .setExtension('KHR_materials_specular', (specularExt.createSpecular() as Specular).setSpecularFactor(0.4).setSpecularColorFactor([1, 0.5, 0.2]))
    .setExtension('KHR_materials_clearcoat', (clearcoatExt.createClearcoat() as Clearcoat).setClearcoatFactor(0.7).setClearcoatRoughnessFactor(0.3))
    .setExtension('KHR_materials_ior', (iorExt.createIOR() as IOR).setIOR(1.4))
    .setExtension('KHR_materials_emissive_strength', (emissiveExt.createEmissiveStrength() as EmissiveStrength).setEmissiveStrength(3));
  facade.getOcclusionTextureInfo()!
    .setTexCoord(2)
    .setExtension('KHR_texture_transform', transformExt.createTransform().setScale([4, 4]).setRotation(0.25));
  const asphalt = document.createMaterial('Road_Asphalt').setBaseColorTexture(albedo).setRoughnessFactor(0.9);
  const leaf = document.createMaterial('Tree_Leaf').setBaseColorFactor([0.1, 0.6, 0.1, 1]).setDoubleSided(true);

  const buildingMesh = document.createMesh('building').addPrimitive(quad(document, buffer, 4).setMaterial(facade));
  const roadMesh = document.createMesh('road').addPrimitive(quad(document, buffer, 1).setMaterial(asphalt));
  const treeMesh = document.createMesh('tree').addPrimitive(quad(document, buffer, 1).setMaterial(leaf));

  const scene = document.createScene('map');
  const district = document.createNode('District').setTranslation([500, 0, 0]);
  district.addChild(document.createNode('Building_A').setMesh(buildingMesh).setTranslation([10, 0, 10]).setExtras({ roadrunner: 'A' }));
  district.addChild(document.createNode('Road_Main').setMesh(roadMesh).setTranslation([0, -1, 0]));
  scene.addChild(district);
  scene.addChild(document.createNode('Building_B').setMesh(buildingMesh).setTranslation([250, 0, 0]));
  scene.addChild(document.createNode('Tree_01').setMesh(treeMesh).setTranslation([-50, 0, -50]));
  // A rigged prop: one joint placed at x=+700, identity inverse bind matrix,
  // fully weighted. Rest pose therefore translates the quad by +700 on x.
  const joint = document.createNode('WorkerRig_Root').setTranslation([700, 0, 0]);
  scene.addChild(joint);
  const skin = document.createSkin('WorkerRig').addJoint(joint);
  const vest = document.createMaterial('Worker_Vest').setBaseColorFactor([1, 0.5, 0, 1]);
  const worker = quad(document, buffer, 1).setMaterial(vest);
  worker.setAttribute('JOINTS_0', document.createAccessor().setType('VEC4').setBuffer(buffer).setArray(new Uint8Array(16)));
  worker.setAttribute('WEIGHTS_0', document.createAccessor().setType('VEC4').setBuffer(buffer).setArray(new Float32Array([1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0])));
  scene.addChild(document.createNode('Worker_Figure').setMesh(document.createMesh('worker').addPrimitive(worker)).setSkin(skin));

  // Orphan subtree (not in any scene), as RoadRunner/UE exports produce for
  // roads and terrain: must still be tiled.
  const orphan = document.createNode('Tile_0_0').setTranslation([0, 0, 300]);
  orphan.addChild(document.createNode('Roads_Road_Layer0').setMesh(roadMesh).setTranslation([0, -2, 0]));

  const io = new NodeIO().registerExtensions(ALL_EXTENSIONS);
  await mkdir(directory, { recursive: true });
  await writeFile(path.join(directory, 'synthetic.glb'), await io.writeBinary(document));
}

beforeAll(async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'simforge-gltf-tiling-test-'));
  temporaryRoots.push(root);
  albedoPng = await sharp({ create: { width: 16, height: 16, channels: 4, background: { r: 180, g: 60, b: 40, alpha: 255 } } }).png().toBuffer();
  normalPng = await sharp({ create: { width: 16, height: 16, channels: 4, background: { r: 128, g: 128, b: 255, alpha: 255 } } }).png().toBuffer();
  sourceDir = path.join(root, 'source');
  await writeSyntheticSource(sourceDir);
  const defaultSky = path.join(root, 'clear-day-sky.hdr');
  await writeFile(defaultSky, '#?RADIANCE\nFORMAT=32-bit_rle_rgbe\n\n-Y 1 +X 1\n');
  previousDefaultSky = process.env['SIMFORGE_DEFAULT_SKY'];
  process.env['SIMFORGE_DEFAULT_SKY'] = defaultSky;
});
afterAll(async () => {
  if (previousDefaultSky === undefined) delete process.env['SIMFORGE_DEFAULT_SKY'];
  else process.env['SIMFORGE_DEFAULT_SKY'] = previousDefaultSky;
  await Promise.all(temporaryRoots.map((root) => rm(root, { recursive: true, force: true })));
});

describe('glTF-native tiling', () => {
  it('partitions mesh nodes by world-space cell and preserves every material property verbatim', async () => {
    const workDir = await mkdtemp(path.join(os.tmpdir(), 'simforge-gltf-tiling-work-'));
    temporaryRoots.push(workDir);
    const stage = await gltfToTiles({ sourceDir, workDir, cellSize: 100 });
    const inventory = JSON.parse(await readFile(path.join(stage.outputDir, 'inventory.json'), 'utf8')) as {
      objects: Array<{ kind: string; file: string; gridX?: number; gridZ?: number; triangles: number }>;
      origin: number[];
    };
    expect(inventory.origin[0]).toBe(-100);
    expect(inventory.objects.map((row) => [row.kind, row.file, row.gridX, row.gridZ, row.triangles])).toEqual([
      ['road', 'tiles/road.glb', undefined, undefined, 4],
      ['static', 'tiles/tile_3_1.lod0.glb', 3, 1, 2],
      ['static', 'tiles/tile_6_1.lod0.glb', 6, 1, 2],
      ['static', 'tiles/tile_8_1.lod0.glb', 8, 1, 2],
      ['vegetation', 'tiles/veg_0_0.lod0.glb', 0, 0, 2],
    ]);

    const report = JSON.parse(await readFile(path.join(stage.outputDir, 'tiling-report.json'), 'utf8')) as GltfTilingReport;
    expect(report.objects).toBe(6);
    expect(report.orphanRootNodes).toEqual(['Tile_0_0']);
    expect(report.skinnedNodesBaked).toBe(1);
    expect(report.skippedNodes).toEqual([]);
    expect(report.materials.verified).toBe(report.materials.tileInstances);
    expect(report.primitives).toEqual({ source: 6, verified: 6 });
    // The facade albedo is embedded in both building tiles and the road tile.
    expect(report.images.distinct).toBe(2);
    expect(report.images.tileInstances).toBe(5);
    expect(report.images.duplicatedBytes).toBe(2 * albedoPng.byteLength + normalPng.byteLength);
    const road = await new NodeIO().registerExtensions(ALL_EXTENSIONS).read(path.join(stage.outputDir, 'tiles', 'road.glb'));
    expect(road.getRoot().listScenes()[0]!.listChildren().map((n) => [n.getName(), n.getTranslation()])).toEqual([['Road_Main', [500, -1, 0]], ['Roads_Road_Layer0', [0, -2, 300]]]);
    expect(report.textureTexcoords).toEqual({ TEXCOORD_0: 3, TEXCOORD_2: 1 });
    expect(report.materialsWithTextureTransform).toBe(1);
    expect(report.materialsWithDivergentSlotTransforms).toBe(1);
    expect(report.extensionsUsed).toEqual([
      'KHR_materials_clearcoat',
      'KHR_materials_emissive_strength',
      'KHR_materials_ior',
      'KHR_materials_specular',
      'KHR_texture_transform',
    ]);

    const io = new NodeIO().registerExtensions(ALL_EXTENSIONS);
    const tile = await io.read(path.join(stage.outputDir, 'tiles', 'tile_6_1.lod0.glb'));
    expect(tile.getRoot().getDefaultScene()).toBe(tile.getRoot().listScenes()[0]!);
    const [node] = tile.getRoot().listScenes()[0]!.listChildren();
    expect(node!.getName()).toBe('Building_A');
    expect(node!.getTranslation()).toEqual([510, 0, 10]);
    expect(node!.getExtras()).toEqual({ roadrunner: 'A' });
    const material = node!.getMesh()!.listPrimitives()[0]!.getMaterial()!;
    expect(material.getName()).toBe('Facade_Brick');
    expect(material.getExtension<Specular>('KHR_materials_specular')!.getSpecularFactor()).toBe(0.4);
    expect(material.getExtension<Specular>('KHR_materials_specular')!.getSpecularColorFactor()).toEqual([1, 0.5, 0.2]);
    expect(material.getExtension<Clearcoat>('KHR_materials_clearcoat')!.getClearcoatFactor()).toBe(0.7);
    expect(material.getExtension<IOR>('KHR_materials_ior')!.getIOR()).toBe(1.4);
    expect(material.getExtension<EmissiveStrength>('KHR_materials_emissive_strength')!.getEmissiveStrength()).toBe(3);
    const occlusionInfo = material.getOcclusionTextureInfo()!;
    expect(occlusionInfo.getTexCoord()).toBe(2);
    const transform = occlusionInfo.getExtension<TextureTransform>('KHR_texture_transform')!;
    expect(transform.getScale()).toEqual([4, 4]);
    expect(transform.getRotation()).toBe(0.25);
    expect(Buffer.from(material.getBaseColorTexture()!.getImage()!).equals(albedoPng)).toBe(true);
    expect(Buffer.from(material.getNormalTexture()!.getImage()!).equals(normalPng)).toBe(true);
    expect(node!.getMesh()!.listPrimitives()[0]!.listSemantics().sort()).toEqual(['NORMAL', 'POSITION', 'TEXCOORD_0', 'TEXCOORD_1', 'TEXCOORD_2']);
    // The tile declares only extensions it actually uses.
    expect(tile.getRoot().listExtensionsUsed().map((e) => e.extensionName).sort()).toEqual(report.extensionsUsed);

    const workerTile = await io.read(path.join(stage.outputDir, 'tiles', 'tile_8_1.lod0.glb'));
    const [workerNode] = workerTile.getRoot().listScenes()[0]!.listChildren();
    expect(workerNode!.getName()).toBe('Worker_Figure');
    expect(workerNode!.getTranslation()).toEqual([0, 0, 0]);
    const workerPrimitive = workerNode!.getMesh()!.listPrimitives()[0]!;
    expect(workerPrimitive.listSemantics().sort()).toEqual(['NORMAL', 'POSITION', 'TEXCOORD_0', 'TEXCOORD_1', 'TEXCOORD_2']);
    expect([...(workerPrimitive.getAttribute('POSITION')!.getArray() as Float32Array)]).toEqual([700, 0, 0, 710, 0, 0, 710, 0, 10, 700, 0, 10]);
    expect(workerTile.getRoot().listSkins()).toEqual([]);

    const otherWorkDir = await mkdtemp(path.join(os.tmpdir(), 'simforge-gltf-tiling-work2-'));
    temporaryRoots.push(otherWorkDir);
    const again = await gltfToTiles({ sourceDir, workDir: otherWorkDir, cellSize: 100 });
    expect(again.outputDigest).toBe(stage.outputDigest);
  }, 60_000);

  it('runs the full pipeline: KTX2 from authored PNGs, native corpus with UV2 baked away', async () => {
    const workDir = await mkdtemp(path.join(os.tmpdir(), 'simforge-gltf-pipeline-work-'));
    temporaryRoots.push(workDir);
    const result = await runMapPipeline({ sourceDir, name: 'synthetic-glb', workDir, ktxBinDir: KTX_BIN_DIR });
    expect(result.derived.map((artifact) => artifact.kind)).toEqual(['browser-optimized', 'ktx2', 'native-corpus']);
    await MeshoptDecoder.ready;
    const io = new NodeIO().registerExtensions(ALL_EXTENSIONS).registerDependencies({ 'meshopt.decoder': MeshoptDecoder });

    const browser = result.stages.browser!;
    const browserTile = await io.read(path.join(browser.outputDir, '3d', 'tiles', 'tile_6_1.lod0.glb'));
    for (const texture of browserTile.getRoot().listTextures()) expect(texture.getMimeType()).toBe('image/webp');

    const ktx2 = result.stages.ktx2!;
    const ktx2Tile = await io.read(path.join(ktx2.outputDir, '3d', 'tiles', 'tile_6_1.lod0.glb'));
    for (const texture of ktx2Tile.getRoot().listTextures()) expect(texture.getMimeType()).toBe('image/ktx2');
    // KTX2 derives from the canonical PNG bytes, never from the WebP variant.
    expect(ktx2.inputDigest).toBe(result.stages.canonical.closureDigest);

    const native = result.stages.nativeCorpus!;
    const nativeTile = await io.read(path.join(native.outputDir, '3d', 'tiles', 'tile_6_1.lod0.glb'));
    const primitive = nativeTile.getRoot().listMeshes()[0]!.listPrimitives()[0]!;
    expect(primitive.listSemantics().sort()).toEqual(['NORMAL', 'POSITION', 'TANGENT', 'TEXCOORD_0', 'TEXCOORD_1']);
    const material = primitive.getMaterial()!;
    expect(material.getExtension<Specular>('KHR_materials_specular')!.getSpecularFactor()).toBe(0.4);
    expect(material.getExtension<Clearcoat>('KHR_materials_clearcoat')!.getClearcoatFactor()).toBe(0.7);
    const occlusionInfo = material.getOcclusionTextureInfo()!;
    expect(occlusionInfo.getTexCoord()).toBe(1);
    expect(occlusionInfo.getExtension('KHR_texture_transform')).toBeNull();
    const occlusionUv = primitive.getAttribute('TEXCOORD_1')!.getArray() as Float32Array;
    // Baked: u' = 4cos(r)·u + 4sin(r)·v for the source UV2 corner (4, 4).
    const cos = Math.cos(0.25);
    const sin = Math.sin(0.25);
    const corner = [...occlusionUv].reduce<[number, number]>((best, _v, i) => (i % 2 === 0 && occlusionUv[i]! > best[0] ? [occlusionUv[i]!, occlusionUv[i + 1]!] : best), [-Infinity, 0]);
    expect(corner[0]).toBeCloseTo(4 * cos * 4 + 4 * sin * 4, 4);
    expect(corner[1]).toBeCloseTo(-4 * sin * 4 + 4 * cos * 4, 4);
  }, 180_000);
});
