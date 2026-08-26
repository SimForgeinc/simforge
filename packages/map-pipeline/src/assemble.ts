import { cp, mkdir, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { NodeIO } from '@gltf-transform/core';

import {
  TOPOLOGY_CONTENT_EPOCH,
  buildLanePolygonsLocal,
  buildMapTopologyIndex,
} from './ported/map-topology/build-topology-index.js';
import type { MapTopologyIndex } from './ported/map-topology/types.js';

import { buildClosure, canonicalJson, closureDigest, filesUnder, hashTree, sha256, writeClosure } from './closure.js';
import type { MapClosure } from './closure.js';
import type { StageResult } from './tiling.js';
export const CLOSURE_ASSEMBLER_REVISION = 4;
export const DEFAULT_SKY_PATH = path.join(os.homedir(), 'simforge-assets', 'hdri', 'clear-day-sky.hdr');

type Bounds = { min: [number, number, number]; max: [number, number, number] };
type InventoryRow = {
  kind: 'road' | 'static' | 'vegetation';
  file: string;
  gridX?: number;
  gridZ?: number;
  bounds: Bounds;
  triangles: number;
};
type PrototypeRow = { id: string; file: string; bounds: Bounds; triangles: number };
type Inventory = {
  cellSize: number;
  origin: [number, number, number];
  bounds: Bounds;
  objects: InventoryRow[];
  vegetationPrototypes?: PrototypeRow[];
};
type VegetationInstance = {
  rotation_quat: [number, number, number, number];
  scale: [number, number, number];
  translation: [number, number, number];
};
type VegetationPrototypeSource = {
  mesh_asset_name?: string;
  prototype_fbx?: string;
  instances?: VegetationInstance[];
};
type VegetationSource = { vegetation_prototypes?: VegetationPrototypeSource[] };
type VegetationInstanceTile = {
  id: string;
  gridX: number;
  gridZ: number;
  instanceFile: string;
  prototypeFiles: string[];
};
export interface AssembleClosureOptions {
  tiles: StageResult;
  mapName: string;
  sourceDir: string;
  xodrPath?: string;
  workDir: string;
}

export interface ClosureStageResult extends StageResult {
  closure: MapClosure;
  closureDigest: string;
  viewerOnly: boolean;
}

function gzipCanonical(value: unknown): Buffer {
  return gzipSync(Buffer.from(`${canonicalJson(value)}\n`), { level: 9 });
}

function sceneManifest(inventory: Inventory, instanceTiles: VegetationInstanceTile[]): unknown {
  const staticRows = inventory.objects.filter((row) => row.kind === 'static');
  const vegRows = inventory.objects.filter((row) => row.kind === 'vegetation');
  const road = inventory.objects.find((row) => row.kind === 'road');
  if (!road) throw new Error('tiling inventory has no road layer');
  const dimensions = [...staticRows, ...vegRows].reduce<[number, number]>(
    (value, row) => [
      Math.max(value[0], (row.gridX ?? 0) + 1),
      Math.max(value[1], (row.gridZ ?? 0) + 1),
    ],
    [1, 1],
  );
  const tileEntry = (row: InventoryRow) => ({
    id: path.basename(row.file, '.lod0.glb').replace('.lod0', ''),
    gridX: row.gridX,
    gridZ: row.gridZ,
    bounds: row.bounds,
    lods: [{ level: 0, file: row.file, triangles: row.triangles, fileSize: 0, geometricError: 0 }],
  });
  return {
    version: '1.2.0',
    generator: 'simforge-map-pipeline',
    created: '1970-01-01T00:00:00.000Z',
    scene: {
      bounds: inventory.bounds,
      totalTriangles: inventory.objects.reduce((sum, row) => sum + row.triangles, 0),
      gridDimensions: dimensions,
      cellSize: [inventory.cellSize, inventory.cellSize],
      origin: inventory.origin,
      lodLevels: 1,
      coordinateSystem: 'y-up',
    },
    tiles: staticRows.map(tileEntry),
    vegetationTiles: vegRows.map(tileEntry),
    staticLayers: [{ id: 'road', file: road.file, triangles: road.triangles, fileSize: 0 }],
    vegetationPrototypes: inventory.vegetationPrototypes ?? [],
    vegetationInstanceTiles: instanceTiles,
  };
}

async function buildSemantics(tilesDir: string, rows: InventoryRow[]): Promise<unknown> {
  const io = new NodeIO();
  const objects: Array<{ id: string; source: string; node: string }> = [];
  for (const row of [...rows].sort((left, right) => left.file.localeCompare(right.file))) {
    const document = await io.read(path.join(tilesDir, row.file.replace(/^tiles\//, '')));
    for (const node of document.getRoot().listNodes().sort((left, right) => left.getName().localeCompare(right.getName()))) {
      const name = node.getName().trim();
      if (name) objects.push({ id: sha256(`${row.file}\0${name}`).slice(0, 24), source: row.file, node: name });
    }
  }
  return { schema: 'simforge.static-semantics.v1', objects };
}

function lanePolygonGeoJson(xodr: string): unknown {
  return {
    type: 'FeatureCollection',
    features: buildLanePolygonsLocal(xodr).map((lane) => ({
      type: 'Feature',
      geometry: { type: 'Polygon', coordinates: [lane.ring.map((point) => [point.x, point.y])] },
      properties: { roadId: lane.roadId, laneId: lane.laneId, laneSection: lane.section },
    })),
  };
}

function vegetationMatrix(instance: VegetationInstance): number[] {
  const [x, y, z, w] = instance.rotation_quat;
  const source = [
    [1 - 2 * (y * y + z * z), 2 * (x * y - z * w), 2 * (x * z + y * w)],
    [2 * (x * y + z * w), 1 - 2 * (x * x + z * z), 2 * (y * z - x * w)],
    [2 * (x * z - y * w), 2 * (y * z + x * w), 1 - 2 * (x * x + y * y)],
  ];
  const basis = [[1, 0, 0], [0, 0, 1], [0, -1, 0]];
  const inverse = [[1, 0, 0], [0, 0, -1], [0, 1, 0]];
  const multiply = (left: number[][], right: number[][]): number[][] =>
    left.map((row) => right[0]!.map((_, column) =>
      row.reduce((sum, value, inner) => sum + value * right[inner]![column]!, 0)));
  const rotation = multiply(multiply(basis, source), inverse);
  const scale = [instance.scale[0], instance.scale[2], instance.scale[1]];
  return [
    rotation[0]![0]! * scale[0]!, rotation[1]![0]! * scale[0]!, rotation[2]![0]! * scale[0]!, 0,
    rotation[0]![1]! * scale[1]!, rotation[1]![1]! * scale[1]!, rotation[2]![1]! * scale[1]!, 0,
    rotation[0]![2]! * scale[2]!, rotation[1]![2]! * scale[2]!, rotation[2]![2]! * scale[2]!, 0,
    instance.translation[0] / 100, instance.translation[2] / 100, -instance.translation[1] / 100, 1,
  ];
}

async function buildSourceMetadata(
  sourceDir: string,
  contentDir: string,
  inventory: Inventory,
): Promise<VegetationInstanceTile[]> {
  const metadataDir = path.join(contentDir, 'metadata');
  await mkdir(metadataDir, { recursive: true });
  let vegetation: VegetationSource | undefined;
  for (const name of ['actors.json', 'materials.json', 'vegetation.json']) {
    try {
      const parsed = JSON.parse(await readFile(path.join(sourceDir, name), 'utf8')) as unknown;
      await writeFile(path.join(metadataDir, name), `${canonicalJson(parsed)}\n`);
      if (name === 'vegetation.json' && parsed !== null && typeof parsed === 'object') {
        vegetation = parsed as VegetationSource;
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }
  if (!vegetation?.vegetation_prototypes) return [];

  const prototypes = [...vegetation.vegetation_prototypes].sort((left, right) =>
    (left.mesh_asset_name ?? left.prototype_fbx ?? '').localeCompare(right.mesh_asset_name ?? right.prototype_fbx ?? ''));
  const cells: Record<string, Array<{ prototype: string; file: string; matrix: number[] }>> = {};
  const prototypeFiles = Object.fromEntries(
    (inventory.vegetationPrototypes ?? []).map((prototype) => [prototype.id.toLowerCase(), prototype.file]),
  );
  for (const prototype of prototypes) {
    const id = prototype.mesh_asset_name ?? path.basename(prototype.prototype_fbx ?? '', '.fbx');
    if (!id) continue;
    const file = prototypeFiles[id.toLowerCase()] ?? `tiles/prototypes/${id}.glb`;
    for (const instance of prototype.instances ?? []) {
      if (!Array.isArray(instance.translation) || instance.translation.length !== 3) continue;
      const worldX = instance.translation[0] / 100;
      const worldZ = -instance.translation[1] / 100;
      const gridX = Math.floor((worldX - inventory.origin[0]) / inventory.cellSize);
      const gridZ = Math.floor((worldZ - inventory.origin[2]) / inventory.cellSize);
      const key = `${gridX},${gridZ}`;
      (cells[key] ??= []).push({ prototype: id, file, matrix: vegetationMatrix(instance) });
    }
  }

  const tiles: VegetationInstanceTile[] = [];
  for (const key of Object.keys(cells).sort((left, right) => {
    const [leftX, leftZ] = left.split(',').map(Number);
    const [rightX, rightZ] = right.split(',').map(Number);
    return leftX! - rightX! || leftZ! - rightZ!;
  })) {
    const [gridX, gridZ] = key.split(',').map(Number) as [number, number];
    const rows = cells[key]!;
    const names = [...new Set(rows.map((row) => row.prototype))].sort();
    const transforms: number[] = [];
    const counts: number[] = [];
    for (const name of names) {
      const matching = rows.filter((row) => row.prototype === name);
      counts.push(matching.length);
      for (const row of matching) transforms.push(...row.matrix);
    }
    const instanceFile = `tiles/veg_${gridX}_${gridZ}.instances.json`;
    await writeFile(path.join(contentDir, '3d', instanceFile), `${canonicalJson({ prototypes: names, counts, transforms })}\n`);
    tiles.push({
      id: `veg_${gridX}_${gridZ}`,
      gridX,
      gridZ,
      instanceFile,
      prototypeFiles: [...new Set(rows.map((row) => row.file))].sort(),
    });
  }
  return tiles;
}

async function resolveXodrPath(sourceDir: string, explicitPath?: string): Promise<string | undefined> {
  if (explicitPath !== undefined) return path.resolve(explicitPath);
  const relativePath = (await filesUnder(sourceDir)).find((file) => file.toLowerCase().endsWith('.xodr'));
  return relativePath === undefined ? undefined : path.join(sourceDir, relativePath);
}

async function resolveSkyPath(sourceDir: string): Promise<string> {
  const ownSky = (await filesUnder(sourceDir)).find((file) =>
    file.toLowerCase().endsWith('env/sky.hdr') || file.toLowerCase() === 'sky.hdr'
  );
  return ownSky === undefined
    ? path.resolve(process.env['SIMFORGE_DEFAULT_SKY'] ?? DEFAULT_SKY_PATH)
    : path.join(sourceDir, ownSky);
}

async function writeSky(contentDir: string, sourceDir: string): Promise<void> {
  const source = await resolveSkyPath(sourceDir);
  const destination = path.join(contentDir, '3d', 'env', 'sky.hdr');
  await mkdir(path.dirname(destination), { recursive: true });
  await cp(source, destination);
}

async function roadSidecars(xodrPath: string | undefined, mapName: string): Promise<{
  xodr: Buffer;
  topology: MapTopologyIndex;
  topologyBytes: Buffer;
  lanePolygons: Buffer;
  signals: Buffer;
} | undefined> {
  if (xodrPath === undefined) return undefined;
  const xodr = await readFile(xodrPath);
  const text = xodr.toString('utf8');
  const topology = buildMapTopologyIndex({
    mapName,
    xodr: text,
    xodrSha256: sha256(xodr),
    now: () => TOPOLOGY_CONTENT_EPOCH,
  });
  return {
    xodr,
    topology,
    topologyBytes: gzipCanonical(topology),
    lanePolygons: gzipCanonical(lanePolygonGeoJson(text)),
    signals: gzipCanonical({ type: 'FeatureCollection', features: [] }),
  };
}

export async function writeRoadSidecars(contentDir: string, xodrPath: string, mapName: string): Promise<void> {
  const sidecars = await roadSidecars(path.resolve(xodrPath), mapName);
  if (sidecars === undefined) throw new Error(`XODR sidecars require an XODR path for ${mapName}`);
  await writeFile(path.join(contentDir, 'map.xodr'), sidecars.xodr);
  await writeFile(path.join(contentDir, 'topology-index.json.gz'), sidecars.topologyBytes);
  await writeFile(path.join(contentDir, 'lane-polygons.geojson.gz'), sidecars.lanePolygons);
  await writeFile(path.join(contentDir, 'signals.geojson.gz'), sidecars.signals);
  await mkdir(path.join(contentDir, 'derived'), { recursive: true });
  await writeFile(path.join(contentDir, 'derived', 'topology-derived.json.gz'), gzipCanonical({ schema: 'simforge.topology-derived.v1', lanes: sidecars.topology.lanes }));
  await writeFile(path.join(contentDir, 'derived', 'locations.json.gz'), gzipCanonical({ schema: 'simforge.map-locations.v1', locations: [] }));
  await writeFile(path.join(contentDir, 'derived', 'roadway-consistency.json.gz'), gzipCanonical({ schema: 'simforge.roadway-consistency.v1', verdict: 'not-evaluated' }));
}

export async function assembleClosure(options: AssembleClosureOptions): Promise<ClosureStageResult> {
  const xodrPath = await resolveXodrPath(options.sourceDir, options.xodrPath);
  const xodrDigest = xodrPath === undefined ? 'none' : sha256(await readFile(xodrPath));
  const inputDigest = sha256(`${options.tiles.outputDigest}\0${options.tiles.inputDigest}\0${xodrDigest}`);
  const toolFingerprint = sha256(`closure-assemble\0${CLOSURE_ASSEMBLER_REVISION}`);
  const cacheKey = sha256(`${inputDigest}\0${toolFingerprint}`);
  const outputDir = path.resolve(options.workDir, 'closure-assemble', cacheKey);
  const contentDir = path.join(outputDir, 'content');
  const existingClosurePath = path.join(outputDir, 'closure.json');
  try {
    const closure = JSON.parse(await readFile(existingClosurePath, 'utf8')) as MapClosure;
    const digest = closureDigest(closure);
    return { inputDigest, toolFingerprint, outputDigest: await hashTree(contentDir), outputDir: contentDir, cacheKey, closure, closureDigest: digest, viewerOnly: closure.metadata?.viewerOnly === true };
  } catch {
    // Rebuild absent or incomplete output.
  }

  await mkdir(path.join(contentDir, '3d'), { recursive: true });
  await cp(path.join(options.tiles.outputDir, 'tiles'), path.join(contentDir, '3d', 'tiles'), { recursive: true });
  const inventory = JSON.parse(await readFile(path.join(options.tiles.outputDir, 'inventory.json'), 'utf8')) as Inventory;
  const instanceTiles = await buildSourceMetadata(options.sourceDir, contentDir, inventory);
  const manifest = sceneManifest(inventory, instanceTiles) as { staticLayers: Array<{ file: string; fileSize?: number }> };
  for (const row of inventory.objects) {
    const member = manifest.staticLayers.find((layer) => layer.file === row.file);
    if (member) member.fileSize = (await readFile(path.join(options.tiles.outputDir, row.file))).byteLength;
  }
  await writeFile(path.join(contentDir, '3d', 'manifest.json'), `${canonicalJson(manifest)}\n`);
  await writeFile(path.join(contentDir, '3d', 'semantics.json'), `${canonicalJson(await buildSemantics(path.join(options.tiles.outputDir, 'tiles'), inventory.objects))}\n`);
  await writeSky(contentDir, options.sourceDir);

  const sidecars = await roadSidecars(xodrPath, options.mapName);
  if (sidecars) await writeRoadSidecars(contentDir, xodrPath!, options.mapName);

  const viewerOnly = sidecars === undefined;
  const closure = await buildClosure(contentDir, 'canonical', { viewerOnly });
  const written = await writeClosure(outputDir, closure);
  const outputDigest = await hashTree(contentDir);
  await writeFile(path.join(outputDir, 'stage.json'), `${JSON.stringify({ schema: 'simforge.map-pipeline-stage.v1', stage: 'closure-assemble', inputDigest, toolFingerprint, outputDigest, closureDigest: written.digest })}\n`);
  return { inputDigest, toolFingerprint, outputDigest, outputDir: contentDir, cacheKey, closure, closureDigest: written.digest, viewerOnly };
}
