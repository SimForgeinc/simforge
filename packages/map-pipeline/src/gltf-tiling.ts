import { createHash } from 'node:crypto';
import { mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { Document, Format, NodeIO, Primitive } from '@gltf-transform/core';
import type { Accessor, Extension, Material, Mesh, Node, Property, PropertyResolver, mat4 } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import type { Transform as TextureTransform } from '@gltf-transform/extensions';
import { copyToDocument, createDefaultPropertyResolver, dedup, getBounds, listTextureInfoByMaterial } from '@gltf-transform/functions';

import { parseGlb } from '../../../tools/glb-ktx2-repack/src/glb.mjs';

import { canonicalJson, hashTree, readWholeFile, sha256, sha256Large } from './closure.js';
import type { StageResult } from './tiling.js';

/**
 * Lossless spatial tiler for glTF/GLB map sources.
 *
 * The Blender tiler (`fbx-to-tiles.py`) exists for FBX/UE exports whose
 * materials must be rebuilt from a binding plan. Routing an already-authored
 * glTF through Blender re-interprets every material (Principled BSDF
 * round-trip, converted specular, exporter-chosen UV/texture policy) and
 * re-encodes every image, which is exactly where the eight RoadRunner map
 * exports lost KHR_materials_* fidelity. This tiler never interprets
 * materials: each mesh node is copied with its full dependency graph
 * (mesh → primitives → accessors, material → textures → images, extension
 * properties) through glTF-Transform's property copier, so every texture
 * slot, UV set, texture transform, sampler, and extension factor reaches the
 * tile exactly as authored. Image bytes are copied verbatim.
 *
 * Output layout and `inventory.json` match the Blender tiler contract
 * consumed by `assembleClosure`: `tiles/road.glb`, `tiles/tile_x_z.lod0.glb`,
 * `tiles/veg_x_z.lod0.glb`.
 *
 * Every tile is re-read after writing and proven equivalent to the source:
 * per node, world transform; per primitive, mode, every vertex attribute and
 * index accessor (value hash) and the full material sampling function
 * (factors, extensions, per-slot image digest, sampler, texCoord, transform).
 * Any mismatch aborts the stage. `tiling-report.json` records the proof plus
 * per-map material/UV/transform/image-multiplicity facts for downstream QA.
 */
export const GLTF_TILER_REVISION = 3;
const GLTF_TRANSFORM_VERSION = '4.4.2';
const CLASSIFY_VEGETATION = /veg|tree|bush|grass|foliage|plant/;
const CLASSIFY_ROAD = /road|asphalt|ground|terrain|pavement|marking|lane/;
/** Marker extensions carry no properties; keep them when the source declares them. */
const MARKER_EXTENSIONS = new Set([
  'KHR_mesh_quantization',
  'KHR_texture_basisu',
  'EXT_texture_webp',
  'EXT_texture_avif',
  'EXT_meshopt_compression',
  'KHR_draco_mesh_compression',
]);

export interface GltfToTilesOptions {
  sourceDir: string;
  workDir: string;
  cellSize?: number;
}

type Kind = 'road' | 'static' | 'vegetation';
type Bounds = { min: [number, number, number]; max: [number, number, number] };

interface SourceObject {
  sourceIndex: number;
  order: number;
  node: Node;
  /** The node's mesh, or its rest-pose bake when the node is skinned. */
  mesh: Mesh;
  skinned: boolean;
  name: string;
  kind: Kind;
  bounds: Bounds;
  triangles: number;
  worldMatrix: number[];
}

interface PrimitiveSignature {
  mode: number;
  material: string | null;
  indices: string | null;
  attributes: Record<string, string>;
}

interface ObjectSignature {
  name: string;
  matrix: number[];
  primitives: PrimitiveSignature[];
}

interface TileRow {
  kind: Kind;
  file: string;
  gridX?: number;
  gridZ?: number;
  bounds: Bounds;
  triangles: number;
}

export interface GltfTilingReport {
  schema: 'simforge.gltf-tiling-report.v1';
  sources: Array<{ file: string; bytes: number; sha256: string }>;
  extensionsUsed: string[];
  skippedNodes: Array<{ source: string; node: string; reason: string }>;
  /** Skinned nodes baked at rest pose into static geometry. */
  skinnedNodesBaked: number;
  objects: number;
  tiles: number;
  materials: { source: number; tileInstances: number; verified: number };
  primitives: { source: number; verified: number };
  images: {
    source: number;
    distinct: number;
    tileInstances: number;
    tileBytes: number;
    duplicatedBytes: number;
  };
  textureTexcoords: Record<string, number>;
  vertexTexcoordAttributes: Record<string, number>;
  materialsWithTextureTransform: number;
  materialsWithDivergentSlotTransforms: number;
}

function classify(node: Node): Kind {
  const mesh = node.getMesh();
  const names = [node.getName(), ...(mesh ? mesh.listPrimitives().map((primitive) => primitive.getMaterial()?.getName() ?? '') : [])];
  const text = names.join(' ').toLowerCase();
  if (CLASSIFY_VEGETATION.test(text)) return 'vegetation';
  if (CLASSIFY_ROAD.test(text)) return 'road';
  return 'static';
}

function primitiveTriangles(primitive: Primitive): number {
  const indices = primitive.getIndices();
  const count = indices ? indices.getCount() : primitive.getAttribute('POSITION')?.getCount() ?? 0;
  switch (primitive.getMode()) {
    case Primitive.Mode.TRIANGLES:
      return Math.floor(count / 3);
    case Primitive.Mode.TRIANGLE_STRIP:
    case Primitive.Mode.TRIANGLE_FAN:
      return Math.max(0, count - 2);
    default:
      return 0;
  }
}

function boundsOf(node: Node): Bounds {
  const box = getBounds(node);
  return { min: [box.min[0], box.min[1], box.min[2]], max: [box.max[0], box.max[1], box.max[2]] };
}

function aggregateBounds(rows: Bounds[]): Bounds {
  return {
    min: [0, 1, 2].map((axis) => Math.min(...rows.map((row) => row.min[axis]!))) as Bounds['min'],
    max: [0, 1, 2].map((axis) => Math.max(...rows.map((row) => row.max[axis]!))) as Bounds['max'],
  };
}

function accessorDigest(accessor: Accessor): string {
  const array = accessor.getArray();
  const hash = createHash('sha256');
  hash.update(`${accessor.getType()}\0${accessor.getComponentType()}\0${accessor.getNormalized() ? 1 : 0}\0${accessor.getCount()}\0`);
  if (array) hash.update(Buffer.from(array.buffer, array.byteOffset, array.byteLength));
  return hash.digest('hex');
}

/**
 * Sampling-function signature of one material, computed from serialized glTF
 * JSON so that core factors and every extension property are covered without
 * per-extension code. Texture references are replaced by the image digest,
 * MIME type, sampler, and texture-level extensions so the signature is
 * independent of texture/image/sampler indices.
 */
function materialSignature(json: Record<string, unknown>, material: Record<string, unknown>, imageDigests: string[]): string {
  const textures = (json['textures'] ?? []) as Array<Record<string, unknown>>;
  const samplers = (json['samplers'] ?? []) as Array<Record<string, unknown>>;
  const describeTexture = (index: number): unknown => {
    const texture = textures[index];
    if (!texture) throw new Error(`material references missing texture ${index}`);
    const extensions = { ...((texture['extensions'] as Record<string, unknown> | undefined) ?? {}) };
    let image = typeof texture['source'] === 'number' ? (texture['source'] as number) : null;
    for (const [name, value] of Object.entries(extensions)) {
      const source = (value as Record<string, unknown> | null)?.['source'];
      if (typeof source === 'number') {
        image = source;
        extensions[name] = { ...(value as Record<string, unknown>), source: imageDigests[source] };
      }
    }
    if (image === null || imageDigests[image] === undefined) throw new Error(`texture ${index} has no resolvable image`);
    const sampler = typeof texture['sampler'] === 'number' ? samplers[texture['sampler'] as number] ?? null : null;
    return { image: imageDigests[image], sampler, extensions };
  };
  const walk = (value: unknown, key: string): unknown => {
    if (Array.isArray(value)) return value.map((entry) => walk(entry, key));
    if (value === null || typeof value !== 'object') return value;
    const record = value as Record<string, unknown>;
    const output: Record<string, unknown> = {};
    for (const [childKey, child] of Object.entries(record)) {
      if (childKey === 'index' && /Texture$/i.test(key) && typeof child === 'number') {
        output['texture'] = describeTexture(child);
      } else {
        output[childKey] = walk(child, childKey);
      }
    }
    return output;
  };
  const { name: _name, ...rest } = material;
  return sha256(canonicalJson(walk(rest, 'material')));
}

function jsonImageDigests(json: Record<string, unknown>, bin: Buffer, resources?: Record<string, Uint8Array>): string[] {
  const images = (json['images'] ?? []) as Array<Record<string, unknown>>;
  const views = (json['bufferViews'] ?? []) as Array<Record<string, number>>;
  return images.map((image, index) => {
    if (typeof image['bufferView'] === 'number') {
      const view = views[image['bufferView']]!;
      return sha256(bin.subarray(view['byteOffset'] ?? 0, (view['byteOffset'] ?? 0) + view['byteLength']!));
    }
    const uri = image['uri'];
    if (typeof uri === 'string' && resources && resources[uri]) return sha256(Buffer.from(resources[uri]));
    throw new Error(`image ${index} has neither an embedded bufferView nor a resolvable uri`);
  });
}

interface PlacedMesh {
  name: string;
  matrix: number[];
  mesh: Mesh;
}

function objectSignatures(entries: PlacedMesh[], materialDigest: (material: Material | null) => string | null): ObjectSignature[] {
  return entries.map((entry) => ({
    name: entry.name,
    matrix: entry.matrix,
    primitives: entry.mesh.listPrimitives().map((primitive) => {
      const indices = primitive.getIndices();
      const attributes: Record<string, string> = {};
      for (const semantic of [...primitive.listSemantics()].sort()) {
        attributes[semantic] = accessorDigest(primitive.getAttribute(semantic)!);
      }
      return { mode: primitive.getMode(), material: materialDigest(primitive.getMaterial()), indices: indices ? accessorDigest(indices) : null, attributes };
    }),
  }));
}

function matricesEqual(left: number[], right: number[]): boolean {
  if (left.length !== right.length) return false;
  for (let i = 0; i < left.length; i += 1) {
    const scale = Math.max(1, Math.abs(left[i]!), Math.abs(right[i]!));
    if (Math.abs(left[i]! - right[i]!) > 1e-5 * scale) return false;
  }
  return true;
}

function assertEquivalent(tileFile: string, expected: ObjectSignature[], actual: ObjectSignature[]): void {
  if (expected.length !== actual.length) throw new Error(`${tileFile}: wrote ${actual.length} nodes, expected ${expected.length}`);
  for (let i = 0; i < expected.length; i += 1) {
    const want = expected[i]!;
    const got = actual[i]!;
    const where = `${tileFile} node ${JSON.stringify(want.name)}`;
    if (want.name !== got.name) throw new Error(`${where}: name changed to ${JSON.stringify(got.name)}`);
    if (!matricesEqual(want.matrix, got.matrix)) throw new Error(`${where}: world transform changed`);
    if (want.primitives.length !== got.primitives.length) throw new Error(`${where}: primitive count ${got.primitives.length} != ${want.primitives.length}`);
    for (let p = 0; p < want.primitives.length; p += 1) {
      const a = want.primitives[p]!;
      const b = got.primitives[p]!;
      if (a.mode !== b.mode) throw new Error(`${where} primitive ${p}: mode changed`);
      if (a.indices !== b.indices) throw new Error(`${where} primitive ${p}: index data changed`);
      if (a.material !== b.material) throw new Error(`${where} primitive ${p}: material sampling function changed`);
      const semantics = Object.keys(a.attributes);
      if (semantics.length !== Object.keys(b.attributes).length) throw new Error(`${where} primitive ${p}: vertex attribute set changed`);
      for (const semantic of semantics) {
        if (a.attributes[semantic] !== b.attributes[semantic]) throw new Error(`${where} primitive ${p}: ${semantic} data changed`);
      }
    }
  }
}

interface LoadedSource {
  file: string;
  bytes: number;
  sha256: string;
  document: Document;
  /** Material → sampling-function digest, from glTF-Transform's serializer. */
  materialDigests: Map<Material, string>;
  imageCount: number;
}

async function loadSource(io: NodeIO, file: string): Promise<LoadedSource> {
  const bytes = await readWholeFile(file);
  const document = file.toLowerCase().endsWith('.glb') ? await io.readBinary(bytes) : await io.read(file);
  // Content-identical accessors, meshes, textures, and materials collapse
  // into one property each. Purely referential; no values change.
  await document.transform(dedup());
  const serialized = await io.writeJSON(document, { format: Format.GLTF, basename: 'source' });
  const json = serialized.json as unknown as Record<string, unknown>;
  const digests = jsonImageDigests(json, Buffer.alloc(0), serialized.resources);
  const materialsJson = (json['materials'] ?? []) as Array<Record<string, unknown>>;
  const materials = document.getRoot().listMaterials();
  if (materialsJson.length !== materials.length) throw new Error(`${file}: serialized ${materialsJson.length} materials for ${materials.length} document materials`);
  const materialDigests = new Map<Material, string>();
  materials.forEach((material, index) => materialDigests.set(material, materialSignature(json, materialsJson[index]!, digests)));
  return { file, bytes: bytes.byteLength, sha256: sha256Large(bytes), document, materialDigests, imageCount: document.getRoot().listTextures().length };
}

const IDENTITY_MATRIX = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1] as const;

