import { describe, expect, it } from 'vitest';
import type { CatalogEntry } from '@uniscenarios/prop-catalog/metadata';
import {
  classifyCarlaFallbackVehicleClass,
  planCarlaVehicleFallbacks,
  selectCarlaVehicleFallback,
} from './carla-fallback.js';
import { createActorCatalogResolver } from './prop-dims.js';

function galleryEntry(overrides: Partial<CatalogEntry> & { id: string }): CatalogEntry {
  return {
    label: 'Uploaded model',
    class: 'vehicle',
    actorClass: 'car',
    description: 'Uploaded model',
    dims: { l: 4.7, w: 1.85, h: 1.5 },
    tags: [],
    defaultParams: {},
    model: {
      kind: 'glb',
      url: 'https://example.invalid/model.glb',
      contentHash: 'a'.repeat(64),
      animated: false,
    },
    ...overrides,
  } as CatalogEntry;
}

const GALLERY_CAR_ID = 'gallery.90dc9cf7-5c32-4a97-b43b-768f2749a221.v1';

describe('classifyCarlaFallbackVehicleClass', () => {
  it('honours explicit van and truck declarations', () => {
    expect(classifyCarlaFallbackVehicleClass('van', { l: 4.7, w: 1.9, h: 1.6 })).toBe('van');
    expect(classifyCarlaFallbackVehicleClass('truck', { l: 4.7, w: 1.9, h: 1.6 })).toBe('truck');
  });

  it('refines the gallery car collapse by shape', () => {
    expect(classifyCarlaFallbackVehicleClass('car', { l: 4.7, w: 1.85, h: 1.5 })).toBe('car');
    expect(classifyCarlaFallbackVehicleClass('car', { l: 5.9, w: 2.0, h: 2.7 })).toBe('van');
    expect(classifyCarlaFallbackVehicleClass('car', { l: 8.0, w: 2.9, h: 4.0 })).toBe('truck');
    expect(classifyCarlaFallbackVehicleClass('car', { l: 4.6, w: 1.8, h: 3.1 })).toBe('truck');
  });

  it('returns null for classes with no CARLA counterpart', () => {
    for (const actorClass of ['bus', 'motorcycle', 'bicycle', 'scooter', 'pedestrian', undefined]) {
      expect(classifyCarlaFallbackVehicleClass(actorClass, { l: 4.7, w: 1.85, h: 1.5 })).toBeNull();
    }
  });
});

describe('selectCarlaVehicleFallback', () => {
  it('maps an unknown car to the nearest CARLA car, deterministically', () => {
    const entry = galleryEntry({ id: GALLERY_CAR_ID, dims: { l: 5.155, w: 1.995, h: 1.775 } });
    const first = selectCarlaVehicleFallback(entry);
    const second = selectCarlaVehicleFallback(entry);
    expect(first).toEqual(second);
    expect(first).toEqual({
      ok: true,
      catalogId: 'vehicle.ford_mustang',
      vehicleClass: 'car',
      lengthDeltaM: 5.006 - 5.155,
      widthDeltaM: 1.881 - 1.995,
      heightDeltaM: 1.54 - 1.775,
    });
  });

  it('keeps vans in the van class', () => {
    const selection = selectCarlaVehicleFallback(
      galleryEntry({ id: 'gallery.van.v1', actorClass: 'van', dims: { l: 5.8, w: 2.0, h: 2.6 } }),
    );
    expect(selection).toMatchObject({ ok: true, catalogId: 'vehicle.van', vehicleClass: 'van' });
  });

  it('keeps trucks in the truck class', () => {
    const selection = selectCarlaVehicleFallback(
      galleryEntry({ id: 'gallery.truck.v1', actorClass: 'truck', dims: { l: 7.4, w: 2.5, h: 3.6 } }),
    );
    expect(selection).toMatchObject({ ok: true, catalogId: 'vehicle.box_truck', vehicleClass: 'truck' });
  });

  it('fails closed for classes without a CARLA counterpart', () => {
    const selection = selectCarlaVehicleFallback(
      galleryEntry({ id: 'gallery.bus.v1', actorClass: 'bus', dims: { l: 12.2, w: 2.55, h: 3.2 } }),
    );
    expect(selection).toMatchObject({ ok: false, reason: 'no_carla_counterpart_class' });
  });

  it('fails closed for non-vehicle entries', () => {
    const selection = selectCarlaVehicleFallback(
      galleryEntry({ id: 'gallery.person.v1', class: 'pedestrian', actorClass: 'pedestrian', dims: { l: 0.5, w: 0.5, h: 1.8 } }),
    );
    expect(selection).toMatchObject({ ok: false, reason: 'not_a_road_vehicle' });
  });

  it('rejects a footprint no same-class vehicle can stand in for', () => {
    const selection = selectCarlaVehicleFallback(
      galleryEntry({ id: 'gallery.roadtrain.v1', actorClass: 'truck', dims: { l: 20.1, w: 2.6, h: 4.1 } }),
    );
    expect(selection).toMatchObject({ ok: false, reason: 'no_comparable_footprint' });
  });
});

describe('planCarlaVehicleFallbacks', () => {
  const resolve = createActorCatalogResolver([
    galleryEntry({ id: GALLERY_CAR_ID, dims: { l: 5.155, w: 1.995, h: 1.775 } }),
    galleryEntry({ id: 'gallery.bus.v1', actorClass: 'bus', dims: { l: 12.2, w: 2.55, h: 3.2 } }),
  ]);

  it('swaps only external vehicle identities and records every substitution', () => {
    const actors = [
      { id: 'ego', tags: ['role:ego', 'class:car', `catalog:${GALLERY_CAR_ID}`] },
      { id: 'lead', tags: ['role:lead', 'class:car', 'catalog:vehicle.sedan'] },
      { id: 'walker', tags: ['role:walker', 'class:pedestrian'] },
    ];
    const plan = planCarlaVehicleFallbacks(actors, resolve);
    expect(plan.actors[0]!.tags).toEqual(['role:ego', 'class:car', 'catalog:vehicle.ford_mustang']);
    expect(plan.actors[1]).toBe(actors[1]);
    expect(plan.actors[2]).toBe(actors[2]);
    expect(plan.substitutions).toEqual([{
      actorId: 'ego',
      authoredCatalogId: GALLERY_CAR_ID,
      fallbackCatalogId: 'vehicle.ford_mustang',
      vehicleClass: 'car',
      lengthDeltaM: 5.006 - 5.155,
      widthDeltaM: 1.881 - 1.995,
      heightDeltaM: 1.54 - 1.775,
    }]);
    expect(plan.unrenderable).toEqual([]);
    // The authored actors are never mutated: browser identity is untouched.
    expect(actors[0]!.tags[2]).toBe(`catalog:${GALLERY_CAR_ID}`);
  });

  it('leaves counterpart-free vehicles failing closed and says why', () => {
    const actors = [{ id: 'bus', tags: ['role:bus', 'class:bus', 'catalog:gallery.bus.v1'] }];
    const plan = planCarlaVehicleFallbacks(actors, resolve);
    expect(plan.actors[0]).toBe(actors[0]);
    expect(plan.substitutions).toEqual([]);
    expect(plan.unrenderable).toEqual([{
      actorId: 'bus',
      catalogId: 'gallery.bus.v1',
      reason: 'no_carla_counterpart_class',
      detail: 'the CARLA 0.10.0 container ships no bus blueprint',
    }]);
  });
});
