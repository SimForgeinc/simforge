import { describe, expect, it } from "vitest";
import fixtures from "./fixtures/divert-tail-parity.json";
import {
  DIVERT_TAIL_MAX_M,
  divertTailFromAbsolute,
  divertTailLengthM,
  resolveDivertTail,
} from "../divert-tail";
import { BehaviorClipSchema } from "../scenario-behavior";

/**
 * The relative divert tail (`plans/2026-07-29-one-motion-model.md` §2.3).
 *
 * The property that matters is not "the maths is right" — it is that a tail means
 * the same thing wherever the car happens to be, because that is the only reason
 * drawn geometry survives cross-map transfer at all. So the tests are mostly about
 * INVARIANCE: the same tail, from different poses, produces the same shape.
 */

const clip = (action: Record<string, unknown>) =>
  BehaviorClipSchema.safeParse({
    id: "c1",
    trigger: { kind: "at_time", t: 1 },
    end: { kind: "completion" },
    action: { kind: "divert_path", ...action },
  });

describe("resolveDivertTail", () => {
  it("puts forward along the heading and lateral to the LEFT", () => {
    // Heading east (yaw 0): forward is +x, left is +y. Getting the handedness
    // backwards is the single most consequential possible error here — the car
    // swerves into oncoming traffic instead of onto the shoulder — and it is
    // invisible in any test that only checks distances.
    const [point] = resolveDivertTail([{ forward_m: 10, lateral_m: 3 }], {
      x: 0,
      y: 0,
      yawDeg: 0,
    });
    expect(point!.x).toBeCloseTo(10, 9);
    expect(point!.y).toBeCloseTo(3, 9);
  });

  it("means the same shape from any pose", () => {
    const tail = [
      { forward_m: 10, lateral_m: 3.5 },
      { forward_m: 25, lateral_m: 3.5 },
      { forward_m: 35, lateral_m: 0 },
    ];
    const shapeOf = (pose: { x: number; y: number; yawDeg: number }) => {
      const points = resolveDivertTail(tail, pose);
      // Leg lengths and turn angles: everything about the shape except where and
      // which way it sits, which is exactly what must NOT survive the move.
      const legs: number[] = [];
      let previous = { x: pose.x, y: pose.y };
      for (const point of points) {
        legs.push(Number(Math.hypot(point.x - previous.x, point.y - previous.y).toFixed(6)));
        previous = point;
      }
      return legs;
    };
    const reference = shapeOf({ x: 0, y: 0, yawDeg: 0 });
    expect(shapeOf({ x: 812.5, y: -1904.25, yawDeg: 137.4 })).toEqual(reference);
    expect(shapeOf({ x: -20, y: 5, yawDeg: -90 })).toEqual(reference);
  });

  it("holds z at the pose rather than inventing an elevation", () => {
    // A tail is a 2D drag over the map, so it has no opinion about height.
    // Interpolating one would put a car under a bridge deck it was drawn beside.
    const points = resolveDivertTail(
      [{ forward_m: 5, lateral_m: 0 }, { forward_m: 40, lateral_m: 0 }],
      { x: 0, y: 0, z: 13.25, yawDeg: 0 },
    );
    expect(points.map((point) => point.z)).toEqual([13.25, 13.25]);
  });

  it("round-trips an absolute polyline back to itself", () => {
    const pose = { x: 626.788, y: 1812.109, z: 13, yawDeg: -48.146 };
    const absolute = [
      { x: 640, y: 1800 },
      { x: 655.5, y: 1788.25 },
    ];
    const resolved = resolveDivertTail(divertTailFromAbsolute(absolute, pose), pose);
    for (const [index, point] of absolute.entries()) {
      expect(resolved[index]!.x).toBeCloseTo(point.x, 6);
      expect(resolved[index]!.y).toBeCloseTo(point.y, 6);
    }
  });
});

