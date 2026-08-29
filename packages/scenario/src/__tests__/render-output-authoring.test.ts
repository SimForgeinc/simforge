import { describe, expect, it } from "vitest";

import {
  buildRenderOutputPresetSpec,
  buildSdgDatasetCompileOutputPlan,
  buildSdgRenderOutputPlan,
  DEFAULT_BBOX_CATEGORIES,
  DEFAULT_RENDER_OUTPUT_SPEC,
  DEFAULT_SDG_DATASET_COMPILE_OUTPUTS,
  DEFAULT_SDG_DIRECT_RENDER_DRAFT,
  parseScenarioSetupRenderConfig,
  RENDER_OUTPUT_PRESETS,
  setSdgOutputEnabled,
} from "../contracts.js";

describe("render output authoring contracts", () => {
  it("owns every non-custom render profile preset and defaults to SDG", () => {
    expect(RENDER_OUTPUT_PRESETS).toEqual({
      playback: {
        label: "Standard Video",
        description: "Encode MP4 videos and a manifest from the configured RGB camera sensors.",
        annotations: [],
        metadata: ["manifest"],
        encodings: ["mp4"],
      },
      training_basic: {
        label: "Training Basic",
        description: "Keep raw camera/range outputs with calibration, timestamps, and 2D boxes.",
        annotations: ["bbox_2d"],
        metadata: ["manifest", "calibration", "timestamps"],
        encodings: ["image_sequence"],
      },
      training_multimodal: {
        label: "Training Multimodal",
        description: "Capture raw multisensor outputs, calibration, timestamps, map metadata, and derived playback.",
        annotations: ["bbox_2d", "bbox_3d", "tracking"],
        metadata: ["manifest", "calibration", "timestamps", "opendrive"],
        encodings: ["image_sequence", "mp4"],
      },
      raw_multisensor: {
        label: "Raw Multisensor",
        description: "Persist only raw sensor sequences and calibration from the configured rig.",
        annotations: [],
        metadata: ["manifest", "calibration", "timestamps"],
        encodings: ["image_sequence"],
      },
      tao_detection: {
        label: "TAO Detection",
        description: "Generate RGB image sequences, calibration, and 2D detection annotations for TAO-style training.",
        annotations: ["bbox_2d", "tracking"],
        metadata: ["manifest", "calibration", "timestamps"],
        encodings: ["image_sequence"],
        modalities: ["rgb"],
      },
      sdg: {
        label: "SDG",
        description: "SDG recipe output: video, ODVG/object annotations, and map/calibration metadata for ground-truth bundles.",
        annotations: ["odvg", "objects", "instances"],
        metadata: ["manifest", "calibration", "timestamps", "opendrive"],
        encodings: ["image_sequence", "mp4"],
        modalities: ["rgb", "depth", "semantic_segmentation", "instance_segmentation", "normals"],
      },
    });
    expect(DEFAULT_RENDER_OUTPUT_SPEC).toEqual(buildRenderOutputPresetSpec("sdg"));
  });

  it("parses render config through the canonical profile schema and bbox defaults", () => {
    const parsed = parseScenarioSetupRenderConfig({
      renderOutputProfile: "not-a-profile",
      outputSpec: buildRenderOutputPresetSpec("playback"),
      bboxCategories: { trafficLights: true, emit3dWorld: false },
    });

    expect(parsed).not.toBeNull();
    expect(parsed?.renderOutputProfile).toBe("playback");
    expect(parsed?.bboxCategories).toEqual({
      ...DEFAULT_BBOX_CATEGORIES,
      trafficLights: true,
      emit3dWorld: false,
    });
  });

  it("applies SDG selection, plan compatibility, camera, and schema defaults", () => {
    const compilePlan = buildSdgDatasetCompileOutputPlan({});
    expect(DEFAULT_SDG_DATASET_COMPILE_OUTPUTS).toEqual([
      "rgb",
      "odvg",
      "rgb_bboxed",
      "videos",
    ]);
    expect(compilePlan.cameraMountIds).toEqual(["scenario_default"]);
    expect(compilePlan.outputs.frames).toEqual([
      "rgb",
      "semantic_segmentation",
      "instance_segmentation",
    ]);
    expect(compilePlan.outputs.annotations).toEqual([
      "odvg",
      "rgb_bboxed",
    ]);
    expect(compilePlan.outputs.media).toEqual(["videos"]);
    expect(compilePlan.bbox).toEqual({
      dynamicActors: true,
      trafficLights: false,
      trafficSigns: false,
    });
    expect(compilePlan.retention).toEqual({
      uploadStageInputs: true,
      uploadRawBundle: false,
    });
    expect(compilePlan.stagePolicy).toEqual({
      groundTruth: true,
      cosmos: false,
      postprocess: false,
    });

    const annotationOnlyPlan = buildSdgRenderOutputPlan({
      draft: { ...DEFAULT_SDG_DIRECT_RENDER_DRAFT, outputs: ["odvg"] },
    });
    expect(annotationOnlyPlan.outputs.frames).toContain("rgb");
    expect(annotationOnlyPlan.outputs.media).toEqual(["videos"]);
  });

  it("re-adds RGB when toggling would empty the SDG selection", () => {
    const updated = setSdgOutputEnabled(
      { ...DEFAULT_SDG_DIRECT_RENDER_DRAFT, outputs: ["rgb"] },
      "rgb",
      false,
    );
    expect(updated.outputs).toEqual(["rgb"]);
  });

  it("fills Alpamayo policy literals from the training profile schema", () => {
    const plan = buildSdgRenderOutputPlan({
      draft: DEFAULT_SDG_DIRECT_RENDER_DRAFT,
      alpamayoCameraMountIds: ["front", "left"],
    });
    expect(plan.trainingProfile).toEqual({
      id: "alpamayo_pai_sft",
      datasetFormat: "PAI",
      cameraMountIds: ["front", "left"],
      requiredLabels: ["egomotion"],
      clipDurationSeconds: 20,
      defaultKeyframeTimestampUs: 5_100_000,
      historySteps: 16,
      futureSteps: 64,
      timeStepSeconds: 0.1,
    });
  });
});
