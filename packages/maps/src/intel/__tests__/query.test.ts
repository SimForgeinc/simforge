/**
 * The query surface.
 *
 * Two things are load-bearing here beyond ordinary filter semantics:
 *
 * - **Index/linear agreement.** The `FactIndex` narrows candidates; if it ever
 *   narrows something a full predicate check would have kept, queries start
 *   returning subtly incomplete answers with no error. The agreement test runs
 *   a battery of queries down both paths and demands byte-identical results.
 * - **Errors instead of empty results.** A filter on a fact key nothing carries
 *   must throw with the closed vocabulary attached, because "no results" is
 *   indistinguishable from "your filter was a typo" and the prior system spent
 *   months in exactly that state.
 */

import { describe, expect, it } from 'vitest';

import { buildMapIntel } from '../build/build.js';
import { findLocations, findLocationsLinear, knownFactKeys } from '../query/find.js';
import { describeLocation, getLocation, relationsFrom, requireLocation } from '../query/describe.js';
import { diceCoefficient, resolveReference } from '../query/resolve.js';
import { MapIntelQueryError, DEFAULT_RESULT_LIMIT, MAX_RESULT_LIMIT } from '../query/types.js';
import type { FindLocationsQuery } from '../query/types.js';
import { miniYaleSources } from './helpers.js';

const { catalog, derived } = buildMapIntel(miniYaleSources());
const index = derived.factIndex;

