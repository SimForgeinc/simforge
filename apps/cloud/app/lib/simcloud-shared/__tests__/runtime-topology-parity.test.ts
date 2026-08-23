import { describe, expect, it } from "vitest";
import {
  bindRuntimeTopology,
  buildRuntimeTopologyParity,
} from "../map-topology/build-runtime-parity";
import type { MapTopologyIndex } from "../map-topology/types";

function topology(): MapTopologyIndex {
  return {
    schemaVersion: 3,
    mapName: "map-1",
    generatedAt: "2026-07-10T00:00:00.000Z",
    source: { xodrSha256: "source-sha" },
    lanes: {
      "1:0:-1": {
        rsl: "1:0:-1",
        roadId: 1,
        section: 0,
        laneId: -1,
        laneType: "driving",
        isJunction: false,
        junctionId: null,
        predecessors: [],
        successors: ["2:0:-1"],
        speedLimitKph: 30,
        polyline: [{ x: 0, y: 0 }, { x: 10, y: 0 }],
      },
      "2:0:-1": {
        rsl: "2:0:-1",
        roadId: 2,
        section: 0,
        laneId: -1,
        laneType: "driving",
        isJunction: true,
        junctionId: "10",
        predecessors: ["1:0:-1"],
        successors: ["3:0:-1"],
        speedLimitKph: 30,
        polyline: [{ x: 10, y: 0 }, { x: 20, y: 0 }],
      },
      "3:0:-1": {
        rsl: "3:0:-1",
        roadId: 3,
        section: 0,
        laneId: -1,
        laneType: "driving",
        isJunction: false,
        junctionId: null,
        predecessors: ["2:0:-1"],
        successors: [],
        speedLimitKph: 30,
        polyline: [{ x: 20, y: 0 }, { x: 30, y: 0 }],
      },
    },
    gates: [{
      id: "10:0:-1--1",
      junctionId: "10",
      turnRelation: "Straight",
      headingChangeRad: 0,
      connectingLaneRsl: "2:0:-1",
      approachLaneRsl: "1:0:-1",
      exitLaneRsls: ["3:0:-1"],
    }],
    junctions: {
      "10": {
        junctionId: "10",
        gateIds: ["10:0:-1--1"],
        internalLaneRsls: ["2:0:-1"],
        approachLaneRsls: ["1:0:-1"],
      },
    },
    stats: {
      roads: 3,
      lanes: 3,
      drivingLanes: 3,
      junctions: 1,
      gates: 1,
      connectionsParsed: 1,
      gatesDropped: 0,
      turnHistogram: { Straight: 1 },
      geojsonTurnAgreementPct: null,
    },
  };
}

function multiFragmentTopology(): MapTopologyIndex {
  const source = topology();
  source.lanes["2:0:-1"]!.laneType = "none";
  source.lanes["2:0:-1"]!.successors = ["4:0:-1"];
  source.lanes["4:0:-1"] = {
    rsl: "4:0:-1",
    roadId: 4,
    section: 0,
    laneId: -1,
    laneType: "none",
    isJunction: true,
    junctionId: "10",
    predecessors: ["2:0:-1"],
    successors: ["3:0:-1"],
    speedLimitKph: 30,
    polyline: [{ x: 20, y: 0 }, { x: 25, y: 0 }],
  };
  source.lanes["3:0:-1"]!.predecessors = ["4:0:-1"];
  source.junctions["10"]!.internalLaneRsls = ["2:0:-1", "4:0:-1"];
  source.stats.lanes = 4;
  return source;
}

const runtimeSegments = [
  { road_id: 1, section_id: 0, lane_id: -1, lane_type: "Driving", is_junction: false },
  { road_id: 2, section_id: 0, lane_id: -1, lane_type: "Driving", is_junction: true },
  { road_id: 3, section_id: 0, lane_id: -1, lane_type: "Driving", is_junction: false },
];

