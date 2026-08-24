import { RenderSpecV3Schema, type RenderSpecV3 } from "@simforge/scenario";
import { z } from "zod";

const Sha256Schema = z.string().regex(/^[a-f0-9]{64}$/);
const PublicIdSchema = z.string().trim().min(1).max(200);
const ArtifactModalitySchema = z.enum(["rgb", "depth", "semantic", "instance", "lidar", "radar"]);
const LocalRenderSpecV3Schema = z.custom<RenderSpecV3>(
  (value) => RenderSpecV3Schema.safeParse(value).success,
  { message: "Invalid render-spec/v3 payload." },
).transform((value) => RenderSpecV3Schema.parse(value));

export const ScenarioRendererEngineSchema = z.enum(["browser", "carla"]);
export type ScenarioRendererEngine = z.infer<typeof ScenarioRendererEngineSchema>;

const ProntoSensorHostSchema = z.strictObject({
  actorId: PublicIdSchema,
  vehicleAsset: z.strictObject({
    catalogAssetId: z.literal("vehicle.kia.carnival"),
    carlaBlueprintId: z.literal("vehicle.kia.carnival"),
    carlaClassPath: z.literal("/Game/Carla/Blueprints/Vehicles/KiaCarnival2025/BP_KiaCarnival2025.BP_KiaCarnival2025_C"),
    make: z.literal("Kia"),
    model: z.literal("Carnival"),
    baseType: z.literal("van"),
    sourceImage: z.strictObject({
      repository: z.literal("ghcr.io/simforgeinc/carla-rfs-munich-belmont"),
      indexSha256: z.literal("f17c639e5f86fd7458fe1d02d3be1d481deeaa714f3cac30e465187d04ec90e5"),
      linuxAmd64ManifestSha256: z.literal("baed0d038437c55efe0abe52a762d352aeb21acdeeff5b11a15f6bd8a648de64"),
    }),
  }),
  sensorRig: z.strictObject({
    rigId: z.literal("pronto.8-camera-6-lidar-4-radar"),
    cameras: z.literal(8),
    lidars: z.literal(6),
    radars: z.literal(4),
  }),
});

const AuthoredSensorHostSchema = z.strictObject({
  actorId: PublicIdSchema,
  vehicleAsset: z.strictObject({ catalogAssetId: PublicIdSchema }),
  sensorRig: z.strictObject({
    rigId: z.literal("authored"),
    cameras: z.number().int().nonnegative().max(1024),
    lidars: z.number().int().nonnegative().max(1024),
    radars: z.number().int().nonnegative().max(1024),
  }),
});

export const ScenarioRenderIntentSchema = z.strictObject({
  schema: z.literal("uniscenario.render-intent/v1"),
  intentId: PublicIdSchema,
  executionPackage: z.strictObject({
    id: PublicIdSchema,
    sourceInputDigest: Sha256Schema,
  }),
  scenarioRevision: z.strictObject({
    revisionId: PublicIdSchema,
    scenarioSha256: Sha256Schema,
    openScenario: z.strictObject({
      sha256: Sha256Schema,
      sizeBytes: z.number().int().nonnegative(),
    }),
    map: z.strictObject({
      mapId: PublicIdSchema,
      revisionId: PublicIdSchema,
      sha256: Sha256Schema,
    }),
  }),
  sensorHost: z.union([ProntoSensorHostSchema, AuthoredSensorHostSchema]),
  renderSpec: LocalRenderSpecV3Schema,
  assets: z.array(z.strictObject({
    assetId: PublicIdSchema,
    kind: z.enum(["map", "catalog", "texture", "mesh", "other"]),
    sha256: Sha256Schema,
    sizeBytes: z.number().int().nonnegative(),
  })).max(10_000),
  seed: z.number().int().nonnegative(),
}).superRefine((intent, context) => {
  const cameraSensors = new Set<string>();
  const lidarSensors = new Set<string>();
  const radarSensors = new Set<string>();
  for (const source of intent.renderSpec.sources) {
    if (source.actorId !== intent.sensorHost.actorId) {
      context.addIssue({
        code: "custom",
        path: ["renderSpec", "sources"],
        message: "Every render source must attach to the declared sensor host.",
      });
    }
    const key = `${source.actorId}\0${source.sensorId}`;
    if (source.modality === "lidar") lidarSensors.add(key);
    else if (source.modality === "radar") radarSensors.add(key);
    else cameraSensors.add(key);
  }
  if (intent.sensorHost.sensorRig.rigId === "authored") {
    const counts = intent.sensorHost.sensorRig;
    if (cameraSensors.size !== counts.cameras
      || lidarSensors.size !== counts.lidars
      || radarSensors.size !== counts.radars) {
      context.addIssue({
        code: "custom",
        path: ["sensorHost", "sensorRig"],
        message: "Authored sensor counts must match the selected physical sensors.",
      });
    }
    return;
  }
  if (cameraSensors.size > 8 || lidarSensors.size > 6 || radarSensors.size > 4) {
    context.addIssue({
      code: "custom",
      path: ["sensorHost", "sensorRig"],
      message: "Selections cannot exceed the declared 8-camera, 6-LiDAR, 4-radar Pronto rig.",
    });
  }
  const invalidImageSource = intent.renderSpec.sources.some((source) =>
    source.modality !== "lidar"
    && source.modality !== "radar"
    && (
      source.attributes.width !== 1280
      || source.attributes.height !== 720
      || source.attributes.fps !== 24
    )
  );
  if (invalidImageSource || (
    intent.renderSpec.video
    && (
      intent.renderSpec.video.width !== 1280
      || intent.renderSpec.video.height !== 720
      || intent.renderSpec.video.fps !== 24
    )
  )) {
    context.addIssue({
      code: "custom",
      path: ["renderSpec"],
      message: "Pronto renders require 1280x720 at 24 fps.",
    });
  }
});
export type ScenarioRenderIntent = z.infer<typeof ScenarioRenderIntentSchema>;