/** Column-major 4x4 product `a * b`. */
function mat4Multiply(a: ArrayLike<number>, b: ArrayLike<number>): number[] {
  const out = new Array<number>(16);
  for (let column = 0; column < 4; column += 1) {
    for (let row = 0; row < 4; row += 1) {
      out[column * 4 + row] = a[row]! * b[column * 4]! + a[4 + row]! * b[column * 4 + 1]! + a[8 + row]! * b[column * 4 + 2]! + a[12 + row]! * b[column * 4 + 3]!;
    }
  }
  return out;
}

/**
 * Bakes a skinned mesh at its rest pose into a new static mesh in the source
 * document: POSITION/NORMAL/TANGENT are transformed by the per-vertex skin
 * matrix (joint world transform × inverse bind matrix, blended by weights),
 * JOINTS_n/WEIGHTS_n are dropped, every other attribute, the indices, the
 * material, and the mode are shared with the source primitive. Positions come
 * out in world space, so the caller places the mesh with an identity matrix.
 */
function bakeRestPose(document: Document, node: Node): Mesh {
  const skin = node.getSkin()!;
  const sourceMesh = node.getMesh()!;
  const joints = skin.listJoints();
  const inverseBind = skin.getInverseBindMatrices();
  const jointMatrices = joints.map((joint, index) => {
    const bind = new Array<number>(16) as unknown as mat4;
    if (inverseBind) inverseBind.getElement(index, bind);
    else bind.splice(0, 16, ...IDENTITY_MATRIX);
    return mat4Multiply(joint.getWorldMatrix(), bind);
  });
  const buffer = document.getRoot().listBuffers()[0] ?? document.createBuffer();
  const baked = document.createMesh(sourceMesh.getName()).setExtras(structuredClone(sourceMesh.getExtras()));
  for (const primitive of sourceMesh.listPrimitives()) {
    const position = primitive.getAttribute('POSITION');
    if (!position) throw new Error(`skinned node ${JSON.stringify(node.getName())} has a primitive without POSITION`);
    const count = position.getCount();
    const skinMatrices: number[][] = [];
    for (let v = 0; v < count; v += 1) skinMatrices.push(new Array<number>(16).fill(0));
    const jointIndex: number[] = [0, 0, 0, 0];
    const weight: number[] = [0, 0, 0, 0];
    for (let set = 0; ; set += 1) {
      const jointsAccessor = primitive.getAttribute(`JOINTS_${set}`);
      const weightsAccessor = primitive.getAttribute(`WEIGHTS_${set}`);
      if (!jointsAccessor || !weightsAccessor) break;
      for (let v = 0; v < count; v += 1) {
        jointsAccessor.getElement(v, jointIndex);
        weightsAccessor.getElement(v, weight);
        const accumulator = skinMatrices[v]!;
        for (let k = 0; k < 4; k += 1) {
          if (weight[k] === 0) continue;
          const matrix = jointMatrices[jointIndex[k]!];
          if (!matrix) throw new Error(`skinned node ${JSON.stringify(node.getName())} references joint ${jointIndex[k]} outside its skin`);
          for (let i = 0; i < 16; i += 1) accumulator[i]! += weight[k]! * matrix[i]!;
        }
      }
    }
    const transformPoints = (accessor: Accessor, isDirection: boolean): Accessor => {
      const size = accessor.getElementSize();
      const out = new Float32Array(count * size);
      const element = new Array<number>(size).fill(0);
      for (let v = 0; v < count; v += 1) {
        accessor.getElement(v, element);
        const m = skinMatrices[v]!;
        const [x, y, z] = element as [number, number, number];
        let tx = m[0]! * x + m[4]! * y + m[8]! * z;
        let ty = m[1]! * x + m[5]! * y + m[9]! * z;
        let tz = m[2]! * x + m[6]! * y + m[10]! * z;
        if (isDirection) {
          const length = Math.hypot(tx, ty, tz) || 1;
          tx /= length;
          ty /= length;
          tz /= length;
        } else {
          tx += m[12]!;
          ty += m[13]!;
          tz += m[14]!;
        }
        out[v * size] = tx;
        out[v * size + 1] = ty;
        out[v * size + 2] = tz;
        if (size === 4) out[v * size + 3] = element[3]!;
      }
      return document.createAccessor(accessor.getName()).setType(accessor.getType()).setArray(out).setBuffer(buffer);
    };
    const bakedPrimitive = document.createPrimitive().setMode(primitive.getMode()).setMaterial(primitive.getMaterial()).setIndices(primitive.getIndices()).setExtras(structuredClone(primitive.getExtras()));
    for (const semantic of primitive.listSemantics()) {
      if (/^(JOINTS|WEIGHTS)_\d+$/.test(semantic)) continue;
      const accessor = primitive.getAttribute(semantic)!;
      if (semantic === 'POSITION') bakedPrimitive.setAttribute(semantic, transformPoints(accessor, false));
      else if (semantic === 'NORMAL' || semantic === 'TANGENT') bakedPrimitive.setAttribute(semantic, transformPoints(accessor, true));
      else bakedPrimitive.setAttribute(semantic, accessor);
    }
    baked.addPrimitive(bakedPrimitive);
  }
  return baked;
}

