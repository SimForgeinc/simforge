import { describe, expect, it } from "vitest";
import {
  flipFractionForTravel,
  laneTravelIncreasesS,
  laneTravelIncreasesSByConvention,
  laneTravelIncreasesSFromCenterline,
  travelOrderedPolyline,
} from "../lane-travel";

/**
 * One place decides which way a lane is driven, because getting it wrong faces
 * vehicles into oncoming traffic. The resolved answer — CARLA's waypoint yaw,
 * stamped onto the bound index — must always beat the lane-id sign convention,
 * which OpenDRIVE does not guarantee.
 */
describe("laneTravelIncreasesS", () => {
  it("prefers the resolved answer over the lane-id sign", () => {
    const resolved = { "1:0:1": true, "1:0:-1": false };

    // Both are the opposite of what the convention would say.
    expect(laneTravelIncreasesS(resolved, "1:0:1", 1)).toBe(true);
    expect(laneTravelIncreasesS(resolved, "1:0:-1", -1)).toBe(false);
  });

  it("falls back to the convention for a lane the crawl never covered", () => {
    const resolved = { "1:0:1": true };

    expect(laneTravelIncreasesS(resolved, "9:0:-1", -1)).toBe(true);
    expect(laneTravelIncreasesS(resolved, "9:0:2", 2)).toBe(false);
  });

  it("falls back to the convention for an index compiled before the field", () => {
    expect(laneTravelIncreasesS(undefined, "1:0:-1", -1)).toBe(true);
    expect(laneTravelIncreasesS(undefined, "1:0:1", 1)).toBe(false);
  });

  /** `false` is a real answer and must not be treated as "unresolved". */
  it("does not mistake a resolved false for a missing entry", () => {
    expect(laneTravelIncreasesS({ "1:0:-1": false }, "1:0:-1", -1)).toBe(false);
  });
});

/**
 * Reading the direction off the lane's own crawled samples.
 *
 * The regression this guards is `78:1:-3` on Di Rosa SF: the corridor builder
 * used to decide travel direction by comparing the lane's `s` against its
 * SUCCESSOR's, and `s` restarts at 0 on every road — so a lane entered at
 * s = 0.5 and leaving onto a junction connector at s = 0 read as "travel
 * decreases s". That flipped the s-fraction, and a car authored 54 m along its
 * lane spawned back at the lane's start, 56 m behind where the author placed it.
 */
describe("laneTravelIncreasesSFromCenterline", () => {
  /** A lane running north: +s tangent is +y, yaw 90 degrees agrees with it. */
  const northbound = [
    { x: 0, y: 0, yaw: 90 },
    { x: 0, y: 10, yaw: 90 },
    { x: 0, y: 20, yaw: 90 },
  ];

  it("reads travel WITH +s when the yaw agrees with the tangent", () => {
    expect(laneTravelIncreasesSFromCenterline(northbound, -3)).toBe(true);
  });

  it("reads travel AGAINST +s when the yaw opposes the tangent", () => {
    const opposed = northbound.map((point) => ({ ...point, yaw: -90 }));
    expect(laneTravelIncreasesSFromCenterline(opposed, -3)).toBe(false);
  });

  /** The sign convention is the last resort, not the first answer. */
  it("beats the lane-id sign convention when the samples disagree with it", () => {
    // A negative lane id says "with +s" by convention; the crawl says otherwise.
    const opposed = northbound.map((point) => ({ ...point, yaw: -90 }));
    expect(laneTravelIncreasesSByConvention(-3)).toBe(true);
    expect(laneTravelIncreasesSFromCenterline(opposed, -3)).toBe(false);
  });

  it("falls back to the convention when no sample carries a usable yaw", () => {
    const unyawed = [
      { x: 0, y: 0 },
      { x: 0, y: 10 },
    ];
    expect(laneTravelIncreasesSFromCenterline(unyawed, -3)).toBe(true);
    expect(laneTravelIncreasesSFromCenterline(unyawed, 3)).toBe(false);
    const nulled = [
      { x: 0, y: 0, yaw: null },
      { x: 0, y: 10, yaw: Number.NaN },
    ];
    expect(laneTravelIncreasesSFromCenterline(nulled, 3)).toBe(false);
  });

  /** Every sample votes, so one bad yaw near a junction cannot flip the lane. */
  it("outvotes a single contrary sample", () => {
    const oneBad = [
      { x: 0, y: 0, yaw: 90 },
      { x: 0, y: 10, yaw: -90 },
      { x: 0, y: 20, yaw: 90 },
      { x: 0, y: 30, yaw: 90 },
    ];
    expect(laneTravelIncreasesSFromCenterline(oneBad, -3)).toBe(true);
  });

  it("handles a lane too short to have a tangent", () => {
    expect(laneTravelIncreasesSFromCenterline([{ x: 0, y: 0, yaw: 90 }], -3)).toBe(true);
    expect(laneTravelIncreasesSFromCenterline([], 3)).toBe(false);
  });

  /**
   * The Di Rosa `78:1:-3` shape: a northbound lane whose successor restarts `s`
   * at 0. Only the lane's own samples are consulted, so the successor cannot
   * affect the answer.
   */
  it("is unaffected by where the successor's s axis restarts", () => {
    expect(laneTravelIncreasesSFromCenterline(northbound, -3)).toBe(true);
  });
});

describe("laneTravelIncreasesSByConvention", () => {
  it("reads negative ids as running with +s and positive against it", () => {
    expect(laneTravelIncreasesSByConvention(-1)).toBe(true);
    expect(laneTravelIncreasesSByConvention(1)).toBe(false);
  });

  /** Lane 0 is the reference line itself and is never driven; the safe read
   *  is the same one the old inline expressions gave. */
  it("treats a missing or zero lane id as against +s", () => {
    expect(laneTravelIncreasesSByConvention(0)).toBe(false);
    expect(laneTravelIncreasesSByConvention(null)).toBe(true);
    expect(laneTravelIncreasesSByConvention(undefined)).toBe(true);
  });
});

describe("travelOrderedPolyline", () => {
  const points = [1, 2, 3];

  it("leaves a with-travel lane alone and reverses an against-travel one", () => {
    expect(travelOrderedPolyline(points, true)).toEqual([1, 2, 3]);
    expect(travelOrderedPolyline(points, false)).toEqual([3, 2, 1]);
  });

  it("copies rather than reversing the caller's array in place", () => {
    travelOrderedPolyline(points, false);
    expect(points).toEqual([1, 2, 3]);
  });
});

describe("flipFractionForTravel", () => {
  it("is identity with travel and a mirror against it", () => {
    expect(flipFractionForTravel(0.2, true)).toBeCloseTo(0.2);
    expect(flipFractionForTravel(0.2, false)).toBeCloseTo(0.8);
  });

  it("is its own inverse", () => {
    expect(flipFractionForTravel(flipFractionForTravel(0.3, false), false))
      .toBeCloseTo(0.3);
  });

  it("clamps out-of-range fractions before flipping", () => {
    expect(flipFractionForTravel(-1, false)).toBeCloseTo(1);
    expect(flipFractionForTravel(2, false)).toBeCloseTo(0);
  });
});
