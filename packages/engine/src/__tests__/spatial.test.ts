import { describe, expect, it } from 'vitest';

import { spatialCandidatePairs } from '../sim/spatial.js';

describe('deterministic spatial broadphase', () => {
  it('is declaration-order independent and returns stable sorted pairs', () => {
    const items = [
      { id: 'z', minX: 8, minY: 0, maxX: 12, maxY: 2 },
      { id: 'a', minX: 0, minY: 0, maxX: 9, maxY: 2 },
      { id: 'm', minX: 100, minY: 100, maxX: 102, maxY: 102 },
    ];
    expect(spatialCandidatePairs(items, 10)).toEqual([{ a: 'a', b: 'z' }]);
    expect(spatialCandidatePairs([...items].reverse(), 10)).toEqual([{ a: 'a', b: 'z' }]);
  });

  it('reduces separated dense traffic from quadratic candidate growth', () => {
    const items = Array.from({ length: 128 }, (_, i) => ({
      id: `actor-${String(i).padStart(3, '0')}`,
      minX: i * 30,
      maxX: i * 30 + 5,
      minY: 0,
      maxY: 2,
    }));
    expect(spatialCandidatePairs(items, 20)).toHaveLength(0);
  });

  it('keeps broadphase false positives so narrow phase can decide contact', () => {
    expect(spatialCandidatePairs([
      { id: 'a', minX: 0, minY: 0, maxX: 1, maxY: 1 },
      { id: 'b', minX: 19, minY: 19, maxX: 19.5, maxY: 19.5 },
    ], 20)).toEqual([{ a: 'a', b: 'b' }]);
  });
});
