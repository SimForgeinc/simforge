import { describe, expect, it } from 'vitest';
import { resolveFreeGroupPlacement, type GroupPlacementActor } from './group-placement';

const sedan = (dx: number, dz = 0): GroupPlacementActor => ({
  catalogId: 'vehicle.sedan',
  dx,
  dz,
  fallbackY: 0.25,
  headingRad: 0,
});

describe('resolveFreeGroupPlacement', () => {
  it('preserves group-relative layout at exact free-form cursor poses', () => {
    const result = resolveFreeGroupPlacement(
      [sedan(-5), sedan(5)],
      { x: 100, z: 40 },
      (x, z) => x / 100 + z / 1000,
      [],
    );

    expect(result.valid).toBe(true);
    expect(result.poses.map(({ x, y, z, headingRad }) => ({ x, y, z, headingRad }))).toEqual([
      { x: 95, y: 0.99, z: 40, headingRad: 0 },
      { x: 105, y: 1.09, z: 40, headingRad: 0 },
    ]);
  });

  it('rejects overlap with an existing actor', () => {
    const result = resolveFreeGroupPlacement(
      [sedan(0)],
      { x: 10, z: 20 },
      (_x, _z, fallbackY) => fallbackY,
      [{ id: 'parked-car', x: 10, z: 20, length: 4.7, width: 1.8, headingRad: 0 }],
    );

    expect(result.valid).toBe(false);
    expect(result.blockerId).toBe('parked-car');
  });

  it('rejects actors in the pasted group that overlap each other', () => {
    const result = resolveFreeGroupPlacement(
      [sedan(0), sedan(1)],
      { x: 0, z: 0 },
      (_x, _z, fallbackY) => fallbackY,
      [],
    );

    expect(result.valid).toBe(false);
    expect(result.blockerId).toBe('paste-0');
  });
});
