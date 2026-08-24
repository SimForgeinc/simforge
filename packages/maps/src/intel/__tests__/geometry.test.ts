/**
 * Geometry and identity primitives.
 */

import { describe, expect, it } from 'vitest';

import {
  asHandle,
  asLaneRef,
  asLocationId,
  formatLaneRef,
  isHandle,
  isLaneRef,
  isLocationId,
  parseLaneRef,
} from '../types/ids.js';
import { compareStrings } from '../build/compare.js';
import {
  angleBetween,
  bearingDegBetween,
  cumulativeLengths,
  headingToBearingDeg,
  poseAtS,
  polylineLength,
  projectOnSegment,
  wrapPi,
} from '../geometry/vec.js';
import { ElevationField } from '../geometry/elevation.js';

describe('branded ids', () => {
  it('validates shapes', () => {
    expect(() => asLaneRef('27:0:4')).not.toThrow();
    expect(() => asLaneRef('27:0')).toThrow(TypeError);
    expect(() => asLaneRef('junction/foo')).toThrow(TypeError);
    expect(() => asLocationId('loc_0123456789abcdef01234567')).not.toThrow();
    expect(() => asLocationId('loc_short')).toThrow(TypeError);
    expect(() => asHandle('junction/college-ave-at-yale-st')).not.toThrow();
    expect(() => asHandle('Junction/College Ave')).toThrow(TypeError);
  });

  it('keeps display strings out of placement positions', () => {
    // A handle is not a lane reference, and the shape check proves it at
    // runtime the same way the brands prove it at compile time.
    expect(isLaneRef('junction/college-ave-at-yale-st')).toBe(false);
    expect(isHandle('27:0:4')).toBe(false);
    expect(isLocationId('junction/college-ave-at-yale-st')).toBe(false);
  });

  it('round-trips lane reference components', () => {
    const parts = parseLaneRef(asLaneRef('115:2:-3'));
    expect(parts).toEqual({ roadId: 115, section: 2, laneId: -3 });
    expect(formatLaneRef(parts)).toBe('115:2:-3');
  });
});

describe('compareStrings', () => {
  it('matches default Array#sort ordering', () => {
    const input = ['387:1:1-1', '387:10:1-1', '387:2:1-1', 'a', 'B', 'á'];
    expect([...input].sort(compareStrings)).toEqual([...input].sort());
  });
});

describe('vec', () => {
  it('wraps angles into (-PI, PI]', () => {
    expect(wrapPi(0)).toBe(0);
    expect(wrapPi(3 * Math.PI)).toBeCloseTo(Math.PI, 9);
    expect(wrapPi(-3 * Math.PI)).toBeCloseTo(Math.PI, 9);
    expect(angleBetween(0.1, -0.1)).toBeCloseTo(0.2, 9);
    expect(angleBetween(3.1, -3.1)).toBeLessThan(0.1);
  });

  it('converts headings to compass bearings', () => {
    expect(headingToBearingDeg(0)).toBeCloseTo(90, 9); // +x is east
    expect(headingToBearingDeg(Math.PI / 2)).toBeCloseTo(0, 9); // +y is north
    expect(headingToBearingDeg(Math.PI)).toBeCloseTo(270, 9);
    expect(bearingDegBetween({ x: 0, y: 0 }, { x: 0, y: 1 })).toBeCloseTo(0, 9);
    expect(bearingDegBetween({ x: 0, y: 0 }, { x: 1, y: 0 })).toBeCloseTo(90, 9);
  });

  it('projects onto a segment with a left-positive side', () => {
    const p = projectOnSegment({ x: 0.5, y: 1 }, { x: 0, y: 0 }, { x: 1, y: 0 });
    expect(p.t).toBeCloseTo(0.5, 9);
    expect(p.distance).toBeCloseTo(1, 9);
    expect(p.side).toBeCloseTo(1, 9);
    const q = projectOnSegment({ x: 0.5, y: -1 }, { x: 0, y: 0 }, { x: 1, y: 0 });
    expect(q.side).toBeCloseTo(-1, 9);
    // Clamps to the segment rather than the infinite line.
    expect(projectOnSegment({ x: 5, y: 0 }, { x: 0, y: 0 }, { x: 1, y: 0 }).t).toBe(1);
  });

  it('samples a polyline by arc length', () => {
    const points = [
      { x: 0, y: 0 },
      { x: 10, y: 0 },
      { x: 10, y: 10 },
    ];
    const cum = cumulativeLengths(points);
    expect(cum).toEqual([0, 10, 20]);
    expect(polylineLength(points)).toBe(20);
    expect(poseAtS(points, cum, 5).point).toEqual({ x: 5, y: 0 });
    expect(poseAtS(points, cum, 15).point.y).toBeCloseTo(5, 9);
    expect(poseAtS(points, cum, 15).headingRad).toBeCloseTo(Math.PI / 2, 9);
    // Clamps outside the extent rather than extrapolating.
    expect(poseAtS(points, cum, -5).point).toEqual({ x: 0, y: 0 });
    expect(poseAtS(points, cum, 500).point).toEqual({ x: 10, y: 10 });
  });
});

describe('ElevationField', () => {
  it('returns the nearest sample and falls back to the global mean', () => {
    const field = new ElevationField();
    field.add(0, 0, 10);
    field.add(200, 200, 30);
    field.finalise();
    expect(field.cellCount).toBe(2);
    expect(field.at({ x: 1, y: 1 })).toBeCloseTo(10, 9);
    expect(field.at({ x: 201, y: 201 })).toBeCloseTo(30, 9);
    // Far from everything: the mean, not zero, not a crash.
    expect(field.at({ x: 100_000, y: 100_000 })).toBeCloseTo(20, 9);
  });

  it('ignores non-finite samples', () => {
    const field = new ElevationField();
    field.add(0, 0, Number.NaN);
    field.finalise();
    expect(field.cellCount).toBe(0);
    expect(field.at({ x: 0, y: 0 })).toBe(0);
  });
});
