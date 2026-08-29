import { z } from "zod-v3";
import { EnvironmentPresetSchema } from "./environment-preset";
import { ScenarioStatus } from "./run-status";
import { ScenarioLocationSchema } from "./scenario-location";
import { TrafficManagerSchema } from "./traffic-manager";
import {
  normalizeRenderDurationOverrideSeconds,
  SCENARIO_TIMING,
} from "./scenario-timing";

/** Simulation engine identifier. */
export const SimulationEngine = z.enum(["CARLA", "FALCON"]);
export type SimulationEngine = z.infer<typeof SimulationEngine>;

// ---------------------------------------------------------------------------
// Sensor types (SDF-inspired, cross-engine)
// ---------------------------------------------------------------------------

/**
 * Physical sensor category (aligned with SDF sensor type taxonomy).
 * Describes the hardware class of the sensor.
 */
export const SensorCategory = z.enum([
  "camera",
  "lidar",
  "radar",
  "imu",
  "gnss",
  "ultrasonic",
  "event_detector",
]);
export type SensorCategory = z.infer<typeof SensorCategory>;

/**
 * Output modality — what kind of data the sensor produces.
 * Separates the physical sensor from the rendering/output mode.
 */
export const SensorOutputModality = z.enum([
  "rgb",
  "depth",
  "semantic_segmentation",
  "instance_segmentation",
  "normals",
  "point_cloud",
  "semantic_point_cloud",
  "radar_data",
  "velocity_field",
  "imu_data",
  "gnss_fix",
  "collision",
  "lane_invasion",
  "obstacle_detection",
]);
export type SensorOutputModality = z.infer<typeof SensorOutputModality>;

export const RenderOutputProfile = z.enum([
  "playback",
  "training_basic",
  "training_multimodal",
  "raw_multisensor",
  "tao_detection",
  // Internal id and user-facing label are both SDG.
  "sdg",
  "custom",
]);
export type RenderOutputProfile = z.infer<typeof RenderOutputProfile>;

export const RenderOutputAnnotation = z.enum([
  "bbox_2d",
  "bbox_3d",
  "tracking",
  "captions",
  "odvg",
  "objects",
  "instances",
]);
export type RenderOutputAnnotation = z.infer<typeof RenderOutputAnnotation>;

export const RenderOutputMetadata = z.enum([
  "manifest",
  "calibration",
  "timestamps",
  "opendrive",
  "recorder",
]);
export type RenderOutputMetadata = z.infer<typeof RenderOutputMetadata>;

export const RenderOutputEncoding = z.enum([
  "image_sequence",
  "mp4",
]);
export type RenderOutputEncoding = z.infer<typeof RenderOutputEncoding>;

export const SdgRecipeStageConfigSchema = z.object({
  ground_truth: z.boolean().default(true),
  cosmos: z.boolean().default(true),
  postprocess: z.boolean().default(true),
});
export type SdgRecipeStageConfig = z.infer<
  typeof SdgRecipeStageConfigSchema
>;

export const SdgRecorderConfigSchema = z.object({
  rig_id: z.string().default("sdg-default"),
  resolution: z.object({
    width: z.number().int().min(1).max(3840).default(1920),
    height: z.number().int().min(1).max(2160).default(1080),
  }),
  fov: z.number().min(1).max(179).default(90),
  fps: z.number().min(1).max(60).default(30),
  start_time: z.number().min(0).default(0),
  duration_seconds: z.number().min(0).default(SCENARIO_TIMING.defaultDurationSeconds),
  time_factor: z.number().min(0.01).max(10).default(1),
  detect_collisions: z.boolean().default(true),
  collision_actor_ids: z.array(z.number().int()).default([]),
  area_threshold: z.number().min(0).default(100),
  limit_distance: z.number().min(0).default(100),
  class_filter_config: z
    .string()
    .default("config/filter_semantic_classes.yaml"),
  outputs: z
    .array(
      z.enum([
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
      ]),
    )
    .default([
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
    ]),
});
export type SdgRecorderConfig = z.infer<
  typeof SdgRecorderConfigSchema
>;

