import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { Document, Format, Logger, NodeIO, PropertyType } from '@gltf-transform/core';
import type { Extension, Mesh, Node, Property, PropertyResolver, mat4 } from '@gltf-transform/core';
import { ALL_EXTENSIONS, EXTMeshoptCompression, KHRTextureBasisu } from '@gltf-transform/extensions';
import type { InstancedMesh } from '@gltf-transform/extensions';
import { cloneDocument, copyToDocument, createDefaultPropertyResolver, getBounds, instance, prune, quantize, reorder } from '@gltf-transform/functions';
import { MeshoptEncoder } from 'meshoptimizer';

import { canonicalJson, sha256 } from './closure.js';

/**
 * The web streaming tier: 100 m cells derived from the in-memory master for
 * the three.js viewer. Every texture is the master's KTX2 by reference
 * (`../../images/<sha>.ktx2`), so a texture shared by N cells is fetched and
 * uploaded once; cells embed only their geometry.
 *
 * - `tiles/road.glb`: faithful always-loaded scene graph: roads/terrain,
 *   lights, cameras, skins, morphs, animation targets and their descendants.
 *   Positions remain float32; skeletons, bind matrices and hierarchy survive.
 * - `tiles/tile_<x>_<z>.lod0.glb`, `tiles/veg_<x>_<z>.lod0.glb`: everything
 *   else by bounds centre; repeated meshes become `EXT_mesh_gpu_instancing`
 *   batches; positions quantized to 16 bits over each mesh's own bounds
 *   (<= 5 mm on a 300 m mesh).
 *
 * The manifest keeps the `1.2.0` schema the viewer already streams.
 */
export const WEB_TIER_REVISION = 2;
export const MESHOPTIMIZER_VERSION = '1.2.0';

const CLASSIFY_VEGETATION = /veg|tree|bush|grass|foliage|plant/;
const CLASSIFY_ROAD = /road|asphalt|ground|terrain|pavement|marking|lane/;
const MARKER_EXTENSIONS = new Set(['KHR_mesh_quantization', 'KHR_texture_basisu', 'EXT_meshopt_compression']);
const INSTANCE_MIN = 2;
const POSITION_BITS = 16;

type Kind = 'road' | 'static' | 'vegetation';
type Bounds = { min: [number, number, number]; max: [number, number, number] };

interface PlacedNode {
  node: Node;
  mesh: Mesh;
  name: string;
  kind: Kind;
  bounds: Bounds;
  triangles: number;
  worldMatrix: number[];
}

interface TileRow {
  kind: Kind;
  file: string;
  gridX?: number;
  gridZ?: number;
  bounds: Bounds;
  triangles: number;
  fileSize: number;
}

export interface WebTierOptions {
  cellSize?: number;
}

export interface WebTierReport {
  schema: 'simforge.web-tier-report.v1';
  cellSize: number;
  tiles: number;
  bytes: number;
  meshNodes: number;
  instancedNodes: number;
  instanceBatches: number;
  skinnedNodesFlattened: number;
  skinnedNodesPreserved: number;
  positionBits: number;
  tilesByKind: Record<Kind, number>;
}

export function webTierToolFingerprint(cellSize: number): string {
  return sha256(`web-tier\0${WEB_TIER_REVISION}\0meshoptimizer=${MESHOPTIMIZER_VERSION}\0cell=${cellSize}`);
}

function classify(node: Node, inheritedVegetation: boolean): Kind {
  if (inheritedVegetation || CLASSIFY_VEGETATION.test(node.getName().toLowerCase())) return 'vegetation';
  const mesh = node.getMesh();
  const materials = (mesh ? mesh.listPrimitives().map((primitive) => primitive.getMaterial()?.getName() ?? '') : []).join(' ').toLowerCase();
  if (CLASSIFY_ROAD.test(`${node.getName().toLowerCase()} ${materials}`)) return 'road';
  return 'static';
}

function primitiveTriangles(mesh: Mesh): number {
  let total = 0;
  for (const primitive of mesh.listPrimitives()) {
    const indices = primitive.getIndices();
    const count = indices ? indices.getCount() : primitive.getAttribute('POSITION')?.getCount() ?? 0;
    switch (primitive.getMode()) {
      case 4:
        total += Math.floor(count / 3);
        break;
      case 5:
      case 6:
        total += Math.max(0, count - 2);
        break;
      default:
        break;
    }
  }
  return total;
}