function meshBounds(mesh: Mesh): Bounds {
  const min: [number, number, number] = [Infinity, Infinity, Infinity];
  const max: [number, number, number] = [-Infinity, -Infinity, -Infinity];
  const element = [0, 0, 0];
  for (const primitive of mesh.listPrimitives()) {
    const position = primitive.getAttribute('POSITION')!;
    for (let v = 0; v < position.getCount(); v += 1) {
      position.getElement(v, element);
      for (let axis = 0; axis < 3; axis += 1) {
        min[axis] = Math.min(min[axis]!, element[axis]!);
        max[axis] = Math.max(max[axis]!, element[axis]!);
      }
    }
  }
  return { min, max };
}

function collectObjects(source: LoadedSource, sourceIndex: number, skipped: GltfTilingReport['skippedNodes']): SourceObject[] {
  const objects: SourceObject[] = [];
  let order = 0;
  const visit = (node: Node): void => {
    order += 1;
    const sourceMesh = node.getMesh();
    if (sourceMesh !== null) {
      if (node.listExtensions().length > 0) {
        skipped.push({ source: path.basename(source.file), node: node.getName(), reason: `node extensions ${node.listExtensions().map((e) => e.extensionName).join(',')} are not tiled` });
      } else {
        // A skinned mesh (rigged prop with no animation in a static map export)
        // is baked at its rest pose into world-space static geometry.
        const skinned = node.getSkin() !== null;
        const mesh = skinned ? bakeRestPose(source.document, node) : sourceMesh;
        const worldMatrix = skinned ? [...IDENTITY_MATRIX] : [...node.getWorldMatrix()];
        objects.push({
          sourceIndex,
          order,
          node,
          mesh,
          skinned,
          name: node.getName(),
          kind: classify(node),
          bounds: skinned ? meshBounds(mesh) : boundsOf(node),
          triangles: mesh.listPrimitives().reduce((sum, primitive) => sum + primitiveTriangles(primitive), 0),
          worldMatrix,
        });
      }
    }
    for (const child of node.listChildren()) visit(child);
  };
  for (const scene of source.document.getRoot().listScenes()) for (const child of scene.listChildren()) visit(child);
  return objects;
}

