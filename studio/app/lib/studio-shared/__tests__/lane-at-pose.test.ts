/**
 * `laneAtPose` — resolving a world point to a lane id.
 *
 * The fixture reproduces the geometry that makes this non-trivial: a two-way
 * road whose POSITIVE-id lane stores its centreline against the direction of
 * travel. That is the real convention (`laneFrameSign`), measured 195/195 on
 * Munich and 342/342 on Belmont, and it is what makes a naive
 * "reject lanes pointing the other way" heading filter pick the wrong lane.
 */
import { describe, expect, it } from "vitest";

import { laneAtPose } from "../map-topology/lane-at-pose";
import type { TopologyLane } from "../map-topology/types";

function lane(rsl: string, laneId: number, points: [number, number][], laneType = "driving"): TopologyLane {
  const [roadId, section] = rsl.split(":").map(Number);
  return {
    rsl,
    roadId: roadId!,
    section: section!,
    laneId,
    laneType,
    isJunction: false,
    junctionId: null,
    predecessors: [],
    successors: [],
    speedLimitKph: null,
    polyline: points.map(([x, y]) => ({ x, y })),
  } as TopologyLane;
}

/**
 * A road running east along y=0. Traffic travels EAST in both lanes.
 * Lane -1 sits at y=-2 and stores its centreline west-to-east (with travel).
 * Lane +1 sits at y=+2 and stores its centreline east-to-west (against it).
 */
const INDEX = {
  lanes: {
    "1:0:-1": lane("1:0:-1", -1, [[0, -2], [100, -2]]),
    "1:0:1": lane("1:0:1", 1, [[100, 2], [0, 2]]),
    "1:0:2": lane("1:0:2", 2, [[100, 6], [0, 6]]),
    "9:0:-1": lane("9:0:-1", -1, [[0, -40], [100, -40]], "sidewalk"),
  },
};

describe("laneAtPose", () => {
  it("resolves a point on a negative-id lane", () => {
    const hit = laneAtPose(INDEX, { x: 50, y: -2 });
    expect(hit?.rsl).toBe("1:0:-1");
    expect(hit?.laneId).toBe(-1);
    expect(hit?.distanceM).toBeCloseTo(0, 6);
  });

  it("resolves a point on a positive-id lane despite its reversed centreline", () => {
    // The whole point: this lane's stored polyline runs east-to-west while the
    // vehicle drives east. A heading filter would discard it and reach for the
    // far lane — on Munich that reached 93.59 m for a lane of the wrong sign.
    const hit = laneAtPose(INDEX, { x: 50, y: 2, yawDeg: 0 });
    expect(hit?.rsl).toBe("1:0:1");
    expect(hit?.laneId).toBe(1);
    expect(hit?.distanceM).toBeCloseTo(0, 6);
  });

  it("reports heading agreement after correcting for the reversed storage", () => {
    // Driving east on a positive lane whose polyline points west: agrees.
    expect(laneAtPose(INDEX, { x: 50, y: 2, yawDeg: 0 })?.headingAgrees).toBe(true);
    // Driving west on the same lane: does not.
    expect(laneAtPose(INDEX, { x: 50, y: 2, yawDeg: 180 })?.headingAgrees).toBe(false);
    // And the negative lane, whose polyline already runs with travel.
    expect(laneAtPose(INDEX, { x: 50, y: -2, yawDeg: 0 })?.headingAgrees).toBe(true);
    expect(laneAtPose(INDEX, { x: 50, y: -2, yawDeg: 180 })?.headingAgrees).toBe(false);
  });

  it("leaves heading agreement unknown when no heading is given", () => {
    expect(laneAtPose(INDEX, { x: 50, y: 2 })?.headingAgrees).toBeNull();
    expect(laneAtPose(INDEX, { x: 50, y: 2, yawDeg: null })?.headingAgrees).toBeNull();
  });

  it("picks the nearer of two same-sign lanes", () => {
    expect(laneAtPose(INDEX, { x: 50, y: 5.5 })?.laneId).toBe(2);
    expect(laneAtPose(INDEX, { x: 50, y: 2.5 })?.laneId).toBe(1);
  });

  it("never resolves to a non-driving lane", () => {
    // Right on the sidewalk centreline, and still not it.
    expect(laneAtPose(INDEX, { x: 50, y: -40 })).toBeNull();
  });

  it("returns null beyond the distance limit rather than guessing", () => {
    expect(laneAtPose(INDEX, { x: 50, y: -20 })).toBeNull();
    expect(laneAtPose(INDEX, { x: 50, y: -20 }, { maxDistanceM: 25 })?.laneId).toBe(-1);
  });

  it("measures perpendicular distance to the segment, not to its vertices", () => {
    const hit = laneAtPose(INDEX, { x: 50, y: -3.5 });
    expect(hit?.distanceM).toBeCloseTo(1.5, 6);
  });

  it("ignores lanes with a degenerate polyline", () => {
    const degenerate = { lanes: { "1:0:-1": lane("1:0:-1", -1, [[5, 0]]) } };
    expect(laneAtPose(degenerate, { x: 5, y: 0 })).toBeNull();
  });
});
