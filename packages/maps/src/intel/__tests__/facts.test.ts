/**
 * The declared-fact vocabulary assertion.
 *
 * The defect being guarded against: `is_t_intersection` was declared in the
 * prior system's tool schema, aliased in three query paths, and written by zero
 * code paths — so every query that filtered on it returned nothing, forever,
 * silently. A declared key with no producer is a build failure here, and this
 * suite is what stops that check from rotting into a warning.
 */

import path from 'node:path';
import { describe, expect, it } from 'vitest';

import { buildMapIntel, buildMapIntelFromDir } from '../build/build.js';
import {
  assertDeclaredFactsProduced,
  DECLARED_FACT_KEYS,
  summariseFactKeys,
} from '../build/facts.js';
import { ALL_MAPS, DEV_ASSETS, devAssetsAvailable, miniYaleSources } from './helpers.js';

const build = buildMapIntel(miniYaleSources());

describe('declared fact vocabulary', () => {
  it('declares no duplicate keys', () => {
    const keys = DECLARED_FACT_KEYS.map((s) => s.key);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('names a producer for every declared key', () => {
    for (const spec of DECLARED_FACT_KEYS) {
      expect(spec.producedBy.length).toBeGreaterThan(0);
      expect(spec.description.length).toBeGreaterThan(10);
    }
  });

  it('produces every `always` key on the fixture', () => {
    const audit = summariseFactKeys(build.catalog.locations);
    expect(audit.missingAlways).toEqual([]);
  });

  it('emits values of the declared type', () => {
    const declared = new Map(DECLARED_FACT_KEYS.map((s) => [s.key, s]));
    for (const loc of build.catalog.locations) {
      for (const [key, value] of Object.entries(loc.facts)) {
        const spec = declared.get(key);
        if (!spec) continue; // adopted from the search index; foreign data
        if (spec.type === 'string[]') {
          expect(Array.isArray(value), `${key} on ${loc.handle}`).toBe(true);
        } else {
          expect(typeof value, `${key} on ${loc.handle}`).toBe(spec.type);
        }
      }
    }
  });

  it('keeps every fact value flat', () => {
    for (const loc of build.catalog.locations) {
      for (const [key, value] of Object.entries(loc.facts)) {
        const ok =
          typeof value === 'string' ||
          typeof value === 'number' ||
          typeof value === 'boolean' ||
          (Array.isArray(value) && value.every((v) => typeof v === 'string' || typeof v === 'number'));
        expect(ok, `${key} on ${loc.handle} is not a flat value`).toBe(true);
      }
    }
  });

  it('fails the build when an `always` key has no producer', () => {
    expect(() => assertDeclaredFactsProduced('test', [{ facts: {} }])).toThrow(
      /declared fact keys with no producer/,
    );
  });

  it('emits fact keys in sorted order', () => {
    for (const loc of build.catalog.locations) {
      const keys = Object.keys(loc.facts);
      expect(keys).toEqual([...keys].sort());
    }
  });
});

describe.skipIf(!devAssetsAvailable())('declared facts across every real map', () => {
  // Builds all five real maps; ~4-6 s on this machine, over vitest's 5 s default.
  it('produces every declared key on at least one map, and every `always` key on all of them', { timeout: 30_000 }, async () => {
    const producedAnywhere = new Set<string>();
    for (const mapId of ALL_MAPS) {
      const built = await buildMapIntelFromDir(path.join(DEV_ASSETS, mapId));
      // `assertDeclaredFactsProduced` already ran inside the build; re-asserting
      // here documents the per-map contract explicitly.
      expect(built.audit.missingAlways, mapId).toEqual([]);
      for (const key of built.audit.produced) producedAnywhere.add(key);
    }
    const neverProduced = DECLARED_FACT_KEYS.filter((s) => !producedAnywhere.has(s.key)).map(
      (s) => s.key,
    );
    expect(neverProduced).toEqual([]);
  });
});