describe("divertTailLengthM", () => {
  it("measures along the path, from the pose", () => {
    // The first leg counts from the pose itself: a tail whose first vertex is
    // 500 m ahead has driven 500 m off-graph even though its vertices sit close
    // together, and a bound that ignored that leg would let it through.
    expect(divertTailLengthM([{ forward_m: 10, lateral_m: 0 }])).toBeCloseTo(10, 9);
    expect(
      divertTailLengthM([
        { forward_m: 0, lateral_m: 3 },
        { forward_m: 4, lateral_m: 3 },
      ]),
    ).toBeCloseTo(7, 9);
  });

  it("is path length, not displacement", () => {
    // A switchback that ends where it started still drove the whole way.
    const tail = [
      { forward_m: 30, lateral_m: 0 },
      { forward_m: 0, lateral_m: 0 },
    ];
    expect(divertTailLengthM(tail)).toBeCloseTo(60, 9);
  });
});

describe("the divert_path clip invariants", () => {
  it("accepts a tail inside the cap", () => {
    expect(clip({ tail: [{ forward_m: 10, lateral_m: 3 }] }).success).toBe(true);
  });

  it("rejects a tail beyond the cap, measured along the path", () => {
    // 30 m out and 30 m back is 60 m driven for 0 m of displacement, so a bound on
    // displacement would wave this through. It sits exactly AT the cap, so the
    // rejection needs one more metre to be a real test of the boundary.
    expect(clip({ tail: [{ forward_m: 30, lateral_m: 0 }, { forward_m: 0, lateral_m: 0 }] }).success).toBe(
      true,
    );
    const tooLong = clip({
      tail: [{ forward_m: 31, lateral_m: 0 }, { forward_m: 0, lateral_m: 0 }],
    });
    expect(tooLong.success).toBe(false);
    expect(JSON.stringify(tooLong.error?.issues)).toContain("departure from a route");
  });

  it("requires exactly one of tail and waypoints", () => {
    expect(clip({}).success).toBe(false);
    expect(
      clip({
        tail: [{ forward_m: 5, lateral_m: 0 }],
        waypoints: [{ x: 1, y: 2 }],
      }).success,
    ).toBe(false);
  });

  it("still accepts the absolute form, uncapped", () => {
    // The 21 corpus actors that carry a drawn path have not been converted yet, and
    // capping the legacy form retroactively would fail-closed on scenarios that
    // work today. That is a migration decision, not a schema one.
    const long = clip({
      waypoints: Array.from({ length: 20 }, (_, index) => ({ x: index * 50, y: 0 })),
    });
    expect(long.success).toBe(true);
  });

  it("leaves rejoin absent, so the field's arrival changed no constructor", () => {
    // Absent reads as `end_clip` by convention. A schema `.default()` would make
    // the key REQUIRED in the output type and force every place that builds a
    // divert clip to name a value it has no opinion about.
    const parsed = clip({ tail: [{ forward_m: 5, lateral_m: 0 }] });
    expect(parsed.success).toBe(true);
    expect(
      parsed.success && parsed.data.action.kind === "divert_path"
        ? parsed.data.action.rejoin
        : "unset",
    ).toBeUndefined();
  });
});

/**
 * The fixtures the worker's `_resolve_divert_tail` is held to.
 *
 * Two implementations doing their own trigonometry agree until they don't, and the
 * disagreement surfaces as a car swerving the wrong way in a render nobody
 * re-previewed. Both sides read this file, so neither can be "fixed" alone.
 */
describe("parity fixtures", () => {
  it("matches the stored expectation for every fixture", () => {
    // Asserting against STORED values, not against a freshly computed result: a
    // test that recomputes what it checks passes no matter what the code does. The
    // Python side asserts the same numbers, so neither implementation can move
    // without the other failing.
    for (const testCase of fixtures.cases) {
      const resolved = resolveDivertTail(testCase.tail, testCase.pose);
      expect(resolved).toHaveLength(testCase.expected.length);
      for (const [index, point] of resolved.entries()) {
        expect(point.x).toBeCloseTo(testCase.expected[index]!.x, 6);
        expect(point.y).toBeCloseTo(testCase.expected[index]!.y, 6);
        expect(point.z).toBeCloseTo(testCase.expected[index]!.z, 6);
      }
      expect(divertTailLengthM(testCase.tail)).toBeCloseTo(testCase.expectedLengthM, 6);
    }
  });

  it("keeps the cap in step with the worker's copy", () => {
    // `DIVERT_TAIL_MAX_M` is duplicated in `behavior_program.py` because the worker
    // cannot import TypeScript. The Python test asserts the same literal.
    expect(DIVERT_TAIL_MAX_M).toBe(60);
  });
});
