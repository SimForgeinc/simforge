import { describe, expect, it } from "vitest";
import type {
  RuntimeBoundMapTopologyIndex,
  RuntimeTopologyParity,
  TopologyGate,
  TopologyLane,
} from "../../map-topology/types";
import { buildSemanticMapGraph } from "../build-semantic-map-graph";
import { SemanticMapGraphSchema, type RuntimeBoundLaneGeometry } from "../types";

const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);
const HASH_C = "c".repeat(64);
const HASH_D = "d".repeat(64);

function lane(
  rsl: string,
  points: Array<[number, number, number]>,
  options: Partial<TopologyLane> = {},
): TopologyLane {
  const [roadId, section, laneId] = rsl.split(":").map(Number);
  return {
    rsl,
    roadId: roadId!,
    section: section!,
    laneId: laneId!,
    laneType: "driving",
    isJunction: false,
    junctionId: null,
    predecessors: [],
    successors: [],
    speedLimitKph: 30,
    representativeWidthM: 3.5,
    polyline: points.map(([x, y]) => ({ x, y })),
    ...options,
  };
}

function exactParity(lanes: Record<string, TopologyLane>, gates: TopologyGate[]): RuntimeTopologyParity {
  const rsls = Object.keys(lanes).sort();
  return {
    status: "exact",
    topologyAuthorableLaneCount: rsls.length,
    runtimeAuthorableLaneCount: rsls.length,
    boundLaneRsls: rsls,
    topologyOnlyLaneRsls: [],
    runtimeOnlyLaneRsls: [],
    laneTypeMismatchRsls: [],
    junctionFlagMismatchRsls: [],
    duplicateRuntimeRsls: [],
    boundGateIds: gates.map((gate) => gate.id).sort(),
    unboundGateIds: [],
    diagnostics: [],
  };
}

function fixture(options: {
  crossingZ?: number | null;
  brokenApproachSeam?: boolean;
  /** Bend the straight-through approach lane before it reaches the junction. */
  curvedApproach?: boolean;
  /** Width of the straight-through exit lane, for the seam width ratio. */
  exitWidthM?: number;
} = {}) {
  const crossingZ = options.crossingZ === undefined ? 0 : options.crossingZ;
  const lanes: Record<string, TopologyLane> = {};
  lanes["1:0:-1"] = lane("1:0:-1", [[-60, 0, 0], [-30, 0, 0]], {
    successors: ["2:0:-1"],
  });
  lanes["2:0:-1"] = lane(
    "2:0:-1",
    options.brokenApproachSeam
      ? [[-20, 0, 0], [-5, 0, 0]]
      : [[-30, 0, 0], [-5, 0, 0]],
    { predecessors: ["1:0:-1"], successors: ["3:0:-1"] },
  );
  lanes["3:0:-1"] = lane(
    "3:0:-1",
    [[-5, 0, 0], [-3, 0, 0], [-1, 1, 0], [0, 3, 0], [0, 5, 0]],
    {
    isJunction: true,
    junctionId: "100",
    predecessors: ["2:0:-1"],
    successors: ["4:0:-1"],
    },
  );
  lanes["4:0:-1"] = lane("4:0:-1", [[0, 5, 0], [0, 35, 0]], {
    predecessors: ["3:0:-1"],
  });
  lanes["5:0:-1"] = lane(
    "5:0:-1",
    options.curvedApproach
      ? [[50, 30, 0], [40, 10, 0], [20, 2, 0], [5, 2, 0]]
      : [[50, 2, 0], [5, 2, 0]],
    { successors: ["6:0:-1"] },
  );
  lanes["6:0:-1"] = lane(
    "6:0:-1",
    [[5, 2, crossingZ ?? 0], [-5, 2, crossingZ ?? 0]],
    {
      isJunction: true,
      junctionId: "100",
      predecessors: ["5:0:-1"],
      successors: ["7:0:-1"],
    },
  );
  lanes["7:0:-1"] = lane(
    "7:0:-1",
    [[-5, 2, crossingZ ?? 0], [-50, 2, crossingZ ?? 0]],
    { predecessors: ["6:0:-1"] },
  );
  // Close to road 4 but deliberately disconnected: geometry alone must never stitch it.
  lanes["8:0:-1"] = lane("8:0:-1", [[0.2, 35, 0], [0.2, 50, 0]]);

  const gates: TopologyGate[] = [
    {
      id: "100:left",
      junctionId: "100",
      turnRelation: "Left",
      headingChangeRad: Math.PI / 2,
      approachLaneRsl: "2:0:-1",
      connectingLaneRsl: "3:0:-1",
      exitLaneRsls: ["4:0:-1"],
    },
    {
      id: "100:straight",
      junctionId: "100",
      turnRelation: "Straight",
      headingChangeRad: 0,
      approachLaneRsl: "5:0:-1",
      connectingLaneRsl: "6:0:-1",
      exitLaneRsls: ["7:0:-1"],
    },
  ];
  const topology: RuntimeBoundMapTopologyIndex = {
    schemaVersion: 3,
    mapName: "semantic-fixture",
    generatedAt: "2026-07-10T00:00:00.000Z",
    source: { xodrSha256: HASH_A },
    lanes,
    gates,
    junctions: {
      "100": {
        junctionId: "100",
        gateIds: gates.map((gate) => gate.id),
        internalLaneRsls: ["3:0:-1", "6:0:-1"],
        approachLaneRsls: ["2:0:-1", "5:0:-1"],
      },
    },
    stats: {
      roads: 8,
      lanes: 8,
      drivingLanes: 8,
      junctions: 1,
      gates: 2,
      connectionsParsed: 2,
      gatesDropped: 0,
      turnHistogram: { Left: 1, Straight: 1 },
      geojsonTurnAgreementPct: null,
    },
    runtimeProvenance: {
      mapAssetId: "map-semantic-fixture",
      runtimeFamily: "carla_ue5",
      runtimeMapName: "semantic-fixture",
      runtimeCatalogVersion: "catalog-v1",
      bundleVersion: "bundle-v1",
      imageDigest: "sha256:image",
      xodrSha256: HASH_A,
      runtimeRoadGraphSha256: HASH_B,
      projectionIdentitySha256: HASH_C,
      compilerVersion: "runtime-topology-v1",
    },
    runtimeParity: exactParity(lanes, gates),
  };
  const runtimeLaneGeometry: Record<string, RuntimeBoundLaneGeometry> = Object.fromEntries(
    Object.entries(lanes).map(([rsl, topologyLane]) => {
      const sourcePoints = (() => {
        if (rsl === "6:0:-1" || rsl === "7:0:-1") {
          return topologyLane.polyline.map((point) => ({ x: point.x, y: point.y, z: crossingZ }));
        }
        return topologyLane.polyline.map((point) => ({ x: point.x, y: point.y, z: 0 }));
      })();
      return [
        rsl,
        {
          rsl,
          storedOrder: "travel" as const,
          representativeWidthM:
            rsl === "7:0:-1" && options.exitWidthM != null ? options.exitWidthM : 3.5,
          polyline: sourcePoints,
        },
      ];
    }),
  );
  return { topology, runtimeLaneGeometry };
}

