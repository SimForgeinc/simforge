import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { Document, NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS, KHRLightsPunctual, KHRMaterialsClearcoat, KHRMaterialsEmissiveStrength, KHRMaterialsIOR, KHRMaterialsSpecular, KHRTextureTransform } from '@gltf-transform/extensions';
import type { Clearcoat, EmissiveStrength, IOR, Light, Specular, Transform as TextureTransform } from '@gltf-transform/extensions';
import { MeshoptDecoder } from 'meshoptimizer';
import sharp from 'sharp';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { materializeRegistryPayload, runMapPipeline, sha256 } from '../src/index.js';
import { resolveKtxBinDir } from '../src/ktx2.js';

const temporaryRoots: string[] = [];
let sourceDir: string;
let albedoPng: Buffer;
let normalPng: Buffer;
let occlusionPng: Buffer;
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

/**
 * A RoadRunner/Unreal-shaped export: shared images, every material extension
 * the exports use, a per-slot texture transform on TEXCOORD_2, a light, an
 * orphan road subtree, an untextured terrain layer beside a textured one, a
 * magenta placeholder, a roughness factor above 1, and a prop placed twice.
 */
async function writeSyntheticSource(directory: string): Promise<void> {
  const document = new Document();
  const buffer = document.createBuffer();
  const specularExt = document.createExtension(KHRMaterialsSpecular);
  const clearcoatExt = document.createExtension(KHRMaterialsClearcoat);
  const iorExt = document.createExtension(KHRMaterialsIOR);
  const emissiveExt = document.createExtension(KHRMaterialsEmissiveStrength);
  const transformExt = document.createExtension(KHRTextureTransform);
  const lightsExt = document.createExtension(KHRLightsPunctual);

  const albedo = document.createTexture('albedo').setImage(albedoPng).setMimeType('image/png');
  const normalMap = document.createTexture('normal').setImage(normalPng).setMimeType('image/png');
  const occlusion = document.createTexture('occlusion').setImage(occlusionPng).setMimeType('image/png');

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
  const asphalt = document.createMaterial('Road_Asphalt').setBaseColorTexture(albedo).setRoughnessFactor(2);
  const leaf = document.createMaterial('Tree_Leaf').setBaseColorFactor([0.1, 0.6, 0.1, 1]).setMetallicFactor(1).setDoubleSided(true);
  const missing = document.createMaterial('WorldGridMaterial').setBaseColorFactor([1, 0, 1, 1]).setEmissiveFactor([1, 0, 1]);

  const buildingMesh = document.createMesh('building').addPrimitive(quad(document, buffer, 4).setMaterial(facade));
  const roadMesh = document.createMesh('road').addPrimitive(quad(document, buffer, 1).setMaterial(asphalt));
  const treeMesh = document.createMesh('tree').addPrimitive(quad(document, buffer, 1).setMaterial(leaf));
  const signMesh = document.createMesh('sign').addPrimitive(quad(document, buffer, 1).setMaterial(missing));

  const scene = document.createScene('map');
  const district = document.createNode('District').setTranslation([500, 0, 0]);
  district.addChild(document.createNode('Building_A').setMesh(buildingMesh).setTranslation([10, 0, 10]).setExtras({ roadrunner: 'A' }));
  district.addChild(document.createNode('Road_Main').setMesh(roadMesh).setTranslation([0, -1, 0]));
  scene.addChild(district);
  scene.addChild(document.createNode('Building_B').setMesh(buildingMesh).setTranslation([250, 0, 0]));
  scene.addChild(document.createNode('Tree_01').setMesh(treeMesh).setTranslation([-50, 0, -50]));
  scene.addChild(document.createNode('Sign_01').setMesh(signMesh).setTranslation([-60, 0, -50]));
  scene.addChild(document.createNode('Sign_02').setMesh(signMesh).setTranslation([-70, 0, -50]).setRotation([0, 0.7071068, 0, 0.7071068]));
  scene.addChild(document.createNode('Lamp').setTranslation([0, 8, 0]).setExtension('KHR_lights_punctual', (lightsExt.createLight() as Light).setType('spot').setIntensity(500)));
  const grassTextured = document.createMaterial('Grass1_Ground_Terrain_Ground_Layer0').setBaseColorTexture(albedo).setNormalTexture(normalMap);
  const grassFlat = document.createMaterial('Grass1_Ground_Terrain_Ground_Layer0_3').setBaseColorFactor([0.16, 0.17, 0.06, 1]);
  const terrainMesh = document.createMesh('terrain')
    .addPrimitive(quad(document, buffer, 1).setMaterial(grassTextured))
    .addPrimitive(quad(document, buffer, 1).setMaterial(grassFlat));
  scene.addChild(document.createNode('Terrain').setMesh(terrainMesh).setTranslation([0, -3, 100]));

  // Orphan subtree (not in any scene), as RoadRunner/UE exports produce for
  // roads and terrain: must render.
  const orphan = document.createNode('Tile_0_0').setTranslation([0, 0, 300]);
  orphan.addChild(document.createNode('Roads_Road_Layer0').setMesh(roadMesh).setTranslation([0, -2, 0]));

  const io = new NodeIO().registerExtensions(ALL_EXTENSIONS);
  await mkdir(directory, { recursive: true });
  await writeFile(path.join(directory, 'synthetic.glb'), await io.writeBinary(document));
}

