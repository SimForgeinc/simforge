import { describe, expect, it } from "vitest";

import { lanePolyline } from "../runtime-lane-geometry";
import type { TopologyLane } from "@simforge-oss/maps/topology";
import type { RuntimeBoundLaneGeometry } from "../types";

/**
 * The connectivity blocker of 2026-07-29: CARLA's waypoint crawl steps along a
 * lane at a fixed interval and stops at the last whole step, so
 * `road_segments[].centerline` ends before the lane does. Measured over all 617
 * crawled Yale Street lanes, the runtime vertices sit on the XODR lane to within
 * 0.002 m laterally and the last one lands at 0.899 of the lane by median. Every
 * junction seam inherited the missing tail as a gap of a few metres, against a
 * 3 m limit.
 */
describe("lanePolyline", () => {
  const lane = (over: Partial<TopologyLane> = {}): TopologyLane => ({
    rsl: "1:0:-1",
    roadId: 1,
    section: 0,
    laneId: -1,
    laneType: "driving",
    isJunction: false,
    junctionId: null,
    predecessors: [],
    successors: [],
    speedLimitKph: null,
    representativeWidthM: 3.5,
    // A 20 m lane, sampled every 5 m.
    polyline: [
      { x: 0, y: 0 },
      { x: 5, y: 0 },
      { x: 10, y: 0 },
      { x: 15, y: 0 },
      { x: 20, y: 0 },
    ],
    ...(over as object),
  } as TopologyLane);

  const runtime = (
    polyline: Array<{ x: number; y: number; z: number | null }>,
    over: Partial<RuntimeBoundLaneGeometry> = {},
  ): Record<string, RuntimeBoundLaneGeometry> => ({
    "1:0:-1": {
      rsl: "1:0:-1",
      storedOrder: "road_s",
      representativeWidthM: 3.5,
      polyline,
      ...over,
    },
  });

  it("splices the tail the crawl never sampled, keeping the lane's own vertices", () => {
    // The crawl stopped at 15 m of a 20 m lane.
    const points = lanePolyline(lane(), runtime([
      { x: 0, y: 0, z: 11 },
      { x: 7.5, y: 0, z: 11.2 },
      { x: 15, y: 0, z: 11.4 },
    ]));
    expect(points[points.length - 1]).toMatchObject({ x: 20, y: 0 });
    // The runtime interior survives — this completes the crawl, it does not
    // replace it with the XODR sampling.
    expect(points.map((point) => point.x)).toEqual([0, 7.5, 15, 20]);
    // Elevation is held at the runtime end rather than nulled, so the seam
    // elevation check still has something to compare.
    expect(points[points.length - 1]!.z).toBe(11.4);
  });

  it("splices a missing head too", () => {
    const points = lanePolyline(lane(), runtime([
      { x: 5, y: 0, z: 11 },
      { x: 20, y: 0, z: 11 },
    ]));
    expect(points[0]).toMatchObject({ x: 0, y: 0 });
    expect(points.map((point) => point.x)).toEqual([0, 5, 20]);
  });

  it("adds nothing when the crawl already reached both ends", () => {
    const points = lanePolyline(lane(), runtime([
      { x: 0, y: 0, z: 11 },
      { x: 20, y: 0, z: 11 },
    ]));
    expect(points.map((point) => point.x)).toEqual([0, 20]);
  });

  it("does not splice an XODR tail that turns away from the runtime lane", () => {
    // Di Rosa 40:3:-1 ended with a crawl point on the successor seam, but its
    // XODR tail turned 90 degrees and ran another 5.86 m across the map. Lateral
    // projection alone called that a missing sample and put the route off-lane.
    const points = lanePolyline(
      lane({
        polyline: [
          { x: 0, y: 0 },
          { x: 15, y: 0 },
          { x: 15, y: 5.86 },
        ],
      }),
      runtime([
        { x: 0, y: 0, z: 11 },
        { x: 15, y: 0, z: 11 },
      ]),
    );
    expect(points.map(({ x, y }) => ({ x, y }))).toEqual([
      { x: 0, y: 0 },
      { x: 15, y: 0 },
    ]);
  });

  it("leaves an end alone when the runtime lane is a DIFFERENT curve", () => {
    // 4 m off to the side is not a short sample, it is a mis-binding, and the
    // seam gate should get to report it rather than have this paper over it.
    const points = lanePolyline(lane(), runtime([
      { x: 0, y: 4, z: 11 },
      { x: 15, y: 4, z: 11 },
    ]));
    expect(points.map((point) => point.x)).toEqual([0, 15]);
    expect(points.every((point) => point.y === 4)).toBe(true);
  });

  it("returns a travel-ordered source untouched", () => {
    // Same 15 m shortfall, but this source is not in +s order, so the lane's own
    // +s vertices are not comparable and nothing is spliced.
    const points = lanePolyline(lane(), runtime(
      [{ x: 15, y: 0, z: 11 }, { x: 0, y: 0, z: 11 }],
      { storedOrder: "travel" },
    ));
    expect(points.map((point) => point.x)).toEqual([15, 0]);
  });

  it("still reverses a positive-id lane after splicing", () => {
    // laneId > 0 is driven against +s by the convention, and the splice happens
    // in +s order before the flip.
    const points = lanePolyline(
      lane({ rsl: "1:0:1", laneId: 1 }),
      {
        "1:0:1": {
          rsl: "1:0:1",
          storedOrder: "road_s",
          representativeWidthM: 3.5,
          polyline: [{ x: 0, y: 0, z: 11 }, { x: 15, y: 0, z: 11 }],
        },
      },
    );
    expect(points.map((point) => point.x)).toEqual([20, 15, 0]);
  });

  it("falls back to the lane's own polyline with no runtime geometry", () => {
    const points = lanePolyline(lane(), {});
    expect(points.map((point) => point.x)).toEqual([0, 5, 10, 15, 20]);
    expect(points.every((point) => point.z === null)).toBe(true);
  });
});
