/**
 * `findLocations` — the structured query surface.
 *
 * Behaviours carried over deliberately from the prior tool surface because they
 * worked: closed vocabularies injected into the schema from one constant, hard
 * per-call caps with actionable errors, `matchedReasons[]`, diversity
 * clustering. Behaviours fixed because they did not:
 *
 * - the subject's own pose comes back inline (whole {@link StudioLocation}),
 *   not an id the caller has to re-fetch;
 * - `anyOf`/`allOf`/`noneOf` exist on tags, affordances and facts;
 * - a filter on an unknown fact key is an **error**, not an empty result — that
 *   is what made the never-written `is_t_intersection` invisible for months.
 *
 * The optional {@link FactIndex} is used for candidate *narrowing* only. It is
 * always a superset filter, so index and linear paths return identical results;
 * a test asserts exactly that.
 */

import { LOCATION_TYPES, type FactValue, type StudioLocation } from '../types/location.js';
import { AFFORDANCES, type LocationCatalog } from '../types/location.js';
import type { FactIndex } from '../types/topology.js';
import { factKeyOf } from '../build/fact-index.js';
import { metresPerDegree } from '../geometry/vec.js';
import { compareStrings } from '../build/compare.js';
import {
  DEFAULT_RESULT_LIMIT,
  MAX_RESULT_LIMIT,
  MapIntelQueryError,
  type FactFilter,
  type FactFilterGroup,
  type FindLocationsQuery,
  type LocationMatch,
  type SetFilter,
} from './types.js';

/** Options for {@link findLocations}. */
export interface FindOptions {
  /** Candidate-narrowing index. Omit for a pure linear scan. */
  index?: FactIndex;
}

interface NormalisedSet {
  anyOf: string[];
  allOf: string[];
  noneOf: string[];
}

/** Run a structured query against a built catalog. */
export function findLocations(
  catalog: LocationCatalog,
  query: FindLocationsQuery = {},
  options: FindOptions = {},
): LocationMatch[] {
  const limit = resolveLimit(query.limit);
  const byId = idIndex(catalog);

  const type = normaliseSet(query.type, 'type', LOCATION_TYPES);
  const subtype = normaliseSet(query.subtype, 'subtype');
  const tags = normaliseSet(query.tags, 'tags');
  const affordances = normaliseSet(query.affordances, 'affordances', AFFORDANCES);
  const anchorQuality = normaliseSet(query.anchorQuality, 'anchorQuality', [
    'exact',
    'projected',
    'inferred',
    'unanchored',
  ]);
  const facts = normaliseFacts(query.facts, catalog);

  let anchor: StudioLocation | undefined;
  if (query.near) {
    anchor = byId.get(query.near.id);
    if (!anchor) {
      throw new MapIntelQueryError(
        'unknown_reference',
        'near.id',
        `no location with id or handle ${JSON.stringify(query.near.id)} on map ${catalog.mapId}`,
      );
    }
    if (!(query.near.withinM > 0)) {
      throw new MapIntelQueryError('invalid_value', 'near.withinM', 'must be a positive number');
    }
  }

  const candidates = narrow(catalog, options.index, type, subtype, tags, affordances);

  const matches: LocationMatch[] = [];
  for (const loc of candidates) {
    const reasons: string[] = [];
    if (!matchSet(loc.type, type, 'type', reasons)) continue;
    if (!matchSet(loc.subtype ?? '', subtype, 'subtype', reasons)) continue;
    if (!matchSetMulti(loc.tags, tags, 'tag', reasons)) continue;
    if (!matchSetMulti(loc.affordances, affordances, 'affordance', reasons)) continue;
    if (!matchSet(loc.quality.anchor, anchorQuality, 'anchorQuality', reasons)) continue;
    if (query.requireRoadAnchor && !loc.anchor.road) continue;
    if (query.requireRoadAnchor) reasons.push('placeable (has road anchor)');
    if (!matchFacts(loc, facts, reasons)) continue;

    let distanceM: number | undefined;
    if (anchor && query.near) {
      distanceM = geoDistance(anchor, loc);
      if (distanceM > query.near.withinM) continue;
      reasons.push(`within ${query.near.withinM} m of ${anchor.handle} (${distanceM.toFixed(1)} m)`);
    }

    matches.push({
      location: loc,
      score: scoreOf(reasons.length, distanceM, query.near?.withinM),
      ...(distanceM === undefined ? {} : { distanceM: Math.round(distanceM * 10) / 10 }),
      matchedReasons: reasons,
    });
  }

  sortMatches(matches, query.sort ?? (query.near ? 'distance' : 'relevance'));

  const diversified = query.diversityRadiusM
    ? diversify(matches, query.diversityRadiusM)
    : matches;
  return diversified.slice(0, limit);
}

