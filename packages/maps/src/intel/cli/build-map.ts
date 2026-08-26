/**
 * Offline catalog builder.
 *
 * ```
 * pnpm --filter ../../index.js build:map -- --map yale-st-palo-alto-ca
 * pnpm --filter ../../index.js build:map -- --all
 * ```
 *
 * Emits, per map, into `dev-assets/<map>/derived/`:
 *
 * - `locations.json.gz`        — the location catalog
 * - `topology-derived.json.gz` — segments, junction descriptors, fact index
 *
 * Both carry the same `catalogRevision` (a hash over the source artifact
 * hashes), which is the cache key: unchanged sources ⇒ unchanged revision ⇒ the
 * artifact does not need rebuilding, and any consumer that stamped the old
 * revision knows to re-derive.
 */

import { existsSync } from 'node:fs';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { gunzipSync, gzipSync } from 'node:zlib';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { buildMapIntelFromDir, type MapIntelBuild } from '../build/build.js';
import { DECLARED_FACT_KEYS } from '../build/facts.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '..', '..', '..', '..');
const DEV_ASSETS = path.join(REPO_ROOT, 'dev-assets');

/** Maps shipped in `dev-assets/`, in build order. */
export const KNOWN_MAPS = [
  'yale-st-palo-alto-ca',
  'belmont-office-park-belmont-ca',
  'el-camino-rd-palo-alto-ca',
  'saratoga-school-area',
  'richmond-field-station-richmond-ca',
] as const;

interface Args {
  maps: string[];
  outRoot: string;
  json: boolean;
}

function parseArgs(argv: readonly string[]): Args {
  const maps: string[] = [];
  let outRoot = DEV_ASSETS;
  let json = false;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    // pnpm forwards `--` through to the script; ignore the separator itself.
    if (arg === '--') continue;
    if (arg === '--all') maps.push(...KNOWN_MAPS);
    else if (arg === '--map') maps.push(String(argv[++i] ?? ''));
    else if (arg === '--out-root') outRoot = path.resolve(String(argv[++i] ?? ''));
    else if (arg === '--json') json = true;
    else if (arg === '--help' || arg === '-h') {
      process.stdout.write(
        'usage: build:map [--map <id> ...] [--all] [--out-root <dir>] [--json]\n',
      );
      process.exit(0);
    } else if (arg?.startsWith('--')) {
      throw new Error(`unknown flag ${arg}`);
    }
  }
  return { maps: [...new Set(maps.filter(Boolean))], outRoot, json };
}

/** Write one map's derived artifacts. Returns the emitted file sizes. */
export async function emitBuild(
  outRoot: string,
  mapId: string,
  build: MapIntelBuild,
): Promise<{ locationsBytes: number; derivedBytes: number; dir: string }> {
  const dir = path.join(outRoot, mapId, 'derived');
  await mkdir(dir, { recursive: true });
  const locations = gzipSync(Buffer.from(JSON.stringify(build.catalog)), { level: 9 });
  const derived = gzipSync(Buffer.from(JSON.stringify(build.derived)), { level: 9 });
  await writeFile(path.join(dir, 'locations.json.gz'), locations);
  await writeFile(path.join(dir, 'topology-derived.json.gz'), derived);
  return { locationsBytes: locations.byteLength, derivedBytes: derived.byteLength, dir };
}

/** Read a previously emitted catalog back. */
export async function readEmitted<T>(outRoot: string, mapId: string, file: string): Promise<T> {
  const bytes = await readFile(path.join(outRoot, mapId, 'derived', file));
  const plain = bytes[0] === 0x1f && bytes[1] === 0x8b ? gunzipSync(bytes) : bytes;
  return JSON.parse(plain.toString('utf8')) as T;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (args.maps.length === 0) {
    process.stderr.write('build:map: pass --map <id> or --all\n');
    process.exit(2);
  }

  const report: Record<string, unknown>[] = [];
  const producedAcrossMaps = new Set<string>();

  for (const mapId of args.maps) {
    const dir = path.join(DEV_ASSETS, mapId);
    if (!existsSync(dir)) {
      process.stderr.write(`build:map: no dev-assets/${mapId}\n`);
      process.exitCode = 1;
      continue;
    }
    const started = Date.now();
    const build = await buildMapIntelFromDir(dir);
    const emitted = await emitBuild(args.outRoot, mapId, build);
    for (const key of build.audit.produced) producedAcrossMaps.add(key);

    const entry = {
      map: mapId,
      catalogRevision: build.catalog.catalogRevision,
      locations: build.catalog.stats.locationCount,
      byType: build.catalog.stats.byType,
      anchorQuality: build.catalog.stats.anchorQuality,
      relations: build.catalog.stats.relationCount,
      handleCollisionsResolved: build.catalog.stats.handleCollisionsResolved,
      handleLadderUsage: build.catalog.stats.handleLadderUsage,
      segments: build.derived.stats.segmentCount,
      junctions: build.derived.stats.junctionCount,
      conflictPairs: build.derived.stats.conflictPairCount,
      conflictPairsByRelation: build.derived.stats.conflictPairsByRelation,
      junctionsByControl: build.derived.stats.junctionsByControl,
      duplicateIds: build.duplicateIds,
      skippedKinds: build.skippedKinds,
      missingConditionalFacts: build.audit.missingConditional,
      locationsGzBytes: emitted.locationsBytes,
      derivedGzBytes: emitted.derivedBytes,
      ms: Date.now() - started,
    };
    report.push(entry);
    if (!args.json) {
      process.stdout.write(
        `${mapId}: ${entry.locations} locations, ${entry.relations} relations, ` +
          `${entry.segments} segments, ${entry.junctions} junctions, ` +
          `${entry.conflictPairs} conflict pairs, rev ${entry.catalogRevision} ` +
          `(${Math.round(emitted.locationsBytes / 1024)} KB + ${Math.round(emitted.derivedBytes / 1024)} KB gz, ${entry.ms} ms)\n`,
      );
    }
  }

  // The declared-vocabulary assertion across the whole build: a `conditional`
  // key that no map produces is still a declared-but-never-written fact.
  const neverProduced = DECLARED_FACT_KEYS.filter((s) => !producedAcrossMaps.has(s.key)).map((s) => s.key);
  if (args.maps.length >= 2 && neverProduced.length > 0) {
    process.stderr.write(
      `build:map: declared fact keys produced by no map in this run: ${neverProduced.join(', ')}\n`,
    );
    process.exitCode = 1;
  }

  if (args.json) process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
}

const invokedDirectly =
  process.argv[1] !== undefined &&
  path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));

if (invokedDirectly) {
  main().catch((err: unknown) => {
    process.stderr.write(`build:map failed: ${err instanceof Error ? err.stack : String(err)}\n`);
    process.exit(1);
  });
}
