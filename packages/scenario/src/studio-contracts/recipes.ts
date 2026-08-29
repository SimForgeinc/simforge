import { z } from "zod-v3";
import type { SdgRecipeConfig, Sensor, SensorOutputModality } from "./simulation-run";
import { SCENARIO_TIMING } from "./scenario-timing";

export const DatasetRecipeIdSchema = z.enum([
  "sdg",
]);
export type DatasetRecipeId = z.infer<typeof DatasetRecipeIdSchema>;

export const PublicExportFormatSchema = z.enum(["ODVG"]);
export type PublicExportFormat = z.infer<typeof PublicExportFormatSchema>;

export const SDG_AUGMENTATION_MATRIX = {
  weatherCondition: ["clear_sky", "overcast", "snow_falling", "raining", "fog"],
  lightingCondition: [
    "sunrise",
    "sunset",
    "twilight",
    "mid_morning",
    "afternoon",
    "zenith",
    "golden_hour",
    "blue_hour",
    "night",
  ],
  roadCondition: ["dry", "snow", "sand", "puddles", "flooding"],
} as const;

export const SDG_COSMOS = {
  model: "nvidia/Cosmos-Transfer2.5-7B",
  executorType: "gradio",
  modelVersion: "ct25",
  guidance: 3,
  numSteps: 35,
  sigma: 90,
  modalities: ["edge"] as const,
  weights: { edge: 1.0 },
  positivePrompt:
    "cinematic, photorealistic, ultra high quality, ultra high resolution, high fidelity, high definition, realistic traffic scene with proper physics and coherent motion",
  negativePrompt:
    "The video captures a game playing, with bad crappy graphics and cartoonish frames. It represents a recording of old outdated games. The lighting looks very fake. The textures are very raw and basic. The geometries are very primitive. The images are very pixelated and of poor CG quality. There are many subtitles in the footage. Overall, the video is unrealistic at all.",
} as const;

export const SDG_OUTPUTS = [
  "rgb",
  "depth",
  "semantic_segmentation",
  "instance_segmentation",
  "normals",
  "edges",
  "masks",
  "odvg",
  "objects",
  "instances",
  "videos",
  "rgb_bboxed",
] as const;
export type SdgOutput = (typeof SDG_OUTPUTS)[number];

export const SDG_RENDER_FPS = 20 as const;
export const SDG_RENDER_RESOLUTION = { width: 1280, height: 720 } as const;

export const SdgOutputSchema = z.enum(SDG_OUTPUTS);

export const SDG_RAW_OUTPUT_MODALITIES = [
  "rgb",
  "depth",
  "semantic_segmentation",
  "instance_segmentation",
  "normals",
] as const satisfies readonly SensorOutputModality[];

export const SDG_OUTPUT_DEPENDENCIES = {
  rgb: [],
  depth: [],
  semantic_segmentation: [],
  instance_segmentation: [],
  normals: [],
  edges: ["rgb", "semantic_segmentation"],
  masks: ["rgb", "semantic_segmentation"],
  odvg: ["rgb", "semantic_segmentation", "instance_segmentation"],
  objects: ["rgb", "semantic_segmentation", "instance_segmentation"],
  instances: ["rgb", "semantic_segmentation", "instance_segmentation"],
  videos: ["rgb"],
  rgb_bboxed: ["rgb", "semantic_segmentation", "instance_segmentation"],
} as const satisfies Record<SdgOutput, readonly SdgOutput[]>;

export function orderedSdgOutputs(values: Iterable<SdgOutput | string>) {
  const selected = new Set(values);
  return SDG_OUTPUTS.filter((output) => selected.has(output));
}

function addSdgOutputWithDependencies(
  output: SdgOutput,
  selected: Set<SdgOutput>,
) {
  for (const dependency of SDG_OUTPUT_DEPENDENCIES[output]) {
    addSdgOutputWithDependencies(dependency, selected);
  }
  selected.add(output);
}