export const SdgCosmosConfigSchema = z.object({
  enabled: z.boolean().default(true),
  num_augmentations: z.number().int().min(1).max(100).default(1),
  weather_condition: z.array(z.string()).default([
    "clear_sky",
    "overcast",
    "snow_falling",
    "raining",
    "fog",
  ]),
  lighting_condition: z.array(z.string()).default([
    "sunrise",
    "sunset",
    "twilight",
    "mid_morning",
    "afternoon",
    "zenith",
    "golden_hour",
    "blue_hour",
    "night",
  ]),
  road_condition: z.array(z.string()).default([
    "dry",
    "snow",
    "sand",
    "puddles",
    "flooding",
  ]),
  executor_type: z.enum(["gradio", "nim"]).default("gradio"),
  model: z.string().default("nvidia/Cosmos-Transfer2.5-7B"),
  model_version: z.string().default("ct25"),
  modalities: z.array(z.enum(["edge", "depth", "seg"])).default(["edge"]),
  weights: z.record(z.string(), z.number()).default({ edge: 1 }),
  guidance: z.number().min(0).default(3),
  num_steps: z.number().int().min(1).default(35),
  resolution: z.number().int().min(1).default(720),
  max_frames: z.number().int().min(1).default(450),
  sigma: z.number().default(90),
  seed: z.number().int().nullable().default(null),
  positive_prompt: z.string().default(
    "cinematic, photorealistic, ultra high quality, ultra high resolution, high fidelity, high definition, realistic traffic scene with proper physics and coherent motion",
  ),
  negative_prompt: z.string().default(
    "The video captures a game playing, with bad crappy graphics and cartoonish frames. It represents a recording of old outdated games. The lighting looks very fake. The textures are very raw and basic. The geometries are very primitive. The images are very pixelated and of poor CG quality. There are many subtitles in the footage. Overall, the video is unrealistic at all.",
  ),
});
export type SdgCosmosConfig = z.infer<
  typeof SdgCosmosConfigSchema
>;

export const SdgPostprocessConfigSchema = z.object({
  enabled: z.boolean().default(true),
  som_overlays: z.boolean().default(true),
  collision_qa: z.boolean().default(true),
  non_collision_qa: z.boolean().default(true),
  balanced_annotations: z.boolean().default(true),
  yes_ratio: z.number().min(0).max(1).default(0.5),
  area_threshold: z.number().min(0).default(100),
});
export type SdgPostprocessConfig = z.infer<
  typeof SdgPostprocessConfigSchema
>;

export const SdgRecipeConfigSchema = z.object({
  recipe_id: z.literal("sdg"),
  stages: SdgRecipeStageConfigSchema,
  recorder_config: SdgRecorderConfigSchema,
  cosmos_config: SdgCosmosConfigSchema,
  postprocess_config: SdgPostprocessConfigSchema,
});
export type SdgRecipeConfig = z.infer<
  typeof SdgRecipeConfigSchema
>;

export const RenderOutputSpecSchema = z.object({
  version: z.literal(1).default(1),
  profile: RenderOutputProfile.default("playback"),
  modalities: z.array(SensorOutputModality).default([]),
  annotations: z.array(RenderOutputAnnotation).default([]),
  metadata: z.array(RenderOutputMetadata).default([]),
  encodings: z.array(RenderOutputEncoding).default([]),
  recipe: SdgRecipeConfigSchema.optional(),
  /** Capture per-LiDAR `.ply` point clouds. Default true. */
  lidar_capture: z.boolean().optional(),
  /** Render bird's-eye-view MP4 from each LiDAR's PLY frames. Default true when LiDAR present. */
  lidar_bev_mp4: z.boolean().optional(),
  /**
   * When true, upload raw frame data in bundle.tar.gz plus bundle.index.json.
   * When omitted, worker defaults to false and uploads stage-input files only.
   */
  save_artifacts: z.boolean().optional(),
  /**
   * Selectable bbox emission categories for the SDG profile.
   * Controls which actor categories produce entries in objects.json /
   * instances.json / odvg / rgb_bboxed overlays. When omitted the worker
   * defaults to dynamic actors only (matches post-4ee894c3 behavior).
   */
  bbox_categories: z
    .object({
      /** Vehicles + pedestrians moving during the recording (autopilot, AI, motion clip, observed motion). */
      dynamic_actors: z.boolean().default(true),
      /** Map-spawned traffic light housings (semantic class 7) plus per-frame Red/Yellow/Green/Off state. */
      traffic_lights: z.boolean().default(false),
      /** Map-spawned traffic signs (stop, yield, speed limits, etc.) from world.get_actors().filter("traffic.*"). */
      traffic_signs: z.boolean().default(false),
    })
    .optional(),
});
export type RenderOutputSpec = z.infer<typeof RenderOutputSpecSchema>;

