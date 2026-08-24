import { afterEach, describe, expect, it, vi } from 'vitest';
import { Box3, type Mesh, Vector3 } from 'three';

import {
  AUTHORING_CATALOG,
  clearExternalCatalogEntries,
  externalModelBinding,
  getEntry,
  isCatalogId,
  isExternalCatalogId,
  listExternalCatalogEntries,
  onExternalCatalogChange,
  registerExternalCatalogEntry,
  resolveCatalogId,
  unregisterExternalCatalogEntry,
  type ExternalCatalogEntry,
} from '../catalog.js';
import { buildProp } from '../registry.js';

const ENTRY = {
  id: 'gallery.asset-1.v1',
  label: 'Gallery delivery robot',
  class: 'sidewalk_robot',
  actorClass: 'sidewalk_robot',
  description: 'A gallery-provided delivery robot used to exercise runtime model registration.',
  dims: { l: 1.8, w: 0.75, h: 1.2 },
  tags: ['delivery', 'sidewalk', 'mobile', 'occlusion:low'],
  defaultParams: {},
  model: {
    kind: 'glb',
    url: 'https://assets.example.test/asset-1.glb',
    contentHash: 'a'.repeat(64),
  },
} satisfies ExternalCatalogEntry;

const PROXY_ENTRY: ExternalCatalogEntry = {
  ...ENTRY,
  id: 'carla.static.prop.trafficcone01',
  label: 'CARLA traffic cone',
  model: { kind: 'proxy', tint: '#e87822' },
};

const authoringIds = AUTHORING_CATALOG.map((entry) => entry.id);

afterEach(() => {
  clearExternalCatalogEntries();
});

describe('external catalog entries', () => {
  it('registers, resolves, lists, and unregisters an entry', () => {
    expect(registerExternalCatalogEntry(ENTRY)).toBe(true);
    expect(registerExternalCatalogEntry(ENTRY)).toBe(false);
    expect(isExternalCatalogId(ENTRY.id)).toBe(true);
    expect(isCatalogId(ENTRY.id)).toBe(true);
    expect(resolveCatalogId(ENTRY.id)).toBe(ENTRY.id);
    expect(listExternalCatalogEntries()).toEqual([ENTRY]);
    expect(externalModelBinding(ENTRY.id)).toBe(ENTRY.model);

    expect(unregisterExternalCatalogEntry(ENTRY.id)).toBe(true);
    expect(unregisterExternalCatalogEntry(ENTRY.id)).toBe(false);
    expect(isCatalogId(ENTRY.id)).toBe(false);
    expect(resolveCatalogId(ENTRY.id)).toBeNull();
    expect(externalModelBinding(ENTRY.id)).toBeNull();
  });

  it('accepts every external namespace while rejecting bare and shadowing ids', () => {
    expect(registerExternalCatalogEntry(PROXY_ENTRY)).toBe(true);
    expect(isExternalCatalogId(PROXY_ENTRY.id)).toBe(true);
    expect(resolveCatalogId(PROXY_ENTRY.id)).toBe(PROXY_ENTRY.id);
    expect(externalModelBinding(PROXY_ENTRY.id)).toBe(PROXY_ENTRY.model);
    expect(() => registerExternalCatalogEntry({ ...ENTRY, id: 'foo.asset-1' })).toThrow(
      /must start with one of "gallery\.", "carla\."/,
    );
    expect(() => registerExternalCatalogEntry({ ...ENTRY, id: 'vehicle.sedan' })).toThrow(
      /shadows a bundled id or alias/,
    );
    expect(() => registerExternalCatalogEntry({ ...ENTRY, id: 'object.cone' })).toThrow(
      /shadows a bundled id or alias/,
    );
  });

  it('returns the registered entry from getEntry', () => {
    registerExternalCatalogEntry(ENTRY);
    expect(getEntry(ENTRY.id)).toBe(ENTRY);
  });

  it('builds a ground-centred placeholder with the catalog dimensions and shared material', () => {
    registerExternalCatalogEntry(ENTRY);
    const first = buildProp(ENTRY.id);
    const second = buildProp(ENTRY.id);
    const size = new Box3().setFromObject(first).getSize(new Vector3());
    const bounds = new Box3().setFromObject(first);
    const firstMesh = first.children[0] as Mesh;
    const secondMesh = second.children[0] as Mesh;

    expect(first.userData.catalogId).toBe(ENTRY.id);
    expect(first.children).toHaveLength(1);
    expect(size.x).toBeCloseTo(ENTRY.dims.l);
    expect(size.y).toBeCloseTo(ENTRY.dims.h);
    expect(size.z).toBeCloseTo(ENTRY.dims.w);
    expect(bounds.min.y).toBeCloseTo(0);
    expect(firstMesh.material).toBe(secondMesh.material);
  });

  it('notifies listeners after mutations and supports unsubscribe', () => {
    const listener = vi.fn();
    const unsubscribe = onExternalCatalogChange(listener);

    registerExternalCatalogEntry(ENTRY);
    registerExternalCatalogEntry(ENTRY);
    registerExternalCatalogEntry({
      ...ENTRY,
      model: {
        kind: 'glb',
        url: ENTRY.model.url,
        contentHash: 'b'.repeat(64),
      },
    });
    unregisterExternalCatalogEntry(ENTRY.id);
    expect(listener).toHaveBeenCalledTimes(3);

    registerExternalCatalogEntry(ENTRY);
    clearExternalCatalogEntries();
    expect(listener).toHaveBeenCalledTimes(5);
    unsubscribe();
    registerExternalCatalogEntry(ENTRY);
    expect(listener).toHaveBeenCalledTimes(5);
  });

  it('keeps the bundled authoring catalog unchanged', () => {
    registerExternalCatalogEntry(ENTRY);
    expect(AUTHORING_CATALOG.map((entry) => entry.id)).toEqual(authoringIds);
    expect(AUTHORING_CATALOG).not.toContain(ENTRY);
  });
});
