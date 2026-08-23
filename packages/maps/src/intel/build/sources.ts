/**
 * Loading the per-map artifacts off disk.
 *
 * Artifact layout under `dev-assets/<mapId>/` (mirrors S3 `maps/<assetId>/`):
 *
 * ```
 * map.xodr                        <assetId>.xodr
 * map.geojson.gz                  <assetId>.geojson          (RoadRunner export)
 * lane-polygons.geojson.gz        <assetId>.lane-polygons.geojson
 * signals.geojson.gz              <assetId>.signals.geojson
 * topology-index.json.gz          <assetId>.topology-index.json
 * search-index.json.gz            <assetId>.search-index.json
 * enrichment/overlay-payload.json enrichment/overlay-payload.json
 * 3d/manifest.json                3d/manifest.json
 * ```
 *
 * Note the file-extension trap: several S3 objects are gzip-compressed but
 * named `.json`/`.geojson`. Every read here sniffs the gzip magic number rather
 * than trusting the extension.
 */

import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import path from 'node:path';

import { CoordinateFrame } from '../../opendrive.js';

import { asMapId, type MapId } from '../types/ids.js';
import type {
  GeoFeatureCollection,
  LanePolygonProperties,
  MapGeojsonProperties,
  OverlayPayload,
  SearchIndex,
  SignalProperties,
  TopologyIndex,
} from '../types/sources.js';
import { sha256 } from './hash.js';

/** Everything one map build reads. */
export interface MapSources {
  mapId: MapId;
  mapAssetId: string;
  dir: string;
  frame: CoordinateFrame;
  topology: TopologyIndex;
  searchIndex: SearchIndex | null;
  signals: GeoFeatureCollection<SignalProperties> | null;
  lanePolygons: GeoFeatureCollection<LanePolygonProperties> | null;
  mapGeojson: GeoFeatureCollection<MapGeojsonProperties> | null;
  overlay: OverlayPayload | null;
  /**
   * `roadId → display name`, for callers that already parsed the OpenDRIVE and
   * can hand over its `<road name>` attributes.
   *
   * The search index and street-name signs are the only other name sources, and
   * a map assembled from a bare `.xodr` plus geometry has neither — its road
   * names would otherwise be silently discarded even though the source file
   * states them. `loadMapSources` deliberately leaves this undefined so disk
   * builds of already-published maps keep their existing catalog identities.
   */
  roadNames?: Record<string, string>;
  /** `artifact name → sha256`. Feeds `catalogRevision`. */
  sourceHashes: Record<string, string>;
}

async function readMaybeGzip(file: string): Promise<Uint8Array | null> {
  if (!existsSync(file)) return null;
  return new Uint8Array(await readFile(file));
}

function decode<T>(bytes: Uint8Array): T {
  const plain = bytes[0] === 0x1f && bytes[1] === 0x8b ? gunzipSync(bytes) : bytes;
  return JSON.parse(new TextDecoder().decode(plain)) as T;
}

/**
 * Load every artifact for one map directory.
 *
 * Only `map.xodr` and `topology-index.json.gz` are required; the catalog
 * degrades gracefully (with fewer location types) when the optional artifacts
 * are absent, which is what makes the fixture-sized test builds possible.
 */
export async function loadMapSources(dir: string): Promise<MapSources> {
  const mapId = asMapId(path.basename(dir));
  const sourceHashes: Record<string, string> = {};

  const read = async <T>(name: string, file: string): Promise<T | null> => {
    const bytes = await readMaybeGzip(path.join(dir, file));
    if (!bytes) return null;
    sourceHashes[name] = sha256(bytes);
    return decode<T>(bytes);
  };

  const xodrPath = path.join(dir, 'map.xodr');
  if (!existsSync(xodrPath)) throw new Error(`loadMapSources: no map.xodr in ${dir}`);
  // The header is in the first few KB; hashing 6 MB of road network to identify
  // the file would be wasteful when the topology index already carries its sha.
  const xodrHandle = await readFile(xodrPath);
  const xodrHeaderText = xodrHandle.subarray(0, 8192).toString('utf8');

  const topology = await read<TopologyIndex>('topology-index', 'topology-index.json.gz');
  if (!topology) throw new Error(`loadMapSources: no topology-index.json.gz in ${dir}`);
  sourceHashes['xodr'] = topology.source?.xodrSha256 ?? sha256(xodrHandle);

  const manifestBytes = await readMaybeGzip(path.join(dir, '3d', 'manifest.json'));
  const manifest = manifestBytes
    ? decode<{ scene: { coordinateSystem?: string; origin?: number[]; bounds?: { min: number[]; max: number[] } } }>(
        manifestBytes,
      )
    : undefined;

  const frame = CoordinateFrame.fromMapAssets(xodrHeaderText, manifest);

  const searchIndex = await read<SearchIndex>('search-index', 'search-index.json.gz');
  const signals = await read<GeoFeatureCollection<SignalProperties>>(
    'signals',
    'signals.geojson.gz',
  );
  const lanePolygons = await read<GeoFeatureCollection<LanePolygonProperties>>(
    'lane-polygons',
    'lane-polygons.geojson.gz',
  );
  const mapGeojson = await read<GeoFeatureCollection<MapGeojsonProperties>>(
    'map-geojson',
    'map.geojson.gz',
  );
  const overlay = await read<OverlayPayload>(
    'overlay-payload',
    path.join('enrichment', 'overlay-payload.json'),
  );

  return {
    mapId,
    mapAssetId: searchIndex?.map_asset_id ?? topology.mapName ?? (mapId as string),
    dir,
    frame,
    topology,
    searchIndex,
    signals,
    lanePolygons,
    mapGeojson,
    overlay,
    sourceHashes,
  };
}
