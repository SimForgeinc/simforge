/**
 * Regenerate `src/__tests__/fixtures/mini-yale.json.gz`.
 *
 * ```
 * pnpm --filter @simforge-oss/maps exec tsx scripts/extract-fixture.ts
 * ```
 *
 * Carves a small, self-contained neighbourhood out of the Yale Street map —
 * centred on junction 387, a signalized four-way — so the test suite exercises
 * *real* data (real polylines, real gates, real signals, real Overture
 * addresses) without depending on the gitignored `dev-assets/` tree.
 *
 * Everything is index-consistent after the carve: the search index's
 * `feature_refs` are remapped onto the compacted GeoJSON feature array and
 * `geojson_feature_uuids` is rebuilt to match, because that positional join is
 * what resolves streets to lane references.
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { gunzipSync, gzipSync } from 'node:zlib';

import { CoordinateFrame } from '@simforge-oss/maps/opendrive';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '..', '..', '..');
const SRC = path.join(REPO_ROOT, 'dev-assets', 'yale-st-palo-alto-ca');
const OUT = path.join(HERE, '..', 'src', '__tests__', 'fixtures', 'mini-yale.json.gz');

/** Junction the fixture is centred on: signalized, four arms, four approaches. */
const CENTRE_JUNCTION = '387';

/** Everything within this radius of the junction centre is retained. */
const RADIUS_M = 95;

/** Cap on retained 3D lane vertices, to keep the fixture small. */
const MAX_LANE_VERTICES = 4;

async function readJson<T>(file: string): Promise<T> {
  const bytes = await readFile(file);
  const plain = bytes[0] === 0x1f && bytes[1] === 0x8b ? gunzipSync(bytes) : bytes;
  return JSON.parse(plain.toString('utf8')) as T;
}