beforeAll(async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'simforge-pipeline-test-'));
  temporaryRoots.push(root);
  albedoPng = await sharp({ create: { width: 16, height: 16, channels: 4, background: { r: 180, g: 60, b: 40, alpha: 255 } } }).png().toBuffer();
  normalPng = await sharp({ create: { width: 16, height: 16, channels: 4, background: { r: 128, g: 128, b: 255, alpha: 255 } } }).png().toBuffer();
  occlusionPng = await sharp({ create: { width: 16, height: 16, channels: 4, background: { r: 200, g: 200, b: 200, alpha: 255 } } }).png().toBuffer();
  sourceDir = path.join(root, 'source');
  await writeSyntheticSource(sourceDir);
  const defaultSky = path.join(root, 'clear-day-sky.hdr');
  await writeFile(defaultSky, '#?RADIANCE\nFORMAT=32-bit_rle_rgbe\n\n-Y 1 +X 1\n');
  previousDefaultSky = process.env['SIMFORGE_DEFAULT_SKY'];
  process.env['SIMFORGE_DEFAULT_SKY'] = defaultSky;
  resolveKtxBinDir(process.env['SIMFORGE_KTX_BIN_DIR']);
});
afterAll(async () => {
  if (previousDefaultSky === undefined) delete process.env['SIMFORGE_DEFAULT_SKY'];
  else process.env['SIMFORGE_DEFAULT_SKY'] = previousDefaultSky;
  await Promise.all(temporaryRoots.map((root) => rm(root, { recursive: true, force: true })));
});