/** UI-to-control-plane adapter. The server materializes and hashes the immutable intent. */
export const SubmitScenarioRenderIntentSchema = z.strictObject({
  schema: z.literal("uniscenario.render-intent-submission/v1"),
  engine: ScenarioRendererEngineSchema,
  revisionId: PublicIdSchema,
  executionPackageId: PublicIdSchema,
  renderSpec: LocalRenderSpecV3Schema,
  idempotencyKey: z.string().trim().min(1).max(200),
  priority: z.number().int().min(-100).max(100).optional(),
});
export type SubmitScenarioRenderIntent = z.infer<typeof SubmitScenarioRenderIntentSchema>;

const UniqueCapabilitiesSchema = z.array(z.enum([
  "openscenario.1_4",
  "timing.fixed_step",
  "environment.authored",
  "artifact.video",
  "artifact.frames",
  "artifact.sensor_archive",
  "artifact.sensor_video",
  "artifact.manifest",
  "artifact.trace",
  "artifact.annotations",
  "map.static_semantics",
  "control.native",
  "divergence.classified",
  "sensor.rgb",
  "sensor.depth",
  "sensor.semantic",
  "sensor.instance",
  "sensor.lidar",
  "sensor.radar",
])).min(1).max(32).refine((items) => new Set(items).size === items.length, "Capabilities must be unique.");

const UniqueModalitiesSchema = z.array(ArtifactModalitySchema)
  .min(1)
  .max(6)
  .refine((items) => new Set(items).size === items.length, "Modalities must be unique.");

export const ScenarioRendererCapabilitySchema = z.strictObject({
  schema: z.literal("uniscenario.render-engine-capabilities/v1"),
  engineId: z.string().min(1).max(128).regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/),
  engineVersion: z.string().min(1).max(128),
  backend: ScenarioRendererEngineSchema,
  protocolVersion: z.literal(1),
  capabilities: UniqueCapabilitiesSchema,
  modalities: UniqueModalitiesSchema,
  limits: z.strictObject({
    maxSimultaneousSensors: z.number().int().min(1).max(1024),
    maxWidth: z.number().int().min(1).max(32768),
    maxHeight: z.number().int().min(1).max(32768),
    maxFramesPerSecond: z.number().int().min(1).max(1000),
  }),
  requiresGpu: z.boolean(),
});
export type ScenarioRendererCapability = z.infer<typeof ScenarioRendererCapabilitySchema>;

const WorkerControlBase = {
  schema: z.literal("uniscenario.render-worker-control/v2"),
} as const;

export const RegisterRenderWorkerV2Schema = z.strictObject({
  ...WorkerControlBase,
  type: z.literal("worker.register"),
  workerId: z.string().min(1).max(128),
  instanceId: z.string().min(1).max(128),
  engine: ScenarioRendererCapabilitySchema,
  labels: z.record(z.string(), z.string()),
});

export const ClaimRenderJobV2Schema = z.strictObject({
  ...WorkerControlBase,
  type: z.literal("job.claim"),
  registrationId: z.string().min(1).max(128),
});

