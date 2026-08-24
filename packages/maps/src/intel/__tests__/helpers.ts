/**
 * Test fixtures.
 *
 * `mini-yale.json.gz` is a real carve of the Yale Street map around junction
 * 387 (a signalized four-way), produced by `scripts/extract-fixture.ts`. Using
 * real data rather than a hand-built toy network matters here: every defect
 * this package exists to avoid — non-contiguous "successors", drivable-only
 * `adjacentLanes`, positional `street:N` ids, junction lanes bounding every
 * road stub — is a property of the *real* artifacts, and a synthetic fixture
 * would quietly not have any of them.
 *
 * The full `dev-assets/` tree is gitignored, so tests that need all five maps
 * are gated on {@link devAssetsAvailable}.
 */

import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { gunzipSync } from 'node:zlib';

import { CoordinateFrame } from '../../opendrive.js';

import { asMapId } from '../types/ids.js';
import type { MapSources } from '../build/sources.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = path.join(HERE, 'fixtures', 'mini-yale.json.gz');
const REPO_ROOT = path.resolve(HERE, '..', '..', '..', '..');

/** Root of the (gitignored) per-map artifact tree. */
export const DEV_ASSETS = path.join(REPO_ROOT, 'dev-assets');

/** Maps expected under `dev-assets/`. */
export const ALL_MAPS = [
  'yale-street',
  'belmont-research-center',
  'el-camino-road',
  'easterbrook-discovery-school',
  'richmond-field-station',
] as const;

/** True when the full artifact tree is present locally. */
export function devAssetsAvailable(): boolean {
  return ALL_MAPS.every((m) => existsSync(path.join(DEV_ASSETS, m, 'topology-index.json.gz')));
}

interface Fixture {
  centreJunctionId: string;
  xodrHeaderText: string;
  sourceHashes: Record<string, string>;
  topology: unknown;
  searchIndex: unknown;
  signals: unknown;
  lanePolygons: unknown;
  mapGeojson: unknown;
  overlay: unknown;
}

let cached: Fixture | null = null;

function readFixture(): Fixture {
  if (!cached) {
    cached = JSON.parse(gunzipSync(readFileSync(FIXTURE)).toString('utf8')) as Fixture;
  }
  return cached;
}

/** The junction the fixture is centred on: signalized, four arms. */
export function fixtureCentreJunctionId(): string {
  return readFixture().centreJunctionId;
}

/**
 * Build a {@link MapSources} from the committed fixture.
 *
 * @param transform Optional hook to mutate the (deep-cloned) raw artifacts
 *   before they are wrapped — used by the input-order-permutation test.
 */
export function miniYaleSources(
  transform?: (raw: {
    topology: Record<string, unknown>;
    searchIndex: Record<string, unknown>;
    signals: Record<string, unknown>;
    lanePolygons: Record<string, unknown>;
    mapGeojson: Record<string, unknown>;
    overlay: Record<string, unknown>;
  }) => void,
): MapSources {
  const fixture = readFixture();
  const raw = structuredClone({
    topology: fixture.topology as Record<string, unknown>,
    searchIndex: fixture.searchIndex as Record<string, unknown>,
    signals: fixture.signals as Record<string, unknown>,
    lanePolygons: fixture.lanePolygons as Record<string, unknown>,
    mapGeojson: fixture.mapGeojson as Record<string, unknown>,
    overlay: fixture.overlay as Record<string, unknown>,
  });
  transform?.(raw);

  return {
    mapId: asMapId('mini-yale'),
    mapAssetId: 'mini-yale_fixture',
    dir: path.dirname(FIXTURE),
    frame: CoordinateFrame.fromMapAssets(fixture.xodrHeaderText),
    topology: raw.topology as unknown as MapSources['topology'],
    searchIndex: raw.searchIndex as unknown as MapSources['searchIndex'],
    signals: raw.signals as unknown as MapSources['signals'],
    lanePolygons: raw.lanePolygons as unknown as MapSources['lanePolygons'],
    mapGeojson: raw.mapGeojson as unknown as MapSources['mapGeojson'],
    overlay: raw.overlay as unknown as MapSources['overlay'],
    sourceHashes: { ...fixture.sourceHashes },
  };
}

/**
 * Deterministic shuffle (xorshift32) — the permutation test needs a *fixed*
 * reordering, not a random one, so a failure is reproducible.
 */
export function shuffle<T>(items: T[], seed = 0x9e3779b9): T[] {
  let state = seed >>> 0;
  const next = (): number => {
    state ^= state << 13;
    state >>>= 0;
    state ^= state >>> 17;
    state ^= state << 5;
    state >>>= 0;
    return state / 0x1_0000_0000;
  };
  const out = items.slice();
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(next() * (i + 1));
    [out[i], out[j]] = [out[j] as T, out[i] as T];
  }
  return out;
}

/** Rebuild an object with its keys in a different (deterministic) order. */
export function shuffleKeys<T>(record: Record<string, T>, seed?: number): Record<string, T> {
  const out: Record<string, T> = {};
  for (const key of shuffle(Object.keys(record), seed)) out[key] = record[key] as T;
  return out;
}