describe('map master pipeline', () => {
  it('builds a verbatim master with external images and a web tier that shares them', async () => {
    const workDir = await mkdtemp(path.join(os.tmpdir(), 'simforge-pipeline-work-'));
    temporaryRoots.push(workDir);
    const result = await runMapPipeline({ sourceDir, name: 'synthetic-map', workDir, cellSize: 100 });
    const master = result.stages.master;
    const web = result.stages.web!;

    // Canonical = master; the web tier is the only derivative.
    expect(result.canonical.kind).toBe('canonical');
    expect(master.closure.metadata).toEqual({ master: true, viewerOnly: true });
    expect(result.derived.map((artifact) => artifact.kind)).toEqual(['web']);
    expect(result.derived[0]!.registryPath).toBe(`derived/web-${web.toolFingerprint}.json`);

    // Master content: one document, one geometry buffer, PNG + KTX2 per distinct image.
    const masterFiles = Object.keys(master.closure.members).sort();
    expect(masterFiles).toContain('master.gltf');
    expect(masterFiles).toContain('geometry.bin');
    expect(masterFiles).toContain('master-report.json');
    expect(masterFiles).toContain('env/sky.hdr');
    const albedoDigest = sha256(albedoPng);
    const normalDigest = sha256(normalPng);
    const occlusionDigest = sha256(occlusionPng);
    expect(masterFiles.filter((file) => file.startsWith('images/')).sort()).toEqual([
      `images/${albedoDigest}.ktx2`, `images/${albedoDigest}.png`,
      `images/${normalDigest}.ktx2`, `images/${normalDigest}.png`,
      `images/${occlusionDigest}.ktx2`, `images/${occlusionDigest}.png`,
    ].sort());
    expect(await readFile(path.join(master.outputDir, `images/${albedoDigest}.png`))).toEqual(albedoPng);
    expect(master.report.images.distinct).toBe(3);

    // The master keeps what the export authored.
    const io = new NodeIO().registerExtensions(ALL_EXTENSIONS);
    const document = await io.read(path.join(master.outputDir, 'master.gltf'));
    const root = document.getRoot();
    expect(root.listExtensionsUsed().map((extension) => extension.extensionName).sort()).toEqual([
      'KHR_lights_punctual', 'KHR_materials_clearcoat', 'KHR_materials_emissive_strength', 'KHR_materials_ior',
      'KHR_materials_specular', 'KHR_texture_basisu', 'KHR_texture_transform',
    ]);
    const materials = Object.fromEntries(root.listMaterials().map((material) => [material.getName(), material]));
    const facade = materials['Facade_Brick']!;
    expect(facade.getExtension<Clearcoat>('KHR_materials_clearcoat')!.getClearcoatFactor()).toBe(0.7);
    expect(facade.getExtension<Specular>('KHR_materials_specular')!.getSpecularColorFactor()).toEqual([1, 0.5, 0.2]);
    const occlusionInfo = facade.getOcclusionTextureInfo()!;
    expect(occlusionInfo.getTexCoord()).toBe(2);
    expect(occlusionInfo.getExtension<TextureTransform>('KHR_texture_transform')!.getScale()).toEqual([4, 4]);
    expect(facade.getBaseColorTextureInfo()!.getExtension('KHR_texture_transform')).toBeNull();
    // Fallback PNG in `images[].uri`, KTX2 behind KHR_texture_basisu (which the reader prefers).
    expect(facade.getBaseColorTexture()!.getURI()).toBe(`images/${albedoDigest}.ktx2`);
    const json = JSON.parse(await readFile(path.join(master.outputDir, 'master.gltf'), 'utf8')) as {
      images: Array<{ uri: string; mimeType: string }>;
      textures: Array<{ source: number; extensions?: { KHR_texture_basisu?: { source: number } } }>;
    };
    for (const texture of json.textures) {
      expect(json.images[texture.source]!.mimeType).toBe('image/png');
      expect(json.images[texture.extensions!.KHR_texture_basisu!.source]!.uri).toBe(json.images[texture.source]!.uri.replace(/\.png$/, '.ktx2'));
    }
    const nodes = Object.fromEntries(root.listNodes().map((node) => [node.getName(), node]));
    expect(nodes['Building_A']!.getExtras()).toEqual({ roadrunner: 'A' });
    expect(nodes['Lamp']!.getExtension<Light>('KHR_lights_punctual')!.getIntensity()).toBe(500);
    // Orphan roads are attached to the scene; every scene node still renders.
    expect(root.listScenes()[0]!.listChildren().map((node) => node.getName())).toContain('Tile_0_0');
    expect(master.report.scene.orphanRootsAttached).toEqual(['Tile_0_0']);
    // Export defects are fixed as JSON edits and reported.
    expect(materials['Road_Asphalt']!.getRoughnessFactor()).toBe(1);
    expect(master.report.fixes.pbrFactorClamps.clamped).toBe(1);
    expect(materials['WorldGridMaterial']!.getBaseColorFactor()).not.toEqual([1, 0, 1, 1]);
    expect(master.report.fixes.exportErrorMaterials.count).toBe(1);
    expect(materials['Grass1_Ground_Terrain_Ground_Layer0_3']!.getBaseColorTexture()).not.toBeNull();
    expect(master.report.fixes.terrainLayers.retextured).toBe(1);
    expect(materials['Tree_Leaf']!.getMetallicFactor()).toBe(0);
    expect(master.report.proof.meshNodesCompared).toBe(8);

    // Web tier: cells + manifest + semantics, KTX2 by reference to the shared images.
    const webFiles = Object.keys(web.closure.members).sort();
    expect(webFiles).toContain('3d/manifest.json');
    expect(webFiles).toContain('3d/semantics.json');
    expect(webFiles).toContain('3d/env/sky.hdr');
    expect(webFiles).toContain(`images/${albedoDigest}.ktx2`);
    expect(webFiles.some((file) => file.endsWith('.png'))).toBe(false);
    expect(web.closure.members[`images/${albedoDigest}.ktx2`]).toEqual(master.closure.members[`images/${albedoDigest}.ktx2`]);
    const manifest = JSON.parse(await readFile(path.join(web.outputDir, '3d', 'manifest.json'), 'utf8')) as {
      tiles: Array<{ id: string; lods: Array<{ file: string }> }>;
      staticLayers: Array<{ id: string; file: string }>;
    };
    expect(manifest.staticLayers.map((layer) => layer.id)).toEqual(['road']);
    expect(manifest.tiles.length).toBeGreaterThan(0);
    const webIo = new NodeIO().registerExtensions(ALL_EXTENSIONS).registerDependencies({ 'meshopt.decoder': MeshoptDecoder });
    let instancedNodes = 0;
    for (const tile of [...manifest.tiles.map((tile) => tile.lods[0]!.file), ...manifest.staticLayers.map((layer) => layer.file)]) {
      const cell = await webIo.read(path.join(web.outputDir, '3d', tile));
      const cellRoot = cell.getRoot();
      for (const texture of cellRoot.listTextures()) {
        expect(texture.getMimeType()).toBe('image/ktx2');
        expect(texture.getURI()).toMatch(/^\.\.\/\.\.\/images\/[a-f0-9]{64}\.ktx2$/);
        await stat(path.join(web.outputDir, '3d', 'tiles', texture.getURI()));
      }
      for (const node of cellRoot.listNodes()) if (node.getExtension('EXT_mesh_gpu_instancing')) instancedNodes += 1;
    }
    // Two placements of one sign collapse into one instanced node; the road
    // sheet is never instanced (its two road placements stay separate nodes).
    expect(instancedNodes).toBe(1);
    expect(web.report.instanceBatches).toBe(1);
    expect(web.report.instancedNodes).toBe(2);

    // Cached stages return the same closure without rebuilding.
    const again = await runMapPipeline({ sourceDir, name: 'synthetic-map', workDir, cellSize: 100 });
    expect(again.canonical.digest).toBe(result.canonical.digest);
    expect(again.derived[0]!.digest).toBe(result.derived[0]!.digest);

    // Registry payload: every member of both closures as a content-addressed blob.
    const payloadDir = path.join(workDir, 'payload');
    await materializeRegistryPayload(result, payloadDir);
    for (const artifact of [result.canonical, ...result.derived]) {
      for (const member of Object.values(artifact.closure.members)) {
        await stat(path.join(payloadDir, 'blobs', 'sha256', member.sha256.slice(0, 2), member.sha256));
      }
    }
    expect(JSON.parse(await readFile(path.join(payloadDir, 'closure.json'), 'utf8'))).toEqual(result.canonical.closure);
  }, 120_000);
});