/** Same query, forced through the linear path. Used by the agreement test. */
export function findLocationsLinear(
  catalog: LocationCatalog,
  query: FindLocationsQuery = {},
): LocationMatch[] {
  return findLocations(catalog, query, {});
}

function resolveLimit(limit: number | undefined): number {
  if (limit === undefined) return DEFAULT_RESULT_LIMIT;
  if (!Number.isInteger(limit) || limit < 1) {
    throw new MapIntelQueryError('invalid_value', 'limit', 'must be a positive integer');
  }
  if (limit > MAX_RESULT_LIMIT) return MAX_RESULT_LIMIT;
  return limit;
}

const ID_INDEX_CACHE = new WeakMap<LocationCatalog, Map<string, StudioLocation>>();

/** `id` **and** `handle` → record. Cached per catalog object. */
export function idIndex(catalog: LocationCatalog): Map<string, StudioLocation> {
  const cached = ID_INDEX_CACHE.get(catalog);
  if (cached) return cached;
  const map = new Map<string, StudioLocation>();
  for (const loc of catalog.locations) {
    map.set(loc.id as string, loc);
    map.set(loc.handle as string, loc);
  }
  ID_INDEX_CACHE.set(catalog, map);
  return map;
}

function normaliseSet(
  filter: SetFilter<string> | undefined,
  path: string,
  vocabulary?: readonly string[],
): NormalisedSet | null {
  if (filter === undefined) return null;
  let out: NormalisedSet;
  if (typeof filter === 'string') out = { anyOf: [filter], allOf: [], noneOf: [] };
  else if (Array.isArray(filter)) out = { anyOf: [...filter], allOf: [], noneOf: [] };
  else {
    const f = filter as { anyOf?: readonly string[]; allOf?: readonly string[]; noneOf?: readonly string[] };
    out = { anyOf: [...(f.anyOf ?? [])], allOf: [...(f.allOf ?? [])], noneOf: [...(f.noneOf ?? [])] };
  }
  if (vocabulary) {
    for (const value of [...out.anyOf, ...out.allOf, ...out.noneOf]) {
      if (!vocabulary.includes(value)) {
        throw new MapIntelQueryError(
          'unknown_value',
          path,
          `${JSON.stringify(value)} is not a valid ${path}`,
          vocabulary,
        );
      }
    }
  }
  return out;
}

function normaliseFacts(group: FactFilterGroup | undefined, catalog: LocationCatalog): {
  anyOf: FactFilter[];
  allOf: FactFilter[];
  noneOf: FactFilter[];
} | null {
  if (!group) return null;
  const out = Array.isArray(group)
    ? { anyOf: [], allOf: [...group], noneOf: [] }
    : {
        anyOf: [...((group as { anyOf?: FactFilter[] }).anyOf ?? [])],
        allOf: [...((group as { allOf?: FactFilter[] }).allOf ?? [])],
        noneOf: [...((group as { noneOf?: FactFilter[] }).noneOf ?? [])],
      };
  const known = knownFactKeys(catalog);
  for (const filter of [...out.anyOf, ...out.allOf, ...out.noneOf]) {
    if (!known.has(filter.key)) {
      throw new MapIntelQueryError(
        'unknown_fact_key',
        `facts.${filter.key}`,
        `no location on map ${catalog.mapId} carries this fact key`,
        [...known].sort(),
      );
    }
  }
  return out;
}