function aggregateBounds(rows: Bounds[]): Bounds {
  return {
    min: [0, 1, 2].map((axis) => Math.min(...rows.map((row) => row.min[axis]!))) as Bounds['min'],
    max: [0, 1, 2].map((axis) => Math.max(...rows.map((row) => row.max[axis]!))) as Bounds['max'],
  };
}

function collectPlacedNodes(master: Document): { placed: PlacedNode[]; skinned: number } {
  const placed: PlacedNode[] = [];
  const visited = new Set<Node>();
  let skinned = 0;
  const visit = (node: Node, inheritedVegetation: boolean): void => {
    if (visited.has(node)) return;
    visited.add(node);
    const kind = classify(node, inheritedVegetation);
    const mesh = node.getMesh();
    if (mesh !== null) {
      if (node.getSkin() !== null) skinned += 1;
      const box = getBounds(node);
      placed.push({
        node,
        mesh,
        name: node.getName(),
        kind,
        bounds: { min: [box.min[0], box.min[1], box.min[2]], max: [box.max[0], box.max[1], box.max[2]] },
        triangles: primitiveTriangles(mesh),
        worldMatrix: [...node.getWorldMatrix()],
      });
    }
    for (const child of node.listChildren()) visit(child, kind === 'vegetation');
  };
  for (const scene of master.getRoot().listScenes()) for (const child of scene.listChildren()) visit(child, false);
  return { placed, skinned };
}

/**
 * Only independent, rigid placements may leave the authored scene graph.
 * An animated or extension-bearing ancestor can affect every descendant,
 * including nodes without their own animation channel.
 */
function coherentNodes(master: Document): Set<Node> {
  const coherent = new Set<Node>();
  const retain = (node: Node): void => {
    if (coherent.has(node)) return;
    coherent.add(node);
    for (const child of node.listChildren()) retain(child);
  };
  const scenes = master.getRoot().listScenes();
  // A streamed placement cannot express membership in alternative scenes.
  for (const scene of scenes) {
    if (scenes.length > 1 || scene.listExtensions().length) {
      for (const node of scene.listChildren()) retain(node);
    }
  }
  for (const animation of master.getRoot().listAnimations()) {
    for (const channel of animation.listChannels()) {
      const target = channel.getTargetNode();
      if (target) retain(target);
    }
  }
  for (const node of master.getRoot().listNodes()) {
    if (node.getSkin() || node.getCamera() || node.listExtensions().length
      || node.getWeights().length || node.getMesh()?.listPrimitives().some((primitive) => primitive.listTargets().length > 0)) {
      retain(node);
    }
  }
  for (const skin of master.getRoot().listSkins()) {
    for (const joint of skin.listJoints()) retain(joint);
    const skeleton = skin.getSkeleton();
    if (skeleton) retain(skeleton);
  }
  return coherent;
}

/**
 * Clone the complete graph, not just mesh dependencies. Keep even empty
 * ancestors: animation, lights and nonidentity inverse bind matrices depend
 * on their authored local transforms. Remove only the mesh attachments that
 * will be rendered once in streaming cells.
 */
async function faithfulDocument(master: Document, streamed: Set<Node>): Promise<Document> {
  const tile = cloneDocument(master).setLogger(new Logger(Logger.Verbosity.WARN));
  // cloneDocument copies Root's ordered node references through its resolver.
  const sourceNodes = master.getRoot().listNodes();
  const targetNodes = tile.getRoot().listNodes();
  for (let i = 0; i < sourceNodes.length; i += 1) {
    if (streamed.has(sourceNodes[i]!)) targetNodes[i]!.setMesh(null);
  }
  await tile.transform(prune({
    propertyTypes: [PropertyType.MESH, PropertyType.PRIMITIVE, PropertyType.PRIMITIVE_TARGET, PropertyType.MATERIAL, PropertyType.TEXTURE, PropertyType.ACCESSOR],
    keepAttributes: true,
    keepSolidTextures: true,
  }));
  return prepareTile(tile);
}

