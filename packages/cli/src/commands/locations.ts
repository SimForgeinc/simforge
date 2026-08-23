/**
 * `uniscenarios locations find | get | resolve` — the model's spatial awareness.
 *
 * The contract these three share is that a model never sees a road id: it asks
 * in semantics (type, facts, affordances, proximity to a handle), and it gets
 * back **handles**, poses and `matchedReasons`. Everything below the handle —
 * `rsl`, `s`, junction ids — is carried through for the layers that need it and
 * is never something the model has to author.
 */

import {
  describeLocation,
  findLocations,
  getLocation,
  resolveReference,
  MapIntelQueryError,
  type FactFilter,
  type FactOp,
  type FindLocationsQuery,
  type LocationMatch,
  type StudioLocation,
} from '@uniscenarios/map-intel';

import { CliError } from '../errors.js';
import { loadMap } from '@uniscenarios/scenario-materializer';
import { emit, emitLines, pad } from '../output.js';
import { EXIT } from '../errors.js';

export interface LocationsFindOptions {
  readonly mapId: string;
  readonly type?: string[] | undefined;
  readonly subtype?: string[] | undefined;
  readonly tags?: string[] | undefined;
  readonly affordances?: string[] | undefined;
  readonly facts: Array<[string, string]>;
  readonly near?: string | undefined;
  readonly withinM?: number | undefined;
  readonly limit?: number | undefined;
  readonly diversityM?: number | undefined;
  readonly pretty: boolean;
}

/** `k=v` → a fact filter, with `k>=v` / `k!=v` / `k~v` shorthands. */
function factFilter(key: string, raw: string): FactFilter {
  const ops: Array<[string, FactOp]> = [
    ['>=', 'gte'],
    ['<=', 'lte'],
    ['!', 'ne'],
    ['>', 'gt'],
    ['<', 'lt'],
    ['~', 'contains'],
  ];
  for (const [token, op] of ops) {
    if (key.endsWith(token)) {
      return { key: key.slice(0, -token.length), op, value: coerce(raw) };
    }
  }
  if (raw === '?') return { key, op: 'exists' };
  if (raw === '!?') return { key, op: 'missing' };
  return { key, op: 'eq', value: coerce(raw) };
}

function coerce(raw: string): string | number | boolean {
  if (raw === 'true') return true;
  if (raw === 'false') return false;
  const n = Number(raw);
  return raw !== '' && Number.isFinite(n) ? n : raw;
}

function locationView(match: LocationMatch): Record<string, unknown> {
  const l = match.location;
  return {
    handle: l.handle,
    id: l.id,
    name: l.name,
    type: l.type,
    subtype: l.subtype ?? null,
    score: Math.round(match.score * 1000) / 1000,
    ...(match.distanceM === undefined ? {} : { distanceM: Math.round(match.distanceM * 10) / 10 }),
    roadAnchor: l.anchor.road ?? null,
    sceneAnchor: l.anchor.scene ?? null,
    anchorQuality: l.quality.anchor,
    affordances: l.affordances,
    tags: l.tags,
    facts: l.facts,
    matchedReasons: match.matchedReasons,
  };
}

function wrapQueryError(error: unknown): never {
  if (error instanceof MapIntelQueryError) {
    throw new CliError(error.code, error.reason, {
      path: error.path,
      ...(error.allowed ? { detail: { allowed: [...error.allowed] } } : {}),
      exitCode: EXIT.commandError,
    });
  }
  throw error;
}