function tileDocument(sources: LoadedSource[], members: SourceObject[]): Document {
  const tile = new Document();
  const resolvers = new Map<number, PropertyResolver<Property>>();
  const scene = tile.createScene('scene');
  tile.getRoot().setDefaultScene(scene);
  const declared = new Set<string>();
  for (const member of members) {
    const source = sources[member.sourceIndex]!;
    let resolve = resolvers.get(member.sourceIndex);
    if (resolve === undefined) {
      for (const extension of source.document.getRoot().listExtensionsUsed()) {
        if (declared.has(extension.extensionName)) continue;
        declared.add(extension.extensionName);
        const target = tile.createExtension(extension.constructor as new (document: Document) => Extension);
        if (extension.isRequired()) target.setRequired(true);
      }
      resolve = createDefaultPropertyResolver(tile, source.document);
      resolvers.set(member.sourceIndex, resolve);
    }
    const mesh = member.mesh;
    const copied = copyToDocument(tile, source.document, [mesh], resolve).get(mesh) as Mesh | undefined;
    if (!copied) throw new Error(`failed to copy mesh for node ${JSON.stringify(member.name)}`);
    const node = tile
      .createNode(member.name)
      .setMesh(copied)
      .setExtras(structuredClone(member.node.getExtras()))
      .setMatrix(member.worldMatrix as mat4);
    const weights = member.node.getWeights();
    if (weights.length > 0) node.setWeights(weights);
    scene.addChild(node);
  }
  // One buffer per GLB; every copied accessor is re-homed onto it.
  const buffers = tile.getRoot().listBuffers();
  const buffer = buffers[0] ?? tile.createBuffer();
  for (const accessor of tile.getRoot().listAccessors()) accessor.setBuffer(buffer);
  for (const extra of buffers.slice(1)) extra.dispose();
  for (const extension of tile.getRoot().listExtensionsUsed()) {
    if (extension.listProperties().length === 0 && !MARKER_EXTENSIONS.has(extension.extensionName)) extension.dispose();
  }
  return tile;
}

