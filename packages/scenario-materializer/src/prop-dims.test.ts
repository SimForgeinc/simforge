import { describe, expect, it } from 'vitest';
import {
  createActorCatalogResolver,
  propBehavior,
  propDims,
} from './prop-dims.js';

describe('campaign prop materialization metadata', () => {
  it('uses exact catalog dimensions for specialized actors and props', () => {
    expect(propDims('vehicle.tram')).toEqual({ l: 30, w: 2.65, h: 3.5 });
    expect(propDims('construction.long_pipe')).toEqual({ l: 8, w: 0.62, h: 0.62 });
    expect(propDims('street.shopping_cart')).toEqual({ l: 1.05, w: 0.65, h: 1.05 });
  });

  it('defaults physical work-zone and rolling props to collidable occluders', () => {
    for (const id of [
      'construction.traffic_cone',
      'construction.channelizer_drum',
      'construction.excavator',
      'construction.barricade_type3',
      'construction.portable_signal',
      'construction.long_pipe',
      'street.shopping_cart',
    ]) expect(propBehavior(id), id).toEqual({ collidable: true, occluder: true });
  });
});

describe('external actor catalog metadata', () => {
  it('accepts a hyphenated gallery UUID and preserves its model binding', () => {
    const catalogId = 'gallery.90dc9cf7-5c32-4a97-b43b-768f2749a221.v1';
    const resolve = createActorCatalogResolver([{
      id: catalogId,
      label: 'Kia Carnival',
      class: 'vehicle',
      actorClass: 'car',
      description: 'Kia Carnival',
      dims: { l: 5.155, w: 1.995, h: 1.775 },
      tags: ['passenger'],
      defaultParams: {},
      model: {
        kind: 'glb',
        url: 'https://example.invalid/kia-carnival.glb',
        contentHash: 'a'.repeat(64),
        animated: false,
      },
    }]);

    expect(resolve(catalogId)).toMatchObject({
      id: catalogId,
      actorClass: 'car',
      dims: { l: 5.155, w: 1.995, h: 1.775 },
      model: {
        kind: 'glb',
        url: 'https://example.invalid/kia-carnival.glb',
        contentHash: 'a'.repeat(64),
      },
    });
  });
});