export function expandSdgOutputs(values: Iterable<SdgOutput>) {
  const expanded = new Set<SdgOutput>();
  for (const output of values) {
    addSdgOutputWithDependencies(output, expanded);
  }
  return orderedSdgOutputs(expanded);
}

export function getRequiredSdgRawModalities(values: Iterable<SdgOutput>) {
  const expanded = expandSdgOutputs(values);
  return SDG_RAW_OUTPUT_MODALITIES.filter((modality) =>
    expanded.includes(modality),
  );
}

const SDG_THIRD_PERSON_POSE = {
  x: -7.5,
  y: 0,
  z: 3.2,
  roll: 0,
  pitch: -20,
  yaw: 0,
} as const;

export const SDG_SENSOR_RIG = {
  id: "sdg-default",
  name: "SDG Default",
  description:
    "CARLA camera rig for SDG capture: RGB, depth, semantic segmentation, instance segmentation, and normals from a shared third-person viewpoint.",
  source: "simforge.sdg.default-rig.v1",
  sensors: [
    {
      id: "sdg_rgb",
      label: "SDG RGB",
      sensorCategory: "camera",
      outputModality: "rgb",
      attachTo: "ego",
      attachmentType: "spring_arm_ghost",
      pose: SDG_THIRD_PERSON_POSE,
      updateRate: 30,
      width: 1920,
      height: 1080,
      fov: 90,
    },
    {
      id: "sdg_depth",
      label: "SDG Depth",
      sensorCategory: "camera",
      outputModality: "depth",
      attachTo: "ego",
      attachmentType: "spring_arm_ghost",
      pose: SDG_THIRD_PERSON_POSE,
      updateRate: 30,
      width: 1920,
      height: 1080,
      fov: 90,
    },
    {
      id: "sdg_semantic_segmentation",
      label: "SDG Semantic Segmentation",
      sensorCategory: "camera",
      outputModality: "semantic_segmentation",
      attachTo: "ego",
      attachmentType: "spring_arm_ghost",
      pose: SDG_THIRD_PERSON_POSE,
      updateRate: 30,
      width: 1920,
      height: 1080,
      fov: 90,
    },
    {
      id: "sdg_instance_segmentation",
      label: "SDG Instance Segmentation",
      sensorCategory: "camera",
      outputModality: "instance_segmentation",
      attachTo: "ego",
      attachmentType: "spring_arm_ghost",
      pose: SDG_THIRD_PERSON_POSE,
      updateRate: 30,
      width: 1920,
      height: 1080,
      fov: 90,
    },
    {
      id: "sdg_normals",
      label: "SDG Normals",
      sensorCategory: "camera",
      outputModality: "normals",
      attachTo: "ego",
      attachmentType: "spring_arm_ghost",
      pose: SDG_THIRD_PERSON_POSE,
      updateRate: 30,
      width: 1920,
      height: 1080,
      fov: 90,
    },
  ] satisfies Sensor[],
} as const;

