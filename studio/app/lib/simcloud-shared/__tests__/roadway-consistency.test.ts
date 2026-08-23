import { describe, expect, it } from "vitest";
import type { TopologyLane } from "../map-topology/types";
import {
  RoadwayConsistencyReportSchema,
  validateRoadwayConsistency,
} from "../map-topology/roadway-consistency";

function line(rsl: string, x: number, options: Partial<TopologyLane> = {}): TopologyLane {
  const [roadId, section, laneId] = rsl.split(":").map(Number);
  return {
    rsl, roadId, section, laneId, laneType: "driving", isJunction: false,
    junctionId: null, predecessors: [], successors: [], speedLimitKph: 40,
    representativeWidthM: 3.5,
    polyline: [{ x, y: 0 }, { x, y: 20 }],
    ...options,
  };
}

function neighbors(a: TopologyLane, b: TopologyLane, allowed: boolean) {
  a.adjacentLanes = {
    left: { side: "left", laneRsl: b.rsl, sameDirection: true, permissionIds: [`${a.rsl}:left`] },
  };
  b.adjacentLanes = {
    right: { side: "right", laneRsl: a.rsl, sameDirection: true, permissionIds: [`${b.rsl}:right`] },
  };
  a.laneChangePermissions = [{ id: `${a.rsl}:left`, side: "left", startS: 0, endS: 20, allowed, marking: allowed ? "broken" : "solid", source: "derived_same_section" }];
  b.laneChangePermissions = [{ id: `${b.rsl}:right`, side: "right", startS: 0, endS: 20, allowed, marking: allowed ? "broken" : "solid", source: "derived_same_section" }];
}

function topology(lanes: TopologyLane[]) {
  return {
    mapName: "fixture",
    source: { xodrSha256: "a".repeat(64) },
    lanes: Object.fromEntries(lanes.map((lane) => [lane.rsl, lane])),
  };
}

describe("validateRoadwayConsistency", () => {
  it("accepts a legal dashed same-direction pair", () => {
    const right = line("25:0:-3", 3.5);
    const left = line("25:0:-2", 0);
    neighbors(right, left, true);
    const report = validateRoadwayConsistency(topology([right, left]));
    expect(report.intervals).toHaveLength(1);
    expect(report.intervals[0]).toMatchObject({ semanticAdjacent: true, semanticLaneChangeAllowed: true });
    expect(report.issues).toEqual([]);
  });

  it("accepts adjacent solid lanes while preserving the blocked permission", () => {
    const right = line("30:0:-2", 3.5);
    const left = line("30:0:-1", 0);
    neighbors(right, left, false);
    const report = validateRoadwayConsistency(topology([right, left]));
    expect(report.intervals[0]).toMatchObject({ semanticAdjacent: true, semanticLaneChangeAllowed: false });
    expect(report.issues).toEqual([]);
  });

  it("finds the Yale-style adjacency dropped between junction connectors", () => {
    const approachRight = line("25:0:-3", 3.5);
    const approachLeft = line("25:0:-2", 0);
    neighbors(approachRight, approachLeft, true);
    const connectorRight = line("1289:0:-1", 3.5, {
      isJunction: true, junctionId: "1280", predecessors: [approachRight.rsl],
    });
    const connectorLeft = line("1291:0:-1", 0, {
      isJunction: true, junctionId: "1280", predecessors: [approachLeft.rsl],
    });
    const report = validateRoadwayConsistency(topology([
      approachRight, approachLeft, connectorRight, connectorLeft,
    ]));
    const issue = report.issues.find((value) => value.laneARsl === "1289:0:-1");
    expect(issue).toMatchObject({ code: "JUNCTION_ADJACENCY_DROPPED", severity: "error" });
    expect(report.intervals.find((value) => value.laneARsl === "1289:0:-1"))
      .toMatchObject({ junctionContinuity: true, semanticAdjacent: false });
  });

  it("rejects a crossing as lateral adjacency", () => {
    const north = line("1:0:-1", 0);
    const east = line("2:0:-1", 0, { polyline: [{ x: -10, y: 10 }, { x: 10, y: 10 }] });
    const report = validateRoadwayConsistency(topology([north, east]));
    expect(report.intervals).toEqual([]);
    expect(report.issues).toEqual([]);
  });

  it("rejects parallel overpasses when elevation evidence is supplied", () => {
    const lower = line("1:0:-1", 0);
    const upper = line("2:0:-1", 3.5);
    const report = validateRoadwayConsistency(topology([lower, upper]), {
      laneElevationsM: { [lower.rsl]: [0, 0], [upper.rsl]: [5, 5] },
    });
    expect(report.intervals).toEqual([]);
    expect(report.issues).toEqual([]);
  });

  it("is deterministic regardless of lane record insertion order", () => {
    const a = line("7:0:-2", 3.5);
    const b = line("7:0:-1", 0);
    expect(validateRoadwayConsistency(topology([a, b])))
      .toEqual(validateRoadwayConsistency(topology([b, a])));
  });
});

describe("RoadwayConsistencyReportSchema integrity", () => {
  function reportWithIssue() {
    const a = line("7:0:-2", 3.5);
    const b = line("7:0:-1", 0);
    return validateRoadwayConsistency(topology([a, b]));
  }

  it("rejects array counts that disagree with report stats", () => {
    const report = reportWithIssue();
    expect(RoadwayConsistencyReportSchema.safeParse({
      ...report,
      stats: { ...report.stats, inferredIntervalCount: 0 },
    }).success).toBe(false);
    expect(RoadwayConsistencyReportSchema.safeParse({
      ...report,
      stats: { ...report.stats, issueCount: 0 },
    }).success).toBe(false);
  });

  it("rejects missing interval references and mismatched lane pairs", () => {
    const report = reportWithIssue();
    expect(RoadwayConsistencyReportSchema.safeParse({
      ...report,
      issues: [{ ...report.issues[0], intervalIndex: report.intervals.length }],
    }).success).toBe(false);
    expect(RoadwayConsistencyReportSchema.safeParse({
      ...report,
      issues: [{ ...report.issues[0], laneARsl: "different:0:-1" }],
    }).success).toBe(false);
  });

  it("rejects duplicate issue IDs", () => {
    const report = reportWithIssue();
    expect(RoadwayConsistencyReportSchema.safeParse({
      ...report,
      stats: { ...report.stats, issueCount: 2 },
      issues: [report.issues[0], { ...report.issues[0] }],
    }).success).toBe(false);
  });

  it("rejects unknown fields at report and nested object boundaries", () => {
    const report = reportWithIssue();
    expect(RoadwayConsistencyReportSchema.safeParse({ ...report, unexpected: true }).success)
      .toBe(false);
    expect(RoadwayConsistencyReportSchema.safeParse({
      ...report,
      intervals: [{ ...report.intervals[0], unexpected: true }],
    }).success).toBe(false);
  });
});