/** Flattened copy of `members` (mesh + material graph) into a fresh document. */
function tileDocument(master: Document, members: PlacedNode[]): Document {
  const tile = new Document().setLogger(new Logger(Logger.Verbosity.WARN));
  const scene = tile.createScene('scene');
  tile.getRoot().setDefaultScene(scene);
  for (const extension of master.getRoot().listExtensionsUsed()) {
    const target = tile.createExtension(extension.constructor as new (document: Document) => Extension);
    if (extension.isRequired()) target.setRequired(true);
  }
  const resolve: PropertyResolver<Property> = createDefaultPropertyResolver(tile, master);
  for (const member of members) {
    const copied = copyToDocument(tile, master, [member.mesh], resolve).get(member.mesh) as Mesh | undefined;
    if (!copied) throw new Error(`failed to copy mesh for node ${JSON.stringify(member.name)}`);
    scene.addChild(tile.createNode(member.name).setMesh(copied).setExtras(structuredClone(member.node.getExtras())).setMatrix(member.worldMatrix as mat4));
  }
  return prepareTile(tile);
}

function prepareTile(tile: Document): Document {
  const buffers = tile.getRoot().listBuffers();
  const buffer = buffers[0] ?? tile.createBuffer();
  for (const accessor of tile.getRoot().listAccessors()) accessor.setBuffer(buffer);
  for (const extra of buffers.slice(1)) extra.dispose();
  // Textures: the master's KTX2 encodings by reference; no bytes in the tile.
  for (const texture of tile.getRoot().listTextures()) {
    const uri = texture.getURI();
    if (!uri.startsWith('images/')) throw new Error(`master texture ${JSON.stringify(texture.getName())} has no images/ URI`);
    texture.setMimeType('image/ktx2').setURI(`../../${uri.replace(/\.[a-z]+$/, '.ktx2')}`).setImage(new Uint8Array(0));
  }
  tile.createExtension(KHRTextureBasisu).setRequired(true);
  tile.createExtension(EXTMeshoptCompression).setRequired(true).setEncoderOptions({ method: EXTMeshoptCompression.EncoderMethod.FILTER });
  for (const extension of tile.getRoot().listExtensionsUsed()) {
    if (extension.listProperties().length === 0 && !MARKER_EXTENSIONS.has(extension.extensionName)) extension.dispose();
  }
  return tile;
}

const GLB_MAGIC = 0x46546c67;
const CHUNK_JSON = 0x4e4f534a;
const CHUNK_BIN = 0x004e4942;

/** Standard two-chunk GLB; `json.buffers[0]` must carry no URI. */
export function writeGlb(json: Record<string, unknown>, bin: Uint8Array): Buffer {
  const jsonBytes = Buffer.from(JSON.stringify(json), 'utf8');
  const jsonPadded = (jsonBytes.length + 3) & ~3;
  const binPadded = (bin.byteLength + 3) & ~3;
  const total = 12 + 8 + jsonPadded + 8 + binPadded;
  const out = Buffer.alloc(total);
  out.writeUInt32LE(GLB_MAGIC, 0);
  out.writeUInt32LE(2, 4);
  out.writeUInt32LE(total, 8);
  out.writeUInt32LE(jsonPadded, 12);
  out.writeUInt32LE(CHUNK_JSON, 16);
  jsonBytes.copy(out, 20);
  out.fill(0x20, 20 + jsonBytes.length, 20 + jsonPadded);
  const binStart = 20 + jsonPadded;
  out.writeUInt32LE(binPadded, binStart);
  out.writeUInt32LE(CHUNK_BIN, binStart + 4);
  Buffer.from(bin.buffer, bin.byteOffset, bin.byteLength).copy(out, binStart + 8);
  return out;
}

/**
 * Cells get position quantization and instancing; the road sheet keeps
 * float32 positions and one node per placement because the viewer's ground
 * index and snow cover read road meshes through `matrixWorld`.
 */