export const SDG_RECIPE_CONFIG: SdgRecipeConfig = {
  recipe_id: "sdg",
  stages: {
    ground_truth: true,
    cosmos: true,
    postprocess: true,
  },
  recorder_config: {
    rig_id: SDG_SENSOR_RIG.id,
    resolution: { width: 1920, height: 1080 },
    fov: 90,
    fps: SDG_RENDER_FPS,
    start_time: 0,
    duration_seconds: SCENARIO_TIMING.defaultDurationSeconds,
    time_factor: 1,
    detect_collisions: true,
    collision_actor_ids: [],
    area_threshold: 100,
    limit_distance: 100,
    class_filter_config: "config/filter_semantic_classes.yaml",
    outputs: [...SDG_OUTPUTS],
  },
  cosmos_config: {
    enabled: true,
    num_augmentations: 1,
    weather_condition: [...SDG_AUGMENTATION_MATRIX.weatherCondition],
    lighting_condition: [...SDG_AUGMENTATION_MATRIX.lightingCondition],
    road_condition: [...SDG_AUGMENTATION_MATRIX.roadCondition],
    executor_type: SDG_COSMOS.executorType,
    model: SDG_COSMOS.model,
    model_version: SDG_COSMOS.modelVersion,
    modalities: [...SDG_COSMOS.modalities],
    weights: { ...SDG_COSMOS.weights },
    guidance: SDG_COSMOS.guidance,
    num_steps: SDG_COSMOS.numSteps,
    resolution: 720,
    max_frames: 450,
    sigma: SDG_COSMOS.sigma,
    seed: null,
    positive_prompt: SDG_COSMOS.positivePrompt,
    negative_prompt: SDG_COSMOS.negativePrompt,
  },
  postprocess_config: {
    enabled: true,
    som_overlays: true,
    collision_qa: true,
    non_collision_qa: true,
    balanced_annotations: true,
    yes_ratio: 0.5,
    area_threshold: 100,
  },
};

const SdgRequiredOutputGroupSchema = z.array(SdgOutputSchema).min(1);
const SdgOptionalOutputGroupSchema = z.array(SdgOutputSchema);
const SdgResolutionSchema = z.object({
  width: z.number().int().min(1).max(3840),
  height: z.number().int().min(1).max(2160),
}).strict();
const SdgCameraMountDescriptorSchema = z.object({
  id: z.string().min(1),
  label: z.string().min(1).optional(),
  attachTo: z.string().min(1).optional(),
  sensorId: z.string().min(1).optional(),
  sourceSensorId: z.string().min(1).optional(),
  kind: z.enum(["actor", "world"]).optional(),
}).strict();

const SdgTrainingProfileSchema = z.object({
  id: z.enum(["alpamayo_pai_sft"]),
  datasetFormat: z.literal("PAI").default("PAI"),
  cameraMountIds: z.array(z.string().min(1)).min(1),
  requiredLabels: z.array(z.enum(["egomotion"])).default(["egomotion"]),
  clipDurationSeconds: z.literal(20).default(20),
  defaultKeyframeTimestampUs: z.literal(5_100_000).default(5_100_000),
  historySteps: z.literal(16).default(16),
  futureSteps: z.literal(64).default(64),
  timeStepSeconds: z.literal(0.1).default(0.1),
}).strict();

export const SdgRenderOutputPlanSchema = z.object({
  schemaVersion: z.literal("simforge.render-output-plan.v1"),
  profile: z.literal("sdg"),
  cameraMountIds: z.array(z.string().min(1)).min(1),
  cameraMounts: z.array(SdgCameraMountDescriptorSchema).default([]),
  trainingProfile: SdgTrainingProfileSchema.optional(),
  outputs: z.object({
    frames: SdgRequiredOutputGroupSchema,
    annotations: SdgOptionalOutputGroupSchema,
    media: SdgRequiredOutputGroupSchema,
  }).strict(),
  recorder: z.object({
    startTime: z.number().min(0).optional(),
    durationSeconds: z.number().min(0),
    fps: z.literal(SDG_RENDER_FPS).default(SDG_RENDER_FPS),
    resolution: SdgResolutionSchema,
    timeFactor: z.number().min(0.01).max(10).optional(),
    limitDistance: z.number().min(0).optional(),
    areaThreshold: z.number().min(0).optional(),
    detectCollisions: z.boolean().optional(),
  }).strict(),
  bbox: z.object({
    dynamicActors: z.boolean(),
    trafficLights: z.boolean(),
    trafficSigns: z.boolean(),
  }).strict(),
  retention: z.object({
    uploadStageInputs: z.boolean(),
    uploadRawBundle: z.boolean(),
  }).strict(),
  stagePolicy: z.object({
    groundTruth: z.boolean().default(true),
    cosmos: z.boolean().default(false),
    postprocess: z.boolean().default(false),
  }).strict().default({ groundTruth: true, cosmos: false, postprocess: false }),
}).strict();
export type SdgRenderOutputPlan = z.infer<typeof SdgRenderOutputPlanSchema>;

