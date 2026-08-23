import { describe, expect, it } from 'vitest';

import { isKnownPropCatalogId, knownPropCatalogIds, propDims } from '../prop-dims.js';

describe('catalog id resolution is fail-loud at author time', () => {
  it('accepts real catalog ids', () => {
    for (const id of ['vehicle.box_truck', 'construction.traffic_cone', 'construction.excavator']) {
      expect(isKnownPropCatalogId(id)).toBe(true);
    }
  });

  it('rejects the exact typo that silently became a sedan', () => {
    // `vehicle.boxTruck` does not exist; the real id is `vehicle.box_truck`.
    expect(isKnownPropCatalogId('vehicle.boxTruck')).toBe(false);
    expect(isKnownPropCatalogId('vehicle.cityBus')).toBe(false);
  });

  it('documents the silent fallback this predicate exists to prevent', () => {
    // propDims keeps its permissive behaviour for non-authoring consumers...
    expect(propDims('vehicle.boxTruck')).toEqual({ l: 4.7, w: 1.82, h: 1.45 });
    // ...which is byte-identical to a sedan, hence the need to check first.
    expect(propDims('vehicle.sedan')).toEqual(propDims('vehicle.boxTruck'));
  });

  it('offers a did-you-mean list', () => {
    const ids = knownPropCatalogIds();
    expect(ids).toContain('vehicle.box_truck');
    expect(ids).toEqual([...ids].sort());
    expect(ids.length).toBeGreaterThan(40);
  });
});
