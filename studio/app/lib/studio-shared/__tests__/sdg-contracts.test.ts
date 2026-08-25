import { describe, expect, it } from "vitest";
import {
  DATASET_RECIPES,
  DEFAULT_SDG_DIRECT_RENDER_DRAFT,
  SDG_RECIPE_CONFIG,
  SCENARIO_TIMING,
  SdgManifestSchema,
  SdgOdvgFrameSchema,
  SdgRenderOutputPlanSchema,
  expandSdgOutputs,
  getRequiredSdgRawModalities,
  resolveRenderDurationSeconds,
} from "../index";

describe("SDG shared contracts", () => {
  it("uses central scenario duration defaults for authored SDG render contracts", () => {
    expect(SCENARIO_TIMING.defaultDurationSeconds).toBe(20);
    expect(SDG_RECIPE_CONFIG.recorder_config.duration_seconds).toBe(20);
    expect(DEFAULT_SDG_DIRECT_RENDER_DRAFT.recorder.durationSeconds).toBe(20);
  });

  it("resolves render duration from explicit render override or scenario duration", () => {
    expect(
      resolveRenderDurationSeconds({
        scenarioDurationSeconds: 20,
        renderDurationOverrideSeconds: null,
      }),
    ).toBe(20);
    expect(
      resolveRenderDurationSeconds({
        scenarioDurationSeconds: 20,
        renderDurationOverrideSeconds: 45,
      }),
    ).toBe(45);
  });

  it("expands requested outputs through the canonical dependency map", () => {
    expect(expandSdgOutputs(["odvg"])).toEqual([
      "rgb",
      "semantic_segmentation",
      "instance_segmentation",
      "odvg",
    ]);
    expect(getRequiredSdgRawModalities(["rgb_bboxed"])).toEqual([
      "rgb",
      "semantic_segmentation",
      "instance_segmentation",
    ]);
  });

  it("validates the canonical grouped render output plan shape", () => {
    const plan = SdgRenderOutputPlanSchema.parse({
      schemaVersion: "simforge.render-output-plan.v1",
      profile: "sdg",
      cameraMountIds: ["front"],
      outputs: {
        frames: ["rgb", "depth"],
        annotations: [],
        media: ["videos"],
      },
      recorder: {
        durationSeconds: 15,
        resolution: { width: 1920, height: 1080 },
      },
      bbox: {
        dynamicActors: true,
        trafficLights: false,
        trafficSigns: false,
      },
      retention: {
        uploadStageInputs: true,
        uploadRawBundle: false,
      },
    });

    expect(plan.outputs).toEqual({
      frames: ["rgb", "depth"],
      annotations: [],
      media: ["videos"],
    });
    expect(plan.bbox).toEqual({
      dynamicActors: true,
      trafficLights: false,
      trafficSigns: false,
    });
    expect(plan.recorder.fps).toBe(20);
    expect(plan.stagePolicy).toEqual({
      groundTruth: true,
      cosmos: false,
      postprocess: false,
    });
  });

  it("rejects non-canonical SDG recorder frame rates", () => {
    const plan = {
      schemaVersion: "simforge.render-output-plan.v1",
      profile: "sdg",
      cameraMountIds: ["front"],
      outputs: {
        frames: ["rgb"],
        annotations: ["odvg"],
        media: ["videos"],
      },
      recorder: {
        durationSeconds: 15,
        fps: 30,
        resolution: { width: 1920, height: 1080 },
      },
      bbox: {
        dynamicActors: true,
        trafficLights: false,
        trafficSigns: false,
      },
      retention: {
        uploadStageInputs: true,
        uploadRawBundle: false,
      },
    };

    expect(SdgRenderOutputPlanSchema.safeParse(plan).success).toBe(false);
  });

  it("rejects internal render output plan fields from the public contract", () => {
    const fullLegacyPlan = {
      recipeId: "sdg",
      recipeVersion: "sdg-compatible-v1",
      cameraOutputGroups: [{ cameraMountId: "front", outputs: ["rgb"] }],
      recorderConfig: { outputs: ["rgb"] },
      bboxPolicy: { categories: { dynamicActors: true } },
      retentionPolicy: { uploadStageInputs: true },
    };
    const legacyFields = [
      { key: "recipeId", value: fullLegacyPlan.recipeId },
      { key: "recipeVersion", value: fullLegacyPlan.recipeVersion },
      { key: "cameraOutputGroups", value: fullLegacyPlan.cameraOutputGroups },
      { key: "recorderConfig", value: fullLegacyPlan.recorderConfig },
      { key: "bboxPolicy", value: fullLegacyPlan.bboxPolicy },
      { key: "retentionPolicy", value: fullLegacyPlan.retentionPolicy },
    ];
    const publicPlan = {
      schemaVersion: "simforge.render-output-plan.v1",
      profile: "sdg",
      cameraMountIds: ["front"],
      outputs: {
        frames: ["rgb"],
        annotations: ["odvg"],
        media: ["videos"],
      },
      recorder: {
        durationSeconds: 15,
        resolution: { width: 1920, height: 1080 },
      },
      bbox: {
        dynamicActors: true,
        trafficLights: false,
        trafficSigns: false,
      },
      retention: {
        uploadStageInputs: true,
        uploadRawBundle: false,
      },
    };

    expect(
      SdgRenderOutputPlanSchema.safeParse({
        ...publicPlan,
        ...fullLegacyPlan,
      }).success,
      "full legacy plan",
    ).toBe(false);

    for (const legacyField of legacyFields) {
      expect(
        SdgRenderOutputPlanSchema.safeParse({
          ...publicPlan,
          [legacyField.key]: legacyField.value,
        }).success,
        legacyField.key,
      ).toBe(false);
    }
  });

  it("allows annotation-free RGB video plans while requiring frame and media outputs", () => {
    const publicPlan = {
      schemaVersion: "simforge.render-output-plan.v1",
      profile: "sdg",
      cameraMountIds: ["front"],
      outputs: {
        frames: ["rgb"],
        annotations: [],
        media: ["videos"],
      },
      recorder: {
        durationSeconds: 15,
        resolution: { width: 1920, height: 1080 },
      },
      bbox: {
        dynamicActors: true,
        trafficLights: false,
        trafficSigns: false,
      },
      retention: {
        uploadStageInputs: true,
        uploadRawBundle: false,
      },
    };

    expect(SdgRenderOutputPlanSchema.safeParse(publicPlan).success).toBe(true);

    expect(
      SdgRenderOutputPlanSchema.safeParse({
        ...publicPlan,
        cameraMountIds: [],
      }).success,
    ).toBe(false);

    for (const group of ["frames", "media"] as const) {
      expect(
        SdgRenderOutputPlanSchema.safeParse({
          ...publicPlan,
          outputs: { ...publicPlan.outputs, [group]: [] },
        }).success,
        group,
      ).toBe(false);
    }
  });

  it("validates SDG manifest quality metrics and downstream inputs", () => {
    const manifest = SdgManifestSchema.parse({
      schema_version: "simforge.sdg.manifest.v1",
      recipe_id: "sdg",
      quality_state: "pass",
      quality_metrics: {
        frames_expected: 2,
        frames_exported: 2,
        frames_with_actor_samples: 2,
        frames_missing_actor_samples: 0,
        frame_alignment_ratio: 1,
        bbox_frames_with_detections: 2,
        dropped_detections_by_reason: {},
      },
      requested_outputs: ["rgb", "odvg", "videos"],
      stages: {
        ground_truth: true,
        cosmos: "configured_by_request",
        postprocess: "configured_by_request",
      },
      frame_count: 2,
      required_cosmos_inputs: {
        video: "video/rgb.mp4",
        controls: { edge: "video/edge.mp4" },
      },
      artifacts: [
        {
          path: "odvg/odvg_000000000000.json",
          recipe_stage: "ground_truth",
          modality: "odvg",
          role: "annotation",
          artifact_type: "odvg_json",
          frame_index: 0,
          downstream_use: "training_bundle",
        },
      ],
    });

    expect(manifest.quality_metrics.frame_alignment_ratio).toBe(1);
    expect(manifest.required_cosmos_inputs.controls.edge).toBe("video/edge.mp4");
  });

  it("uses SDG as the canonical dataset recipe", () => {
    expect(DATASET_RECIPES).toHaveLength(1);
    expect(DATASET_RECIPES[0]).toMatchObject({
      id: "sdg",
      name: "SDG",
      format: "ODVG",
      outputProfile: "sdg",
      stages: { render: true, augment: true, export: true },
    });
  });

  it("validates canonical worker ODVG labels without deprecated bbox aliases", () => {
    const frame = SdgOdvgFrameSchema.parse({
      frame_id: "frame_000000000000",
      image_filename: "frame_000000000000.jpg",
      depth_file_name: "depth/depth_000000000000.png",
      instance_segmentation_file_name: "instance_segmentation/seg_000000000000.png",
      semantic_segmentation_file_name: "semantic_segmentation/seg_000000000000.png",
      edge_file_name: "edges/edge_000000000000.png",
      timestamp: 0,
      width: 1920,
      height: 1080,
      detections: {
        instances: [
          {
            "object-id": 42,
            category: "dynamic_actor",
            blueprint_id: "vehicle.tesla.model3",
            bbox_2d_visible_pixel: [10, 20, 110, 160],
            mask: [[10, 20, 110, 20, 110, 160, 10, 160]],
            bbox_3d_world: {
              coordinate_system: "carla_world_meters",
              center: { x: 1, y: 2, z: 3, yaw: 90 },
              size: { length: 4.5, width: 2, height: 1.7 },
              projection: "runtime_actor_extent",
            },
            bbox_3d_camera: {
              coordinate_system: "camera_meters",
              center: { x: 0.5, y: -0.1, z: 12 },
              size: { length: 4.5, width: 2, height: 1.7 },
              orientation: {
                yaw: 90,
                reference: "carla_world_yaw_degrees",
              },
              projection: "world_to_camera_transform",
            },
            bbox_3d_projection: null,
            bbox_3d_projection_method: null,
            bbox_quality: {
              source: "visible_instance_mask",
              visibility_ratio: 0.9,
              area_px: 1200,
              bbox_area_px: 1500,
              image_size: { width: 1920, height: 1080 },
              filtering_reason: null,
            },
          },
        ],
      },
    });

    expect(frame.detections.instances[0].bbox_2d_visible_pixel).toEqual([
      10,
      20,
      110,
      160,
    ]);
    expect(frame.detections.instances[0]).not.toHaveProperty("bbox_2d");
    expect(frame.detections.instances[0]).not.toHaveProperty("bbox_3d");
  });
});