function textureFacts(objects: SourceObject[]): Pick<GltfTilingReport, 'textureTexcoords' | 'vertexTexcoordAttributes' | 'materialsWithTextureTransform' | 'materialsWithDivergentSlotTransforms'> {
  const textureTexcoords: Record<string, number> = {};
  const vertexTexcoordAttributes: Record<string, number> = {};
  let withTransform = 0;
  let divergent = 0;
  const seen = new Set<Material>();
  for (const object of objects) {
    for (const primitive of object.mesh.listPrimitives()) {
      for (const semantic of primitive.listSemantics()) {
        if (semantic.startsWith('TEXCOORD_')) vertexTexcoordAttributes[semantic] = (vertexTexcoordAttributes[semantic] ?? 0) + 1;
      }
      const material = primitive.getMaterial();
      if (material === null || seen.has(material)) continue;
      seen.add(material);
      const variants = new Set<string>();
      let transformed = false;
      for (const info of listTextureInfoByMaterial(material)) {
        const transform = info.getExtension<TextureTransform>('KHR_texture_transform');
        const texCoord = transform?.getTexCoord() ?? info.getTexCoord();
        textureTexcoords[`TEXCOORD_${texCoord}`] = (textureTexcoords[`TEXCOORD_${texCoord}`] ?? 0) + 1;
        if (transform) transformed = true;
        variants.add(`${texCoord}|${transform ? [...transform.getOffset(), transform.getRotation(), ...transform.getScale()].join(',') : 'identity'}`);
      }
      if (transformed) withTransform += 1;
      if (variants.size > 1) divergent += 1;
    }
  }
  return { textureTexcoords, vertexTexcoordAttributes, materialsWithTextureTransform: withTransform, materialsWithDivergentSlotTransforms: divergent };
}