const FACT_KEY_CACHE = new WeakMap<LocationCatalog, Set<string>>();

/** Every fact key present anywhere in the catalog. */
export function knownFactKeys(catalog: LocationCatalog): Set<string> {
  const cached = FACT_KEY_CACHE.get(catalog);
  if (cached) return cached;
  const keys = new Set<string>();
  for (const loc of catalog.locations) for (const key of Object.keys(loc.facts)) keys.add(key);
  FACT_KEY_CACHE.set(catalog, keys);
  return keys;
}

/**
 * Candidate narrowing.
 *
 * Only ever *removes* records that a subsequent full predicate check would also
 * remove, so the index can never change the answer — only how many records get
 * examined.
 */
function narrow(
  catalog: LocationCatalog,
  index: FactIndex | undefined,
  type: NormalisedSet | null,
  subtype: NormalisedSet | null,
  tags: NormalisedSet | null,
  affordances: NormalisedSet | null,
): StudioLocation[] {
  if (!index) return catalog.locations;
  const buckets: string[][] = [];
  const collect = (record: Record<string, readonly string[]>, set: NormalisedSet | null): void => {
    if (!set) return;
    // `anyOf` is a union; `allOf` entries each restrict independently.
    if (set.anyOf.length > 0) {
      buckets.push([...new Set(set.anyOf.flatMap((v) => record[v] ?? []))]);
    }
    for (const value of set.allOf) buckets.push([...(record[value] ?? [])]);
  };
  collect(index.locationsByType, type);
  collect(index.locationsBySubtype, subtype);
  collect(index.locationsByTag, tags);
  collect(index.locationsByAffordance, affordances);
  if (buckets.length === 0) return catalog.locations;

  // Selectivity ordering: intersect starting from the rarest bucket.
  buckets.sort((a, b) => a.length - b.length);
  let acc = new Set(buckets[0] as string[]);
  for (let i = 1; i < buckets.length && acc.size > 0; i++) {
    const next = new Set(buckets[i] as string[]);
    acc = new Set([...acc].filter((id) => next.has(id)));
  }
  const byId = idIndex(catalog);
  return catalog.locations.filter((l) => acc.has(l.id as string) && byId.has(l.id as string));
}

function matchSet(
  value: string,
  set: NormalisedSet | null,
  label: string,
  reasons: string[],
): boolean {
  if (!set) return true;
  if (set.noneOf.includes(value)) return false;
  if (set.allOf.length > 0 && set.allOf.some((v) => v !== value)) return false;
  if (set.anyOf.length > 0 && !set.anyOf.includes(value)) return false;
  if (set.anyOf.length > 0 || set.allOf.length > 0) reasons.push(`${label}=${value}`);
  return true;
}

function matchSetMulti(
  values: readonly string[],
  set: NormalisedSet | null,
  label: string,
  reasons: string[],
): boolean {
  if (!set) return true;
  const owned = new Set(values);
  for (const v of set.noneOf) if (owned.has(v)) return false;
  for (const v of set.allOf) {
    if (!owned.has(v)) return false;
    reasons.push(`${label}=${v}`);
  }
  if (set.anyOf.length > 0) {
    const hit = set.anyOf.filter((v) => owned.has(v));
    if (hit.length === 0) return false;
    for (const v of hit) reasons.push(`${label}=${v}`);
  }
  return true;
}

function matchFacts(
  loc: StudioLocation,
  facts: { anyOf: FactFilter[]; allOf: FactFilter[]; noneOf: FactFilter[] } | null,
  reasons: string[],
): boolean {
  if (!facts) return true;
  for (const filter of facts.noneOf) if (evaluateFact(loc, filter)) return false;
  for (const filter of facts.allOf) {
    if (!evaluateFact(loc, filter)) return false;
    reasons.push(describeFilter(loc, filter));
  }
  if (facts.anyOf.length > 0) {
    const hit = facts.anyOf.filter((f) => evaluateFact(loc, f));
    if (hit.length === 0) return false;
    for (const f of hit) reasons.push(describeFilter(loc, f));
  }
  return true;
}