export type RenderOutputPresetDefinition = {
  label: string;
  description: string;
  annotations: RenderOutputAnnotation[];
  metadata: RenderOutputMetadata[];
  encodings: RenderOutputEncoding[];
  modalities?: SensorOutputModality[];
};

export type PresetRenderOutputProfile = Exclude<RenderOutputProfile, "custom">;

export const RENDER_OUTPUT_PRESETS = {
  playback: {
    label: "Standard Video",
    description:
      "Encode MP4 videos and a manifest from the configured RGB camera sensors.",
    annotations: [],
    metadata: ["manifest"],
    encodings: ["mp4"],
  },
  training_basic: {
    label: "Training Basic",
    description:
      "Keep raw camera/range outputs with calibration, timestamps, and 2D boxes.",
    annotations: ["bbox_2d"],
    metadata: ["manifest", "calibration", "timestamps"],
    encodings: ["image_sequence"],
  },
  training_multimodal: {
    label: "Training Multimodal",
    description:
      "Capture raw multisensor outputs, calibration, timestamps, map metadata, and derived playback.",
    annotations: ["bbox_2d", "bbox_3d", "tracking"],
    metadata: ["manifest", "calibration", "timestamps", "opendrive"],
    encodings: ["image_sequence", "mp4"],
  },
  raw_multisensor: {
    label: "Raw Multisensor",
    description:
      "Persist only raw sensor sequences and calibration from the configured rig.",
    annotations: [],
    metadata: ["manifest", "calibration", "timestamps"],
    encodings: ["image_sequence"],
  },
  tao_detection: {
    label: "TAO Detection",
    description:
      "Generate RGB image sequences, calibration, and 2D detection annotations for TAO-style training.",
    annotations: ["bbox_2d", "tracking"],
    metadata: ["manifest", "calibration", "timestamps"],
    encodings: ["image_sequence"],
    modalities: ["rgb"],
  },
  sdg: {
    label: "SDG",
    description:
      "SDG recipe output: video, ODVG/object annotations, and map/calibration metadata for ground-truth bundles.",
    annotations: ["odvg", "objects", "instances"],
    metadata: ["manifest", "calibration", "timestamps", "opendrive"],
    encodings: ["image_sequence", "mp4"],
    modalities: [
      "rgb",
      "depth",
      "semantic_segmentation",
      "instance_segmentation",
      "normals",
    ],
  },
} satisfies Record<PresetRenderOutputProfile, RenderOutputPresetDefinition>;

export const DEFAULT_RENDER_OUTPUT_PROFILE = "sdg" as const satisfies PresetRenderOutputProfile;

export function buildRenderOutputPresetSpec(
  profile: PresetRenderOutputProfile = DEFAULT_RENDER_OUTPUT_PROFILE,
): RenderOutputSpec {
  const preset = RENDER_OUTPUT_PRESETS[profile];
  return RenderOutputSpecSchema.parse({
    version: 1,
    profile,
    annotations: [...preset.annotations],
    metadata: [...preset.metadata],
    encodings: [...preset.encodings],
    modalities: [...("modalities" in preset ? preset.modalities : [])],
  });
}

export const DEFAULT_RENDER_OUTPUT_SPEC = buildRenderOutputPresetSpec();

export const DEFAULT_BBOX_CATEGORIES = {
  dynamicActors: true,
  trafficLights: false,
  trafficSigns: false,
  emit2dVisiblePixel: true,
  emit3dCamera: true,
  emit3dWorld: true,
  emit3dProjection: true,
} as const;

