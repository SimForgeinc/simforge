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
 * Everything is loaded lazily and memoised per process, because `simforge batch`
 * runs hundreds of cells against the same three files and the `LaneGraph` build
 * is the single most expensive thing in the CLI.
 */

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { gunzipSync } from 'node:zlib';
import { createHash } from 'node:crypto';
import { homedir } from 'node:os';

import type { DerivedTopology, LocationCatalog } from '@simforge-oss/maps/node';
import {
  normalizeDerivedMapIndex,
  type DerivedMapIndex,
} from './anchor/index.js';
import { parseMapSignalCatalog, topologyWithMapSpeedLimits, type SignalGeoJson } from './map-signals.js';
import { buildLaneGraph, type LaneGraph, type TopologyIndex } from '@simforge-oss/engine';

import { CliError } from './errors.js';
import type { MapSignalCatalog } from './map-signals.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
/** `packages/cli/src` → repo root. */
export const REPO_ROOT = path.resolve(HERE, '..', '..', '..');
export const DEV_ASSETS = process.env['SCEN_DEV_ASSETS']
  ? path.resolve(process.env['SCEN_DEV_ASSETS'])
  : path.join(path.resolve(process.env['SIMFORGE_MAPS_CACHE_ROOT'] ?? path.join(process.env['XDG_DATA_HOME'] ?? path.join(homedir(), '.local', 'share'), 'simforge', 'maps')), 'dev-assets');

/** Artifact file names, relative to `dev-assets/<mapId>/`. */
export const ARTIFACTS = {
  topology: 'topology-index.json.gz',
  derived: path.join('derived', 'topology-derived.json.gz'),
  locations: path.join('derived', 'locations.json.gz'),
  searchIndex: 'search-index.json.gz',
} as const;

const MAP_ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const REQUIRED_FILES = ['map.xodr', 'signals.geojson.gz', ARTIFACTS.topology, ARTIFACTS.derived, ARTIFACTS.locations];
interface InstallationReceipt {
  schema: 'simforge.map-installation.v1';
  name: string;
  releaseDigest: string;
  profile: 'semantic' | 'native' | 'web';
  members: Record<string, { sha256: string; bytes: number }>;
}
const installationCache = new Map<string, { signature: string; receipt: InstallationReceipt }>();

function installation(dir: string, mapId: string): InstallationReceipt | undefined {
  const file = path.join(dir, '.map-release.json');
  const stat = statSync(file, { throwIfNoEntry: false });
  if (!stat) return undefined;
  const signature = `${stat.ino}:${stat.size}:${stat.mtimeMs}`;
  const cached = installationCache.get(file);
  if (cached?.signature === signature) return cached.receipt;
  const receipt = JSON.parse(readFileSync(file, 'utf8')) as InstallationReceipt;
  if (receipt.schema !== 'simforge.map-installation.v1' || receipt.name !== mapId
    || !['semantic', 'native', 'web'].includes(receipt.profile) || !/^[a-f0-9]{64}$/.test(receipt.releaseDigest)
    || !receipt.members || REQUIRED_FILES.some((name) => !receipt.members[name])) {
    throw new CliError('invalid_map_installation', `invalid installed release for "${mapId}"`, { path: file });
  }
  if (installationCache.size >= 32) installationCache.delete(installationCache.keys().next().value!);
  installationCache.set(file, { signature, receipt });
  return receipt;
}

export interface MapArtifactPresence {
  readonly topologyIndex: boolean;
  readonly derivedTopology: boolean;
  readonly locations: boolean;
  readonly searchIndex: boolean;
}

export function mapDir(mapId: string, root = DEV_ASSETS): string {
  if (!MAP_ID.test(mapId)) throw new CliError('unknown_map', `invalid map identifier "${mapId}"`, { path: '--map' });
  return path.join(path.resolve(root), mapId);
}

export function artifactPresence(mapId: string, root = DEV_ASSETS): MapArtifactPresence {
  const dir = mapDir(mapId, root);
  return {
    topologyIndex: existsSync(path.join(dir, ARTIFACTS.topology)),
    derivedTopology: existsSync(path.join(dir, ARTIFACTS.derived)),
    locations: existsSync(path.join(dir, ARTIFACTS.locations)),
    searchIndex: existsSync(path.join(dir, ARTIFACTS.searchIndex)),
  };
}

