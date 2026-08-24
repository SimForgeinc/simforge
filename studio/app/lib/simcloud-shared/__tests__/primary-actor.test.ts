import { describe, expect, it } from "vitest";

import { primaryActor, ScenarioEditorActorDraftSchema } from "../scenario-editor";

/**
 * Subject identity is derived only from a configured sensor rig. These pin the
 * invariant because a designation with no sensors records nothing, while the
 * first sensor vehicle is the actual measurement source.
 */
type Candidate = {
  id: string;
  kind: "vehicle" | "walker" | "prop";
  role: "subject" | "traffic" | "pedestrian" | "prop";
  sensors?: unknown[];
};

const car = (over: Partial<Candidate> = {}): Candidate => ({
  id: "car",
  kind: "vehicle",
  role: "traffic",
  sensors: [],
  ...over,
});

describe("primaryActor", () => {
  it("picks the vehicle carrying a sensor rig", () => {
    const actors = [
      car({ id: "a" }),
      car({ id: "b", sensors: [{ kind: "camera" }] }),
      car({ id: "c" }),
    ];
    expect(primaryActor(actors)?.id).toBe("b");
  });

  it("prefers the rig over a declared subject role", () => {
    // The rig is the fact; the role is a label that may be stale.
    const actors = [
      car({ id: "declared", role: "subject" }),
      car({ id: "rigged", sensors: [{ kind: "camera" }] }),
    ];
    expect(primaryActor(actors)?.id).toBe("rigged");
  });

  it("does not treat a role designation or an unrigged vehicle as the subject", () => {
    const actors = [car({ id: "a" }), car({ id: "b", role: "subject" })];
    expect(primaryActor(actors)).toBeNull();
  });

  it("never picks a walker, prop, or unrigged vehicle as the subject", () => {
    const actors: Candidate[] = [
      { id: "ped", kind: "walker", role: "pedestrian", sensors: [{}] },
      { id: "cone", kind: "prop", role: "prop" },
      car({ id: "car" }),
    ];
    expect(primaryActor(actors)).toBeNull();
  });

  it("returns null for a scene with no vehicles", () => {
    const actors: Candidate[] = [
      { id: "ped", kind: "walker", role: "pedestrian" },
    ];
    expect(primaryActor(actors)).toBeNull();
  });

  it("handles an empty scene", () => {
    expect(primaryActor([])).toBeNull();
  });

  it("treats an absent sensors field as no rig", () => {
    const actors = [car({ id: "a", sensors: undefined }), car({ id: "b" })];
    expect(primaryActor(actors)).toBeNull();
  });

  it.each(["ego", "hero"])("normalizes persisted role %s without re-emitting it", (role) => {
    const parsed = ScenarioEditorActorDraftSchema.parse({
      id: "legacy",
      label: "Legacy camera vehicle",
      kind: "vehicle",
      role,
      blueprint: "vehicle.test",
      spawn: {
        road_id: "1",
        s_fraction: 0.5,
        world_anchor: { x: 0, y: 0, z: 0, yaw: 0 },
      },
      sensors: [{
        id: "camera",
        sensorCategory: "camera",
        outputModality: "rgb",
        attachTo: "legacy",
        pose: { x: 0, y: 0, z: 1.5, roll: 0, pitch: 0, yaw: 0 },
      }],
    });
    expect(parsed.role).toBe("subject");
    expect(JSON.stringify(parsed)).not.toContain(`\"role\":\"${role}\"`);
    expect(primaryActor([parsed])?.id).toBe("legacy");
  });
});