export type ScenarioSetupRenderConfig = {
  renderOutputProfile: RenderOutputProfile;
  renderOutputCustomModalities?: SensorOutputModality[];
  renderOutputCustomAnnotations?: RenderOutputAnnotation[];
  renderOutputCustomMetadata?: RenderOutputMetadata[];
  renderOutputCustomEncodings?: RenderOutputEncoding[];
  outputSpec: RenderOutputSpec;
  sdgRenderDraft?: Record<string, unknown>;
  sdgCameraMountIds?: string[];
  environmentPreset?: Record<string, unknown>;
  lidarCapture?: boolean;
  lidarBevMp4?: boolean;
  saveArtifacts?: boolean;
  bboxCategories: {
    dynamicActors: boolean;
    trafficLights: boolean;
    trafficSigns: boolean;
    emit2dVisiblePixel: boolean;
    emit3dCamera: boolean;
    emit3dWorld: boolean;
    emit3dProjection: boolean;
  };
  renderDurationOverrideSeconds?: number | null;
};

function asRenderConfigRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function hasOwnRenderConfigProperty(
  record: Record<string, unknown>,
  key: string,
): boolean {
  return Object.prototype.hasOwnProperty.call(record, key);
}

function asRenderConfigStringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === "string")
    : [];
}

export function parseScenarioSetupRenderConfig(
  value: unknown,
): ScenarioSetupRenderConfig | null {
  const record = asRenderConfigRecord(value);
  const parsedOutputSpec = RenderOutputSpecSchema.safeParse(
    record.outputSpec ?? record.output_spec,
  );
  if (!parsedOutputSpec.success) return null;

  const parsedProfile = RenderOutputProfile.safeParse(record.renderOutputProfile);
  const bbox = asRenderConfigRecord(record.bboxCategories);

  return {
    renderOutputProfile: parsedProfile.success
      ? parsedProfile.data
      : parsedOutputSpec.data.profile,
    renderOutputCustomModalities: asRenderConfigStringArray(
      record.renderOutputCustomModalities,
    ) as SensorOutputModality[],
    renderOutputCustomAnnotations: asRenderConfigStringArray(
      record.renderOutputCustomAnnotations,
    ) as RenderOutputAnnotation[],
    renderOutputCustomMetadata: asRenderConfigStringArray(
      record.renderOutputCustomMetadata,
    ) as RenderOutputMetadata[],
    renderOutputCustomEncodings: asRenderConfigStringArray(
      record.renderOutputCustomEncodings,
    ) as RenderOutputEncoding[],
    outputSpec: parsedOutputSpec.data,
    sdgCameraMountIds: asRenderConfigStringArray(record.sdgCameraMountIds),
    ...(hasOwnRenderConfigProperty(record, "sdgRenderDraft")
      ? { sdgRenderDraft: asRenderConfigRecord(record.sdgRenderDraft) }
      : {}),
    ...(hasOwnRenderConfigProperty(record, "environmentPreset")
      ? { environmentPreset: asRenderConfigRecord(record.environmentPreset) }
      : {}),
    lidarCapture:
      typeof record.lidarCapture === "boolean"
        ? record.lidarCapture
        : parsedOutputSpec.data.lidar_capture,
    lidarBevMp4:
      typeof record.lidarBevMp4 === "boolean"
        ? record.lidarBevMp4
        : parsedOutputSpec.data.lidar_bev_mp4,
    saveArtifacts:
      typeof record.saveArtifacts === "boolean"
        ? record.saveArtifacts
        : parsedOutputSpec.data.save_artifacts,
    bboxCategories: {
      dynamicActors:
        typeof bbox.dynamicActors === "boolean"
          ? bbox.dynamicActors
          : DEFAULT_BBOX_CATEGORIES.dynamicActors,
      trafficLights:
        typeof bbox.trafficLights === "boolean"
          ? bbox.trafficLights
          : DEFAULT_BBOX_CATEGORIES.trafficLights,
      trafficSigns:
        typeof bbox.trafficSigns === "boolean"
          ? bbox.trafficSigns
          : DEFAULT_BBOX_CATEGORIES.trafficSigns,
      emit2dVisiblePixel:
        typeof bbox.emit2dVisiblePixel === "boolean"
          ? bbox.emit2dVisiblePixel
          : DEFAULT_BBOX_CATEGORIES.emit2dVisiblePixel,
      emit3dCamera:
        typeof bbox.emit3dCamera === "boolean"
          ? bbox.emit3dCamera
          : DEFAULT_BBOX_CATEGORIES.emit3dCamera,
      emit3dWorld:
        typeof bbox.emit3dWorld === "boolean"
          ? bbox.emit3dWorld
          : DEFAULT_BBOX_CATEGORIES.emit3dWorld,
      emit3dProjection:
        typeof bbox.emit3dProjection === "boolean"
          ? bbox.emit3dProjection
          : DEFAULT_BBOX_CATEGORIES.emit3dProjection,
    },
    renderDurationOverrideSeconds: hasOwnRenderConfigProperty(
      record,
      "renderDurationOverrideSeconds",
    )
      ? normalizeRenderDurationOverrideSeconds(
          record.renderDurationOverrideSeconds,
        )
      : null,
  };
}

