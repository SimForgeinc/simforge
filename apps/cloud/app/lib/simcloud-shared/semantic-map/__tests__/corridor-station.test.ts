/**
 * The corridor-station conventions, pinned.
 *
 * Every one of these is a silent failure when it is wrong: the anchor still
 * validates, the job still succeeds, the car just drives somewhere else. That
 * is why they are tested at this level rather than only through the callers —
 * a route compiler and an actor binder both cross this boundary, and the route
 * compiler got it wrong for a whole campaign by shipping a constant fraction.
 */

import { describe, expect, it } from "vitest";

import {
  corridorStationAnchor,
  parseRsl,
  pointAndYawAtStation,
  runtimeBindingAtCorridorStation,
  travelFractionToRoadFraction,
} from "../corridor-station";
import type { LaneCorridor, SemanticMapPoint } from "../types";

function straight(length: number, steps = 10): SemanticMapPoint[] {
  return Array.from({ length: steps + 1 }, (_, index) => ({
    x: (length * index) / steps,
    y: 0,
    z: 0,
  }));
}

function corridor(
  fragments: LaneCorridor["runtimeFragments"],
  lengthM: number,
): LaneCorridor {
  return {
    id: "c",
    laneType: "driving",
    runtimeFragments: fragments,
    polyline: straight(lengthM),
    lengthM,
    representativeWidthM: 3.5,
    minWidthM: 3.5,
    maxWidthM: 3.5,
    speedLimitKph: 50,
    start: { point: { x: 0, y: 0, z: 0 }, headingRad: 0, kind: "map_boundary", junctionId: null },
    end: { point: { x: lengthM, y: 0, z: 0 }, headingRad: 0, kind: "map_boundary", junctionId: null },
    predecessorCorridorIds: [],
    successorCorridorIds: [],
    lateralAdjacencies: [],
    seams: [],
    authoringStatus: "authorable",
    diagnosticCodes: [],
  } as unknown as LaneCorridor;
}

describe("parseRsl", () => {
  it("splits a road:section:lane key and keeps the road id a string", () => {
    expect(parseRsl("61:0:-7")).toEqual({
      roadId: "61",
      sectionId: 0,
      laneId: -7,
    });
  });

  it("refuses anything that is not three integers", () => {
    // A corridor whose fragment key does not parse must produce NO binding
    // rather than a partial one — a half-filled anchor resolves somewhere.
    for (const bad of ["", "61:0", "61:0:-7:1", "c_west_rsl", "61:a:-7", "61.5:0:-7"]) {
      expect(parseRsl(bad)).toBeNull();
    }
  });
});

describe("travelFractionToRoadFraction", () => {
  it("passes travel through on a negative-id lane, where +s runs with travel", () => {
    expect(travelFractionToRoadFraction(-1, 0)).toBe(0);
    expect(travelFractionToRoadFraction(-1, 0.25)).toBeCloseTo(0.25);
    expect(travelFractionToRoadFraction(-7, 1)).toBe(1);
  });

  it("inverts on a positive-id lane, where +s runs against travel", () => {
    expect(travelFractionToRoadFraction(1, 0)).toBe(1);
    expect(travelFractionToRoadFraction(1, 0.25)).toBeCloseTo(0.75);
    expect(travelFractionToRoadFraction(3, 1)).toBe(0);
  });

  it("clamps rather than extrapolating past the lane", () => {
    expect(travelFractionToRoadFraction(-1, 1.4)).toBe(1);
    expect(travelFractionToRoadFraction(-1, -0.2)).toBe(0);
  });
});

describe("runtimeBindingAtCorridorStation", () => {
  const twoFragments = corridor(
    [
      { rsl: "10:0:-1", startArcM: 0, endArcM: 40 },
      { rsl: "10:1:-1", startArcM: 40, endArcM: 100 },
    ],
    100,
  );

  it("picks the fragment that covers the station, not the first one", () => {
    expect(runtimeBindingAtCorridorStation(twoFragments, 10)).toMatchObject({
      roadId: "10",
      sectionId: 0,
    });
    expect(runtimeBindingAtCorridorStation(twoFragments, 70)).toMatchObject({
      roadId: "10",
      sectionId: 1,
    });
  });

  it("measures the fraction within the fragment, not along the corridor", () => {
    // 70 m along the corridor is 30 m into a 60 m fragment: half way, not 0.7.
    expect(runtimeBindingAtCorridorStation(twoFragments, 70)!.sFraction).toBeCloseTo(0.5);
    expect(runtimeBindingAtCorridorStation(twoFragments, 20)!.sFraction).toBeCloseTo(0.5);
  });

  it("binds the very end of the corridor to its last fragment", () => {
    // The walk reaches a corridor's final vertex on every leg; a lookup that
    // fell through there would leave the last anchor of every leg unbound.
    const end = runtimeBindingAtCorridorStation(twoFragments, 100);
    expect(end).toMatchObject({ sectionId: 1 });
    expect(end!.sFraction).toBeCloseTo(1);
  });

  it("returns null past the corridor rather than clamping into it", () => {
    expect(runtimeBindingAtCorridorStation(twoFragments, 140)).toBeNull();
    expect(runtimeBindingAtCorridorStation(twoFragments, -5)).toBeNull();
  });

  it("returns null when the fragment key is not a runtime lane", () => {
    const unparseable = corridor([{ rsl: "c_west_rsl", startArcM: 0, endArcM: 100 }], 100);
    expect(runtimeBindingAtCorridorStation(unparseable, 50)).toBeNull();
  });
});

describe("pointAndYawAtStation", () => {
  it("interpolates position and reports the heading of travel", () => {
    const at = pointAndYawAtStation(straight(100), 25);
    expect(at!.point.x).toBeCloseTo(25);
    expect(at!.yaw).toBeCloseTo(0);
  });

  it("reports the heading a corner turns to", () => {
    const corner: SemanticMapPoint[] = [
      { x: 0, y: 0, z: 0 },
      { x: 10, y: 0, z: 0 },
      { x: 10, y: 10, z: 0 },
    ];
    expect(pointAndYawAtStation(corner, 15)!.yaw).toBeCloseTo(90);
  });

  it("measures arc length in 3D, matching how corridors were built", () => {
    // `buildCorridors` accumulates `distance3dOr2d`. A 2D reading here would
    // drift from the fragment bounds on any road with real grade, and land
    // anchors in the neighbouring section.
    const climbing: SemanticMapPoint[] = [
      { x: 0, y: 0, z: 0 },
      { x: 30, y: 0, z: 40 },
    ];
    // 3D length is 50, so station 25 is the midpoint at x = 15.
    expect(pointAndYawAtStation(climbing, 25)!.point.x).toBeCloseTo(15);
  });
});

describe("corridorStationAnchor", () => {
  it("returns the lane binding and the world pose together", () => {
    const anchor = corridorStationAnchor(
      corridor([{ rsl: "10:0:-1", startArcM: 0, endArcM: 100 }], 100),
      60,
    );
    expect(anchor).toMatchObject({ roadId: "10", sectionId: 0, laneId: -1 });
    expect(anchor!.sFraction).toBeCloseTo(0.6);
    expect(anchor!.point.x).toBeCloseTo(60);
  });
});
