import { mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { Format, NodeIO } from '@gltf-transform/core';
import type { Document, Material, Node } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import { dedup } from '@gltf-transform/functions';
import sharp from 'sharp';
import { readWholeFile, sha256, sha256Large } from './closure.js';
import { neutralizeExportErrorMaterials } from './export-error-materials.js';
import type { ExportErrorMaterialReport } from './export-error-materials.js';
import { assertSignaturesEquivalent, jsonImageDigests, materialSignature, sceneNodeSignatures } from './identity.js';
import type { NodeSignature } from './identity.js';
import { classifyImages, encodeConcurrency, encodeKtx2, ktx2ToolFingerprint, mapConcurrent } from './ktx2.js';
import type { ImageClass, Ktx2Options } from './ktx2.js';
import { clampPbrFactors } from './material-ranges.js';
import type { MaterialRangeReport } from './material-ranges.js';
import { borrowTerrainLayerTextures, collectLibraryDonors, terrainDonorLibrary, terrainDonorPoolDigest, terrainLayerBase } from './terrain-layer-textures.js';
import type { TerrainLayerReport } from './terrain-layer-textures.js';

/**
 * The map master: one glTF per map that keeps everything the export authored.
 *
 * The source GLB (RoadRunner via Unreal's glTF exporter) is re-containered,
 * not re-interpreted: the node hierarchy, lights, cameras, extras, every
 * material extension, every UV set and per-slot texture transform, and every
 * accessor byte survive. Two things change shape only:
 *
 * - images leave the buffer and become `images/<sha256>.png` (the authored
 *   bytes, one file per distinct image) with a `KHR_texture_basisu` sibling
 *   `images/<sha256>.ktx2` (UASTC) in the fallback form, so a stock loader
 *   reads the PNG and the renderers read the GPU encoding;
 * - nodes the export left outside every scene are attached to the scene
 *   (glTF says they are not rendered; the export's intent is unambiguous).
 *
 * Export defects that would otherwise render as errors are corrected as
 * JSON-level material edits and listed in `master-report.json`: magenta
 * "missing material" placeholders, PBR factors outside [0, 1], untextured
 * terrain layers, and metallic foliage. Nothing else differs from the source,
 * and the builder proves it: every mesh node's world transform, vertex and
 * index data, and material sampling function (modulo the listed fixes) is
 * re-derived from the written files and compared with the source.
 */
export const MASTER_BUILDER_REVISION = 1;
export const GLTF_TRANSFORM_VERSION = '4.4.2';

const CLASSIFY_VEGETATION = /veg|tree|bush|grass|foliage|plant/;
const RASTER_MIME = new Map([
  ['image/png', 'png'],
  ['image/jpeg', 'jpg'],
  ['image/webp', 'webp'],
]);

export interface BuildMasterOptions {
  sourceDir: string;
  /** Explicit manifest-selected source; otherwise exactly one top-level GLB/glTF is required. */
  sourcePath?: string;
  outputDir: string;
  ktx2?: Ktx2Options;
  /** `master.gltf` files of other maps consulted for terrain donors. */
  donorLibrary?: readonly string[];
}

export interface MasterImageStats {
  distinct: number;
  pngBytes: number;
  ktx2Bytes: number;
  encoded: number;
  cached: number;
  dilated: number;
  byClass: Record<ImageClass, number>;
  /** Longest edge histogram of the distinct images. */
  byLongestEdge: Record<string, number>;
}

export interface MasterReport {
  schema: 'simforge.map-master-report.v1';
  sources: Array<{ file: string; bytes: number; sha256: string }>;
  extensionsUsed: string[];
  scene: { nodes: number; meshNodes: number; meshes: number; primitives: number; materials: number; textures: number; lights: number; cameras: number; skins: number; orphanRootsAttached: string[] };
  fixes: {
    exportErrorMaterials: ExportErrorMaterialReport;
    pbrFactorClamps: MaterialRangeReport;
    terrainLayers: TerrainLayerReport;
    vegetationMaterialsMadeDielectric: string[];
  };
  images: MasterImageStats;
  proof: { meshNodesCompared: number; materialsExemptedByFix: number };
  toolFingerprint: string;
}

export interface MasterBuildResult {
  /** In-memory master; textures carry their `images/<sha>.png` URIs. */
  document: Document;
  json: Record<string, unknown>;
  report: MasterReport;
}

export function masterToolFingerprint(ktx2: Ktx2Options = {}): string {
  return sha256(`master\0${MASTER_BUILDER_REVISION}\0gltf-transform=${GLTF_TRANSFORM_VERSION}\0${ktx2ToolFingerprint(ktx2)}`);
}

export async function resolveMasterSource(sourceDir: string, explicitPath?: string): Promise<string> {
  if (explicitPath !== undefined) {
    const selected = path.resolve(explicitPath);
    if (!/\.(glb|gltf)$/i.test(selected) || !(await stat(selected)).isFile()) throw new Error(`invalid map scene source: ${selected}`);
    return selected;
  }
  const names = (await readdir(sourceDir)).filter((name) => /\.(glb|gltf)$/i.test(name)).sort();
  const files: string[] = [];
  for (const name of names) if ((await stat(path.join(sourceDir, name))).isFile()) files.push(path.join(sourceDir, name));
  if (files.length !== 1) throw new Error(`${sourceDir} must contain exactly one top-level GLB/glTF source, found ${files.length}`);
  return files[0]!;
}

/** Nodes with no Node or Scene parent: the export left them outside every scene. */
function attachOrphanRoots(document: Document): string[] {
  const root = document.getRoot();
  const scenes = root.listScenes();
  if (scenes.length === 0) throw new Error('source declares no scene');
  const scene = scenes[0]!;
  root.setDefaultScene(scene);
  for (const extra of scenes.slice(1)) {
    for (const child of extra.listChildren()) scene.addChild(child);
    extra.dispose();
  }
  const attached: string[] = [];
  for (const node of root.listNodes()) {
    if (node.listParents().some((parent) => parent.propertyType === 'Node' || parent.propertyType === 'Scene')) continue;
    scene.addChild(node);
    attached.push(node.getName());
  }
  return attached;
}

function vegetationMaterials(document: Document): Material[] {
  const materials = new Set<Material>();
  const visit = (node: Node, inherited: boolean): void => {
    const vegetation = inherited || CLASSIFY_VEGETATION.test(node.getName().toLowerCase());
    const mesh = node.getMesh();
    if (vegetation && mesh) for (const primitive of mesh.listPrimitives()) if (primitive.getMaterial()) materials.add(primitive.getMaterial()!);
    for (const child of node.listChildren()) visit(child, vegetation);
  };
  for (const scene of document.getRoot().listScenes()) for (const child of scene.listChildren()) visit(child, false);
  return [...materials];
}

function serializedMaterialDigests(io: NodeIO, document: Document): Promise<Map<Material, string>> {
  return io.writeJSON(document, { format: Format.GLTF, basename: 'source' }).then((serialized) => {
    const json = serialized.json as unknown as Record<string, unknown>;
    const digests = jsonImageDigests(json, Buffer.alloc(0), serialized.resources);
    const materialsJson = (json['materials'] ?? []) as Array<Record<string, unknown>>;
    const materials = document.getRoot().listMaterials();
    if (materialsJson.length !== materials.length) throw new Error(`serialized ${materialsJson.length} materials for ${materials.length} document materials`);
    const out = new Map<Material, string>();
    materials.forEach((material, index) => out.set(material, materialSignature(json, materialsJson[index]!, digests)));
    return out;
  });
}

function longestEdgeBucket(width: number, height: number): string {
  return String(Math.max(width, height));
}

export async function buildMaster(options: BuildMasterOptions): Promise<MasterBuildResult> {
  const io = new NodeIO().registerExtensions(ALL_EXTENSIONS);
  const file = await resolveMasterSource(options.sourceDir, options.sourcePath);
  const bytes = await readWholeFile(file);
  const document = file.toLowerCase().endsWith('.glb') ? await io.readBinary(bytes) : await io.read(file);
  const sourceRecord = { file: path.basename(file), bytes: bytes.byteLength, sha256: sha256Large(bytes) };
  // Content-identical accessors, meshes, textures and materials collapse into
  // one property each. Purely referential; no values change.
  await document.transform(dedup());
  const orphanRootsAttached = attachOrphanRoots(document);
  const root = document.getRoot();

  // Source identity before any fix: what the renderer would sample.
  const sourceMaterialDigests = await serializedMaterialDigests(io, document);

  // JSON-level fixes for export defects.
  const exportErrors = neutralizeExportErrorMaterials(document);
  const clamps = clampPbrFactors(document);
  const donorLibrary = await collectLibraryDonors(
    new Set(root.listMaterials().flatMap((material) => (material.getBaseColorTexture() === null && terrainLayerBase(material.getName()) !== null ? [terrainLayerBase(material.getName())!] : []))),
    options.donorLibrary ?? terrainDonorLibrary(),
  );
  const terrain = borrowTerrainLayerTextures(document, donorLibrary);
  const dielectric: string[] = [];
  for (const material of vegetationMaterials(document)) {
    if (material.getMetallicFactor() === 0) continue;
    material.setMetallicFactor(0);
    dielectric.push(material.getName());
  }
  const fixedNames = new Set<string>([
    ...exportErrors.names,
    ...Object.keys(clamps.byName),
    ...dielectric,
    ...Object.values(terrain.byBase).flatMap((entry) => entry.materials),
  ]);
  // Node signatures do not depend on the fixes; materials the fixes touched
  // are compared by name only, everything else by sampling function.
  const sourceSignatures = sceneNodeSignatures(document, (material) => materialProofDigest(material, fixedNames, sourceMaterialDigests));

  // Externalize images by content digest.
  for (const texture of root.listTextures()) {
    const image = texture.getImage();
    const mime = texture.getMimeType();
    if (image === null) throw new Error(`texture ${JSON.stringify(texture.getName())} has no image data`);
    const extension = RASTER_MIME.get(mime);
    if (!extension) throw new Error(`texture ${JSON.stringify(texture.getName())} has unsupported MIME type ${mime}`);
    texture.setURI(`images/${sha256(Buffer.from(image))}.${extension}`);
  }
  const buffers = root.listBuffers();
  const buffer = buffers[0] ?? document.createBuffer();
  for (const accessor of root.listAccessors()) accessor.setBuffer(buffer);
  for (const extra of buffers.slice(1)) extra.dispose();
  buffer.setURI('geometry.bin');

  const serialized = await io.writeJSON(document, { format: Format.GLTF, basename: 'master' });
  const json = serialized.json as unknown as Record<string, unknown>;
  const imagesDir = path.join(options.outputDir, 'images');
  await mkdir(imagesDir, { recursive: true });
  await writeFile(path.join(options.outputDir, 'geometry.bin'), serialized.resources['geometry.bin']!);
  const images = (json['images'] ?? []) as Array<Record<string, unknown>>;
  let pngBytes = 0;
  const byLongestEdge: Record<string, number> = {};
  for (const image of images) {
    const uri = image['uri'] as string;
    const data = serialized.resources[uri]!;
    pngBytes += data.byteLength;
    const destination = path.join(options.outputDir, uri);
    try {
      if ((await stat(destination)).size === data.byteLength) continue;
    } catch {
      // Absent; write below.
    }
    await writeFile(destination, data);
  }

  // GPU encoding: one KTX2 per distinct image, classified by slot usage.
  const classes = classifyImages(json);
  const byClass: Record<ImageClass, number> = { color: 0, normal: 0, data: 0 };
  let encoded = 0;
  let cached = 0;
  let dilated = 0;
  let ktx2Bytes = 0;
  const ktx2Uris = await mapConcurrent(images, encodeConcurrency(), async (image, index) => {
    const uri = image['uri'] as string;
    const cls = classes.get(index)!;
    byClass[cls] += 1;
    const meta = await sharp(Buffer.from(serialized.resources[uri]!)).metadata();
    const edge = longestEdgeBucket(meta.width ?? 0, meta.height ?? 0);
    byLongestEdge[edge] = (byLongestEdge[edge] ?? 0) + 1;
    const ktx2Uri = uri.replace(/\.[a-z]+$/, '.ktx2');
    const destination = path.join(options.outputDir, ktx2Uri);
    try {
      const existing = await stat(destination);
      cached += 1;
      ktx2Bytes += existing.size;
      return ktx2Uri;
    } catch {
      // Encode below.
    }
    const result = await encodeKtx2(serialized.resources[uri]!, cls, options.ktx2);
    await writeFile(destination, result.bytes);
    encoded += 1;
    ktx2Bytes += result.bytes.byteLength;
    if (result.dilated) dilated += 1;
    return ktx2Uri;
  });

  // KHR_texture_basisu in fallback form: the PNG stays the core source.
  const pngCount = images.length;
  ktx2Uris.forEach((uri, index) => {
    images.push({ ...(typeof images[index]!['name'] === 'string' ? { name: images[index]!['name'] } : {}), mimeType: 'image/ktx2', uri });
  });
  for (const texture of (json['textures'] ?? []) as Array<Record<string, unknown>>) {
    const source = texture['source'];
    if (typeof source !== 'number') continue;
    texture['extensions'] = { ...((texture['extensions'] as Record<string, unknown> | undefined) ?? {}), KHR_texture_basisu: { source: pngCount + source } };
  }
  json['extensionsUsed'] = [...new Set([...((json['extensionsUsed'] as string[] | undefined) ?? []), 'KHR_texture_basisu'])];
  (json['asset'] as Record<string, unknown>)['generator'] = `simforge-map-pipeline master ${MASTER_BUILDER_REVISION} (glTF-Transform ${GLTF_TRANSFORM_VERSION})`;
  await writeFile(path.join(options.outputDir, 'master.gltf'), JSON.stringify(json));

  // Prove the written files against the source.
  const proof = await proveMaster(options.outputDir, sourceSignatures, fixedNames);

  let meshNodes = 0;
  let primitives = 0;
  const visit = (node: Node): void => {
    const mesh = node.getMesh();
    if (mesh) {
      meshNodes += 1;
      primitives += mesh.listPrimitives().length;
    }
    for (const child of node.listChildren()) visit(child);
  };
  for (const child of root.listScenes()[0]!.listChildren()) visit(child);
  const report: MasterReport = {
    schema: 'simforge.map-master-report.v1',
    sources: [sourceRecord],
    extensionsUsed: (json['extensionsUsed'] as string[]).slice().sort(),
    scene: {
      nodes: root.listNodes().length,
      meshNodes,
      meshes: root.listMeshes().length,
      primitives,
      materials: root.listMaterials().length,
      textures: root.listTextures().length,
      lights: (((json['extensions'] as Record<string, unknown> | undefined)?.['KHR_lights_punctual'] as { lights?: unknown[] } | undefined)?.lights ?? []).length,
      cameras: root.listCameras().length,
      skins: root.listSkins().length,
      orphanRootsAttached,
    },
    fixes: { exportErrorMaterials: exportErrors, pbrFactorClamps: clamps, terrainLayers: terrain, vegetationMaterialsMadeDielectric: dielectric },
    images: { distinct: pngCount, pngBytes, ktx2Bytes, encoded, cached, dilated, byClass, byLongestEdge },
    proof,
    toolFingerprint: sha256(`${masterToolFingerprint(options.ktx2)}\0${terrainDonorPoolDigest(donorLibrary)}`),
  };
  await writeFile(path.join(options.outputDir, 'master-report.json'), `${JSON.stringify(report, null, 2)}\n`);
  return { document, json, report };
}

/**
 * Re-derive every mesh node's signature from the written master and compare
 * with the source. Geometry comes from `geometry.bin`; images are digested
 * from disk (the PNG members, never the KTX2 encodings) without being decoded.
 */
async function proveMaster(outputDir: string, expected: NodeSignature[], fixedNames: ReadonlySet<string>): Promise<MasterReport['proof']> {
  const json = JSON.parse(await readFile(path.join(outputDir, 'master.gltf'), 'utf8')) as Record<string, unknown>;
  const images = (json['images'] ?? []) as Array<Record<string, unknown>>;
  const pngCount = images.filter((image) => image['mimeType'] !== 'image/ktx2').length;
  json['images'] = images.slice(0, pngCount);
  for (const texture of (json['textures'] ?? []) as Array<Record<string, unknown>>) {
    const extensions = texture['extensions'] as Record<string, unknown> | undefined;
    if (extensions) {
      delete extensions['KHR_texture_basisu'];
      if (Object.keys(extensions).length === 0) delete texture['extensions'];
    }
  }
  json['extensionsUsed'] = ((json['extensionsUsed'] as string[] | undefined) ?? []).filter((name) => name !== 'KHR_texture_basisu');
  const digests: string[] = [];
  const resources: Record<string, Uint8Array<ArrayBuffer>> = { 'geometry.bin': new Uint8Array(await readFile(path.join(outputDir, 'geometry.bin'))) };
  for (const image of json['images'] as Array<Record<string, unknown>>) {
    const uri = image['uri'] as string;
    digests.push(sha256(await readFile(path.join(outputDir, uri))));
    resources[uri] = new Uint8Array(0);
  }
  const io = new NodeIO().registerExtensions(ALL_EXTENSIONS);
  const document = await io.readJSON({ json: json as never, resources });
  const materialsJson = (json['materials'] ?? []) as Array<Record<string, unknown>>;
  const materials = document.getRoot().listMaterials();
  if (materialsJson.length !== materials.length) throw new Error(`master serialized ${materialsJson.length} materials for ${materials.length} document materials`);
  const digestOf = new Map<Material, string>();
  materials.forEach((material, index) => digestOf.set(material, materialSignature(json, materialsJson[index]!, digests)));
  const actual = sceneNodeSignatures(document, (material) => materialProofDigest(material, fixedNames, digestOf));
  assertSignaturesEquivalent('master.gltf', expected, actual);
  return { meshNodesCompared: actual.length, materialsExemptedByFix: fixedNames.size };
}

/** Materials a fix touched are compared by name; every other by sampling function. */
function materialProofDigest(material: Material | null, fixedNames: ReadonlySet<string>, digests: ReadonlyMap<Material, string>): string | null {
  if (material === null) return null;
  if (fixedNames.has(material.getName())) return `fixed:${material.getName()}`;
  const digest = digests.get(material);
  if (digest === undefined) throw new Error(`material ${JSON.stringify(material.getName())} has no source digest`);
  return digest;
}
