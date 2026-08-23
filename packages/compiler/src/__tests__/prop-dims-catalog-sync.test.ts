/**
 * `PROP_DIMS` is a hand-maintained mirror of `@simforge/asset-catalog`, kept
 * separate so the headless CLI does not import three.js for three numbers per
 * prop. A mirror with no test is a mirror that drifts, and drift here is
 * invisible: a catalog id the mirror has never heard of falls through
 * `propDims` to 1 x 1 x 1 (or, under a `vehicle.` prefix, to a sedan) and the
 * scenario silently loses the object it was about.
 *
 * This reads the published `catalog.json` rather than the code catalog so the
 * assertion costs no dependency on the renderer package.
 */

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { PROP_ALIAS_TARGETS, PROP_DIMS, isKnownPropCatalogId, propBehavior, propDims } from '../prop-dims.js';

const here = dirname(fileURLToPath(import.meta.url));
const catalogJsonPath = resolve(here, '..', '..', '..', 'prop-catalog', 'catalog.json');

interface CatalogEntryJson {
  id: string;
  class: string;
  dims: { l: number; w: number; h: number };
  tags: readonly string[];
}

const catalog = JSON.parse(readFileSync(catalogJsonPath, 'utf8')) as CatalogEntryJson[];

describe('PROP_DIMS mirrors the prop catalog', () => {
  it('knows every catalog id', () => {
    const missing = catalog.map((entry) => entry.id).filter((id) => !(id in PROP_DIMS));
    expect(missing).toEqual([]);
  });

  it('carries the catalogued dimensions for every id', () => {
    for (const entry of catalog) {
      expect(PROP_DIMS[entry.id], entry.id).toEqual(entry.dims);
    }
  });

  it('has no ids the catalog does not define, other than declared aliases', () => {
    const canonical = new Set(catalog.map((entry) => entry.id));
    const orphans = Object.keys(PROP_DIMS).filter(
      (id) => !canonical.has(id) && !isAliasOf(id, canonical),
    );
    expect(orphans).toEqual([]);
  });
});

/** An alias must name a real catalog entry with identical dimensions. */
function isAliasOf(id: string, canonical: ReadonlySet<string>): boolean {
  const target = PROP_ALIAS_TARGETS[id];
  return target !== undefined && canonical.has(target);
}

describe('author-facing object ids resolve to real footprints', () => {
  it.each([
    ['object.tyre', 'hazard.tire_debris'],
    ['object.box', 'hazard.cardboard_box'],
    ['object.shopping_cart', 'street.shopping_cart'],
    ['object.cone', 'construction.traffic_cone'],
    ['object.barrel', 'construction.channelizer_drum'],
    ['object.barrier', 'construction.jersey_barrier'],
    ['object.sign_board', 'construction.sign_road_work'],
  ])('%s gets the footprint of %s', (alias, canonical) => {
    expect(isKnownPropCatalogId(alias), alias).toBe(true);
    expect(propDims(alias)).toEqual(propDims(canonical));
    expect(propDims(alias)).not.toEqual({ l: 1, w: 1, h: 1 });
  });

  it('gives a deer a deer-sized footprint, not a unit cube', () => {
    expect(isKnownPropCatalogId('animal.deer')).toBe(true);
    const deer = propDims('animal.deer');
    expect(deer.l).toBeGreaterThan(1.4);
    expect(deer.h).toBeGreaterThan(1.2);
  });

  it('makes carriageway debris collidable', () => {
    for (const id of ['object.tyre', 'hazard.ladder', 'hazard.mattress', 'hazard.debris']) {
      expect(propBehavior(id).collidable, id).toBe(true);
    }
  });

  it('still refuses ids that do not exist', () => {
    expect(isKnownPropCatalogId('object.hovercraft')).toBe(false);
    expect(isKnownPropCatalogId('animal.dragon')).toBe(false);
    expect(isKnownPropCatalogId('vehicle.boxTruck')).toBe(false);
  });
});
