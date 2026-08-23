import { describe, expect, it } from "vitest";

import { appendPolyline } from "../geometry";

/**
 * `appendPolyline` used to average across ANY mismatch, so a segment handed to it
 * back to front was spliced at the midpoint of the gap and then walked
 * backwards — a polyline that looks smooth and drives into oncoming traffic.
 *
 * Written while chasing the 2026-07-29 gate-geometry demotions, which turned out
 * to be the crawl truncation in `runtime-lane-geometry.ts` rather than this. The
 * reversal it guards against is real but rare (4 of 51 remaining failing seams
 * across the eight corpus maps), so these cases pin behaviour, not a fix.
 */
describe("appendPolyline", () => {
  const line = (fromX: number, toX: number, steps = 4) =>
    Array.from({ length: steps + 1 }, (_, index) => ({
      x: fromX + ((toX - fromX) * index) / steps,
      y: 0,
      z: 0,
    }));

  it("joins an aligned segment without inventing a vertex", () => {
    const target = line(0, 10);
    appendPolyline(target, line(10, 20));
    expect(target[target.length - 1]).toMatchObject({ x: 20 });
    // Monotonic: it went one way.
    for (let index = 1; index < target.length; index += 1) {
      expect(target[index]!.x).toBeGreaterThan(target[index - 1]!.x);
    }
  });

  it("absorbs survey noise at the join, which is what the average is for", () => {
    const target = line(0, 10);
    appendPolyline(target, [{ x: 10.02, y: 0, z: 0 }, { x: 20, y: 0, z: 0 }]);
    expect(target[target.length - 1]).toMatchObject({ x: 20 });
    for (let index = 1; index < target.length; index += 1) {
      expect(target[index]!.x).toBeGreaterThanOrEqual(target[index - 1]!.x);
    }
  });

  it("FLIPS a reversed segment instead of averaging over the reversal", () => {
    const target = line(0, 10);
    // Same 10..20 stretch, stored back to front — the shape half a real map's
    // lanes are stored in.
    appendPolyline(target, line(20, 10));
    expect(target[target.length - 1]).toMatchObject({ x: 20 });
    // The whole path still runs one way. Before the fix this doubled back and
    // ended at x=10 having spliced a vertex at x=15.
    for (let index = 1; index < target.length; index += 1) {
      expect(target[index]!.x).toBeGreaterThan(target[index - 1]!.x);
    }
  });

  it("leaves a marginal difference alone rather than flipping on noise", () => {
    // Both ends near the join: flipping would be arbitrary, so it must not.
    const target = line(0, 10);
    appendPolyline(target, [{ x: 10.1, y: 0, z: 0 }, { x: 10.4, y: 0, z: 0 }]);
    expect(target[target.length - 1]).toMatchObject({ x: 10.4 });
  });

  it("merges a single-point segment into the join, having no direction to judge", () => {
    // Pre-existing behaviour, pinned rather than changed: a one-point segment
    // has no orientation, so it collapses into the averaging join and the path
    // ends at the midpoint. Worth a test because the orientation check above
    // deliberately skips this case, and a future reader will wonder whether the
    // skip is an oversight.
    const target = line(0, 10);
    appendPolyline(target, [{ x: 40, y: 0, z: 0 }]);
    expect(target[target.length - 1]).toMatchObject({ x: 25 });
  });
});
