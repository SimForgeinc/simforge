import { cp, mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { gzipSync } from 'node:zlib';

import { NodeIO } from '@gltf-transform/core';

import {
  TOPOLOGY_CONTENT_EPOCH,
  buildLanePolygonsLocal,
  buildMapTopologyIndex,
} from '../../../studio/app/lib/studio-shared/map-topology/build-topology-index.js';
import type { MapTopologyIndex } from '../../../studio/app/lib/studio-shared/map-topology/types.js';

import { buildClosure, canonicalJson, closureDigest, filesUnder, hashTree, sha256, writeClosure } from './closure.js';
import type { MapClosure } from './closure.js';
import type { StageResult } from './tiling.js';

export const CLOSURE_ASSEMBLER_REVISION = 1;

type Bounds = { min: [number, number, number]; max: [number, number, number] };
type InventoryRow = {
  kind: 'road' | 'static' | 'vegetation';
  file: string;
  gridX?: number;
  gridZ?: number;
  bounds: Bounds;
  triangles: number;
};
type Inventory = {
  cellSize: number;
  origin: [number, number, number];
  bounds: Bounds;
  objects: InventoryRow[];
};

export interface AssembleClosureOptions {
  tiles: StageResult;
  mapName: string;
  sourceDir: string;
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

function sceneManifest(inventory: Inventory): unknown {
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

async function findXodr(sourceDir: string): Promise<string | undefined> {
  return (await filesUnder(sourceDir)).find((file) => file.toLowerCase().endsWith('.xodr'));
}

async function roadSidecars(sourceDir: string, mapName: string): Promise<{
  xodr: Buffer;
  topology: MapTopologyIndex;
  topologyBytes: Buffer;
  lanePolygons: Buffer;
  signals: Buffer;
} | undefined> {
  const relativePath = await findXodr(sourceDir);
  if (!relativePath) return undefined;
  const xodr = await readFile(path.join(sourceDir, relativePath));
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

export async function assembleClosure(options: AssembleClosureOptions): Promise<ClosureStageResult> {
  const inputDigest = sha256(`${options.tiles.outputDigest}\0${await hashTree(options.sourceDir)}`);
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
  const manifest = sceneManifest(inventory) as { staticLayers: Array<{ file: string }> };
  for (const row of inventory.objects) {
    const member = manifest.staticLayers.find((layer) => layer.file === row.file);
    if (member) (member as { fileSize?: number }).fileSize = (await readFile(path.join(options.tiles.outputDir, row.file))).byteLength;
  }
  await writeFile(path.join(contentDir, '3d', 'manifest.json'), `${canonicalJson(manifest)}\n`);
  await writeFile(path.join(contentDir, '3d', 'semantics.json'), `${canonicalJson(await buildSemantics(path.join(options.tiles.outputDir, 'tiles'), inventory.objects))}\n`);

  const sidecars = await roadSidecars(options.sourceDir, options.mapName);
  if (sidecars) {
    await writeFile(path.join(contentDir, 'map.xodr'), sidecars.xodr);
    await writeFile(path.join(contentDir, 'topology-index.json.gz'), sidecars.topologyBytes);
    await writeFile(path.join(contentDir, 'lane-polygons.geojson.gz'), sidecars.lanePolygons);
    await writeFile(path.join(contentDir, 'signals.geojson.gz'), sidecars.signals);
    await mkdir(path.join(contentDir, 'derived'), { recursive: true });
    await writeFile(path.join(contentDir, 'derived', 'topology-derived.json.gz'), gzipCanonical({ schema: 'simforge.topology-derived.v1', lanes: sidecars.topology.lanes }));
    await writeFile(path.join(contentDir, 'derived', 'locations.json.gz'), gzipCanonical({ schema: 'simforge.map-locations.v1', locations: [] }));
    await writeFile(path.join(contentDir, 'derived', 'roadway-consistency.json.gz'), gzipCanonical({ schema: 'simforge.roadway-consistency.v1', verdict: 'not-evaluated' }));
  }

  const viewerOnly = sidecars === undefined;
  const closure = await buildClosure(contentDir, 'canonical', { viewerOnly });
  const written = await writeClosure(outputDir, closure);
  const outputDigest = await hashTree(contentDir);
  await writeFile(path.join(outputDir, 'stage.json'), `${JSON.stringify({ schema: 'simforge.map-pipeline-stage.v1', stage: 'closure-assemble', inputDigest, toolFingerprint, outputDigest, closureDigest: written.digest })}\n`);
  return { inputDigest, toolFingerprint, outputDigest, outputDir: contentDir, cacheKey, closure, closureDigest: written.digest, viewerOnly };
}