describe("buildRuntimeTopologyParity", () => {
  it("marks exact RSL/type/junction bindings and their gate authorable", () => {
    const parity = buildRuntimeTopologyParity({ topology: topology(), runtimeSegments });
    expect(parity.status).toBe("exact");
    expect(parity.boundLaneRsls).toEqual(["1:0:-1", "2:0:-1", "3:0:-1"]);
    expect(parity.boundGateIds).toEqual(["10:0:-1--1"]);
    expect(parity.diagnostics).toEqual([]);
  });

  it("fails closed for duplicate runtime RSLs", () => {
    const parity = buildRuntimeTopologyParity({
      topology: topology(),
      runtimeSegments: [...runtimeSegments, runtimeSegments[0]!],
    });
    expect(parity.status).toBe("incompatible");
    expect(parity.duplicateRuntimeRsls).toEqual(["1:0:-1"]);
    expect(parity.diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "DUPLICATE_RUNTIME_RSL", rsl: "1:0:-1" }),
    ]));
  });

  it("ignores duplicate non-authorable runtime lanes", () => {
    const sidewalk = {
      road_id: 50,
      section_id: 0,
      lane_id: -2,
      lane_type: "Sidewalk",
      is_junction: false,
    };
    const parity = buildRuntimeTopologyParity({
      topology: topology(),
      runtimeSegments: [...runtimeSegments, sidewalk, sidewalk],
    });
    expect(parity.status).toBe("exact");
    expect(parity.duplicateRuntimeRsls).toEqual([]);
  });

  it("binds exact non-driving connector lanes required by a gate", () => {
    const source = topology();
    source.lanes["2:0:-1"]!.laneType = "none";
    const parity = buildRuntimeTopologyParity({
      topology: source,
      runtimeSegments: [
        runtimeSegments[0]!,
        { ...runtimeSegments[1]!, lane_type: "None" },
        runtimeSegments[2]!,
      ],
    });
    expect(parity.status).toBe("exact");
    expect(parity.boundLaneRsls).toContain("2:0:-1");
    expect(parity.boundGateIds).toEqual(["10:0:-1--1"]);
  });

  it("fails closed for a duplicate non-driving connector required by a gate", () => {
    const source = topology();
    source.lanes["2:0:-1"]!.laneType = "none";
    const connector = { ...runtimeSegments[1]!, lane_type: "None" };
    const parity = buildRuntimeTopologyParity({
      topology: source,
      runtimeSegments: [runtimeSegments[0]!, connector, connector, runtimeSegments[2]!],
    });
    expect(parity.status).toBe("incompatible");
    expect(parity.duplicateRuntimeRsls).toEqual(["2:0:-1"]);
    expect(parity.unboundGateIds).toEqual([]);
  });

  it("binds every exact fragment in a multi-fragment junction movement", () => {
    const parity = buildRuntimeTopologyParity({
      topology: multiFragmentTopology(),
      runtimeSegments: [
        runtimeSegments[0]!,
        { ...runtimeSegments[1]!, lane_type: "None" },
        { road_id: 4, section_id: 0, lane_id: -1, lane_type: "None", is_junction: true },
        runtimeSegments[2]!,
      ],
    });
    expect(parity.status).toBe("exact");
    expect(parity.boundLaneRsls).toEqual(["1:0:-1", "2:0:-1", "3:0:-1", "4:0:-1"]);
    expect(parity.boundGateIds).toEqual(["10:0:-1--1"]);
  });

  it("unbinds a movement whose intermediate runtime fragment is missing", () => {
    const parity = buildRuntimeTopologyParity({
      topology: multiFragmentTopology(),
      runtimeSegments: [
        runtimeSegments[0]!,
        { ...runtimeSegments[1]!, lane_type: "None" },
        runtimeSegments[2]!,
      ],
    });
    expect(parity.status).toBe("partial");
    expect(parity.boundLaneRsls).not.toContain("4:0:-1");
    expect(parity.unboundGateIds).toEqual(["10:0:-1--1"]);
  });

  it("treats a duplicate intermediate runtime fragment as incompatible", () => {
    const middle = {
      road_id: 4,
      section_id: 0,
      lane_id: -1,
      lane_type: "None",
      is_junction: true,
    };
    const parity = buildRuntimeTopologyParity({
      topology: multiFragmentTopology(),
      runtimeSegments: [
        runtimeSegments[0]!,
        { ...runtimeSegments[1]!, lane_type: "None" },
        middle,
        middle,
        runtimeSegments[2]!,
      ],
    });
    expect(parity.status).toBe("incompatible");
    expect(parity.duplicateRuntimeRsls).toEqual(["4:0:-1"]);
  });

  it("keeps an exact gate bound when parity is partial elsewhere", () => {
    const source = topology();
    source.lanes["9:0:-1"] = {
      ...source.lanes["1:0:-1"]!,
      rsl: "9:0:-1",
      roadId: 9,
      predecessors: [],
      successors: [],
    };
    const parity = buildRuntimeTopologyParity({ topology: source, runtimeSegments });
    expect(parity.status).toBe("partial");
    expect(parity.topologyOnlyLaneRsls).toContain("9:0:-1");
    expect(parity.boundGateIds).toEqual(["10:0:-1--1"]);
  });

  it("is deterministic when runtime segments are shuffled", () => {
    const forward = buildRuntimeTopologyParity({ topology: topology(), runtimeSegments });
    const reversed = buildRuntimeTopologyParity({
      topology: topology(),
      runtimeSegments: [...runtimeSegments].reverse(),
    });
    expect(reversed).toEqual(forward);
  });

  it("reports a runtime lane type mismatch instead of a missing lane", () => {
    const parity = buildRuntimeTopologyParity({
      topology: topology(),
      runtimeSegments: [
        { ...runtimeSegments[0]!, lane_type: "Parking" },
        runtimeSegments[1]!,
        runtimeSegments[2]!,
      ],
    });
    expect(parity.status).toBe("partial");
    expect(parity.laneTypeMismatchRsls).toEqual(["1:0:-1"]);
    expect(parity.topologyOnlyLaneRsls).toEqual([]);
  });

  it("marks missing and mismatched lanes partial and unbinds the movement", () => {
    const parity = buildRuntimeTopologyParity({
      topology: topology(),
      runtimeSegments: [
        runtimeSegments[0]!,
        { ...runtimeSegments[1]!, is_junction: false },
      ],
    });
    expect(parity.status).toBe("partial");
    expect(parity.topologyOnlyLaneRsls).toEqual(["3:0:-1"]);
    expect(parity.junctionFlagMismatchRsls).toEqual(["2:0:-1"]);
    expect(parity.unboundGateIds).toEqual(["10:0:-1--1"]);
  });

  it("attaches immutable runtime provenance without changing the base graph", () => {
    const source = topology();
    const bound = bindRuntimeTopology({
      topology: source,
      runtimeSegments,
      provenance: {
        mapAssetId: "map-1",
        runtimeFamily: "carla_ue4",
        runtimeMapName: "Map_One",
        runtimeCatalogVersion: "catalog-v1",
        bundleVersion: "bundle-v1",
        imageDigest: "sha256:image",
        xodrSha256: "a".repeat(64),
        runtimeRoadGraphSha256: "b".repeat(64),
        projectionIdentitySha256: "c".repeat(64),
        compilerVersion: "runtime-bound-topology-v1",
      },
    });
    expect(bound.lanes).toBe(source.lanes);
    expect(bound.runtimeParity.status).toBe("exact");
    expect(bound.runtimeProvenance.runtimeMapName).toBe("Map_One");
  });
});