async function writeTile(io: NodeIO, tile: Document, cell: boolean, basename: string): Promise<{ glb: Buffer; instancedNodes: number; batches: number }> {
  if (cell) await tile.transform(instance({ min: INSTANCE_MIN }));
  let instancedNodes = 0;
  let batches = 0;
  for (const node of tile.getRoot().listNodes()) {
    const batch = node.getExtension<InstancedMesh>('EXT_mesh_gpu_instancing');
    if (batch === null) continue;
    batches += 1;
    instancedNodes += batch.getAttribute('TRANSLATION')?.getCount() ?? 0;
  }
  const transforms = [reorder({ encoder: MeshoptEncoder, target: 'size' })];
  if (cell) transforms.push(quantize({ pattern: /^POSITION$/, quantizePosition: POSITION_BITS, quantizationVolume: 'mesh' }));
  await tile.transform(...transforms);
  const { json, resources } = await io.writeJSON(tile, { format: Format.GLTF, basename });
  const out = json as unknown as Record<string, unknown>;
  const buffers = out['buffers'] as Array<Record<string, unknown>>;
  // Buffer 0 is the meshopt-compressed data (buffer 1 is the URI-less
  // fallback the extension declares); it becomes the GLB BIN chunk.
  const uri = buffers[0]?.['uri'];
  if (typeof uri !== 'string' || resources[uri] === undefined) throw new Error(`${basename}: writer produced no external buffer 0 (${JSON.stringify(uri)})`);
  const bin = resources[uri]!;
  delete buffers[0]!['uri'];
  return { glb: writeGlb(out, bin), instancedNodes, batches };
}

function sceneManifest(cellSize: number, origin: [number, number, number], bounds: Bounds, rows: TileRow[]): unknown {
  const staticRows = rows.filter((row) => row.kind === 'static');
  const vegRows = rows.filter((row) => row.kind === 'vegetation');
  const road = rows.find((row) => row.kind === 'road');
  if (!road) throw new Error('web tier has no road layer');
  const dimensions = [...staticRows, ...vegRows].reduce<[number, number]>(
    (value, row) => [Math.max(value[0], (row.gridX ?? 0) + 1), Math.max(value[1], (row.gridZ ?? 0) + 1)],
    [1, 1],
  );
  const tileEntry = (row: TileRow) => ({
    id: path.basename(row.file, '.lod0.glb'),
    gridX: row.gridX,
    gridZ: row.gridZ,
    bounds: row.bounds,
    lods: [{ level: 0, file: row.file, triangles: row.triangles, fileSize: row.fileSize, geometricError: 0 }],
  });
  return {
    version: '1.2.0',
    generator: 'simforge-map-pipeline',
    created: '1970-01-01T00:00:00.000Z',
    scene: {
      bounds,
      totalTriangles: rows.reduce((sum, row) => sum + row.triangles, 0),
      gridDimensions: dimensions,
      cellSize: [cellSize, cellSize],
      origin,
      lodLevels: 1,
      coordinateSystem: 'y-up',
    },
    tiles: staticRows.map(tileEntry),
    vegetationTiles: vegRows.map(tileEntry),
    staticLayers: [{ id: 'road', file: road.file, triangles: road.triangles, fileSize: road.fileSize }],
    vegetationPrototypes: [],
    vegetationInstanceTiles: [],
  };
}

function semantics(placed: PlacedNode[]): unknown {
  const objects = placed
    .filter((row) => row.name.trim().length > 0)
    .map((row) => ({ id: sha256(`master.gltf\0${row.name}`).slice(0, 24), source: 'master.gltf', node: row.name }))
    .sort((left, right) => left.node.localeCompare(right.node));
  return { schema: 'simforge.static-semantics.v1', objects };
}

/**
 * Writes `3d/manifest.json`, `3d/semantics.json` and `3d/tiles/*.glb` under
 * `outputDir` from the in-memory master document.
 */