function evaluateFact(loc: StudioLocation, filter: FactFilter): boolean {
  const actual = loc.facts[filter.key];
  switch (filter.op) {
    case 'exists':
      return actual !== undefined;
    case 'missing':
      return actual === undefined;
    case 'eq':
      return actual !== undefined && factKeyOf(actual) === factKeyOf(filter.value as FactValue);
    case 'ne':
      return actual === undefined || factKeyOf(actual) !== factKeyOf(filter.value as FactValue);
    case 'gt':
    case 'gte':
    case 'lt':
    case 'lte': {
      if (typeof actual !== 'number' || typeof filter.value !== 'number') return false;
      if (filter.op === 'gt') return actual > filter.value;
      if (filter.op === 'gte') return actual >= filter.value;
      if (filter.op === 'lt') return actual < filter.value;
      return actual <= filter.value;
    }
    case 'in': {
      if (actual === undefined || !Array.isArray(filter.value)) return false;
      return (filter.value as readonly unknown[]).some((v) => factKeyOf(v as FactValue) === factKeyOf(actual));
    }
    case 'contains': {
      if (Array.isArray(actual)) {
        return (actual as readonly unknown[]).some(
          (v) => factKeyOf(v as FactValue) === factKeyOf(filter.value as FactValue),
        );
      }
      if (typeof actual === 'string' && typeof filter.value === 'string') {
        return actual.toLowerCase().includes(filter.value.toLowerCase());
      }
      return false;
    }
    default:
      return false;
  }
}

function describeFilter(loc: StudioLocation, filter: FactFilter): string {
  const actual = loc.facts[filter.key];
  const rendered = actual === undefined ? 'absent' : factKeyOf(actual);
  if (filter.op === 'exists' || filter.op === 'missing') return `${filter.key} ${filter.op}`;
  return `${filter.key} ${filter.op} ${factKeyOf(filter.value as FactValue)} (actual ${rendered})`;
}

function geoDistance(a: StudioLocation, b: StudioLocation): number {
  const { perLng, perLat } = metresPerDegree((a.anchor.geo.lat + b.anchor.geo.lat) / 2);
  return Math.hypot(
    (a.anchor.geo.lng - b.anchor.geo.lng) * perLng,
    (a.anchor.geo.lat - b.anchor.geo.lat) * perLat,
  );
}

function scoreOf(reasonCount: number, distanceM: number | undefined, withinM: number | undefined): number {
  const base = Math.min(1, reasonCount / 4);
  if (distanceM === undefined || !withinM) return Math.round(base * 1000) / 1000;
  const proximity = 1 - Math.min(1, distanceM / withinM);
  return Math.round((base * 0.6 + proximity * 0.4) * 1000) / 1000;
}

function sortMatches(matches: LocationMatch[], sort: 'relevance' | 'distance' | 'handle'): void {
  // Handle is the tiebreak everywhere, so a query is fully deterministic even
  // when scores and distances collide.
  matches.sort((a, b) => {
    if (sort === 'handle')
      return compareStrings(a.location.handle as string, b.location.handle as string);
    if (sort === 'distance') {
      const da = a.distanceM ?? Infinity;
      const db = b.distanceM ?? Infinity;
      if (da !== db) return da - db;
    } else if (a.score !== b.score) {
      return b.score - a.score;
    }
    return compareStrings(a.location.handle as string, b.location.handle as string);
  });
}

function diversify(matches: readonly LocationMatch[], radiusM: number): LocationMatch[] {
  const kept: LocationMatch[] = [];
  for (const candidate of matches) {
    const tooClose = kept.some((k) => geoDistance(k.location, candidate.location) < radiusM);
    if (!tooClose) kept.push(candidate);
  }
  return kept;
}
