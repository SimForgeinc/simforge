/**
 * Yale Street test fixtures.
 *
 * `dev-assets/` is not committed, so every suite that uses real map data guards
 * itself with `describe.skipIf(!hasYaleAssets())`. The loader deliberately goes
 * through `@simforge/maps/opendrive`' `decodeMaybeGzippedJson` — the same
 * code path the editor uses — rather than re-implementing gzip handling.
 *
 * Two indexes are available on purpose:
 *
 * - {@link loadYaleIndex} — map-intel's `derived/topology-derived.json(.gz)`
 *   through the normalizer, i.e. the production path;
 * - {@link loadYaleSelfDerived} — our own derivation from `topology-index`,
 *   which keeps this lane unblocked and gives the derived facts a second,
 *   independent implementation to be compared against.
 */

import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { decodeMaybeGzippedJson } from '@simforge/maps/opendrive';

import { deriveMapIndexFromTopology } from '../derive.js';
import type { RawSearchIndex, RawTopologyIndex } from '../derive.js';
import { normalizeDerivedMapIndex } from '../normalize.js';
import type { DerivedMapIndex } from '../types/map-index.js';

const here = dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = resolve(here, '../../../..');
export const YALE_DIR = resolve(REPO_ROOT, 'dev-assets/yale-st-palo-alto-ca');
export const YALE_TOPOLOGY = resolve(YALE_DIR, 'topology-index.json.gz');
export const YALE_SEARCH = resolve(YALE_DIR, 'search-index.json.gz');

/** map-intel's outputs, gzipped or plain. */
const derivedCandidates = [
  resolve(YALE_DIR, 'derived/topology-derived.json.gz'),
  resolve(YALE_DIR, 'derived/topology-derived.json'),
];
const locationCandidates = [
  resolve(YALE_DIR, 'derived/locations.json.gz'),
  resolve(YALE_DIR, 'derived/locations.json'),
];

const firstExisting = (paths: string[]): string | null => paths.find((p) => existsSync(p)) ?? null;

export function hasYaleAssets(): boolean {
  return existsSync(YALE_TOPOLOGY);
}

export function hasMapIntelDerived(): boolean {
  return firstExisting(derivedCandidates) !== null;
}

async function loadTopology(): Promise<RawTopologyIndex> {
  return decodeMaybeGzippedJson<RawTopologyIndex>(readFileSync(YALE_TOPOLOGY));
}

async function loadSearchIndex(): Promise<RawSearchIndex | undefined> {
  if (!existsSync(YALE_SEARCH)) return undefined;
  return decodeMaybeGzippedJson<RawSearchIndex>(readFileSync(YALE_SEARCH));
}

let cachedNormalized: Promise<DerivedMapIndex> | null = null;
let cachedSelfDerived: Promise<DerivedMapIndex> | null = null;

/** map-intel's derived index when present, our own derivation otherwise. */
export function loadYaleIndex(): Promise<DerivedMapIndex> {
  if (cachedNormalized) return cachedNormalized;
  cachedNormalized = (async () => {
    const derivedPath = firstExisting(derivedCandidates);
    if (!derivedPath) return loadYaleSelfDerived();
    const [topology, searchIndex] = await Promise.all([loadTopology(), loadSearchIndex()]);
    const derived = await decodeMaybeGzippedJson<Record<string, unknown>>(readFileSync(derivedPath));
    const locationsPath = firstExisting(locationCandidates);
    const locations = locationsPath
      ? await decodeMaybeGzippedJson<unknown>(readFileSync(locationsPath))
      : undefined;
    return normalizeDerivedMapIndex(derived, {
      mapId: 'yale-st-palo-alto-ca',
      topology,
      ...(searchIndex ? { searchIndex } : {}),
      ...(locations ? { locations } : {}),
    });
  })();
  return cachedNormalized;
}

/** Our own derivation, straight from `topology-index.json.gz`. */
export function loadYaleSelfDerived(): Promise<DerivedMapIndex> {
  if (cachedSelfDerived) return cachedSelfDerived;
  cachedSelfDerived = (async () => {
    const [topology, searchIndex] = await Promise.all([loadTopology(), loadSearchIndex()]);
    return deriveMapIndexFromTopology(topology, {
      mapId: 'yale-st-palo-alto-ca',
      ...(searchIndex ? { searchIndex } : {}),
    });
  })();
  return cachedSelfDerived;
}
