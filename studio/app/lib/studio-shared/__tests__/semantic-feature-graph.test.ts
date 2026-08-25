import { describe, expect, it } from "vitest";
import {
  CROSS_MAP_SCENE_MOTIF_SCHEMA_VERSION,
  CROSS_MAP_VARIATION_SCHEMA_VERSION,
  CrossMapVariationPreviewResponseSchema,
  SEMANTIC_FEATURE_GRAPH_COMPILER_VERSION,
  SEMANTIC_FEATURE_GRAPH_SCHEMA_VERSION,
  SemanticFeatureGraphSchema,
} from "../index";

const runtimeProvenance = {
  mapAssetId: "map-target",
  runtimeFamily: "carla_ue5" as const,
  runtimeMapName: "TownTarget",
  runtimeCatalogVersion: "catalog-v1",
  bundleVersion: "bundle-v1",
  imageDigest: "sha256:image",
  xodrSha256: "a".repeat(64),
  runtimeRoadGraphSha256: "b".repeat(64),
  projectionIdentitySha256: "c".repeat(64),
  compilerVersion: "runtime-topology-v1",
};

const formation = {
  schemaVersion: "simforge.scene-formation.v2" as const,
  id: "formation:ego",
  kind: "vehicle_interaction" as const,
  transferPolicy: "event_constrained" as const,
  source: {
    scenarioId: "scenario-source",
    mapAssetId: "map-source",
    mapName: "TownSource",
    runtime: "carla_ue5" as const,
    featureGraphRevision: `sha256:${"e".repeat(64)}`,
  },
  anchors: [{
    id: "anchor:primary",
    frameKind: "movement" as const,
    featureId: "lane:source",
    featureKind: "driving_corridor",
    origin: { x: 0, y: 0, z: 0 },
    tangent: { x: 1, y: 0 },
    normal: { x: 0, y: 1 },
    stationM: 0,
    lateralOriginM: 0,
    usableIntervalM: null,
    widthM: 3.5,
    curvaturePerM: 0,
    grade: 0,
    runtimeBindingIds: ["1:0:-1"],
  }],
  members: [{
    sourceActorId: "ego",
    kind: "vehicle" as const,
    role: "ego" as const,
    blueprint: "vehicle.tesla.model3",
    isStatic: false,
    anchorId: "anchor:primary",
    pose: { longitudinalM: 0, lateralM: 0, verticalM: 0, yawDeltaDeg: 0, pitchDeltaDeg: 0, rollDeltaDeg: 0 },
    footprint: null,
    requiredFeatureKinds: ["driving_corridor"],
    eventSamples: [],
    pattern: null,
  }],
  constraints: [],
  hash: `sha256:${"1".repeat(64)}`,
};

describe("semantic feature graph contract", () => {
  it("represents exact runtime lanes and projected source-fused features together", () => {
    const graph = SemanticFeatureGraphSchema.parse({
      schemaVersion: SEMANTIC_FEATURE_GRAPH_SCHEMA_VERSION,
      compilerVersion: SEMANTIC_FEATURE_GRAPH_COMPILER_VERSION,
      graphRevision: `sha256:${"d".repeat(64)}`,
      generatedAt: "2026-07-11T00:00:00.000Z",
      mapAssetId: "map-target",
      mapName: "TownTarget",
      runtimeProvenance,
      features: [
        {
          id: "lane:1:0:-1",
          kind: "driving_corridor",
          label: "Driving lane",
          geometry: { type: "polyline", points: [{ x: 0, y: 0 }, { x: 20, y: 0 }] },
          sources: [{ source: "opendrive", sourceId: "1:0:-1", confidence: 1, revision: "a".repeat(64) }],
          runtimeBinding: { status: "exact", laneRsls: ["1:0:-1"], gateIds: [], candidateId: null, maximumProjectionErrorM: 0 },
          authoringStatus: "authorable",
          properties: {},
          diagnosticCodes: [],
        },
        {
          id: "candidate:parking-1",
          kind: "parking_area",
          label: "Street parking",
          geometry: { type: "polygon", rings: [[{ x: 0, y: 4 }, { x: 20, y: 4 }, { x: 20, y: 7 }, { x: 0, y: 4 }]] },
          sources: [{ source: "geojson", sourceId: "parking-1", confidence: 0.9, revision: null }],
          runtimeBinding: { status: "projected", laneRsls: ["1:0:-1"], gateIds: [], candidateId: "parking-1", maximumProjectionErrorM: 4 },
          authoringStatus: "authorable",
          properties: {},
          diagnosticCodes: [],
        },
      ],
      relations: [{
        id: "relation:parking:lane",
        kind: "parallel_to",
        fromFeatureId: "candidate:parking-1",
        toFeatureId: "lane:1:0:-1",
        confidence: 0.8,
        distanceM: 4,
        properties: {},
      }],
      stats: {
        featureCount: 2,
        relationCount: 1,
        authorableCount: 2,
        exactRuntimeBoundCount: 1,
        projectedRuntimeBoundCount: 1,
        byKind: { driving_corridor: 1, parking_area: 1 },
      },
    });

    expect(graph.features.map((feature) => feature.sources[0]?.source)).toEqual(["opendrive", "geojson"]);
    expect(graph.features[1]?.runtimeBinding.status).toBe("projected");
  });
});

describe("cross-map variation contract", () => {
  it("carries motif, match, actors, and graph revision as one reproducible preview", () => {
    const motifWithoutHash = {
      schemaVersion: CROSS_MAP_SCENE_MOTIF_SCHEMA_VERSION,
      source: {
        scenarioId: "scenario-source",
        mapAssetId: "map-source",
        mapName: "TownSource",
        runtime: "carla_ue5" as const,
        featureGraphRevision: `sha256:${"e".repeat(64)}`,
      },
      primaryActorId: "ego",
      actors: [{
        sourceActorId: "ego",
        kind: "vehicle" as const,
        role: "ego" as const,
        isStatic: false,
        behavior: "corridor_route" as const,
        sourcePathLengthM: 40,
        sourceDurationS: 8,
        speedKph: 18,
        requiredFeatureKinds: ["driving_corridor"],
        properties: {},
      }],
      relations: [],
      formations: [formation],
      formationHash: `sha256:${"2".repeat(64)}`,
      timingToleranceS: 1,
      spatialToleranceM: 3,
    };
    const parsed = CrossMapVariationPreviewResponseSchema.parse({
      schemaVersion: CROSS_MAP_VARIATION_SCHEMA_VERSION,
      motif: { ...motifWithoutHash, motifHash: `sha256:${"f".repeat(64)}` },
      matches: [{
        matchId: "cm_match",
        targetMapAssetId: "map-target",
        targetMapName: "TownTarget",
        runtime: "carla_ue5",
        featureGraphRevision: `sha256:${"d".repeat(64)}`,
        status: "incompatible",
        fidelity: "incompatible",
        score: 0,
        targetAnchor: null,
        targetJunctionId: null,
        actors: null,
        diagnostics: [{ code: "NO_MATCH", severity: "error", message: "No compatible target." }],
        selectedFeatureIds: [],
        formationContractHash: null,
      }],
      generatedAt: "2026-07-11T00:00:00.000Z",
    });

    expect(parsed.motif.source.featureGraphRevision).toMatch(/^sha256:/);
    expect(parsed.matches[0]?.status).toBe("incompatible");
  });
});