export async function buildWebTier(master: Document, outputDir: string, options: WebTierOptions = {}): Promise<WebTierReport> {
  await MeshoptEncoder.ready;
  const cellSize = options.cellSize ?? 100;
  const io = new NodeIO().registerExtensions(ALL_EXTENSIONS).registerDependencies({ 'meshopt.encoder': MeshoptEncoder });
  const { placed, skinned } = collectPlacedNodes(master);
  if (placed.length === 0) throw new Error('master has no mesh nodes');
  placed.sort((left, right) => left.name.localeCompare(right.name));

  const coherent = coherentNodes(master);
  const categories: Record<Kind, PlacedNode[]> = { road: [], static: [], vegetation: [] };
  for (const row of placed) categories[coherent.has(row.node) ? 'road' : row.kind].push(row);
  if (categories.road.length === 0) {
    const ground = placed.reduce((best, candidate) => (candidate.bounds.min[1] < best.bounds.min[1] ? candidate : best));
    categories[ground.kind].splice(categories[ground.kind].indexOf(ground), 1);
    categories.road.push(ground);
  }
  const sceneBounds = aggregateBounds(placed.map((row) => row.bounds));
  const originX = Math.floor(sceneBounds.min[0] / cellSize) * cellSize;
  const originZ = Math.floor(sceneBounds.min[2] / cellSize) * cellSize;

  const tiles: Array<{ row: Omit<TileRow, 'fileSize'>; members: PlacedNode[]; quantize: boolean }> = [];
  tiles.push({
    row: { kind: 'road', file: 'tiles/road.glb', bounds: aggregateBounds(categories.road.map((row) => row.bounds)), triangles: categories.road.reduce((sum, row) => sum + row.triangles, 0) },
    members: categories.road,
    quantize: false,
  });
  for (const kind of ['static', 'vegetation'] as const) {
    const cells = new Map<string, { gridX: number; gridZ: number; members: PlacedNode[] }>();
    for (const row of categories[kind]) {
      const gridX = Math.floor(((row.bounds.min[0] + row.bounds.max[0]) / 2 - originX) / cellSize);
      const gridZ = Math.floor(((row.bounds.min[2] + row.bounds.max[2]) / 2 - originZ) / cellSize);
      const key = `${gridX},${gridZ}`;
      let cell = cells.get(key);
      if (cell === undefined) cells.set(key, (cell = { gridX, gridZ, members: [] }));
      cell.members.push(row);
    }
    const prefix = kind === 'static' ? 'tile' : 'veg';
    for (const cell of [...cells.values()].sort((left, right) => left.gridX - right.gridX || left.gridZ - right.gridZ)) {
      tiles.push({
        row: { kind, file: `tiles/${prefix}_${cell.gridX}_${cell.gridZ}.lod0.glb`, gridX: cell.gridX, gridZ: cell.gridZ, bounds: aggregateBounds(cell.members.map((row) => row.bounds)), triangles: cell.members.reduce((sum, row) => sum + row.triangles, 0) },
        members: cell.members,
        quantize: true,
      });
    }
  }

  const webDir = path.join(outputDir, '3d');
  await mkdir(path.join(webDir, 'tiles'), { recursive: true });
  const rows: TileRow[] = [];
  const report: WebTierReport = {
    schema: 'simforge.web-tier-report.v1',
    cellSize,
    tiles: tiles.length,
    bytes: 0,
    meshNodes: placed.length,
    instancedNodes: 0,
    instanceBatches: 0,
    skinnedNodesFlattened: 0,
    skinnedNodesPreserved: skinned,
    positionBits: POSITION_BITS,
    tilesByKind: { road: 1, static: 0, vegetation: 0 },
  };
  const streamed = new Set([...categories.static, ...categories.vegetation].map((row) => row.node));
  for (const tile of tiles) {
    const document = tile.row.kind === 'road'
      ? await faithfulDocument(master, streamed)
      : tileDocument(master, tile.members);
    const written = await writeTile(io, document, tile.quantize, path.basename(tile.row.file, '.glb'));
    await writeFile(path.join(webDir, tile.row.file), written.glb);
    rows.push({ ...tile.row, fileSize: written.glb.byteLength });
    report.bytes += written.glb.byteLength;
    report.instancedNodes += written.instancedNodes;
    report.instanceBatches += written.batches;
    if (tile.row.kind !== 'road') report.tilesByKind[tile.row.kind] += 1;
  }
  await writeFile(path.join(webDir, 'manifest.json'), `${canonicalJson(sceneManifest(cellSize, [originX, sceneBounds.min[1], originZ], sceneBounds, rows))}\n`);
  await writeFile(path.join(webDir, 'semantics.json'), `${canonicalJson(semantics(placed))}\n`);
  await writeFile(path.join(outputDir, 'web-tier-report.json'), `${JSON.stringify(report, null, 2)}\n`);
  return report;
}