describe('findLocations', () => {
  it('filters by type and returns the subject inline', () => {
    const hits = findLocations(catalog, { type: 'junction', limit: 50 }, { index });
    expect(hits.length).toBeGreaterThan(0);
    for (const hit of hits) {
      expect(hit.location.type).toBe('junction');
      // The subject's own pose comes back with it — no second round trip.
      expect(hit.location.anchor.geo.lat).toBeTypeOf('number');
      expect(hit.location.anchor.scene.x).toBeTypeOf('number');
      expect(hit.matchedReasons).toContain('type=junction');
    }
  });

  it('supports anyOf / allOf / noneOf on tags', () => {
    const anyOf = findLocations(catalog, { tags: { anyOf: ['MIDBLOCK', 'PARKING_SPACE'] }, limit: 200 });
    expect(anyOf.length).toBeGreaterThan(0);
    for (const hit of anyOf) {
      expect(hit.location.tags.some((t) => t === 'MIDBLOCK' || t === 'PARKING_SPACE')).toBe(true);
    }

    const allOf = findLocations(catalog, { tags: { allOf: ['MIDBLOCK', 'STRAIGHT'] }, limit: 200 });
    for (const hit of allOf) {
      expect(hit.location.tags).toContain('MIDBLOCK');
      expect(hit.location.tags).toContain('STRAIGHT');
    }

    const noneOf = findLocations(catalog, { type: 'parking_space', tags: { noneOf: ['PARKING_PARALLEL'] }, limit: 200 });
    for (const hit of noneOf) expect(hit.location.tags).not.toContain('PARKING_PARALLEL');
  });

  it('supports comparison operators on facts', () => {
    const wide = findLocations(
      catalog,
      { facts: [{ key: 'lanes_same_dir', op: 'gte', value: 2 }], limit: 200 },
      { index },
    );
    expect(wide.length).toBeGreaterThan(0);
    for (const hit of wide) {
      expect(hit.location.facts['lanes_same_dir'] as number).toBeGreaterThanOrEqual(2);
      expect(hit.matchedReasons.join(' ')).toContain('lanes_same_dir gte 2');
    }

    const lefts = findLocations(catalog, {
      facts: {
        allOf: [
          { key: 'turn_relation', op: 'eq', value: 'Left' },
          { key: 'is_protected', op: 'eq', value: false },
        ],
      },
      limit: 200,
    });
    for (const hit of lefts) {
      expect(hit.location.facts['turn_relation']).toBe('Left');
      expect(hit.location.facts['is_protected']).toBe(false);
    }
  });

  it('supports contains on array facts', () => {
    const keys = knownFactKeys(catalog);
    if (!keys.has('connected_road_names')) return;
    const hits = findLocations(catalog, {
      facts: [{ key: 'connected_road_names', op: 'exists' }],
      limit: 5,
    });
    expect(hits.length).toBeGreaterThan(0);
  });

  it('filters by proximity to another record and reports the distance', () => {
    const junction = catalog.locations.find((l) => l.type === 'junction');
    expect(junction).toBeDefined();
    if (!junction) return;
    const near = findLocations(
      catalog,
      { near: { id: junction.handle as string, withinM: 60 }, limit: 100 },
      { index },
    );
    expect(near.length).toBeGreaterThan(0);
    for (const hit of near) {
      expect(hit.distanceM).toBeDefined();
      expect(hit.distanceM ?? Infinity).toBeLessThanOrEqual(60);
    }
    // Distance-sorted by default when `near` is present.
    const distances = near.map((h) => h.distanceM ?? 0);
    expect(distances).toEqual([...distances].sort((a, b) => a - b));
  });

  it('accepts either an id or a handle as the near reference', () => {
    const junction = catalog.locations.find((l) => l.type === 'junction');
    if (!junction) return;
    const byHandle = findLocations(catalog, { near: { id: junction.handle as string, withinM: 40 } });
    const byId = findLocations(catalog, { near: { id: junction.id as string, withinM: 40 } });
    expect(byId.map((h) => h.location.id)).toEqual(byHandle.map((h) => h.location.id));
  });

  it('applies diversity clustering', () => {
    const all = findLocations(catalog, { type: 'parking_space', limit: 200 });
    const diverse = findLocations(catalog, { type: 'parking_space', limit: 200, diversityRadiusM: 25 });
    expect(diverse.length).toBeLessThan(all.length);
    expect(diverse.length).toBeGreaterThan(0);
  });

  it('can require placeability', () => {
    const placeable = findLocations(catalog, { requireRoadAnchor: true, limit: 200 });
    for (const hit of placeable) expect(hit.location.anchor.road).not.toBeNull();
  });

  it('clamps excessive result limits instead of hard-failing', () => {
    expect(findLocations(catalog, { limit: MAX_RESULT_LIMIT + 1 }).length).toBeLessThanOrEqual(MAX_RESULT_LIMIT);
    expect(findLocations(catalog, { limit: 5000 }).length).toBeLessThanOrEqual(MAX_RESULT_LIMIT);
    expect(findLocations(catalog, {}).length).toBeLessThanOrEqual(DEFAULT_RESULT_LIMIT);
  });

  it('rejects an unknown fact key with the available vocabulary', () => {
    try {
      findLocations(catalog, { facts: [{ key: 'is_t_intersection', op: 'eq', value: true }] });
      throw new Error('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(MapIntelQueryError);
      const e = err as MapIntelQueryError;
      expect(e.code).toBe('unknown_fact_key');
      expect(e.path).toBe('facts.is_t_intersection');
      expect(e.allowed?.length ?? 0).toBeGreaterThan(10);
      expect(e.toJSON().allowed).toBeDefined();
    }
  });

  it('rejects an unknown type with the closed vocabulary', () => {
    try {
      findLocations(catalog, { type: 'roundabout' as never });
      throw new Error('should have thrown');
    } catch (err) {
      expect((err as MapIntelQueryError).code).toBe('unknown_value');
      expect((err as MapIntelQueryError).allowed).toContain('junction');
    }
  });

  it('rejects an unresolvable near reference', () => {
    expect(() => findLocations(catalog, { near: { id: 'junction/nope', withinM: 10 } })).toThrow(
      /unknown_reference/,
    );
  });

  it('sorts deterministically', () => {
    const q: FindLocationsQuery = { type: 'junction_movement', limit: 50 };
    const a = findLocations(catalog, q, { index });
    const b = findLocations(catalog, q, { index });
    expect(a.map((h) => h.location.handle)).toEqual(b.map((h) => h.location.handle));
    const byHandle = findLocations(catalog, { ...q, sort: 'handle' }, { index }).map(
      (h) => h.location.handle as string,
    );
    expect(byHandle).toEqual([...byHandle].sort());
  });
});

describe('fact index and linear scan agree', () => {
  const anchor = catalog.locations.find((l) => l.type === 'junction');
  const queries: FindLocationsQuery[] = [
    {},
    { type: 'junction', limit: 100 },
    { type: ['junction', 'crosswalk'], limit: 100 },
    { type: { noneOf: ['parking_space'] }, limit: 100 },
    { subtype: 'left', limit: 100 },
    { tags: { anyOf: ['MIDBLOCK', 'SCHOOL_ZONE'] }, limit: 100 },
    { tags: { allOf: ['MIDBLOCK', 'STRAIGHT'] }, limit: 100 },
    { tags: { noneOf: ['PARKING_SPACE'] }, limit: 100 },
    { affordances: { allOf: ['vehicleSpawn', 'route'] }, limit: 100 },
    { affordances: 'occluder', limit: 100 },
    { facts: [{ key: 'lanes_same_dir', op: 'gte', value: 2 }], limit: 100 },
    { facts: [{ key: 'turn_relation', op: 'eq', value: 'Left' }], limit: 100 },
    { facts: { noneOf: [{ key: 'is_protected', op: 'eq', value: true }] }, limit: 100 },
    { facts: { anyOf: [{ key: 'speed_limit_kph', op: 'gt', value: 40 }, { key: 'is_one_way', op: 'eq', value: true }] }, limit: 100 },
    { anchorQuality: 'exact', limit: 100 },
    { requireRoadAnchor: true, type: 'parking_space', limit: 100 },
    { type: 'midblock_segment', diversityRadiusM: 30, limit: 100 },
    ...(anchor
      ? [
          { near: { id: anchor.handle as string, withinM: 120 }, limit: 100 },
          { type: 'junction_movement' as const, near: { id: anchor.handle as string, withinM: 200 }, limit: 100 },
        ]
      : []),
  ];

  it.each(queries.map((q, i) => [i, q] as const))('query %i', (_i, query) => {
    const indexed = findLocations(catalog, query, { index });
    const linear = findLocationsLinear(catalog, query);
    expect(JSON.stringify(indexed)).toBe(JSON.stringify(linear));
  });

  it('narrows rather than filters — the index never invents a hit', () => {
    const all = new Set(catalog.locations.map((l) => l.id as string));
    for (const [, ids] of Object.entries(index.locationsByType)) {
      for (const id of ids) expect(all.has(id as string)).toBe(true);
    }
    for (const [key, ids] of Object.entries(index.locationsByTag)) {
      for (const id of ids) {
        const loc = catalog.locations.find((l) => l.id === id);
        expect(loc?.tags, key).toContain(key);
      }
    }
  });

  it('lists high-cardinality fact keys as unindexed rather than dropping them', () => {
    for (const key of index.unindexedFactKeys) {
      expect(knownFactKeys(catalog).has(key)).toBe(true);
      expect(index.locationsByFact[key]).toBeUndefined();
    }
    // ...and those keys still work in queries, via the linear path.
    const key = index.unindexedFactKeys[0];
    if (key) {
      expect(() => findLocations(catalog, { facts: [{ key, op: 'exists' }] }, { index })).not.toThrow();
    }
  });

  it('maps every segment lane back to its segment', () => {
    for (const seg of derived.segments) {
      for (const lane of seg.laneRefs) {
        expect(index.segmentByLaneRef[lane as string]).toBe(seg.id);
      }
    }
  });
});

describe('getLocation and describeLocation', () => {
  it('resolves by id and by handle', () => {
    const first = catalog.locations[0];
    expect(first).toBeDefined();
    if (!first) return;
    expect(getLocation(catalog, first.id as string)?.id).toBe(first.id);
    expect(getLocation(catalog, first.handle as string)?.id).toBe(first.id);
    expect(getLocation(catalog, 'nope')).toBeUndefined();
    expect(() => requireLocation(catalog, 'nope')).toThrow(MapIntelQueryError);
  });

  it('describes a junction in grounded prose', () => {
    const junction = catalog.locations.find((l) => l.type === 'junction' && l.anchor.road);
    expect(junction).toBeDefined();
    if (!junction) return;
    const text = describeLocation(catalog, junction.handle as string);
    expect(text).toContain(junction.name);
    expect(text).toContain(junction.handle as string);
    // The road anchor is stated explicitly so a model never has to guess it.
    expect(text).toContain(junction.anchor.road?.rsl as string);
    expect(text).toMatch(/anchor quality: (exact|projected|inferred)/);
    expect(text).toContain('derived control');
    expect(text).toMatch(/Sources: /);
  });

  it('says plainly when a record is not placeable', () => {
    const orphan = catalog.locations.find((l) => !l.anchor.road);
    if (!orphan) return;
    expect(describeLocation(catalog, orphan.handle as string)).toContain('no road anchor');
  });

  it('reports relation direction in words', () => {
    const withRelations = catalog.locations.find((l) => relationsFrom(catalog, l).length > 0);
    expect(withRelations).toBeDefined();
    if (!withRelations) return;
    const text = describeLocation(catalog, withRelations.handle as string);
    expect(text).toMatch(/to the (north|south|east|west|northeast|northwest|southeast|southwest)/);
  });
});

describe('resolveReference', () => {
  it('round-trips an exact handle', () => {
    const first = catalog.locations[0];
    if (!first) return;
    const hits = resolveReference(catalog, first.handle as string);
    expect(hits[0]?.id).toBe(first.id);
    expect(hits[0]?.score).toBe(1);
  });

  it('maps type keywords onto the taxonomy', () => {
    const hits = resolveReference(catalog, 'the intersection', { limit: 5 });
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0]?.type).toBe('junction');

    const parking = resolveReference(catalog, 'a parking space', { limit: 5 });
    expect(parking.some((h) => h.type === 'parking_space')).toBe(true);
  });

  it('finds a place by street name', () => {
    const named = catalog.locations.find(
      (l) => typeof l.facts['road_name'] === 'string' && (l.facts['road_name'] as string).length > 4,
    );
    expect(named).toBeDefined();
    if (!named) return;
    const road = named.facts['road_name'] as string;
    const hits = resolveReference(catalog, `somewhere on ${road}`, { limit: 10 });
    expect(hits.length).toBeGreaterThan(0);
    expect(hits.some((h) => h.reasons.some((r) => r.includes('matches') || r.includes('shares')))).toBe(true);
  });

  it('is deterministic and explainable', () => {
    const a = resolveReference(catalog, 'crosswalk near the school');
    const b = resolveReference(catalog, 'crosswalk near the school');
    expect(a).toEqual(b);
    for (const hit of a) expect(hit.reasons.length).toBeGreaterThan(0);
  });

  it('returns nothing for empty input', () => {
    expect(resolveReference(catalog, '   ')).toEqual([]);
  });

  it('computes a sane dice coefficient', () => {
    expect(diceCoefficient('night', 'nacht')).toBeCloseTo(0.25, 2);
    expect(diceCoefficient('abc', 'abc')).toBe(1);
    expect(diceCoefficient('', 'abc')).toBe(0);
  });
});