export const RenderArtifactIdentitySchema = z.discriminatedUnion("role", [
  z.strictObject({
    role: z.enum(["video", "frames", "sensorArchive"]),
    actorId: PublicIdSchema,
    sensorId: PublicIdSchema,
    modality: ArtifactModalitySchema,
  }),
  z.strictObject({
    role: z.enum(["manifest", "trace", "annotations", "diagnostics"]),
    actorId: z.null(),
    sensorId: z.null(),
    modality: z.null(),
  }),
]);
export type RenderArtifactIdentity = z.infer<typeof RenderArtifactIdentitySchema>;

const RenderProgressBase = {
  schema: z.literal("uniscenario.render-progress/v1"),
  jobId: z.string().min(1).max(128),
  attempt: z.number().int().min(1).max(1_000_000),
  sequence: z.number().int().nonnegative(),
  timestamp: z.string().datetime({ offset: true }),
} as const;
const RenderStageSchema = z.enum(["downloading", "preparing", "rendering", "encoding", "uploading", "finalizing"]);

export const RenderProgressRecordSchema = z.union([
  z.strictObject({ ...RenderProgressBase, event: z.literal("job.started") }),
  z.strictObject({ ...RenderProgressBase, event: z.literal("stage.started"), stage: RenderStageSchema }),
  z.strictObject({
    ...RenderProgressBase,
    event: z.literal("stage.progress"),
    stage: RenderStageSchema,
    completed: z.number().finite().nonnegative(),
    total: z.number().finite().positive(),
    unit: z.enum(["frames", "bytes", "items", "seconds"]),
  }).refine((record) => record.completed <= record.total, {
    path: ["completed"],
    message: "completed must not exceed total",
  }),
  z.strictObject({
    ...RenderProgressBase,
    event: z.literal("artifact.ready"),
    identity: RenderArtifactIdentitySchema,
    sha256: Sha256Schema,
    sizeBytes: z.number().int().nonnegative(),
    mediaType: z.string().min(1).max(200),
  }),
  z.strictObject({
    ...RenderProgressBase,
    event: z.literal("warning"),
    code: z.string().min(1).max(128),
    message: z.string().min(1).max(2_000),
  }),
  z.strictObject({
    ...RenderProgressBase,
    event: z.literal("job.canceled"),
    reason: z.string().min(1).max(2_000),
  }),
]);
export type RenderProgressRecord = z.infer<typeof RenderProgressRecordSchema>;

export const LeaseHeartbeatV2Schema = z.strictObject({
  ...WorkerControlBase,
  type: z.literal("lease.heartbeat"),
  leaseId: PublicIdSchema,
  fenceToken: z.string().trim().min(32),
  progressSequence: z.number().int().nonnegative(),
});

export const AppendRenderProgressV2Schema = z.strictObject({
  ...WorkerControlBase,
  type: z.literal("lease.progress"),
  leaseId: PublicIdSchema,
  fenceToken: z.string().trim().min(32),
  records: z.array(RenderProgressRecordSchema).min(1).max(1_000),
});

export const ReserveRenderArtifactV2Schema = z.strictObject({
  ...WorkerControlBase,
  type: z.literal("artifact.reserve"),
  leaseId: PublicIdSchema,
  fenceToken: z.string().trim().min(32),
  identity: RenderArtifactIdentitySchema,
  sha256: Sha256Schema,
  sizeBytes: z.number().int().nonnegative(),
  mediaType: z.string().trim().min(1).max(200),
});

const CompletionManifestSchema = z.strictObject({
  artifacts: z.array(z.strictObject({
    artifactId: PublicIdSchema,
    identity: RenderArtifactIdentitySchema,
    sha256: Sha256Schema,
    sizeBytes: z.number().int().nonnegative(),
    mediaType: z.string().trim().min(1).max(200),
  })).min(1).max(4096),
});

export const CompleteRenderJobV2Schema = z.strictObject({
  ...WorkerControlBase,
  type: z.literal("job.complete"),
  leaseId: PublicIdSchema,
  fenceToken: z.string().trim().min(32),
  intentSha256: Sha256Schema,
  manifest: CompletionManifestSchema,
});

export const FailRenderJobV2Schema = z.strictObject({
  ...WorkerControlBase,
  type: z.literal("job.fail"),
  leaseId: PublicIdSchema,
  fenceToken: z.string().trim().min(32),
  intentSha256: Sha256Schema,
  failure: z.strictObject({
    code: z.string().trim().min(1).max(100),
    message: z.string().trim().min(1).max(2_000),
    retryable: z.boolean(),
    details: z.record(z.string(), z.unknown()).optional(),
  }),
});

export const DrainRenderWorkerV2Schema = z.strictObject({
  ...WorkerControlBase,
  type: z.literal("worker.drain"),
  registrationId: PublicIdSchema,
});