/** Complete installed bundles, in stable lexical order; no curated-name allowlist. */
export function availableMaps(root = DEV_ASSETS): string[] {
  let entries;
  try { entries = readdirSync(root, { withFileTypes: true }); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []; throw error; }
  return entries.filter((entry) => MAP_ID.test(entry.name) && (entry.isDirectory() || entry.isSymbolicLink())
    && REQUIRED_FILES.every((file) => statSync(path.join(root, entry.name, file), { throwIfNoEntry: false })?.isFile()))
    .map((entry) => entry.name).sort();
}

async function readMapBytes(file: string, code: string, expected?: { sha256: string; bytes: number }): Promise<Buffer> {
  let bytes: Buffer;
  try {
    bytes = await readFile(file);
  } catch {
    throw new CliError(code, `missing artifact ${path.relative(REPO_ROOT, file)}`, {
      path: file,
      detail: { hint: 'pull the complete map release with `simforge maps pull <name>@<version>`' },
    });
  }
  if (expected && (bytes.length !== expected.bytes || createHash('sha256').update(bytes).digest('hex') !== expected.sha256)) {
    throw new CliError('map_installation_digest_mismatch', `installed map resource changed: ${file}`, { path: file });
  }
  return bytes;
}

async function readJsonGz<T>(file: string, code: string, expected?: { sha256: string; bytes: number }): Promise<T> {
  const bytes = await readMapBytes(file, code, expected);
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

const cache = new Map<string, { identity: string; bundle: Promise<MapBundle> }>();

export function assertKnownMap(mapId: string, root = DEV_ASSETS): void {
  const dir = mapDir(mapId, root);
  if (!statSync(dir, { throwIfNoEntry: false })?.isDirectory()) {
    throw new CliError('unknown_map', `no installed map "${mapId}"`, { path: '--map', detail: { known: availableMaps(root), devAssets: root } });
  }
  const missing = REQUIRED_FILES.filter((file) => !statSync(path.join(dir, file), { throwIfNoEntry: false })?.isFile());
  if (missing.length) throw new CliError('map_not_present', `map "${mapId}" is incomplete`, { path: '--map', detail: { devAssets: root, missing } });
}

/** Load (and memoise) a map bundle. */
export function loadMap(mapId: string, root = DEV_ASSETS): Promise<MapBundle> {
  let dir: string, receipt: InstallationReceipt | undefined, identity: string;
  try {
    assertKnownMap(mapId, root);
    dir = mapDir(mapId, root);
    receipt = installation(dir, mapId);
    identity = receipt?.releaseDigest ?? REQUIRED_FILES.map((file) => {
      const stat = statSync(path.join(dir, file));
      return `${stat.ino}:${stat.size}:${stat.mtimeMs}`;
    }).join('|');
  } catch (error) { return Promise.reject(error); }
  const cached = cache.get(dir);
  if (cached?.identity === identity) return cached.bundle;
  const expected = (file: string) => receipt?.members[file.split(path.sep).join('/')];
  const built = (async (): Promise<MapBundle> => {
    const [rawTopology, derived, catalog, xodr, signals] = await Promise.all([
      readJsonGz<TopologyIndex>(path.join(dir, ARTIFACTS.topology), 'missing_topology_index', expected(ARTIFACTS.topology)),
      readJsonGz<DerivedTopology>(path.join(dir, ARTIFACTS.derived), 'missing_derived_topology', expected(ARTIFACTS.derived)),
      readJsonGz<LocationCatalog>(path.join(dir, ARTIFACTS.locations), 'missing_location_catalog', expected(ARTIFACTS.locations)),
      readMapBytes(path.join(dir, 'map.xodr'), 'missing_xodr', expected('map.xodr')),
      readJsonGz<SignalGeoJson>(path.join(dir, 'signals.geojson.gz'), 'missing_signals', expected('signals.geojson.gz')),
    ]);
    if (rawTopology.source?.xodrSha256 && rawTopology.source.xodrSha256 !== createHash('sha256').update(xodr).digest('hex')) {
      throw new CliError('map_topology_source_mismatch', `map "${mapId}" mixes different OpenDRIVE and topology versions`, { path: dir });
    }
    const signalCatalog = parseMapSignalCatalog(xodr.toString('utf8'), signals);
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
  })().catch((error) => { if (cache.get(dir)?.bundle === built) cache.delete(dir); throw error; });
  if (cache.size >= 32) cache.delete(cache.keys().next().value!);
  cache.set(dir, { identity, bundle: built });
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
