/**
 * Map artifacts: discovery, loading, and the two indexes everything above needs.
 *
 * A "map bundle" is the join of the three producers:
 *
 * | artifact | producer | consumer here |
 * |---|---|---|
 * | `topology-index.json.gz` | the map pipeline | `sim-engine`'s `LaneGraph`, and the lane/gate spine the matcher normalizer needs |
 * | `derived/topology-derived.json.gz` | `map-intel` | the matcher's `DerivedMapIndex` |
 * | `derived/locations.json.gz` | `map-intel` | the location catalog + the matcher's crossing / parking point features |
 *
 * Everything is loaded lazily and memoised per process, because `uniscenarios batch`
 * runs hundreds of cells against the same three files and the `LaneGraph` build
 * is the single most expensive thing in the CLI.
 */

import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { gunzipSync } from 'node:zlib';

import {
  KNOWN_MAPS,
  type DerivedTopology,
  type LocationCatalog,
} from '@uniscenarios/map-intel';
import {
  normalizeDerivedMapIndex,
  type DerivedMapIndex,
} from '@uniscenarios/anchor-matcher';
import { topologyWithMapSpeedLimits } from './map-signals.js';
import { buildLaneGraph, type LaneGraph, type TopologyIndex } from '@uniscenarios/sim-engine';

import { CliError } from './errors.js';
import type { MapSignalCatalog } from './map-signals.js';
import { loadMapSignalCatalog } from './map-signals-loader.js';

export { KNOWN_MAPS };

const HERE = path.dirname(fileURLToPath(import.meta.url));
/** `packages/cli/src` → repo root. */
export const REPO_ROOT = path.resolve(HERE, '..', '..', '..');
export const DEV_ASSETS = process.env['SCEN_DEV_ASSETS']
  ? path.resolve(process.env['SCEN_DEV_ASSETS'])
  : path.join(REPO_ROOT, 'dev-assets');

/** Artifact file names, relative to `dev-assets/<mapId>/`. */
export const ARTIFACTS = {
  topology: 'topology-index.json.gz',
  derived: path.join('derived', 'topology-derived.json.gz'),
  locations: path.join('derived', 'locations.json.gz'),
  searchIndex: 'search-index.json.gz',
} as const;

export interface MapArtifactPresence {
  readonly topologyIndex: boolean;
  readonly derivedTopology: boolean;
  readonly locations: boolean;
  readonly searchIndex: boolean;
}

export function mapDir(mapId: string): string {
  return path.join(DEV_ASSETS, mapId);
}

export function artifactPresence(mapId: string): MapArtifactPresence {
  const dir = mapDir(mapId);
  return {
    topologyIndex: existsSync(path.join(dir, ARTIFACTS.topology)),
    derivedTopology: existsSync(path.join(dir, ARTIFACTS.derived)),
    locations: existsSync(path.join(dir, ARTIFACTS.locations)),
    searchIndex: existsSync(path.join(dir, ARTIFACTS.searchIndex)),
  };
}

/** Maps that exist on disk, in the canonical order. */
export function availableMaps(): string[] {
  return KNOWN_MAPS.filter((id) => existsSync(mapDir(id)));
}

async function readJsonGz<T>(file: string, code: string): Promise<T> {
  let bytes: Buffer;
  try {
    bytes = await readFile(file);
  } catch {
    throw new CliError(code, `missing artifact ${path.relative(REPO_ROOT, file)}`, {
      path: file,
      detail: { hint: 'run `pnpm --filter @uniscenarios/map-intel build:map -- --all`' },
    });
  }
  const plain = bytes[0] === 0x1f && bytes[1] === 0x8b ? gunzipSync(bytes) : bytes;
  return JSON.parse(plain.toString('utf8')) as T;
}

/** Everything the CLI knows about one map. Built once, shared across cells. */
export interface MapBundle {
  readonly mapId: string;
  readonly catalog: LocationCatalog;
  readonly derived: DerivedTopology;
  readonly topology: TopologyIndex;
  /** The matcher's view — derived facts adopted from `map-intel`. */
  readonly index: DerivedMapIndex;
  /** The engine's view — directed lanes with geometric successors. */
  readonly graph: LaneGraph;
  /** Physical heads + OpenDRIVE controller/junction sequence bindings. */
  readonly signalCatalog: MapSignalCatalog;
}

const cache = new Map<string, Promise<MapBundle>>();

export function assertKnownMap(mapId: string): void {
  if (!(KNOWN_MAPS as readonly string[]).includes(mapId)) {
    throw new CliError('unknown_map', `no such map "${mapId}"`, {
      path: '--map',
      detail: { known: [...KNOWN_MAPS] },
    });
  }
  if (!existsSync(mapDir(mapId))) {
    throw new CliError('map_not_present', `dev-assets/${mapId} is not on disk`, {
      path: '--map',
      detail: { devAssets: DEV_ASSETS },
    });
  }
}

/** Load (and memoise) a map bundle. */
export function loadMap(mapId: string): Promise<MapBundle> {
  const cached = cache.get(mapId);
  if (cached) return cached;
  const built = (async (): Promise<MapBundle> => {
    assertKnownMap(mapId);
    const dir = mapDir(mapId);
    const [rawTopology, derived, catalog, signalCatalog] = await Promise.all([
      readJsonGz<TopologyIndex>(path.join(dir, ARTIFACTS.topology), 'missing_topology_index'),
      readJsonGz<DerivedTopology>(path.join(dir, ARTIFACTS.derived), 'missing_derived_topology'),
      readJsonGz<LocationCatalog>(path.join(dir, ARTIFACTS.locations), 'missing_location_catalog'),
      loadMapSignalCatalog(path.join(dir, 'map.xodr'), path.join(dir, 'signals.geojson.gz')),
    ]);
    const topology = topologyWithMapSpeedLimits(rawTopology, signalCatalog);
    const index = normalizeDerivedMapIndex(derived as unknown, {
      mapId,
      // The derived file carries only the derived layers; lanes and gates live
      // in the topology index, so the normalizer needs both.
      topology: topology as never,
      locations: catalog as unknown,
    });
    const graph = buildLaneGraph(topology);
    return { mapId, catalog, derived, topology, index, graph, signalCatalog };
  })();
  cache.set(mapId, built);
  return built;
}

/** Resolve `--map` / `--maps` / `--all-maps` into an ordered map id list. */
export function resolveMapSelection(options: {
  map?: string | undefined;
  maps?: readonly string[] | undefined;
  allMaps?: boolean;
}): string[] {
  if (options.allMaps) return availableMaps();
  if (options.maps && options.maps.length > 0) {
    for (const id of options.maps) assertKnownMap(id);
    return [...options.maps];
  }
  if (options.map) {
    assertKnownMap(options.map);
    return [options.map];
  }
  throw new CliError('missing_option', 'one of --map, --maps or --all-maps is required', {
    path: '--map',
  });
}
