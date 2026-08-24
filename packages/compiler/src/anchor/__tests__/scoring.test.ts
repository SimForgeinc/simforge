/**
 * Scoring primitives and the tolerance bands from
 * `docs/research/retargeting.md` § Matcher.
 */

import { describe, expect, it } from 'vitest';

import {
  DEFAULT_TOLERANCES,
  armCountNearMiss,
  nearMissScore,
  passesRequired,
  scoreBool,
  scoreRange,
  scoreSet,
  toleranceFor,
} from '../scoring.js';
import { cumulativeLengths, curvatureDegPer10mAt, polylineIntersection, projectPoint } from '../geometry.js';
import { sha256Hex } from '../sha256.js';

describe('scoreRange', () => {
  it('scores 1 inside the range', () => {
    expect(scoreRange(50, [40, 60], 'speedKph').score).toBe(1);
    expect(scoreRange(40, [40, 60], 'speedKph').slack).toBe(0);
  });

  it('falls off linearly across the tolerance band and never goes negative', () => {
    // speed band is 10 kph: 5 kph out is half a point.
    expect(scoreRange(65, [40, 60], 'speedKph').score).toBeCloseTo(0.5, 6);
    expect(scoreRange(70, [40, 60], 'speedKph').score).toBe(0);
    expect(scoreRange(200, [40, 60], 'speedKph').score).toBe(0);
    expect(scoreRange(35, [40, 60], 'speedKph').slack).toBe(5);
  });

  it('uses "25% of range width, minimum 10 m" for distances', () => {
    expect(toleranceFor('distanceM', [0, 20])).toBe(10);
    expect(toleranceFor('distanceM', [0, 200])).toBe(50);
    expect(scoreRange(30, [0, 20], 'distanceM').score).toBe(0);
    expect(scoreRange(25, [0, 20], 'distanceM').score).toBeCloseTo(0.5, 6);
  });

  it('uses 0.4 m for widths and 2°/10 m for curvature', () => {
    expect(DEFAULT_TOLERANCES.widthM).toBe(0.4);
    expect(DEFAULT_TOLERANCES.curvatureDegPer10m).toBe(2);
    expect(scoreRange(3.1, [3.3, 3.9], 'widthM').score).toBeCloseTo(0.5, 6);
    expect(scoreRange(3, [0, 2], 'curvatureDegPer10m').score).toBeCloseTo(0.5, 6);
  });

  it('honours anchor-level and per-clause tolerance overrides', () => {
    expect(scoreRange(70, [40, 60], 'speedKph', { speedKph: 20 }).score).toBeCloseTo(0.5, 6);
    expect(scoreRange(70, [40, 60], 'speedKph', { speedKph: 20 }, 40).score).toBeCloseTo(0.75, 6);
    expect(scoreRange(41, [40, 60], 'speedKph', undefined, 0).score).toBe(1);
    expect(scoreRange(39, [40, 60], 'speedKph', undefined, 0).score).toBe(0);
  });
});

describe('scoreSet and the near-miss table', () => {
  it('implements the table from the research doc', () => {
    expect(nearMissScore('signalized', 'signalized')).toBe(1);
    expect(nearMissScore('all_way_stop', 'signalized')).toBe(0.6);
    expect(nearMissScore('signalized', 'all_way_stop')).toBe(0.6);
    expect(nearMissScore('minor_stop', 'yield')).toBe(0.85);
    expect(nearMissScore('signalized', 'uncontrolled')).toBe(0);
    expect(armCountNearMiss(4, 4)).toBe(1);
    expect(armCountNearMiss(3, 4)).toBe(0.4);
    expect(armCountNearMiss(4, 3)).toBe(0.4);
    expect(armCountNearMiss(6, 4)).toBe(0);
  });

  it('takes the best member of the requested set, deterministically', () => {
    expect(scoreSet('signalized', ['signalized', 'all_way_stop']).score).toBe(1);
    const near = scoreSet('all_way_stop', ['signalized']);
    expect(near.score).toBe(0.6);
    expect(near.closest).toBe('signalized');
    expect(near.slack).toBeCloseTo(0.4, 6);
    // Author order must not change the answer.
    expect(scoreSet('yield', ['minor_stop', 'signalized'])).toEqual(
      scoreSet('yield', ['signalized', 'minor_stop']),
    );
  });

  it('scores a miss with no near-miss entry as zero', () => {
    expect(scoreSet('roundabout', ['signalized']).score).toBe(0);
  });
});

describe('scoreBool and required gating', () => {
  it('is pass/fail', () => {
    expect(scoreBool(true, true).score).toBe(1);
    expect(scoreBool(false, true).score).toBe(0);
    expect(scoreBool(false, false).score).toBe(1);
  });

  it('treats a required clause as passing only at full score', () => {
    expect(passesRequired(1)).toBe(true);
    expect(passesRequired(0.999)).toBe(false);
    expect(passesRequired(0.6)).toBe(false);
  });
});

describe('geometry', () => {
  const straight = [
    { x: 0, y: 0 },
    { x: 10, y: 0 },
    { x: 20, y: 0 },
  ];

  it('measures arc length', () => {
    expect(cumulativeLengths(straight)).toEqual([0, 10, 20]);
  });

  it('reports zero curvature on a straight and real curvature on a bend', () => {
    expect(curvatureDegPer10mAt(straight, 10)).toBeCloseTo(0, 6);
    const bend = [
      { x: 0, y: 0 },
      { x: 10, y: 0 },
      { x: 20, y: 10 },
    ];
    expect(curvatureDegPer10mAt(bend, 10)).toBeGreaterThan(20);
  });

  it('projects a point with a signed side', () => {
    expect(projectPoint(straight, { x: 5, y: 3 })).toMatchObject({ side: 1 });
    expect(projectPoint(straight, { x: 5, y: -3 })).toMatchObject({ side: -1 });
    expect(projectPoint(straight, { x: 5, y: 3 }).s).toBeCloseTo(5, 6);
    expect(projectPoint(straight, { x: 5, y: 3 }).distance).toBeCloseTo(3, 6);
  });

  it('finds the first crossing of two polylines with its angle', () => {
    const crossing = polylineIntersection(straight, [
      { x: 12, y: -5 },
      { x: 12, y: 5 },
    ])!;
    expect(crossing.point.x).toBeCloseTo(12, 6);
    expect(crossing.sOnA).toBeCloseTo(12, 6);
    expect(crossing.angleDeg).toBeCloseTo(90, 6);
    expect(polylineIntersection(straight, [{ x: 0, y: 5 }, { x: 20, y: 5 }])).toBeNull();
  });
});

describe('sha256', () => {
  it('matches the FIPS-180-4 vectors', () => {
    expect(sha256Hex('')).toBe(
      'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
    );
    expect(sha256Hex('abc')).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    );
    expect(sha256Hex('a'.repeat(1000)).length).toBe(64);
  });
});
