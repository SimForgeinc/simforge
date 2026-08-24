import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { AUTHORING_CATALOG, CATALOG, CATALOG_IDS, getEntry, isCatalogId, queryCatalog } from '../catalog.js';
import { BUILDER_IDS } from '../registry.js';
import { catalogSchema, parseCatalog } from '../schema.js';
import { PROP_CLASSES } from '../types.js';

const here = dirname(fileURLToPath(import.meta.url));
const catalogJsonPath = resolve(here, '..', '..', 'catalog.json');

describe('catalog', () => {
  it('validates against the zod schema', () => {
    expect(() => catalogSchema.parse(CATALOG)).not.toThrow();
  });

  it('has unique ids that match their class', () => {
    const ids = new Set<string>();
    for (const entry of CATALOG) {
      expect(ids.has(entry.id), `duplicate ${entry.id}`).toBe(false);
      ids.add(entry.id);
      expect(entry.id.startsWith(`${entry.class}.`)).toBe(true);
      expect(PROP_CLASSES).toContain(entry.class);
    }
  });

  it('gives every entry exactly one occlusion tag and a usable description', () => {
    for (const entry of CATALOG) {
      const occlusion = entry.tags.filter((tag) => tag.startsWith('occlusion:'));
      expect(occlusion, entry.id).toHaveLength(1);
      expect(entry.description.length, entry.id).toBeGreaterThan(40);
      expect(entry.label.length, entry.id).toBeGreaterThan(2);
    }
  });

  it('covers every class', () => {
    const covered = new Set(CATALOG.map((entry) => entry.class));
    for (const cls of PROP_CLASSES) expect(covered.has(cls), `no entries for ${cls}`).toBe(true);
  });

  it('has a builder for every id and no orphan builders', () => {
    expect([...BUILDER_IDS].sort()).toEqual([...CATALOG_IDS].sort());
  });

  it('exposes lookups and guards', () => {
    expect(getEntry('vehicle.sedan').dims.l).toBeGreaterThan(4);
    expect(isCatalogId('vehicle.sedan')).toBe(true);
    expect(isCatalogId('vehicle.hovercraft')).toBe(false);
    expect(() => getEntry('vehicle.hovercraft' as never)).toThrow();
  });

  it('keeps legacy ids loadable but out of new-authoring choices', () => {
    expect(getEntry('pedestrian.adult_walking').legacyAliasOf).toBe('pedestrian.adult');
    expect(AUTHORING_CATALOG).toHaveLength(CATALOG.length - 4);
    expect(AUTHORING_CATALOG.some((entry) => entry.legacyAliasOf)).toBe(false);
  });

  it('queries by class and by tag', () => {
    const vehicles = queryCatalog({ class: 'vehicle' });
    expect(vehicles.length).toBeGreaterThanOrEqual(13);
    expect(vehicles.map((entry) => entry.id)).toContain('vehicle.sedan');
    expect(vehicles.map((entry) => entry.id)).toContain('vehicle.ambulance');
    expect(queryCatalog({ class: ['hazard', 'occluder'] }).length).toBe(11);

    const vru = queryCatalog({ tags: ['vru'] });
    expect(vru.map((entry) => entry.id)).toContain('pedestrian.child_walking');
    expect(vru.map((entry) => entry.id)).toContain('vehicle.bicycle');

    const blockers = queryCatalog({ tags: ['occlusion:high'] });
    expect(blockers.map((entry) => entry.id)).toContain('vehicle.semi_truck');
    expect(blockers.map((entry) => entry.id)).not.toContain('hazard.cardboard_box');

    const workzoneRuns = queryCatalog({ class: 'construction', tags: ['workzone', 'run'] });
    expect(workzoneRuns.map((entry) => entry.id)).toEqual([
      'construction.jersey_barrier_run',
      'construction.long_pipe',
    ]);

    expect(queryCatalog()).toHaveLength(CATALOG.length);
  });

  it('exposes stable ids for emergency, rail, work-zone and vulnerable-road-user campaigns', () => {
    const required = [
      'vehicle.ambulance',
      'vehicle.tram',
      'vehicle.mobility_scooter',
      'pedestrian.traffic_marshal',
      'construction.temporary_stop_sign',
      'construction.portable_signal',
      'construction.long_pipe',
      'street.shopping_cart',
      'construction.excavator',
      'construction.barricade_type3',
      'construction.pedestrian_barrier',
    ];
    for (const id of required) expect(isCatalogId(id), id).toBe(true);
    expect(queryCatalog({ tags: ['workzone'] }).map((entry) => entry.id)).toContain('construction.portable_signal');
    expect(queryCatalog({ tags: ['vru'] }).map((entry) => entry.id)).toContain('vehicle.mobility_scooter');
  });
});

describe('catalog.json', () => {
  it('is in sync with the code catalog', () => {
    const onDisk: unknown = JSON.parse(readFileSync(catalogJsonPath, 'utf8'));
    expect(onDisk).toEqual(JSON.parse(JSON.stringify(CATALOG)));
  });

  it('round-trips through the schema parser', () => {
    const onDisk: unknown = JSON.parse(readFileSync(catalogJsonPath, 'utf8'));
    const parsed = parseCatalog(onDisk);
    expect(parsed).toHaveLength(CATALOG.length);
  });

  it('rejects malformed entries', () => {
    const bad = [
      {
        id: 'Vehicle.Sedan',
        label: 'Sedan',
        class: 'vehicle',
        description: 'too short',
        dims: { l: 1, w: 1, h: 1 },
        tags: [],
        defaultParams: {},
      },
    ];
    expect(() => parseCatalog(bad)).toThrow();
  });

  it('rejects an entry with two occlusion tags', () => {
    const bad = JSON.parse(JSON.stringify(CATALOG)) as Array<{ tags: string[] }>;
    (bad[0] as { tags: string[] }).tags = ['occlusion:low', 'occlusion:high'];
    expect(() => parseCatalog(bad)).toThrow(/occlusion/);
  });
});
