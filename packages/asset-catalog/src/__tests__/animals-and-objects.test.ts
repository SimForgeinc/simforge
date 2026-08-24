/**
 * Actors and objects the catalog could not previously express.
 *
 * Two capabilities are asserted here, both of which were unauthorable:
 *
 * 1. **Animals.** `ACTOR_CLASSES` has carried `animal` since v2, but there was
 *    no `animal.*` catalog id, so an author writing "a deer runs into the road"
 *    had to hand-write `dims` (see `examples/mechanisms/obstacle/animal-crossing`)
 *    or substitute a pedestrian — which mislabels the scenario.
 * 2. **Loose objects in the carriageway, under the name an author reaches for.**
 *    The canonical ids are `hazard.*` / `construction.*` / `street.*`; an author
 *    (or an LLM) writes `object.tyre`, `object.cone`, `object.barrier`. Those
 *    used to resolve to nothing, and an unresolved id silently materialised as a
 *    sedan. `resolveCatalogId` closes that gap without minting duplicate props.
 */

import { describe, expect, it } from 'vitest';

import { CATALOG, CATALOG_ALIASES, CATALOG_IDS, getEntry, isCatalogId, resolveCatalogId } from '../catalog.js';
import { BUILDER_IDS } from '../registry.js';
import { PROP_CLASSES } from '../types.js';

describe('animals', () => {
  it('exposes an animal class', () => {
    expect(PROP_CLASSES).toContain('animal');
  });

  it.each(['animal.deer', 'animal.dog', 'animal.cat'])('has %s with a builder', (id) => {
    expect(isCatalogId(id), id).toBe(true);
    expect(BUILDER_IDS as readonly string[]).toContain(id);
    expect(getEntry(id as never).class).toBe('animal');
  });

  it('sizes the deer as a large animal and the cat as a small one', () => {
    const deer = getEntry('animal.deer' as never);
    const cat = getEntry('animal.cat' as never);
    expect(deer.dims.l).toBeGreaterThan(1.4);
    expect(deer.dims.h).toBeGreaterThan(1.2);
    expect(cat.dims.l).toBeLessThan(0.7);
    expect(cat.dims.h).toBeLessThan(0.45);
  });

  it('tags every animal as a vulnerable road user that belongs in the roadway', () => {
    const animals = CATALOG.filter((entry) => entry.class === 'animal');
    expect(animals.length).toBeGreaterThanOrEqual(3);
    for (const entry of animals) {
      expect(entry.tags, entry.id).toContain('vru');
      expect(entry.tags, entry.id).toContain('mobile');
    }
  });
});

describe('loose objects in the carriageway', () => {
  it.each([
    ['object.tyre', 'hazard.tire_debris'],
    ['object.box', 'hazard.cardboard_box'],
    ['object.shopping_cart', 'street.shopping_cart'],
  ])('resolves the author-facing name %s onto the existing prop %s', (alias, canonical) => {
    expect(resolveCatalogId(alias)).toBe(canonical);
  });

  it.each(['hazard.ladder', 'hazard.mattress', 'hazard.debris'])('adds %s', (id) => {
    expect(isCatalogId(id), id).toBe(true);
    expect(getEntry(id as never).tags).toContain('debris');
    expect(getEntry(id as never).tags).toContain('roadway');
  });

  it.each(['object.ladder', 'object.mattress', 'object.debris'])('exposes %s to authors', (alias) => {
    const resolved = resolveCatalogId(alias);
    expect(resolved, alias).not.toBeNull();
    expect(isCatalogId(resolved!)).toBe(true);
  });
});

describe('traffic-management furniture', () => {
  it.each([
    ['object.cone', 'construction.traffic_cone'],
    ['object.barrel', 'construction.channelizer_drum'],
    ['object.barrier', 'construction.jersey_barrier'],
    ['object.sign_board', 'construction.sign_road_work'],
  ])('resolves %s to %s', (alias, canonical) => {
    expect(resolveCatalogId(alias)).toBe(canonical);
  });
});

describe('the alias table', () => {
  it('only ever points at real catalog ids', () => {
    for (const [alias, canonical] of Object.entries(CATALOG_ALIASES)) {
      expect(isCatalogId(canonical), `${alias} -> ${canonical}`).toBe(true);
    }
  });

  it('never shadows a canonical id', () => {
    for (const alias of Object.keys(CATALOG_ALIASES)) {
      expect(CATALOG_IDS as readonly string[], alias).not.toContain(alias);
    }
  });

  it('resolves canonical ids to themselves and unknown ids to null', () => {
    expect(resolveCatalogId('vehicle.sedan')).toBe('vehicle.sedan');
    expect(resolveCatalogId('vehicle.boxTruck')).toBeNull();
    expect(resolveCatalogId('object.hovercraft')).toBeNull();
  });
});
