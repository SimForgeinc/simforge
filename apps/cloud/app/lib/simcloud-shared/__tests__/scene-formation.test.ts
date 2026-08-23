import { describe, expect, it } from "vitest";
import {
  canonicalSceneFormationJson,
  SCENE_FORMATION_SCHEMA_VERSION,
  SceneFormationSchema,
} from "../index";

function fixture() {
  return {
    schemaVersion: SCENE_FORMATION_SCHEMA_VERSION,
    id: "formation:occlusion",
    kind: "pedestrian_occlusion" as const,
    transferPolicy: "rigid" as const,
    source: {
      scenarioId: "scenario-source",
      mapAssetId: "map-source",
      mapName: "TownSource",
      runtime: "carla_ue5" as const,
      featureGraphRevision: `sha256:${"a".repeat(64)}`,
    },
    anchors: [{
      id: "anchor:emergence",
      frameKind: "emergence" as const,
      featureId: "walking:source",
      featureKind: "walking_corridor",
      origin: { x: 10.0004, y: 4, z: 0 },
      tangent: { x: 1, y: 0 },
      normal: { x: 0, y: 1 },
      stationM: 10,
      lateralOriginM: 0,
      usableIntervalM: [0, 20] as [number, number],
      widthM: 2,
      curvaturePerM: 0,
      grade: 0,
      runtimeBindingIds: ["10:0:1"],
    }],
    members: [
      {
        sourceActorId: "walker",
        kind: "walker" as const,
        role: "pedestrian" as const,
        blueprint: "walker.pedestrian.0001",
        isStatic: false,
        anchorId: "anchor:emergence",
        pose: { longitudinalM: 0, lateralM: 0, verticalM: 0, yawDeltaDeg: 90, pitchDeltaDeg: 0, rollDeltaDeg: 0 },
        footprint: null,
        requiredFeatureKinds: ["walking_corridor"],
        eventSamples: [],
        pattern: null,
      },
      ...["parked-a", "parked-b"].map((sourceActorId, index) => ({
        sourceActorId,
        kind: "vehicle" as const,
        role: "traffic" as const,
        blueprint: "vehicle.audi.a2",
        isStatic: true,
        anchorId: "anchor:emergence",
        pose: { longitudinalM: index === 0 ? -3 : 3, lateralM: 0, verticalM: 0, yawDeltaDeg: 0, pitchDeltaDeg: 0, rollDeltaDeg: 0 },
        footprint: null,
        requiredFeatureKinds: ["parking_lane"],
        eventSamples: [],
        pattern: null,
      })),
    ],
    constraints: [{
      id: "constraint:emerges-between",
      kind: "emerges_between" as const,
      strength: "hard" as const,
      subjectMemberId: "walker",
      objectMemberIds: ["parked-a", "parked-b"],
      eventId: "emergence",
      metric: "pose" as const,
      expected: { value: null, longitudinalM: 0, lateralM: 0, verticalM: 0, yawDeltaDeg: null, timeS: 2, boolean: true, order: ["parked-a", "walker", "parked-b"] },
      compileTolerance: 0.5,
      runtimeTolerance: 0.75,
      source: "authored" as const,
      reason: "The walker must emerge through the gap between both parked cars.",
    }],
    hash: `sha256:${"b".repeat(64)}`,
  };
}

describe("scene formation v2", () => {
  it("represents one pedestrian constrained by multiple occluders", () => {
    const parsed = SceneFormationSchema.parse(fixture());
    expect(parsed.constraints[0]?.objectMemberIds).toEqual(["parked-a", "parked-b"]);
  });

  it("rejects obsolete formation versions instead of silently migrating them", () => {
    expect(() => SceneFormationSchema.parse({ ...fixture(), schemaVersion: "simforge.scene-formation.v1" })).toThrow();
  });

  it("canonicalizes object key order and quantizes coordinates to integer millimetres", () => {
    expect(canonicalSceneFormationJson({ y: 2, x: 1.0004 })).toBe(
      canonicalSceneFormationJson({ x: 1, y: 2 }),
    );
    expect(canonicalSceneFormationJson({ x: 1.0006 })).toBe('{"x":1001}');
    expect(canonicalSceneFormationJson({ z: "x", b: [true, null], a: -1.0005 })).toBe(
      '{"a":-1000,"b":[true,null],"z":"x"}',
    );
  });
});
