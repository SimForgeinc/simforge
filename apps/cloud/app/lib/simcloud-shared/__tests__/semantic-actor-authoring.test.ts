import { describe, expect, it } from "vitest";
import {
  SemanticActorAuthoringSchema,
  semanticExecutableActorProjection,
  stableSemanticBindingJson,
  quantizeSemanticExecutableProof,
} from "../semantic-actor-authoring";

const provenance = {
  mapAssetId: "map-1",
  runtimeFamily: "carla_ue5",
  runtimeMapName: "MapOne",
  runtimeCatalogVersion: "catalog-1",
  bundleVersion: "bundle-1",
  imageDigest: "sha256:image",
  xodrSha256: "a".repeat(64),
  runtimeRoadGraphSha256: "b".repeat(64),
  projectionIdentitySha256: "c".repeat(64),
  compilerVersion: "runtime-topology.v1",
} as const;

describe("semantic actor authoring contract", () => {
  it("requires one exact intent/compilation revision", () => {
    const value = {
      schemaVersion: "simforge.semantic-actor-authoring.v1",
      intent: {
        kind: "corridor_station",
        graphRevision: "sem-a",
        corridorId: "cor-a",
        stationM: 12,
        laneRole: "single",
      },
      compilation: {
        status: "exact",
        graphRevision: "sem-a",
        semanticCompilerVersion: "semantic-map-compiler.v3",
        bindingCompilerVersion: "semantic-runtime-binding.v1",
        runtimeProvenance: provenance,
        outputHash: `sha256:${"d".repeat(64)}`,
        runtimeLaneRsls: ["1:0:-1"],
        runtimeGateIds: [],
      },
    };
    expect(SemanticActorAuthoringSchema.parse(value)).toEqual(value);
    expect(
      SemanticActorAuthoringSchema.safeParse({
        ...value,
        compilation: { ...value.compilation, graphRevision: "sem-b" },
      }).success,
    ).toBe(false);
  });

  it("canonicalizes only concrete executable fields with stable key order", () => {
    const projected = semanticExecutableActorProjection({
      route: [{ s_fraction: 1, road_id: "2" }],
      spawn: { road_id: "1", s_fraction: -0 },
      ignored: true,
    });
    expect(stableSemanticBindingJson(projected)).toBe(
      '{"autopilot":null,"destination":null,"is_static":null,"path_placement":[],"placement_mode":null,"route":[{"road_id":"2","s_fraction":1}],"route_direction":null,"spawn":{"road_id":"1","s_fraction":0},"spawn_point":null,"spawn_yaw":null,"timed_waypoints":[]}',
    );
  });

  it("quantizes persisted execution geometry to micrometer precision", () => {
    expect(
      quantizeSemanticExecutableProof({ z: 12.119864299288853 }),
    ).toEqual({ z: 12.119864 });
  });
});