describe("link-attested binding", () => {
  /**
   * The crawl's step is ~5 m, so a shorter lane-section gets no waypoints and
   * never reaches the segment list. Both shapes below are that same defect —
   * `21:0:-2` on Di Rosa, 1.6 m long, whose gate stranded a keep-lane ego 6.5 m
   * from its spawn inside the intersection.
   */
  function shortSectionTopology(): MapTopologyIndex {
    const source = topology();
    // 2:0:-1 (junction) -> 9:0:-1 (a 1 m stub) -> 3:0:-1
    source.lanes["2:0:-1"]!.successors = ["9:0:-1"];
    source.lanes["9:0:-1"] = {
      rsl: "9:0:-1",
      roadId: 9,
      section: 0,
      laneId: -1,
      laneType: "driving",
      isJunction: false,
      junctionId: null,
      predecessors: ["2:0:-1"],
      successors: ["3:0:-1"],
      speedLimitKph: 30,
      polyline: [{ x: 20, y: 0 }, { x: 21, y: 0 }],
    };
    source.lanes["3:0:-1"]!.predecessors = ["9:0:-1"];
    source.gates[0]!.exitLaneRsls = ["9:0:-1"];
    return source;
  }

  it("binds a lane the crawl skipped but its own links name", () => {
    const parity = buildRuntimeTopologyParity({
      topology: shortSectionTopology(),
      // CARLA names the stub as a successor without ever sampling it.
      runtimeSegments: runtimeSegments.map((segment) =>
        segment.road_id === 2 ? { ...segment, successors: [{ rsl: "9:0:-1" }] } : segment),
    });
    expect(parity.linkAttestedLaneRsls).toEqual(["9:0:-1"]);
    expect(parity.boundLaneRsls).toContain("9:0:-1");
    expect(parity.boundGateIds).toEqual(["10:0:-1--1"]);
  });

  it("binds a lane the crawl steps over without naming", () => {
    const parity = buildRuntimeTopologyParity({
      topology: shortSectionTopology(),
      // The Di Rosa shape: CARLA links straight past the stub to the lane beyond
      // it, so the stub appears in no segment and in no link.
      runtimeSegments: runtimeSegments.map((segment) =>
        segment.road_id === 2 ? { ...segment, successors: [{ rsl: "3:0:-1" }] } : segment),
    });
    expect(parity.linkAttestedLaneRsls).toEqual(["9:0:-1"]);
    expect(parity.boundGateIds).toEqual(["10:0:-1--1"]);
  });

  it("leaves a lane neither named nor bridged unbound", () => {
    const parity = buildRuntimeTopologyParity({
      topology: shortSectionTopology(),
      runtimeSegments,
    });
    expect(parity.linkAttestedLaneRsls).toEqual([]);
    expect(parity.topologyOnlyLaneRsls).toContain("9:0:-1");
    expect(parity.boundGateIds).toEqual([]);
  });

  it("refuses to bridge when the OpenDRIVE offers more than one way through", () => {
    const source = shortSectionTopology();
    // A second, equally short stub between the same pair. Which one the car took
    // is now a guess, and a guess is worse than an unbound gate.
    source.lanes["2:0:-1"]!.successors = ["9:0:-1", "11:0:-1"];
    source.lanes["11:0:-1"] = {
      ...source.lanes["9:0:-1"]!,
      rsl: "11:0:-1",
      roadId: 11,
      polyline: [{ x: 20, y: 1 }, { x: 21, y: 1 }],
    };
    source.lanes["3:0:-1"]!.predecessors = ["9:0:-1", "11:0:-1"];
    const parity = buildRuntimeTopologyParity({
      topology: source,
      runtimeSegments: runtimeSegments.map((segment) =>
        segment.road_id === 2 ? { ...segment, successors: [{ rsl: "3:0:-1" }] } : segment),
    });
    expect(parity.linkAttestedLaneRsls).toEqual([]);
  });

  it("does not bridge through a lane the crawl DID sample", () => {
    // A sampled intermediate means the elision theory is wrong: CARLA had every
    // chance to link through it and chose not to.
    const parity = buildRuntimeTopologyParity({
      topology: shortSectionTopology(),
      runtimeSegments: [
        ...runtimeSegments.map((segment) =>
          segment.road_id === 2 ? { ...segment, successors: [{ rsl: "3:0:-1" }] } : segment),
        { road_id: 9, section_id: 0, lane_id: -1, lane_type: "Driving", is_junction: false },
      ],
    });
    expect(parity.linkAttestedLaneRsls).toEqual([]);
  });
});