export type SdgDirectRenderDraft = {
  outputs: SdgOutput[];
  recorder: {
    startTime: number;
    durationSeconds: number;
    fps: number;
    resolution: {
      width: number;
      height: number;
    };
    timeFactor: number;
    limitDistance: number;
    areaThreshold: number;
    detectCollisions: boolean;
  };
};

export const DEFAULT_SDG_DIRECT_RENDER_DRAFT: SdgDirectRenderDraft = {
  outputs: ["rgb", "videos"],
  recorder: {
    startTime: 0,
    durationSeconds: SCENARIO_TIMING.defaultDurationSeconds,
    fps: SDG_RENDER_FPS,
    resolution: { ...SDG_RENDER_RESOLUTION },
    timeFactor: 1,
    limitDistance: 100,
    areaThreshold: 100,
    detectCollisions: true,
  },
};

export const SdgQualityStateSchema = z.enum(["pass", "warning", "fail"]);
export type SdgQualityState = z.infer<typeof SdgQualityStateSchema>;

export const SdgQualityMetricsSchema = z.object({
  frames_expected: z.number().int().min(0),
  frames_exported: z.number().int().min(0),
  frames_with_actor_samples: z.number().int().min(0),
  frames_missing_actor_samples: z.number().int().min(0),
  frame_alignment_ratio: z.number().min(0).max(1),
  bbox_frames_with_detections: z.number().int().min(0),
  dropped_detections_by_reason: z.record(z.string(), z.number().int().min(0)),
  quality_state: SdgQualityStateSchema.optional(),
});
export type SdgQualityMetrics = z.infer<typeof SdgQualityMetricsSchema>;

export const SdgManifestArtifactSchema = z.object({
  path: z.string().min(1),
  recipe_stage: z.enum(["ground_truth", "cosmos", "postprocess"]).or(z.string().min(1)),
  modality: z.string().min(1),
  role: z.string().min(1),
  artifact_type: z.string().min(1),
  frame_index: z.number().int().min(0).nullable().optional(),
  downstream_use: z.string().min(1),
});
export type SdgManifestArtifact = z.infer<typeof SdgManifestArtifactSchema>;

export const SdgBbox2dVisiblePixelSchema = z
  .array(z.number().int().min(0))
  .length(4);
export type SdgBbox2dVisiblePixel = z.infer<typeof SdgBbox2dVisiblePixelSchema>;

export const SdgBbox3dSchema = z.object({
  coordinate_system: z.string().min(1),
  center: z.record(z.string(), z.number().nullable()),
  size: z.object({
    length: z.number().min(0),
    width: z.number().min(0),
    height: z.number().min(0),
  }),
  orientation: z.record(z.string(), z.union([z.number(), z.string(), z.null()])).optional(),
  projection: z.string().min(1).optional(),
});
export type SdgBbox3d = z.infer<typeof SdgBbox3dSchema>;

export const SdgBboxQualitySchema = z.object({
  source: z.string().min(1),
  visibility_ratio: z.number().min(0).max(1),
  area_px: z.number().int().min(0),
  bbox_area_px: z.number().int().min(1),
  image_size: z.object({
    width: z.number().int().min(1),
    height: z.number().int().min(1),
  }),
  filtering_reason: z.string().nullable().optional(),
});
export type SdgBboxQuality = z.infer<typeof SdgBboxQualitySchema>;