/* eslint-disable @typescript-eslint/no-explicit-any */
async function main(): Promise<void> {
  const xodrHeaderText = (await readFile(path.join(SRC, 'map.xodr'))).subarray(0, 8192).toString('utf8');
  const frame = CoordinateFrame.fromMapAssets(xodrHeaderText);

  const topology = await readJson<any>(path.join(SRC, 'topology-index.json.gz'));
  const searchIndex = await readJson<any>(path.join(SRC, 'search-index.json.gz'));
  const signals = await readJson<any>(path.join(SRC, 'signals.geojson.gz'));
  const lanePolygons = await readJson<any>(path.join(SRC, 'lane-polygons.geojson.gz'));
  const mapGeojson = await readJson<any>(path.join(SRC, 'map.geojson.gz'));
  const overlay = await readJson<any>(path.join(SRC, 'enrichment', 'overlay-payload.json'));

  // --- centre -------------------------------------------------------------
  const centreJunction = topology.junctions[CENTRE_JUNCTION];
  if (!centreJunction) throw new Error(`no junction ${CENTRE_JUNCTION}`);
  const centrePoints: { x: number; y: number }[] = centreJunction.internalLaneRsls.flatMap(
    (rsl: string) => topology.lanes[rsl]?.polyline ?? [],
  );
  const cx = centrePoints.reduce((a, p) => a + p.x, 0) / centrePoints.length;
  const cy = centrePoints.reduce((a, p) => a + p.y, 0) / centrePoints.length;
  const withinLocal = (x: number, y: number): boolean => Math.hypot(x - cx, y - cy) <= RADIUS_M;
  const withinGeo = (lng: number, lat: number): boolean => {
    const [x, y] = frame.wgs84ToLocal(lng, lat);
    return withinLocal(x, y);
  };

  // --- lanes --------------------------------------------------------------
  const keptLanes: Record<string, any> = {};
  for (const rsl of Object.keys(topology.lanes).sort()) {
    const lane = topology.lanes[rsl];
    if (!lane?.polyline?.length) continue;
    if (!lane.polyline.some((p: any) => withinLocal(p.x, p.y))) continue;
    keptLanes[rsl] = lane;
  }
  const laneSet = new Set(Object.keys(keptLanes));
  // Prune dangling references so the fixture is internally consistent.
  for (const lane of Object.values<any>(keptLanes)) {
    lane.predecessors = lane.predecessors.filter((r: string) => laneSet.has(r));
    lane.successors = lane.successors.filter((r: string) => laneSet.has(r));
    for (const side of ['left', 'right'] as const) {
      const adj = lane.adjacentLanes?.[side];
      if (adj?.laneRsl && !laneSet.has(adj.laneRsl)) adj.laneRsl = null;
    }
  }

  const keptGates = topology.gates
    .filter((g: any) => laneSet.has(g.connectingLaneRsl) && laneSet.has(g.approachLaneRsl))
    .map((g: any) => ({ ...g, exitLaneRsls: g.exitLaneRsls.filter((r: string) => laneSet.has(r)) }));
  const gateJunctions = new Set<string>(keptGates.map((g: any) => g.junctionId));

  const keptJunctions: Record<string, any> = {};
  for (const jid of Object.keys(topology.junctions).sort()) {
    if (!gateJunctions.has(jid)) continue;
    const j = topology.junctions[jid];
    const internal = j.internalLaneRsls.filter((r: string) => laneSet.has(r));
    if (internal.length === 0) continue;
    keptJunctions[jid] = {
      ...j,
      internalLaneRsls: internal,
      approachLaneRsls: j.approachLaneRsls.filter((r: string) => laneSet.has(r)),
      gateIds: keptGates.filter((g: any) => g.junctionId === jid).map((g: any) => g.id),
    };
  }

  // --- map geojson (compacted, index-consistent) ---------------------------
  const keptFeatures: any[] = [];
  const newIndexByOldIndex = new Map<number, number>();
  mapGeojson.features.forEach((f: any, i: number) => {
    const type = f.properties?.Type;
    if (type !== 'Lane' && type !== 'ParkingSpace' && type !== 'Junction') return;
    const coords = flattenPositions(f.geometry?.coordinates);
    if (coords.length === 0 || !coords.some(([lng, lat]) => withinGeo(lng, lat))) return;
    newIndexByOldIndex.set(i, keptFeatures.length);
    keptFeatures.push(type === 'Lane' ? thinLane(f) : f);
  });

  // --- search index --------------------------------------------------------
  const keptObjects: Record<string, any> = {};
  for (const key of Object.keys(searchIndex.objects).sort()) {
    const obj = searchIndex.objects[key];
    if (!withinGeo(obj.centroid[0], obj.centroid[1])) continue;
    const refs = (obj.feature_refs ?? [])
      .map((r: any) => ({ ...r, geojson_feature_id: newIndexByOldIndex.get(r.geojson_feature_id) }))
      .filter((r: any) => r.geojson_feature_id !== undefined);
    keptObjects[key] = { ...obj, feature_refs: refs };
  }
  const objectIds = new Set(Object.keys(keptObjects));
  for (const obj of Object.values<any>(keptObjects)) {
    if (obj.anchor && !objectIds.has(obj.anchor.object_id)) delete obj.anchor;
  }
  const keptEdges = searchIndex.graph.edges.filter(
    (e: any) => objectIds.has(e.from) && objectIds.has(e.to),
  );

  // --- signals, lane polygons, overlay -------------------------------------
  const keptSignals = signals.features.filter((f: any) => {
    const c = f.geometry?.coordinates;
    return (
      Array.isArray(c) &&
      Number.isFinite(c[0]) &&
      Number.isFinite(c[1]) &&
      withinGeo(c[0], c[1])
    );
  });

  const keptLanePolygons = lanePolygons.features
    .filter((f: any) => {
      const rsl = `${f.properties.road_id}:${f.properties.section_id ?? 0}:${f.properties.lane_id}`;
      return laneSet.has(rsl);
    })
    // Geometry is unused by the build (the guid ↔ rsl join lives in properties),
    // so it is replaced by a single representative point.
    .map((f: any) => ({
      type: 'Feature',
      geometry: { type: 'Point', coordinates: firstPosition(f.geometry?.coordinates) },
      properties: f.properties,
    }));

  const keptLayers = overlay.layers.map((layer: any) => ({
    ...layer,
    data: layer.data
      ? {
          type: 'FeatureCollection',
          features: (layer.data.features ?? []).filter((f: any) => {
            const c = firstPosition(f.geometry?.coordinates);
            return (
              c.length >= 2 &&
              Number.isFinite(c[0]) &&
              Number.isFinite(c[1]) &&
              withinGeo(c[0] as number, c[1] as number)
            );
          }),
        }
      : undefined,
  }));
  for (const layer of keptLayers) layer.feature_count = layer.data?.features.length ?? 0;

  const fixture = {
    _comment:
      `Carved from yale-street around junction ${CENTRE_JUNCTION} (radius ${RADIUS_M} m) by ` +
      'scripts/extract-fixture.ts. Real data, index-consistent.',
    centreJunctionId: CENTRE_JUNCTION,
    xodrHeaderText,
    sourceHashes: {
      'topology-index': 'fixture-topology',
      'search-index': 'fixture-search',
      signals: 'fixture-signals',
      'lane-polygons': 'fixture-lane-polygons',
      'map-geojson': 'fixture-map-geojson',
      'overlay-payload': 'fixture-overlay',
      xodr: topology.source?.xodrSha256 ?? 'fixture-xodr',
    },
    topology: {
      schemaVersion: topology.schemaVersion,
      mapName: 'mini-yale',
      source: topology.source,
      lanes: keptLanes,
      gates: keptGates,
      junctions: keptJunctions,
    },
    searchIndex: {
      version: searchIndex.version,
      map_asset_id: 'mini-yale_fixture',
      geojson_feature_uuids: keptFeatures.map((f) => f.properties.Id ?? ''),
      objects: keptObjects,
      graph: { edges: keptEdges },
    },
    signals: { type: 'FeatureCollection', features: keptSignals },
    lanePolygons: { type: 'FeatureCollection', features: keptLanePolygons },
    mapGeojson: { type: 'FeatureCollection', features: keptFeatures },
    overlay: { bbox: overlay.bbox, layers: keptLayers },
  };

  await mkdir(path.dirname(OUT), { recursive: true });
  const json = JSON.stringify(fixture, roundReplacer);
  const packed = gzipSync(Buffer.from(json), { level: 9 });
  await writeFile(OUT, packed);
  process.stdout.write(
    `mini-yale.json.gz: ${Math.round(packed.byteLength / 1024)} KB gz (${Math.round(json.length / 1024)} KB raw) — ` +
      `${Object.keys(keptLanes).length} lanes, ${keptGates.length} gates, ` +
      `${Object.keys(keptJunctions).length} junctions, ${Object.keys(keptObjects).length} search objects, ` +
      `${keptSignals.length} signals, ${keptFeatures.length} geojson features\n`,
  );
}

