import { describe, expect, it } from 'vitest';
import {
  solvePlanarCollisions,
  type PlanarCollisionBody,
} from '../sim/collision-response.js';

function body(
  id: string,
  x: number,
  previousX: number,
  vx: number,
  y = 0,
): PlanarCollisionBody {
  return {
    id,
    lengthM: 4,
    widthM: 2,
    inverseMass: 1 / 1_500,
    inverseInertia: 1 / 2_500,
    previous: { x: previousX, y, yawRad: 0 },
    x,
    y,
    yawRad: 0,
    vx,
    vy: 0,
    angularVelocity: 0,
  };
}

describe('deterministic planar collision response', () => {
  it('uses swept contact to prevent a high-speed vehicle tunneling through a wall', () => {
    const car = body('car', 10, 0, 200);
    const impulses = solvePlanarCollisions([car], [{
      id: 'map:wall',
      obb: { center: { x: 5, y: 0 }, lengthM: 0.2, widthM: 20, headingRad: 0 },
    }], 0.05);
    expect(car.x).toBeLessThan(2.92);
    expect(car.vx).toBeLessThanOrEqual(0);
    expect(impulses[0]?.normalImpulseNs).toBeGreaterThan(200_000);
  });

  it('preserves bounded momentum and energy for equal vehicle impacts', () => {
    const a = body('a', 0.2, -0.3, 10);
    const b = body('b', 3.8, 4.3, -10);
    const beforeMomentum = 1_500 * (a.vx + b.vx);
    const beforeEnergy = 0.5 * 1_500 * (a.vx ** 2 + b.vx ** 2);
    solvePlanarCollisions([a, b], [], 0.05);
    const afterMomentum = 1_500 * (a.vx + b.vx);
    const afterEnergy = 0.5 * 1_500 * (a.vx ** 2 + b.vx ** 2);
    expect(Math.abs(afterMomentum - beforeMomentum)).toBeLessThan(1e-6);
    expect(afterEnergy).toBeLessThanOrEqual(beforeEnergy * 1.01);
  });

  it('is declaration-order deterministic and depenetrates resting contacts below 2 cm', () => {
    const run = (reverse: boolean) => {
      const a = body('a', 0, 0, 0);
      const b = body('b', 3.5, 3.5, 0);
      solvePlanarCollisions(reverse ? [b, a] : [a, b], [], 0.05);
      return { a: { x: a.x, vx: a.vx }, b: { x: b.x, vx: b.vx } };
    };
    const normal = run(false);
    const reversed = run(true);
    expect(reversed).toEqual(normal);
    const remainingPenetration = 4 - (normal.b.x - normal.a.x);
    expect(remainingPenetration).toBeLessThan(0.02);
  });

  it('adds angular response and friction for a glancing impact', () => {
    const car = body('car', 3, 2.6, 8, 1.5);
    car.vy = -3;
    solvePlanarCollisions([car], [{
      id: 'prop:barrier',
      obb: { center: { x: 5, y: 0 }, lengthM: 0.3, widthM: 10, headingRad: 0 },
    }], 0.05);
    expect(Math.abs(car.angularVelocity)).toBeGreaterThan(0.01);
    expect(Math.hypot(car.vx, car.vy)).toBeLessThan(Math.hypot(8, -3));
  });
});