/**
 * Sensor pose: position (x,y,z) and orientation (roll, pitch, yaw).
 * Relative to the entity referenced by `attachTo` (or the world origin).
 * Aligned with the SDF <pose> element.
 */
export const SensorPoseSchema = z.object({
  x: z.number(),
  y: z.number(),
  z: z.number(),
  roll: z.number(),
  pitch: z.number(),
  yaw: z.number(),
});
export type SensorPose = z.infer<typeof SensorPoseSchema>;

/** Sensor attachment type (CARLA-specific camera mount modes). */
export const SensorAttachmentType = z.enum([
  "rigid",
  "spring_arm",
  "spring_arm_ghost",
]);
export type SensorAttachmentType = z.infer<typeof SensorAttachmentType>;

export const SensorMountRole = z.enum([
  "perception",
  "preview",
  "auxiliary",
  "sdg_primary",
  "alpamayo_pai",
]);
export type SensorMountRole = z.infer<typeof SensorMountRole>;

/**
 * Single sensor definition — flat, unified type for all sensor categories.
 *
 * Common fields are always present. Sensor-specific fields (camera resolution,
 * LiDAR channels, radar range, etc.) are optional and only relevant for their
 * respective category. This is the single source of truth used by the editor,
 * runtime provider, and dashboard.
 *
 * World-placed sensors use `attachTo: "world"` with `pose` as world position.
 * Ego-attached sensors use `attachTo: "ego"` with `pose` as offset from vehicle.
 */
export const SensorSchema = z.object({
  id: z.string(),
  label: z.string().default(""),
  sensorCategory: SensorCategory,
  outputModality: SensorOutputModality,
  mountId: z.string().optional(),
  mountLabel: z.string().optional(),
  mountRole: SensorMountRole.optional(),
  supportedOutputModalities: z.array(SensorOutputModality).optional(),
  sourceSensorId: z.string().optional(),
  /** Entity name, "ego", or "world" — what the sensor is attached to. */
  attachTo: z.string().min(1),
  attachmentType: SensorAttachmentType.default("rigid"),
  /** Position + orientation. World coords when attachTo="world", relative offset otherwise. */
  pose: SensorPoseSchema,
  /** Capture frequency in Hz. */
  updateRate: z.number().min(0).max(60).optional(),

  // Camera-specific
  width: z.number().int().min(1).max(3840).optional(),
  height: z.number().int().min(1).max(2160).optional(),
  fov: z.number().min(1).max(179).optional(),
  clipNear: z.number().optional(),
  clipFar: z.number().optional(),
  enablePostprocessEffects: z.boolean().optional(),

  // LiDAR-specific
  channels: z.number().int().min(1).max(128).optional(),
  range: z.number().min(0).max(300).optional(),
  pointsPerSecond: z.number().int().min(100).optional(),
  rotationFrequency: z.number().min(1).max(60).optional(),
  upperFov: z.number().optional(),
  lowerFov: z.number().optional(),

  // Radar-specific
  horizontalFov: z.number().min(1).max(179).optional(),
  verticalFov: z.number().min(1).max(179).optional(),
  radarRange: z.number().min(1).max(300).optional(),

  // Tracking (world-placed sensors that follow a named actor)
  trackingTarget: z.string().optional(),

  /** @deprecated Legacy field. New sensors use flat fields. Kept for dual-read safety during migration. */
  configJson: z.string().optional(),
});
export type Sensor = z.infer<typeof SensorSchema>;

// ---------------------------------------------------------------------------
// Native scenario definition types
// ---------------------------------------------------------------------------