/** Trim float noise: 7 decimals is ~1 cm of longitude, far past what we need. */
function roundReplacer(_key: string, value: unknown): unknown {
  return typeof value === 'number' && Number.isFinite(value) && !Number.isInteger(value)
    ? Number(value.toFixed(7))
    : value;
}

function thinLane(f: any): any {
  const coords = f.geometry?.coordinates;
  if (!Array.isArray(coords)) return f;
  const step = Math.max(1, Math.ceil(coords.length / MAX_LANE_VERTICES));
  const thinned = coords.filter((_: unknown, i: number) => i % step === 0);
  return {
    type: 'Feature',
    geometry: { type: f.geometry.type, coordinates: thinned },
    properties: { Id: f.properties.Id, Type: f.properties.Type, LaneType: f.properties.LaneType },
  };
}

function flattenPositions(coords: unknown): [number, number][] {
  const out: [number, number][] = [];
  const walk = (node: unknown): void => {
    if (!Array.isArray(node)) return;
    if (typeof node[0] === 'number' && typeof node[1] === 'number') {
      out.push([node[0], node[1]]);
      return;
    }
    for (const child of node) walk(child);
  };
  walk(coords);
  return out;
}

function firstPosition(coords: unknown): number[] {
  const all = flattenPositions(coords);
  return all[0] ? [all[0][0], all[0][1]] : [];
}

await main();
