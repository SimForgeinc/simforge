import { describe, expect, it } from "vitest";
import {
  LEGACY_SEMANTIC_EXECUTION_INDEX_COMPILER_VERSION,
  SEMANTIC_EXECUTION_INDEX_COMPILER_VERSION,
  SemanticExecutionIndexSchema,
  buildSemanticExecutionIndex,
} from "../execution-index";
import { SEMANTIC_MAP_COMPILER_VERSION, SEMANTIC_MAP_SCHEMA_VERSION, type SemanticMapGraph } from "../types";

function graph(): SemanticMapGraph {
  return {
    schemaVersion: SEMANTIC_MAP_SCHEMA_VERSION,
    compilerVersion: SEMANTIC_MAP_COMPILER_VERSION,
    graphRevision: `sha256:${"d".repeat(64)}`,
    generatedAt: "2026-07-12T00:00:00.000Z",
    source: {
      mapName: "MapOne",
      topologySchemaVersion: 3,
      runtimeProvenance: {
        mapAssetId: "map-1",
        runtimeFamily: "carla_ue5",
        runtimeMapName: "MapOne",
        runtimeCatalogVersion: "catalog-1",
        bundleVersion: "bundle-1",
        imageDigest: "sha256:image",
        xodrSha256: "a".repeat(64),
        runtimeRoadGraphSha256: "b".repeat(64),
        projectionIdentitySha256: "c".repeat(64),
        compilerVersion: "simforge.runtime-bound-topology.v1",
      },
    },
    authority: "runtime_verified",
    authoringReady: true,
    buildConfig: {
      maximumSeamGapM: 3,
      maximumSeamHeadingDeltaRad: 0.5,
      maximumSeamWidthRatio: 1.8,
      maximumSeamElevationDeltaM: 1.5,
      maximumApproachBoundaryDistanceM: 15,
      maximumApproachHeadingDeltaRad: 0.5,
      maximumApproachElevationDeltaM: 1.5,
      maximumInternalFragments: 32,
      maximumVariantsPerGate: 8,
      minimumConflictAngleRad: 0.2,
      conflictEndpointExclusionM: 2,
      conflictClusterRadiusM: 6,
    },
    corridors: [],
    approaches: [],
    movementVariants: [],
    movements: [],
    conflictZones: [],
    diagnostics: [],
    stats: {
      eligibleRuntimeLanes: 0,
      boundRuntimeLanes: 0,
      corridors: 0,
      authorableCorridors: 0,
      approaches: 0,
      movements: 0,
      movementVariants: 0,
      conflictZones: 0,
      representedNonJunctionArcM: 0,
      eligibleNonJunctionArcM: 0,
      representedArcPct: 100,
    },
  };
}

describe("semantic execution index controls", () => {
  it("binds and deterministically merges runtime controls to lane RSLs", () => {
    const controls = {
      trafficLights: [
        {
          actor_id: 11,
          opendrive_id: "signal-7",
          affected_lane_waypoints: [{ rsl: "2:0:-1" }, { rsl: "1:0:-1" }],
          stop_waypoints: [{ rsl: "3:0:-2" }],
        },
        {
          actor_id: 12,
          opendrive_id: "signal-7",
          affected_lane_waypoints: [{ rsl: "2:0:-1" }],
        },
      ],
      landmarks: [
        { id: "stop-1", type: "206", waypoint: { rsl: "4:0:-1" } },
        { id: "yield-1", name: "Sign_R1-2", waypoint: { rsl: "5:0:-1" } },
        { id: "speed-1", type: "274", waypoint: { rsl: "6:0:-1" } },
      ],
    };
    const first = buildSemanticExecutionIndex(graph(), controls);
    const second = buildSemanticExecutionIndex(graph(), {
      trafficLights: [...controls.trafficLights].reverse(),
      landmarks: [...controls.landmarks].reverse(),
    });

    expect(first.compilerVersion).toBe(SEMANTIC_EXECUTION_INDEX_COMPILER_VERSION);
    expect(first.controlBindings).toEqual([
      {
        semanticId: "control:stop_sign:landmark:stop-1",
        runtimeIds: ["landmark:stop-1"],
        laneRsls: ["4:0:-1"],
        kind: "stop_sign",
      },
      {
        semanticId: "control:traffic_light:opendrive:signal-7",
        runtimeIds: ["actor:11", "actor:12", "opendrive:signal-7"],
        laneRsls: ["1:0:-1", "2:0:-1", "3:0:-2"],
        kind: "traffic_light",
      },
      {
        semanticId: "control:yield_sign:landmark:yield-1",
        runtimeIds: ["landmark:yield-1"],
        laneRsls: ["5:0:-1"],
        kind: "yield_sign",
      },
    ]);
    expect(second.controlBindings).toEqual(first.controlBindings);
    expect(second.indexRevision).toBe(first.indexRevision);
  });

  it("keeps v1 artifacts readable and defaults their lane bindings", () => {
    const current = buildSemanticExecutionIndex(graph());
    const legacy = SemanticExecutionIndexSchema.parse({
      ...current,
      compilerVersion: LEGACY_SEMANTIC_EXECUTION_INDEX_COMPILER_VERSION,
      indexRevision: `${LEGACY_SEMANTIC_EXECUTION_INDEX_COMPILER_VERSION}:${graph().graphRevision}`,
      controlBindings: [
        {
          semanticId: "control:traffic_light:actor:1",
          runtimeIds: ["actor:1"],
          kind: "traffic_light",
        },
      ],
    });
    expect(legacy.controlBindings[0]?.laneRsls).toEqual([]);
  });
});