/** Native scenario header metadata. */
export const FileHeaderSchema = z.object({
  revMajor: z.number().int().default(1),
  revMinor: z.number().int().default(2),
  date: z.string(),
  description: z.string(),
  author: z.string().optional(),
});
export type FileHeader = z.infer<typeof FileHeaderSchema>;

/** Typed parameter declaration for scenario variations. */
export const ParameterDeclarationSchema = z.object({
  name: z.string(),
  parameterType: z.string(),
  value: z.string(),
});
export type ParameterDeclaration = z.infer<typeof ParameterDeclarationSchema>;

/** Reference to the road network (OpenDRIVE, scene graph, traffic signals). */
export const RoadNetworkSchema = z.object({
  logicFile: z.string().optional(),
  sceneGraphFile: z.string().optional(),
  trafficSignals: z.string().optional(),
});
export type RoadNetwork = z.infer<typeof RoadNetworkSchema>;

/** World position: x, y, z in metres; h (heading), p (pitch), r (roll) in radians. */
export const WorldPositionSchema = z.object({
  x: z.number(),
  y: z.number(),
  z: z.number().default(0),
  h: z.number().default(0),
  p: z.number().default(0),
  r: z.number().default(0),
});
export type WorldPosition = z.infer<typeof WorldPositionSchema>;

/** Vehicle categories supported by native scenario definitions. */
export const VehicleCategory = z.enum([
  "car",
  "van",
  "truck",
  "bus",
  "motorbike",
  "bicycle",
  "trailer",
  "semitrailer",
  "train",
  "tram",
]);
export type VehicleCategory = z.infer<typeof VehicleCategory>;

/** Pedestrian categories supported by native scenario definitions. */
export const PedestrianCategory = z.enum(["pedestrian", "wheelchair", "animal"]);
export type PedestrianCategory = z.infer<typeof PedestrianCategory>;

/** Bounding box with center and dimensions. */
export const BoundingBoxSchema = z.object({
  center: z.object({ x: z.number(), y: z.number(), z: z.number() }),
  dimensions: z.object({
    width: z.number(),
    length: z.number(),
    height: z.number(),
  }),
});
export type BoundingBox = z.infer<typeof BoundingBoxSchema>;

/** Freeform key-value properties bag. */
const PropertiesSchema = z.record(
  z.string(),
  z.union([z.string(), z.number(), z.boolean()]),
);

/** Vehicle entity declaration. */
export const VehicleEntitySchema = z.object({
  type: z.literal("vehicle"),
  name: z.string(),
  vehicleCategory: VehicleCategory,
  boundingBox: BoundingBoxSchema.optional(),
  properties: PropertiesSchema.optional(),
});
export type VehicleEntity = z.infer<typeof VehicleEntitySchema>;

/** Pedestrian entity declaration. */
export const PedestrianEntitySchema = z.object({
  type: z.literal("pedestrian"),
  name: z.string(),
  pedestrianCategory: PedestrianCategory,
  mass: z.number().optional(),
  boundingBox: BoundingBoxSchema.optional(),
  properties: PropertiesSchema.optional(),
});
export type PedestrianEntity = z.infer<typeof PedestrianEntitySchema>;

/** MiscObject entity declaration. */
export const MiscObjectEntitySchema = z.object({
  type: z.literal("miscObject"),
  name: z.string(),
  miscObjectCategory: z.string(),
  mass: z.number().optional(),
  boundingBox: BoundingBoxSchema.optional(),
  properties: PropertiesSchema.optional(),
});
export type MiscObjectEntity = z.infer<typeof MiscObjectEntitySchema>;

/** Discriminated union of entity object types (Vehicle | Pedestrian | MiscObject). */
export const EntityObjectSchema = z.discriminatedUnion("type", [
  VehicleEntitySchema,
  PedestrianEntitySchema,
  MiscObjectEntitySchema,
]);
export type EntityObject = z.infer<typeof EntityObjectSchema>;

/** ObjectController attached to a ScenarioObject (stores role, control_mode, etc.). */
export const ObjectControllerSchema = z.object({
  name: z.string().optional(),
  properties: PropertiesSchema.optional(),
});
export type ObjectController = z.infer<typeof ObjectControllerSchema>;

/**
 * ScenarioObject: pairs an entity declaration with an optional controller.
 * `name` is the unique entity reference used in storyboard actions.
 */