function build(source = fixture()) {
  return buildSemanticMapGraph({
    topology: source.topology,
    runtimeLaneGeometry: source.runtimeLaneGeometry,
  });
}

describe("buildSemanticMapGraph", () => {
  it("builds schema-valid corridors, approaches, movements, variants, and conflicts", () => {
    const graph = build();
    expect(() => SemanticMapGraphSchema.parse(graph)).not.toThrow();
    expect(graph.authority).toBe("runtime_verified");
    expect(graph.authoringReady).toBe(true);
    expect(graph.corridors).toHaveLength(5);
    expect(
      graph.corridors.find((corridor) =>
        corridor.runtimeFragments.some((fragment) => fragment.rsl === "1:0:-1")),
    ).toMatchObject({
      runtimeFragments: [
        expect.objectContaining({ rsl: "1:0:-1" }),
        expect.objectContaining({ rsl: "2:0:-1" }),
      ],
      authoringStatus: "authorable",
    });
    expect(graph.approaches).toHaveLength(4);
    expect(graph.movements).toHaveLength(2);
    expect(graph.movementVariants).toHaveLength(2);
    expect(graph.conflictZones).toHaveLength(1);
    expect(graph.conflictZones[0]).toMatchObject({
      kind: "crossing",
      authoringStatus: "authorable",
    });
  });

  it("measures the turn across the junction, not across the whole composed path", () => {
    // The approach lane sweeps in from the north-east before straightening out.
    // A whole-path measurement reads the sweep as part of the turn and calls a
    // straight-through movement a Right; over the eight corpus maps that took
    // away the only authorable way out of 125 corridors.
    const graph = build(fixture({ curvedApproach: true }));
    const straight = graph.movementVariants.find((variant) => variant.gateId === "100:straight");
    expect(straight).toMatchObject({ authoringStatus: "authorable" });
    expect(straight!.diagnosticCodes).not.toContain("MOVEMENT_TURN_MISMATCH");
    expect(
      graph.diagnostics.filter((entry) => entry.code === "MOVEMENT_TURN_MISMATCH"),
    ).toHaveLength(0);
  });

  it("reports a width change at a seam without making it unauthorable", () => {
    // 3.5 m into an 8.5 m lot aisle: ratio 2.4 against a 1.8 limit, meeting at
    // the same point in the same direction. That is a road, not a defect.
    const graph = build(fixture({ exitWidthM: 8.5 }));
    const straight = graph.movementVariants.find((variant) => variant.gateId === "100:straight");
    expect(straight).toMatchObject({ authoringStatus: "authorable" });
    expect(straight!.diagnosticCodes).not.toContain("GATE_GEOMETRY_DISCONTINUITY");
    const corridor = graph.corridors.find((entry) =>
      entry.runtimeFragments.some((fragment) => fragment.rsl === "7:0:-1"));
    expect(corridor).toMatchObject({ authoringStatus: "authorable" });
  });

  it("still refuses a seam the lanes do not actually share", () => {
    // The width rule stopped deciding; the gap rule did not.
    const graph = build(fixture({ brokenApproachSeam: true }));
    expect(
      graph.diagnostics.some((entry) => entry.code === "CORRIDOR_SEAM_GAP"),
    ).toBe(true);
  });

  it("is deterministic under shuffled topology insertion order", () => {
    const source = fixture();
    const reversedLanes = Object.fromEntries(Object.entries(source.topology.lanes).reverse());
    const shuffled = {
      topology: {
        ...source.topology,
        lanes: reversedLanes,
        gates: [...source.topology.gates].reverse(),
        runtimeParity: {
          ...source.topology.runtimeParity,
          boundLaneRsls: [...source.topology.runtimeParity.boundLaneRsls].reverse(),
          boundGateIds: [...source.topology.runtimeParity.boundGateIds].reverse(),
        },
      },
      runtimeLaneGeometry: Object.fromEntries(
        Object.entries(source.runtimeLaneGeometry).reverse(),
      ),
    };
    expect(buildSemanticMapGraph(shuffled)).toEqual(build(source));
  });

  it("projects metric lane-change permissions onto semantic corridor stations", () => {
    const source = fixture();
    source.topology.lanes["1:0:-1"]!.adjacentLanes = {
      left: {
        side: "left",
        laneRsl: "8:0:-1",
        sameDirection: true,
        permissionIds: ["permission-left"],
      },
    };
    source.topology.lanes["1:0:-1"]!.laneChangePermissions = [{
      id: "permission-left",
      side: "left",
      startS: 5,
      endS: 20,
      allowed: true,
      marking: "broken",
      source: "derived_same_section",
    }];

    const graph = build(source);
    const sourceCorridor = graph.corridors.find((corridor) =>
      corridor.runtimeFragments.some((fragment) => fragment.rsl === "1:0:-1"));
    const targetCorridor = graph.corridors.find((corridor) =>
      corridor.runtimeFragments.some((fragment) => fragment.rsl === "8:0:-1"));

    expect(sourceCorridor?.lateralAdjacencies).toEqual([{
      side: "left",
      targetCorridorId: targetCorridor?.id,
      sameDirection: true,
      permissionIntervals: [{
        startM: 5,
        endM: 20,
        allowed: true,
        marking: "broken",
        source: "derived_same_section",
      }],
    }]);
  });

  it("never stitches by proximity and rejects a topology-linked broken seam", () => {
    const graph = build(fixture({ brokenApproachSeam: true }));
    const roadOne = graph.corridors.find((corridor) =>
      corridor.runtimeFragments.some((fragment) => fragment.rsl === "1:0:-1"));
    const roadTwo = graph.corridors.find((corridor) =>
      corridor.runtimeFragments.some((fragment) => fragment.rsl === "2:0:-1"));
    const disconnected = graph.corridors.find((corridor) =>
      corridor.runtimeFragments.some((fragment) => fragment.rsl === "8:0:-1"));
    expect(roadOne?.id).not.toBe(roadTwo?.id);
    expect(disconnected?.runtimeFragments.map((fragment) => fragment.rsl)).toEqual(["8:0:-1"]);
    expect(graph.diagnostics.map((row) => row.code)).toContain("CORRIDOR_SEAM_GAP");
  });

  it("accepts partial map parity but only builds movements from the exact bound subset", () => {
    const source = fixture();
    source.topology.runtimeParity = {
      ...source.topology.runtimeParity,
      status: "partial",
      boundLaneRsls: source.topology.runtimeParity.boundLaneRsls.filter((rsl) => rsl !== "4:0:-1"),
      topologyOnlyLaneRsls: ["4:0:-1"],
      boundGateIds: ["100:straight"],
      unboundGateIds: ["100:left"],
    };
    const graph = build(source);
    expect(graph.authority).toBe("runtime_verified");
    expect(graph.authoringReady).toBe(true);
    expect(graph.movements).toHaveLength(1);
    expect(graph.movementVariants).toHaveLength(1);
    expect(graph.movements[0]?.turnRelation).toBe("Straight");
    expect(
      graph.corridors.find((corridor) =>
        corridor.runtimeFragments.some((fragment) => fragment.rsl === "4:0:-1"))
        ?.authoringStatus,
    ).toBe("unbound");
    expect(graph.diagnostics.map((row) => row.code)).toEqual(
      expect.arrayContaining([
        "RUNTIME_PARITY_PARTIAL",
        "RUNTIME_LANE_UNBOUND",
        "GATE_RUNTIME_UNBOUND",
      ]),
    );
  });

  it("fails the whole graph closed for incompatible duplicate runtime identities", () => {
    const source = fixture();
    source.topology.runtimeParity = {
      ...source.topology.runtimeParity,
      status: "incompatible",
      duplicateRuntimeRsls: ["5:0:-1"],
    };
    const graph = build(source);
    expect(graph.authority).toBe("diagnostic_only");
    expect(graph.authoringReady).toBe(false);
    expect(graph.diagnostics.map((row) => row.code)).toContain(
      "RUNTIME_PARITY_INCOMPATIBLE",
    );
  });

  it("splits an unbound upstream fragment away from an exact gate approach", () => {
    const source = fixture();
    source.topology.runtimeParity = {
      ...source.topology.runtimeParity,
      status: "partial",
      boundLaneRsls: source.topology.runtimeParity.boundLaneRsls.filter(
        (rsl) => rsl !== "1:0:-1",
      ),
      topologyOnlyLaneRsls: ["1:0:-1"],
    };
    const graph = build(source);
    const upstream = graph.corridors.find((corridor) =>
      corridor.runtimeFragments.some((fragment) => fragment.rsl === "1:0:-1"));
    const gateApproach = graph.corridors.find((corridor) =>
      corridor.runtimeFragments.some((fragment) => fragment.rsl === "2:0:-1"));
    expect(upstream?.id).not.toBe(gateApproach?.id);
    expect(upstream?.authoringStatus).toBe("unbound");
    expect(gateApproach?.authoringStatus).toBe("authorable");
    expect(graph.movements).toHaveLength(2);
    expect(graph.movements.every((movement) => movement.authoringStatus === "authorable")).toBe(true);
  });

  it("rejects a gate whose declared binding omits a junction-internal successor fragment", () => {
    const source = fixture();
    source.topology.lanes["3:0:-1"]!.successors = ["9:0:-1"];
    source.topology.lanes["9:0:-1"] = lane(
      "9:0:-1",
      [[0, 5, 0], [0, 8, 0]],
      {
        isJunction: true,
        junctionId: "100",
        predecessors: ["3:0:-1"],
        successors: ["4:0:-1"],
      },
    );
    source.topology.lanes["4:0:-1"]!.predecessors = ["9:0:-1"];
    source.runtimeLaneGeometry["9:0:-1"] = {
      rsl: "9:0:-1",
      storedOrder: "travel",
      representativeWidthM: 3.5,
      polyline: [{ x: 0, y: 5, z: 0 }, { x: 0, y: 8, z: 0 }],
    };
    // Simulate an older parity report that marked the immediate gate fields
    // bound without including the connector's directed internal closure.
    expect(source.topology.runtimeParity.boundGateIds).toContain("100:left");
    expect(source.topology.runtimeParity.boundLaneRsls).not.toContain("9:0:-1");
    const graph = build(source);
    expect(graph.movements.map((movement) => movement.turnRelation)).toEqual(["Straight"]);
    expect(graph.diagnostics.map((row) => row.code)).toContain("GATE_INTERNAL_PATH_MISSING");
  });

  it("does not create an XY conflict for grade-separated movements", () => {
    const graph = build(fixture({ crossingZ: 8 }));
    expect(graph.movements).toHaveLength(2);
    expect(graph.conflictZones).toHaveLength(0);
  });

  it("keeps an XY conflict diagnostic-only when runtime elevation is unknown", () => {
    const graph = build(fixture({ crossingZ: null }));
    expect(graph.conflictZones).toHaveLength(1);
    expect(graph.conflictZones[0]?.authoringStatus).toBe("diagnostic_only");
    expect(graph.conflictZones[0]?.diagnosticCodes).toContain("CONFLICT_ELEVATION_UNKNOWN");
  });

  it("fails schema parsing before compilation when provenance hashes are malformed", () => {
    const source = fixture();
    source.topology.runtimeProvenance.runtimeRoadGraphSha256 = HASH_D.slice(1);
    expect(() => build(source)).toThrow();
  });
});