export async function gltfToTiles(options: GltfToTilesOptions): Promise<StageResult> {
  const sourceDir = path.resolve(options.sourceDir);
  const cellSize = options.cellSize ?? 100;
  const inputDigest = await hashTree(sourceDir);
  const toolFingerprint = sha256(`gltf-to-tiles\0${GLTF_TILER_REVISION}\0gltf-transform=${GLTF_TRANSFORM_VERSION}\0cell=${cellSize}`);
  const cacheKey = sha256(`${inputDigest}\0${toolFingerprint}`);
  const outputDir = path.resolve(options.workDir, 'gltf-to-tiles', cacheKey);
  const receiptPath = path.join(outputDir, 'stage.json');
  try {
    const receipt = JSON.parse(await readFile(receiptPath, 'utf8')) as { outputDigest?: string };
    if (typeof receipt.outputDigest === 'string') {
      return { inputDigest, toolFingerprint, outputDigest: receipt.outputDigest, outputDir, cacheKey };
    }
  } catch {
    // A missing/incomplete cache entry is rebuilt below.
  }

  const files: string[] = [];
  for (const name of (await readdir(sourceDir)).sort()) {
    // Source views are often symlink farms; follow links to regular files.
    if (/\.(glb|gltf)$/i.test(name) && (await stat(path.join(sourceDir, name))).isFile()) files.push(path.join(sourceDir, name));
  }
  const io = new NodeIO().registerExtensions(ALL_EXTENSIONS);
  const sources: LoadedSource[] = [];
  for (const file of files) sources.push(await loadSource(io, file));
  if (sources.length === 0) throw new Error(`${sourceDir} contains no top-level GLB or glTF files`);

  const skippedNodes: GltfTilingReport['skippedNodes'] = [];
  const objects = sources.flatMap((source, index) => collectObjects(source, index, skippedNodes));
  if (objects.length === 0) throw new Error(`${sourceDir} contains no mesh nodes`);
  objects.sort((left, right) => left.name.localeCompare(right.name) || left.sourceIndex - right.sourceIndex || left.order - right.order);

  const categories: Record<Kind, SourceObject[]> = { road: [], static: [], vegetation: [] };
  for (const object of objects) categories[object.kind].push(object);
  if (categories.road.length === 0) {
    // Same fallback as the Blender tiler: the lowest object becomes the road layer.
    const ground = objects.reduce((best, candidate) => (candidate.bounds.min[1] < best.bounds.min[1] ? candidate : best));
    categories[ground.kind].splice(categories[ground.kind].indexOf(ground), 1);
    categories.road.push(ground);
  }
  const sceneBounds = aggregateBounds(objects.map((object) => object.bounds));
  const originX = Math.floor(sceneBounds.min[0] / cellSize) * cellSize;
  const originZ = Math.floor(sceneBounds.min[2] / cellSize) * cellSize;

  const tiles: Array<{ row: TileRow; members: SourceObject[] }> = [];
  tiles.push({
    row: { kind: 'road', file: 'tiles/road.glb', bounds: aggregateBounds(categories.road.map((o) => o.bounds)), triangles: categories.road.reduce((sum, o) => sum + o.triangles, 0) },
    members: categories.road,
  });
  for (const kind of ['static', 'vegetation'] as const) {
    const cells = new Map<string, { gridX: number; gridZ: number; members: SourceObject[] }>();
    for (const object of categories[kind]) {
      const centerX = (object.bounds.min[0] + object.bounds.max[0]) / 2;
      const centerZ = (object.bounds.min[2] + object.bounds.max[2]) / 2;
      const gridX = Math.floor((centerX - originX) / cellSize);
      const gridZ = Math.floor((centerZ - originZ) / cellSize);
      const key = `${gridX},${gridZ}`;
      let cell = cells.get(key);
      if (cell === undefined) cells.set(key, (cell = { gridX, gridZ, members: [] }));
      cell.members.push(object);
    }
    const prefix = kind === 'static' ? 'tile' : 'veg';
    for (const cell of [...cells.values()].sort((left, right) => left.gridX - right.gridX || left.gridZ - right.gridZ)) {
      tiles.push({
        row: {
          kind,
          file: `tiles/${prefix}_${cell.gridX}_${cell.gridZ}.lod0.glb`,
          gridX: cell.gridX,
          gridZ: cell.gridZ,
          bounds: aggregateBounds(cell.members.map((o) => o.bounds)),
          triangles: cell.members.reduce((sum, o) => sum + o.triangles, 0),
        },
        members: cell.members,
      });
    }
  }

  await mkdir(path.join(outputDir, 'tiles'), { recursive: true });
  const imageMultiplicity = new Map<string, { bytes: number; instances: number }>();
  let materialInstances = 0;
  let verifiedMaterials = 0;
  let verifiedPrimitives = 0;
  let tileImageInstances = 0;
  let tileImageBytes = 0;
  const sourceMaterialDigest = (sourceIndex: number) => (material: Material | null) => (material === null ? null : sources[sourceIndex]!.materialDigests.get(material) ?? null);
  for (const tile of tiles) {
    const expected = tile.members.map((member) => objectSignatures([{ name: member.name, matrix: member.worldMatrix, mesh: member.mesh }], sourceMaterialDigest(member.sourceIndex))[0]!);
    const document = tileDocument(sources, tile.members);
    const glb = Buffer.from(await io.writeBinary(document));
    await writeFile(path.join(outputDir, tile.row.file), glb);

    // Prove the written bytes against the source: re-read, re-derive every
    // signature from the tile alone, and compare.
    const { json, bin } = parseGlb(glb);
    const digests = jsonImageDigests(json, bin);
    const written = await io.readBinary(glb);
    const writtenMaterials = written.getRoot().listMaterials();
    const materialsJson = (json['materials'] ?? []) as Array<Record<string, unknown>>;
    const writtenDigest = new Map<Material, string>();
    writtenMaterials.forEach((material, index) => writtenDigest.set(material, materialSignature(json, materialsJson[index]!, digests)));
    const actual = objectSignatures(
      written.getRoot().listScenes()[0]!.listChildren().map((node) => ({ name: node.getName(), matrix: [...node.getWorldMatrix()], mesh: node.getMesh()! })),
      (material) => (material === null ? null : writtenDigest.get(material) ?? null),
    );
    assertEquivalent(tile.row.file, expected, actual);

    materialInstances += writtenMaterials.length;
    verifiedMaterials += writtenMaterials.length;
    verifiedPrimitives += actual.reduce((sum, object) => sum + object.primitives.length, 0);
    const views = (json['bufferViews'] ?? []) as Array<Record<string, number>>;
    ((json['images'] ?? []) as Array<Record<string, number>>).forEach((image, index) => {
      const bytes = views[image['bufferView']!]!['byteLength']!;
      tileImageInstances += 1;
      tileImageBytes += bytes;
      const entry = imageMultiplicity.get(digests[index]!) ?? { bytes, instances: 0 };
      entry.instances += 1;
      imageMultiplicity.set(digests[index]!, entry);
    });
  }

  const inventory = {
    schema: 'simforge.gltf-tiles.v1',
    cellSize,
    origin: [originX, sceneBounds.min[1], originZ],
    bounds: sceneBounds,
    objects: tiles.map((tile) => tile.row),
    vegetationPrototypes: [],
  };
  await writeFile(path.join(outputDir, 'inventory.json'), `${canonicalJson(inventory)}\n`);
  const distinctBytes = [...imageMultiplicity.values()].reduce((sum, entry) => sum + entry.bytes, 0);
  const report: GltfTilingReport = {
    schema: 'simforge.gltf-tiling-report.v1',
    sources: sources.map((source) => ({ file: path.basename(source.file), bytes: source.bytes, sha256: source.sha256 })),
    extensionsUsed: [...new Set(sources.flatMap((source) => source.document.getRoot().listExtensionsUsed().map((e) => e.extensionName)))].sort(),
    skippedNodes,
    skinnedNodesBaked: objects.filter((object) => object.skinned).length,
    objects: objects.length,
    tiles: tiles.length,
    materials: { source: sources.reduce((sum, source) => sum + source.materialDigests.size, 0), tileInstances: materialInstances, verified: verifiedMaterials },
    primitives: { source: objects.reduce((sum, object) => sum + object.mesh.listPrimitives().length, 0), verified: verifiedPrimitives },
    images: {
      source: sources.reduce((sum, source) => sum + source.imageCount, 0),
      distinct: imageMultiplicity.size,
      tileInstances: tileImageInstances,
      tileBytes: tileImageBytes,
      duplicatedBytes: tileImageBytes - distinctBytes,
    },
    ...textureFacts(objects),
  };
  await writeFile(path.join(outputDir, 'tiling-report.json'), `${canonicalJson(report)}\n`);

  const outputDigest = await hashTree(outputDir);
  await writeFile(receiptPath, `${JSON.stringify({ schema: 'simforge.map-pipeline-stage.v1', stage: 'gltf-to-tiles', inputDigest, toolFingerprint, outputDigest })}\n`);
  return { inputDigest, toolFingerprint, outputDigest, outputDir, cacheKey };
}
