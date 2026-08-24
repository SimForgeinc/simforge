import { describe, expect, it } from 'vitest';
import { firstOverlap, footprintsOverlap, withinRange, type Footprint } from './obb';

const at = (x: number, z: number, headingDeg: number, length = 4.7, width = 1.82): Footprint => ({
  x,
  z,
  length,
  width,
  headingRad: (headingDeg * Math.PI) / 180,
});

describe('footprintsOverlap', () => {
  it('separates two cars nose to tail by their real length', () => {
    // Heading 0 points along +X, so a gap along X is a longitudinal gap.
    const a = at(0, 0, 0);
    // 4.7 m long, so bumpers touch at 4.7 m between centres; the 0.3 m
    // clearance pushes the threshold to 5.0.
    expect(footprintsOverlap(a, at(4.6, 0, 0), 0.3)).toBe(true);
    expect(footprintsOverlap(a, at(4.95, 0, 0), 0.3)).toBe(true);
    expect(footprintsOverlap(a, at(5.05, 0, 0), 0.3)).toBe(false);
    // Without the clearance they may sit bumper to bumper.
    expect(footprintsOverlap(a, at(4.75, 0, 0), 0)).toBe(false);
  });

  it('separates two cars side by side by their real width', () => {
    const a = at(0, 0, 0);
    expect(footprintsOverlap(a, at(0, 1.8, 0), 0.3)).toBe(true);
    expect(footprintsOverlap(a, at(0, 2.2, 0), 0.3)).toBe(false);
    // A lane's worth apart is clear.
    expect(footprintsOverlap(a, at(0, 3.5, 0), 0.3)).toBe(false);
  });

  it('is orientation-aware, not a bounding circle', () => {
    // Two 20 m trailers, one along X and one along Z, crossing at the origin:
    // their circles overlap hugely, their boxes only near the crossing.
    const long = { length: 20.1, width: 2.6 };
    const a = at(0, 0, 0, long.length, long.width);
    const crossing = at(8, 0, 90, long.length, long.width);
    expect(withinRange(a, crossing, 0.3)).toBe(true); // circles say "maybe"
    expect(footprintsOverlap(a, crossing, 0.3)).toBe(true); // and the boxes agree
    const clear = at(0, 8, 0, long.length, long.width); // parallel, 8 m to the side
    expect(withinRange(a, clear, 0.3)).toBe(true);
    expect(footprintsOverlap(a, clear, 0.3)).toBe(false); // circles would say "hit"
  });

  it('is symmetric and rotation-invariant', () => {
    for (let deg = 0; deg < 360; deg += 17) {
      const rad = (deg * Math.PI) / 180;
      // The same pair, rigidly rotated about the origin, must give one answer.
      const d = 3.0;
      const a = at(0, 0, deg);
      const b = at(Math.cos(rad) * d, -Math.sin(rad) * d, deg);
      expect(footprintsOverlap(a, b, 0.3)).toBe(true);
      expect(footprintsOverlap(b, a, 0.3)).toBe(true);
      const far = at(Math.cos(rad) * 6, -Math.sin(rad) * 6, deg);
      expect(footprintsOverlap(a, far, 0.3)).toBe(false);
      expect(footprintsOverlap(far, a, 0.3)).toBe(false);
    }
  });

  it('treats a pedestrian as the small box it is', () => {
    const ped = { length: 0.85, width: 0.5 };
    const a = at(0, 0, 0, ped.length, ped.width);
    // 0.85 m deep plus 0.3 m clearance: they clear at 1.15 m apart, not at the
    // ~2.5 m a car-sized box would demand.
    expect(footprintsOverlap(a, at(1.1, 0, 0, ped.length, ped.width), 0.3)).toBe(true);
    expect(footprintsOverlap(a, at(1.2, 0, 0, ped.length, ped.width), 0.3)).toBe(false);
  });
});

describe('firstOverlap', () => {
  const others = [
    { id: 'a', ...at(0, 0, 0) },
    { id: 'b', ...at(20, 0, 0) },
    { id: 'c', ...at(40, 0, 0) },
  ];

  it('finds the blocker and skips the actor being moved', () => {
    expect(firstOverlap(at(20.5, 0, 0), others, 0.3)?.id).toBe('b');
    expect(firstOverlap(at(20.5, 0, 0), others, 0.3, new Set(['b']))).toBeNull();
    expect(firstOverlap(at(10, 0, 0), others, 0.3)).toBeNull();
  });
});
