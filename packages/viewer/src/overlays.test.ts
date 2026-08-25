import { describe, expect, it } from 'vitest';
import { ViewerOverlayLayer } from './overlays';

describe('ViewerOverlayLayer', () => {
  it('replaces pins, paths and markers atomically and snaps them to ground', () => {
    const layer = new ViewerOverlayLayer(() => 12);
    layer.set({
      pins: [{ id: 'result', position: { x: 1, y: -99, z: 2 }, highlighted: true }],
      paths: [{
        id: 'route',
        points: [{ x: 0, y: 0, z: 0 }, { x: 3, y: 0, z: 4 }],
        arrow: true,
      }],
      markers: [{ id: 'spawn', position: { x: 5, y: 0, z: 6 }, shape: 'box' }],
    });

    expect(layer.group.children.map((child) => child.name)).toEqual([
      'pin:result',
      'path:route',
      'marker:spawn',
    ]);
    expect(layer.group.getObjectByName('pin:result')?.children[0]?.position.y).toBeCloseTo(14.15);

    layer.set({ markers: [{ id: 'collision', position: { x: 0, y: 0, z: 0 }, shape: 'cross' }] });
    expect(layer.group.children.map((child) => child.name)).toEqual(['marker:collision']);
    expect(layer.group.children[0]?.children).toHaveLength(2);
    layer.dispose();
    expect(layer.group.children).toHaveLength(0);
  });

  it('falls back to authored height when ground is unavailable', () => {
    const layer = new ViewerOverlayLayer(() => null);
    layer.set({ pins: [{ id: 'fallback', position: { x: 0, y: 7, z: 0 } }] });
    expect(layer.group.children[0]?.children[0]?.position.y).toBeCloseTo(8.75);
  });
});