export const ScenarioObjectSchema = z.object({
  name: z.string(),
  entityObject: EntityObjectSchema,
  objectController: ObjectControllerSchema.optional(),
});
export type ScenarioObject = z.infer<typeof ScenarioObjectSchema>;

// ---------------------------------------------------------------------------
// Storyboard types
// ---------------------------------------------------------------------------

/** Timed lifecycle for entities that spawn/despawn mid-scenario (e.g. humans). */
export const EntityLifecycleSchema = z.object({
  spawnTime: z.number().optional(),
  destroyTime: z.number().optional(),
});
export type EntityLifecycle = z.infer<typeof EntityLifecycleSchema>;

/** Per-entity initialisation action (position, speed, lifecycle). */
export const InitActionSchema = z.object({
  entityRef: z.string(),
  teleportAction: z
    .object({ position: WorldPositionSchema })
    .optional(),
  speedAction: z.object({ value: z.number() }).optional(),
  lifecycle: EntityLifecycleSchema.optional(),
});
export type InitAction = z.infer<typeof InitActionSchema>;

/** Action within a maneuver event. */
export const ManeuverActionSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("acquirePosition"),
    position: WorldPositionSchema,
    speed: z.number(),
  }),
  z.object({
    type: z.literal("stationary"),
    duration: z.number(),
  }),
  z.object({
    type: z.literal("speedAction"),
    value: z.number(),
  }),
]);
export type ManeuverAction = z.infer<typeof ManeuverActionSchema>;

/** Trigger condition (simplified). */
export const TriggerConditionSchema = z.object({
  type: z.enum(["simulationTime", "distance", "custom"]),
  value: z.number().optional(),
  params: PropertiesSchema.optional(),
});
export type TriggerCondition = z.infer<typeof TriggerConditionSchema>;

/** Trigger: array of condition groups (OR of ANDs). */
export const TriggerSchema = z.object({
  conditionGroups: z.array(z.array(TriggerConditionSchema)),
});
export type Trigger = z.infer<typeof TriggerSchema>;

/** Event: named set of actions with an optional start trigger. */
export const EventSchema = z.object({
  name: z.string(),
  actions: z.array(ManeuverActionSchema),
  startTrigger: TriggerSchema.optional(),
});
export type Event = z.infer<typeof EventSchema>;

/** Maneuver: named sequence of events. */
export const ManeuverSchema = z.object({
  name: z.string(),
  events: z.array(EventSchema),
});
export type Maneuver = z.infer<typeof ManeuverSchema>;

/** ManeuverGroup: binds actors to maneuvers. */
export const ManeuverGroupSchema = z.object({
  name: z.string(),
  actorRefs: z.array(z.string()),
  maneuvers: z.array(ManeuverSchema),
});
export type ManeuverGroup = z.infer<typeof ManeuverGroupSchema>;

/** Act: container for maneuver groups with optional start/stop triggers. */
export const ActSchema = z.object({
  name: z.string(),
  maneuverGroups: z.array(ManeuverGroupSchema),
  startTrigger: TriggerSchema.optional(),
  stopTrigger: TriggerSchema.optional(),
});
export type Act = z.infer<typeof ActSchema>;

/** Story: named collection of acts. */
export const StorySchema = z.object({
  name: z.string(),
  acts: z.array(ActSchema),
});
export type Story = z.infer<typeof StorySchema>;

/** Storyboard: init actions + stories + optional stop trigger. */
export const StoryboardSchema = z.object({
  init: z.object({ actions: z.array(InitActionSchema) }),
  stories: z.array(StorySchema).default([]),
  stopTrigger: TriggerConditionSchema.optional(),
});
export type Storyboard = z.infer<typeof StoryboardSchema>;

// ---------------------------------------------------------------------------
// ScenarioDefinition
// ---------------------------------------------------------------------------

/** Native scenario definition; SimForge metadata lives on Scenario. */
export const ScenarioDefinitionSchema = z.object({
  fileHeader: FileHeaderSchema.optional(),
  parameterDeclarations: z.array(ParameterDeclarationSchema).default([]),
  roadNetwork: RoadNetworkSchema.optional(),
  entities: z.array(ScenarioObjectSchema),
  storyboard: StoryboardSchema,
});
export type ScenarioDefinition = z.infer<typeof ScenarioDefinitionSchema>;

