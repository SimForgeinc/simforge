import { describe, expect, it } from 'vitest';
import { propBehavior, propDims } from './prop-dims.js';

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
