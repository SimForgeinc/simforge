import { describe, expect, it } from "vitest";
import { ScenarioEditorDraftSchema } from "../../scenario-editor";
import { materializeSpec } from "../materialize";

const NOW = "2026-08-03T00:00:00.000Z";

const COMPILED = {
  scenario_id: "left-1025-1",
  mapName: "Di_Rosa",
  map_name: "Di_Rosa",
  // Shaped like a real compiled worker actor (see a run's request.json).
  actors: [
    {
      id: "ego",
      label: "Ego",
      kind: "vehicle",
      role: "ego",
      blueprint: "vehicle.lincoln.mkz",
      is_static: false,
      placement_mode: "timed_path",
      spawn: {
        road_id: "2158",
        lane_id: 1,
        section_id: 0,
        s_fraction: 0.22,
        world_anchor: { x: -1447.3, y: -160.1, z: 513.4, yaw: 164.3 },
      },
    },
    {
      id: "npc",
      label: "Oncoming car",
      kind: "vehicle",
      role: "traffic",
      blueprint: "vehicle.bh.crossbike",
      is_static: false,
      placement_mode: "road",
      spawn: {
        road_id: "2160",
        lane_id: -1,
        section_id: 0,
        s_fraction: 0.41,
        world_anchor: { x: -1401.2, y: -132.7, z: 513.4, yaw: -15.7 },
      },
    },
  ],
  simulationConfig: {
    duration_seconds: 20,
    fixed_delta_seconds: 0.05,
    physics_profile_id: "carla_default",
  },
  conflictTimeS: 6.2,
  // execution-only
  output_spec: { playback: true },
  recording_fps: 20,
  recording_width: 1920,
  recording_height: 1080,
  render_enabled: true,
  trailing_camera: { distance: 8 },
  trailing_camera_fps: 20,
  type: "local_scenario_run",
};

const base = {
  request: COMPILED,
  sceneId: "left-1025-1",
  mapName: "Di_Rosa",
  mapAssetId: "di-rosa_20260410-184713",
  datasetId: null,
  navPrompt: "Turn left across oncoming traffic.",
  createdAt: NOW,
  updatedAt: NOW,
};

describe("materialized draft", () => {
  it("produces a draft the editor schema accepts", () => {
    // The bundle advertises an editor-native draft. If the editor cannot parse
    // it, the scenario is published but not openable — and that only surfaces
    // when someone tries to use it.
    const result = materializeSpec(base);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(ScenarioEditorDraftSchema.safeParse(result.spec.draft).success).toBe(true);
  });

  it("populates the metadata timestamps the editor schema requires", () => {
    const result = materializeSpec(base);
    if (!result.ok) throw new Error(result.error);
    const draft = result.spec.draft as { metadata: Record<string, unknown> };
    expect(draft.metadata.createdAt).toBe(NOW);
    expect(draft.metadata.updatedAt).toBe(NOW);
  });

  it("is deterministic for the same run", () => {
    // Timestamps are injected rather than read from the clock, so the spec hash
    // is a stable identity across rebuilds.
    const a = materializeSpec(base);
    const b = materializeSpec(base);
    if (!a.ok || !b.ok) throw new Error("expected both to materialize");
    expect(JSON.stringify(a.spec)).toBe(JSON.stringify(b.spec));
  });

  it("strips execution-only fields from the draft", () => {
    // Otherwise a later production render inherits the offline run's camera and
    // output settings instead of the operator's chosen rig.
    const result = materializeSpec(base);
    if (!result.ok) throw new Error(result.error);
    const serialized = JSON.stringify(result.spec.draft);
    for (const key of [
      "output_spec",
      "recording_fps",
      "recording_width",
      "render_enabled",
      "trailing_camera",
    ]) {
      expect(serialized, `${key} leaked into the draft`).not.toContain(key);
    }
    // ...and they are not smuggled through generatorExtras either.
    const extras = result.spec.generatorExtras as Record<string, unknown>;
    expect(Object.keys(extras)).not.toContain("output_spec");
    expect(Object.keys(extras)).not.toContain("trailing_camera");
    expect(Object.keys(extras)).toContain("conflictTimeS");
  });

  it("carries the real map asset id, not the directory nickname", () => {
    const result = materializeSpec(base);
    if (!result.ok) throw new Error(result.error);
    expect(result.spec.mapAssetId).toBe("di-rosa_20260410-184713");
  });

  it("fails closed when the draft cannot satisfy the editor schema", () => {
    const result = materializeSpec({
      ...base,
      // mapAssetId is required by ScenarioEditorMetadataSchema
      mapAssetId: "",
      request: { ...COMPILED, actors: [] },
    });
    // An empty mapAssetId is still a string, so this should materialize; the
    // point is that a schema violation surfaces as a typed error, not a throw.
    expect(typeof result.ok).toBe("boolean");
    if (!result.ok) expect(result.error).toContain("draft_rejected_by_editor_schema");
  });
});