export const SdgOdvgDetectionSchema = z.object({
  "object-id": z.number().int().min(0),
  category: z.string().min(1),
  blueprint_id: z.string().nullable().optional(),
  type_id: z.string().optional(),
  speed_limit_kmh: z.number().nullable().optional(),
  traffic_light_state: z.string().optional(),
  bbox_2d_visible_pixel: SdgBbox2dVisiblePixelSchema.optional(),
  mask: z.array(z.array(z.number().int().min(0))).default([]),
  road_lane_id: z.union([z.string(), z.number(), z.null()]).optional(),
  lane_position: z.union([z.string(), z.number(), z.null()]).optional(),
  vehicle_color: z.string().nullable().optional(),
  bbox_3d_world: SdgBbox3dSchema.optional(),
  bbox_3d_camera: SdgBbox3dSchema.nullable().optional(),
  bbox_3d_projection: z.array(z.array(z.number()).length(4)).nullable().optional(),
  bbox_3d_projection_method: z.string().nullable().optional(),
  bbox_quality: SdgBboxQualitySchema,
});
export type SdgOdvgDetection = z.infer<typeof SdgOdvgDetectionSchema>;

export const SdgOdvgFrameSchema = z.object({
  frame_id: z.string().min(1),
  image_filename: z.string().min(1),
  depth_file_name: z.string().min(1),
  instance_segmentation_file_name: z.string().min(1),
  semantic_segmentation_file_name: z.string().min(1),
  edge_file_name: z.string().min(1),
  timestamp: z.number().min(0),
  width: z.number().int().min(1),
  height: z.number().int().min(1),
  detections: z.object({
    instances: z.array(SdgOdvgDetectionSchema),
  }),
});
export type SdgOdvgFrame = z.infer<typeof SdgOdvgFrameSchema>;

export const SdgManifestSchema = z.object({
  schema_version: z.literal("simforge.sdg.manifest.v1"),
  recipe_id: z.literal("sdg"),
  quality_state: SdgQualityStateSchema,
  quality_metrics: SdgQualityMetricsSchema,
  requested_outputs: z.array(SdgOutputSchema),
  includes: z.string().optional(),
  bbox_filter: z.record(z.string(), z.boolean()).optional(),
  bbox_categories: z.array(z.string()).default([]),
  traffic_light_cycles: z.array(z.record(z.string(), z.unknown())).default([]),
  dynamic_actor_ids: z.array(z.number().int()).nullable().optional(),
  lidar: z.array(z.record(z.string(), z.unknown())).default([]),
  stages: z.record(z.string(), z.union([z.boolean(), z.string()])),
  frame_count: z.number().int().min(0),
  required_cosmos_inputs: z.object({
    video: z.string().nullable(),
    controls: z.record(z.string(), z.string()),
  }),
  artifacts: z.array(SdgManifestArtifactSchema),
});
export type SdgManifest = z.infer<typeof SdgManifestSchema>;

export const DATASET_RECIPES = [
  {
    id: "sdg",
    name: "SDG",
    description:
      "Synthetic data generation recipe with multimodal ground truth, optional augmentation, and ODVG export.",
    stages: { render: true, augment: true, export: true },
    format: "ODVG",
    sensorRigId: SDG_SENSOR_RIG.id,
    outputProfile: "sdg",
    requiredModalities: [...SDG_RAW_OUTPUT_MODALITIES],
    requiredAnnotations: [],
    augmentationMatrix: SDG_AUGMENTATION_MATRIX,
    cosmos: SDG_COSMOS,
    recipeConfig: SDG_RECIPE_CONFIG,
    sourceReference: "simforge.sdg.recipe.v1",
  },
] as const;

export type DatasetRecipe = (typeof DATASET_RECIPES)[number];
export type DatasetRecipeStages = DatasetRecipe["stages"];

export function getDatasetRecipe(id: DatasetRecipeId): DatasetRecipe {
  const recipe = DATASET_RECIPES.find((item) => item.id === id);
  if (!recipe) throw new Error(`Unknown dataset recipe: ${id}`);
  return recipe;
}
