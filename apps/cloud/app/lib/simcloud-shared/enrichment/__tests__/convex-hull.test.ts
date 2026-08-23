import { describe, expect, it } from "vitest";
import { convexHull, type LngLat } from "../convex-hull";

describe("convexHull", () => {
  it("returns the input unchanged when there are 0 or 1 points", () => {
    expect(convexHull([])).toEqual([]);
    expect(convexHull([[0, 0]])).toEqual([[0, 0]]);
  });

  it("wraps a square's hull and closes the ring", () => {
    const square: LngLat[] = [
      [0, 0],
      [1, 0],
      [1, 1],
      [0, 1],
    ];
    const hull = convexHull(square);
    expect(hull).toHaveLength(5); // 4 corners + closing duplicate
    expect(hull[0]).toEqual(hull[hull.length - 1]);
  });

  it("excludes interior points from the hull", () => {
    const pts: LngLat[] = [
      [0, 0],
      [4, 0],
      [4, 4],
      [0, 4],
      [2, 2], // interior
      [1, 1], // interior
    ];
    const hull = convexHull(pts);
    expect(hull).toHaveLength(5);
    expect(hull).not.toContainEqual([2, 2]);
    expect(hull).not.toContainEqual([1, 1]);
  });

  it("excludes points strictly on an edge between two hull points", () => {
    const pts: LngLat[] = [
      [0, 0],
      [2, 0],
      [4, 0], // mid-edge, collinear
      [4, 4],
      [0, 4],
    ];
    const hull = convexHull(pts);
    expect(hull).toHaveLength(5);
    expect(hull).not.toContainEqual([2, 0]);
  });

  it("handles arbitrary input order — same set of vertices", () => {
    const a = convexHull([
      [0, 0],
      [1, 0],
      [1, 1],
      [0, 1],
    ]);
    const b = convexHull([
      [1, 1],
      [0, 1],
      [1, 0],
      [0, 0],
    ]);
    expect(a).toHaveLength(b.length);
    const setA = new Set(a.map((p) => p.join(",")));
    const setB = new Set(b.map((p) => p.join(",")));
    expect(setA).toEqual(setB);
  });
});