export async function locationsFind(options: LocationsFindOptions): Promise<number> {
  const bundle = await loadMap(options.mapId);
  const query: FindLocationsQuery = {
    ...(options.type ? { type: options.type as FindLocationsQuery['type'] } : {}),
    ...(options.subtype ? { subtype: options.subtype } : {}),
    ...(options.tags ? { tags: options.tags } : {}),
    ...(options.affordances
      ? { affordances: options.affordances as FindLocationsQuery['affordances'] }
      : {}),
    ...(options.facts.length > 0
      ? { facts: { allOf: options.facts.map(([k, v]) => factFilter(k, v)) } }
      : {}),
    ...(options.near
      ? { near: { id: options.near, withinM: options.withinM ?? 250 } }
      : {}),
    ...(options.limit === undefined ? {} : { limit: options.limit }),
    ...(options.diversityM === undefined ? {} : { diversityRadiusM: options.diversityM }),
  };

  let matches: LocationMatch[];
  try {
    matches = findLocations(bundle.catalog, query, { index: bundle.derived.factIndex });
  } catch (error) {
    wrapQueryError(error);
  }

  const payload = {
    mapId: options.mapId,
    catalogRevision: bundle.catalog.catalogRevision,
    query,
    count: matches.length,
    results: matches.map(locationView),
  };
  if (!options.pretty) {
    emit(payload, options);
    return EXIT.ok;
  }
  const lines = [
    `${matches.length} location(s) on ${options.mapId} (catalog ${bundle.catalog.catalogRevision})`,
    '',
  ];
  for (const m of matches) {
    const road = m.location.anchor.road;
    lines.push(
      `${pad(m.location.handle, 52)}${pad(m.location.type, 20)}${
        road ? `${road.rsl}@${road.s.toFixed(1)}m` : 'unanchored'
      }`,
    );
    if (m.matchedReasons.length > 0) lines.push(`    ${m.matchedReasons.join('; ')}`);
  }
  emitLines(lines);
  return EXIT.ok;
}

export interface LocationsGetOptions {
  readonly mapId: string;
  readonly ref: string;
  readonly describe: boolean;
  readonly pretty: boolean;
}

export async function locationsGet(options: LocationsGetOptions): Promise<number> {
  const bundle = await loadMap(options.mapId);
  const location: StudioLocation | undefined = getLocation(bundle.catalog, options.ref);
  if (!location) {
    throw new CliError('unknown_reference', `no location "${options.ref}" on ${options.mapId}`, {
      path: 'ref',
      detail: {
        hint: 'use `uniscenarios locations resolve` for free text, or `uniscenarios locations find` to browse',
      },
    });
  }
  const payload: Record<string, unknown> = {
    mapId: options.mapId,
    location,
    ...(options.describe
      ? { description: describeLocation(bundle.catalog, location.handle) }
      : {}),
  };
  if (!options.pretty) {
    emit(payload, options);
    return EXIT.ok;
  }
  const lines = [
    `${location.name} — ${location.handle}`,
    `type: ${location.type}${location.subtype ? ` / ${location.subtype}` : ''}`,
    location.anchor.road
      ? `road: ${location.anchor.road.rsl} s=${location.anchor.road.s.toFixed(2)} heading=${location.anchor.road.headingRad.toFixed(3)}`
      : 'road: unanchored',
    `quality: ${location.quality.anchor}`,
    `affordances: ${location.affordances.join(', ') || '—'}`,
    `tags: ${location.tags.join(', ') || '—'}`,
  ];
  if (options.describe) lines.push('', describeLocation(bundle.catalog, location.handle));
  emitLines(lines);
  return EXIT.ok;
}

export interface LocationsResolveOptions {
  readonly mapId: string;
  readonly text: string;
  readonly limit?: number | undefined;
  readonly pretty: boolean;
}

export async function locationsResolve(options: LocationsResolveOptions): Promise<number> {
  const bundle = await loadMap(options.mapId);
  const resolved = resolveReference(bundle.catalog, options.text, {
    ...(options.limit === undefined ? {} : { limit: options.limit }),
  });
  const payload = {
    mapId: options.mapId,
    text: options.text,
    count: resolved.length,
    results: resolved.map((r) => ({ ...r, score: Math.round(r.score * 1000) / 1000 })),
  };
  if (!options.pretty) {
    emit(payload, options);
    return resolved.length > 0 ? EXIT.ok : EXIT.validationFindings;
  }
  if (resolved.length === 0) {
    emitLines([`no location on ${options.mapId} matched ${JSON.stringify(options.text)}`]);
    return EXIT.validationFindings;
  }
  emitLines(
    resolved.map(
      (r) => `${pad(r.handle, 52)}${r.score.toFixed(3)}  ${r.reasons.join('; ')}`,
    ),
  );
  return EXIT.ok;
}