// ---------------------------------------------------------------------------
// Helpers for querying entities
// ---------------------------------------------------------------------------

export function isEgoEntity(entity: ScenarioObject): boolean {
  return entity.objectController?.properties?.role === "ego";
}

export function getEntityCategory(
  entity: ScenarioObject,
): "vehicle" | "pedestrian" | "miscObject" {
  return entity.entityObject.type;
}

export function blueprintToVehicleCategory(blueprint: string): VehicleCategory {
  const b = blueprint.toLowerCase();
  if (b.includes("bicycle") || b.includes("crossbike")) return "bicycle";
  if (
    b.includes("motorcycle") ||
    b.includes("harley") ||
    b.includes("kawasaki") ||
    b.includes("yamaha")
  )
    return "motorbike";
  if (b.includes("truck") || b.includes("firetruck")) return "truck";
  if (b.includes("bus")) return "bus";
  if (b.includes("van") || b.includes("ambulance") || b.includes("sprinter"))
    return "van";
  return "car";
}

// ---------------------------------------------------------------------------
// Output & Artifact types (unchanged)
// ---------------------------------------------------------------------------

export const GeneratedBy = z.enum([
  "Scenario Generator Tool",
  "CARLA Simulator",
  "COSMOS Transfer",
  "COSMOS Reasoning",
]);
export type GeneratedBy = z.infer<typeof GeneratedBy>;

export const OutputType = z.enum([
  "MP4",
  "ROSBAG",
  "LOG",
  "POST_PROCESSING_ARTIFACT",
  "SCENARIO_CONFIG",
  "COSMOS_REASONING",
]);
export type OutputType = z.infer<typeof OutputType>;

export const OutputConfigSchema = z.array(OutputType);
export type OutputConfig = z.infer<typeof OutputConfigSchema>;

export const DEFAULT_OUTPUT_CONFIG: OutputConfig = ["MP4"];

export const SimulationArtifactSchema = z.object({
  id: z.string(),
  simulationId: z.string(),
  type: OutputType,
  uri: z.string(),
  sizeBytes: z.number(),
  createdAt: z.string(),
  isAvailable: z.boolean(),
  sensorId: z.string().optional(),
  environmentPresetRef: z.array(z.string()).default([]),
  generatedBy: GeneratedBy.optional(),
  sourceArtifactId: z.string().optional(),
  metadata: z.string().optional(),
});
export type SimulationArtifact = z.infer<typeof SimulationArtifactSchema>;

// ---------------------------------------------------------------------------
// Scenario (top-level record — the parent entity designed in the editor)
// ---------------------------------------------------------------------------

export const ScenarioSchema = z.object({
  id: z.string(),
  /** Human-readable name (promoted from the former scenarioDefinition.displayName). */
  displayName: z.string(),
  /** Natural-language description of the scenario intent. */
  intentDescription: z.string().default(""),
  location: ScenarioLocationSchema.default({
    scenario_location_id: "",
    map_asset_id: "",
    display_name: "Unknown",
    intent: "",
    region: { type: "BBOX", bbox: { min_lat: 0, min_lng: 0, max_lat: 0, max_lng: 0 } },
    created_at: "",
    updated_at: "",
  }),
  engine: SimulationEngine.default("CARLA"),
  status: ScenarioStatus,
  createdAt: z.string(),
  sensors: z.array(SensorSchema).default([]),
  environmentPresets: z.array(EnvironmentPresetSchema).default([]),
  /**
   * When true, outputs are auto-created for default environment variations.
   * Promoted from the former scenarioDefinition.useDefaultEnvironmentVariations.
   */
  useDefaultEnvironmentVariations: z.boolean().optional(),
  trafficManager: TrafficManagerSchema.default({
    intent: undefined,
    engine: "CARLA_TRAFFIC",
  }),
  /** Native scenario definition. */
  scenarioDefinition: ScenarioDefinitionSchema.default({
    parameterDeclarations: [],
    entities: [],
    storyboard: { init: { actions: [] }, stories: [] },
  }),
  outputConfig: OutputConfigSchema.default(DEFAULT_OUTPUT_CONFIG),
  artifacts: z.array(SimulationArtifactSchema).default([]),
});
export type Scenario = z.infer<typeof ScenarioSchema>;
