import { z } from "zod";
import {
  SCENARIO_TEMPLATE_VERSION,
  ScenarioTemplateV2Schema,
  type RenderSpecV3,
  type ScenarioTemplateV2,
} from "@simforge/scenario";
import {
  UNISCENARIO_NATIVE_PHYSICS_ACCEPTANCE_LIMITS,
  UniScenarioParityEvidenceV1Schema,
  UniScenarioRenderWorkerIdentitySchema,
  type UniScenarioParityEvidenceV1,
  type UniScenarioRenderResourceRequest,
} from "@simcloud/shared";

export const UNISCENARIO_SCHEMA_VERSION = String(SCENARIO_TEMPLATE_VERSION);
export const OPENSCENARIO_NATIVE_PROFILE = "ASAM OpenSCENARIO XML 1.4";
export const UNISCENARIO_RENDER_CONTRACT_VERSION = "2.0.0";
export const EMPTY_AMBIENT_CONFIG_SHA256 = "44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a";
export const EMPTY_AMBIENT_RESULT_SHA256 = "1925590408012373ea3cc6b9d02703527531492efb52aa39689d541a0581f840";
const AmbientDigestSchema = z.string().regex(/^[a-f0-9]{64}$/);
const AmbientConfigSchema = z.record(z.unknown());

export const UniScenarioAmbientProvenanceSchema = z.discriminatedUnion("mode", [
  z.strictObject({
    mode: z.literal("disabled"),
    ambientConfig: z.object({}).strict(),
    configSha256: z.literal(EMPTY_AMBIENT_CONFIG_SHA256),
    /** SHA-256 of the canonical materialized-traffic artifact, including disabled. */
    resultSha256: AmbientDigestSchema,
  }),
  z.strictObject({
    mode: z.literal("native"),
    runtimeVersion: z.string().trim().min(1).max(128),
    seed: z.union([z.string().trim().min(1).max(256), z.number().int()]),
    ambientConfig: AmbientConfigSchema,
    configSha256: AmbientDigestSchema,
    resultSha256: AmbientDigestSchema,
  }),
  z.strictObject({
    mode: z.literal("sumo"),
    sumoVersion: z.string().trim().min(1).max(64),
    networkSha256: AmbientDigestSchema,
    seed: z.union([z.string().trim().min(1).max(256), z.number().int()]),
    ambientConfig: AmbientConfigSchema,
    configSha256: AmbientDigestSchema,
    resultSha256: AmbientDigestSchema,
  }),
]);
export type UniScenarioAmbientProvenance = z.infer<typeof UniScenarioAmbientProvenanceSchema>;
export const UniScenarioMaterializedTrafficReferenceSchema = z.strictObject({
  artifactId: z.string().trim().min(1),
  sha256: AmbientDigestSchema,
  sizeBytes: z.number().int().positive().max(512 * 1024 * 1024),
  sourceInputDigest: AmbientDigestSchema,
  mapAssetId: z.string().trim().min(1),
  mapVersionId: z.string().trim().min(1),
});
export type UniScenarioMaterializedTrafficReference = z.infer<typeof UniScenarioMaterializedTrafficReferenceSchema>;
export const ReserveUniScenarioMaterializedTrafficSchema = UniScenarioMaterializedTrafficReferenceSchema.omit({ artifactId: true }).extend({
  expectedVersion: z.number().int().positive(),
});
export const CompleteUniScenarioMaterializedTrafficSchema = UniScenarioMaterializedTrafficReferenceSchema;
export const DISABLED_AMBIENT_PROVENANCE: UniScenarioAmbientProvenance = {
  mode: "disabled",
  ambientConfig: {},
  configSha256: EMPTY_AMBIENT_CONFIG_SHA256,
  resultSha256: EMPTY_AMBIENT_RESULT_SHA256,
};

export const UNISCENARIO_AUTHORING_QUALITY_IDS = [
  "roads-only",
  "ultra-low-3d",
  "minimal",
  "high",
] as const;
export const UniScenarioAuthoringQualitySchema = z.enum(UNISCENARIO_AUTHORING_QUALITY_IDS);
export type UniScenarioAuthoringQuality = z.infer<typeof UniScenarioAuthoringQualitySchema>;
export const DEFAULT_UNISCENARIO_AUTHORING_QUALITY_ID = "minimal" satisfies UniScenarioAuthoringQuality;

export const UNISCENARIO_AUTHORING_QUALITY_CHOICES = [
  { id: "roads-only", label: "Roads Only", guidance: "CPU/software-rendering mode. Keeps 3D roads, every lane marking, signals and actors; city, vegetation and decorative street furniture are not downloaded.", downloadGuidance: "Measured cold load: 11–14 MB", gpuMemoryGuidance: "Resident estimate: 1–6 MB · 0 GB dedicated GPU required", recommended: false },
  { id: "ultra-low-3d", label: "Low", guidance: "Real navigable 3D roads, buildings and actors with flat unlit colors, no textures, lighting, environment, vegetation or nonessential overlays.", downloadGuidance: "Measured cold load: 18–58 MB", gpuMemoryGuidance: "Resident estimate: 11–47 MB · 1 GB GPU recommended", recommended: false },
  { id: "minimal", label: "Balanced", guidance: "Road and coarse city context only: no vegetation, low resolution, and very restrained streaming.", downloadGuidance: "Measured cold load: 45–534 MB", gpuMemoryGuidance: "Resident estimate: 370–640 MB · 2 GB GPU recommended", recommended: true },
  { id: "high", label: "High", guidance: "Sharper viewport with a larger resident scene.", downloadGuidance: "Measured cold load: 44–816 MB", gpuMemoryGuidance: "Resident estimate: 377–1,601 MB · 4 GB GPU recommended", recommended: false },
] as const satisfies ReadonlyArray<{ id: UniScenarioAuthoringQuality; label: string; guidance: string; downloadGuidance: string; gpuMemoryGuidance: string; recommended: boolean }>;

const CanonicalUniScenarioContentSchema = z
  .custom<ScenarioTemplateV2>((value) => ScenarioTemplateV2Schema.safeParse(value).success, {
    message: "Invalid UniScenario v2 document.",
  })
  .transform((value) => ScenarioTemplateV2Schema.parse(value));

/**
 * A document's description lives at `content.meta.description` and nowhere else.
 *
 * These `description` fields are a convenience on the wire only: the store folds them INTO
 * `canonical_content` before hashing, and reads them back out of the STORED GENERATED projection.
 * There is no `documents.description` column, because a second copy is a dual write that would
 * silently diverge from `content_sha256` and from every exported `.xosc` (§6.1).
 */
const DocumentDescriptionSchema = z.string().trim().max(4000);

export const CreateUniScenarioDocumentSchema = z.object({
  title: z.string().trim().min(1).max(200),
  description: DocumentDescriptionSchema.optional(),
  schemaVersion: z.string().trim().min(1).default(UNISCENARIO_SCHEMA_VERSION),
  content: CanonicalUniScenarioContentSchema,
  mapVersionId: z.string().trim().min(1).nullable().optional(),
  datasetId: z.string().trim().min(1),
  authoringQualityId: UniScenarioAuthoringQualitySchema,
});

export const UpdateUniScenarioDocumentSchema = z.object({
  expectedVersion: z.number().int().positive(),
  title: z.string().trim().min(1).max(200).optional(),
  description: DocumentDescriptionSchema.optional(),
  schemaVersion: z.string().trim().min(1).optional(),
  content: CanonicalUniScenarioContentSchema.optional(),
  mapVersionId: z.string().trim().min(1).nullable().optional(),
  authoringQualityId: UniScenarioAuthoringQualitySchema.optional(),
});

export const ReserveUniScenarioSimulationPreviewSchema = z.strictObject({
  expectedVersion: z.number().int().positive(),
  sha256: AmbientDigestSchema,
  sizeBytes: z.number().int().positive().max(512 * 1024 * 1024),
});
export const CompleteUniScenarioSimulationPreviewSchema = ReserveUniScenarioSimulationPreviewSchema.extend({
  artifactId: z.string().trim().min(1),
});
export type UniScenarioSimulationPreviewDto = {
  artifactId: string; draftVersion: number; sha256: string; sizeBytes: number;
  mediaType: string; downloadUrl: string; createdAt: string;
};

export const CreateUniScenarioDatasetSchema = z.object({
  name: z.string().trim().min(1).max(200),
  description: z.string().trim().max(2000).nullable().optional(),
});

export const UpdateUniScenarioDatasetSchema = z
  .object({
    name: z.string().trim().min(1).max(200).optional(),
    description: z.string().trim().max(2000).nullable().optional(),
  })
  .refine((value) => value.name !== undefined || value.description !== undefined, {
    message: "Provide a name or a description to update.",
  });

export const UNISCENARIO_DATASET_VISIBILITIES = ["workspace", "organization", "public"] as const;
export const UniScenarioDatasetVisibilitySchema = z.enum(UNISCENARIO_DATASET_VISIBILITIES);
export type UniScenarioDatasetVisibility = z.infer<typeof UniScenarioDatasetVisibilitySchema>;

export const UNISCENARIO_RATING_REVIEWED_VIA = ["queue", "browser"] as const;

export const UpsertUniScenarioDocumentRatingSchema = z.object({
  score: z.number().int().min(1).max(5),
  comment: z.string().trim().max(4000).nullable().optional(),
  reviewedVia: z.enum(UNISCENARIO_RATING_REVIEWED_VIA).default("browser"),
  /** Which immutable revision the reviewer actually looked at, when known. */
  revisionId: z.string().trim().min(1).nullable().optional(),
  /** Which render the reviewer actually watched, when known. */
  renderJobId: z.string().trim().min(1).nullable().optional(),
});

export const UniScenarioRatingBatchSchema = z.object({
  documentIds: z.array(z.string().trim().min(1)).min(1).max(200),
});

/**
 * Organizational tag colour.
 *
 * Lowercase six-digit hex, matching the table CHECK exactly. Uppercase is normalized rather than
 * rejected because v1's palette is written `#E8E044` everywhere and a case mismatch is not a thing
 * the operator can see or fix.
 */
export const UniScenarioTagColorSchema = z
  .string()
  .trim()
  .toLowerCase()
  .regex(/^#[0-9a-f]{6}$/, "Expected a six-digit hex colour.");

export const CreateUniScenarioTagSchema = z.object({
  label: z.string().trim().min(1).max(64),
  color: UniScenarioTagColorSchema.nullable().optional(),
});

export const UpdateUniScenarioTagSchema = z
  .object({
    label: z.string().trim().min(1).max(64).optional(),
    color: UniScenarioTagColorSchema.nullable().optional(),
  })
  .refine((value) => value.label !== undefined || value.color !== undefined, {
    message: "Provide a label or a color to update.",
  });

/** A set-replace, not add/remove — see `setUniScenarioDocumentTags`. */
export const SetUniScenarioDocumentTagsSchema = z.object({
  tagIds: z.array(z.string().trim().min(1)).max(64),
});

export const DuplicateUniScenarioDocumentSchema = z.object({
  title: z.string().trim().min(1).max(200).optional(),
  datasetId: z.string().trim().min(1).optional(),
});

export const ListUniScenarioDocumentSummariesSchema = z.object({
  datasetId: z.string().trim().min(1),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  /** Opaque `(updated_at, id)` keyset cursor produced by the previous page. */
  cursor: z.string().trim().min(1).max(200).nullable().optional(),
});

export const CreateUniScenarioDatasetItemSchema = z.object({
  revisionId: z.string().trim().min(1),
  renderJobId: z.string().trim().min(1).nullable().optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
});

export const CreateUniScenarioRevisionSchema = z.object({
  expectedVersion: z.number().int().positive(),
  idempotencyKey: z.string().trim().min(1).max(200).optional(),
  ambient: UniScenarioAmbientProvenanceSchema.default(DISABLED_AMBIENT_PROVENANCE),
  materializedTraffic: UniScenarioMaterializedTrafficReferenceSchema.optional(),
}).superRefine((value, context) => {
  if (!value.materializedTraffic) {
    context.addIssue({ code: "custom", path: ["materializedTraffic"], message: "Complete materialized traffic evidence is required." });
  } else if (value.materializedTraffic.sha256 !== value.ambient.resultSha256) {
    context.addIssue({ code: "custom", path: ["materializedTraffic", "sha256"], message: "Materialized traffic must match the ambient result digest." });
  }
});

export const CreateValidationRunSchema = z.object({
  revisionId: z.string().trim().min(1),
  validatorKind: z.string().trim().min(1).max(100),
  validatorVersion: z.string().trim().min(1).max(100),
  idempotencyKey: z.string().trim().min(1).max(200),
});

export const CreateExportSchema = z.object({
  revisionId: z.string().trim().min(1),
  idempotencyKey: z.string().trim().min(1).max(200),
  ambient: UniScenarioAmbientProvenanceSchema.default(DISABLED_AMBIENT_PROVENANCE),
});

export const UniScenarioRenderSensorKindSchema = z.enum([
  "rgb",
  "depth",
  "semantic",
  "instance",
  "normals",
  "lidar",
  "semantic_lidar",
  "radar",
]);
export type UniScenarioRenderSensorKind = z.infer<
  typeof UniScenarioRenderSensorKindSchema
>;

const RenderSensorTransformSchema = z.strictObject({
  x: z.number(),
  y: z.number(),
  z: z.number(),
  pitch: z.number().min(-Math.PI).max(Math.PI),
  yaw: z.number().min(-Math.PI).max(Math.PI),
  roll: z.number().min(-Math.PI).max(Math.PI),
});

const RenderSensorAttachmentSchema = z.enum([
  "rigid",
  "spring_arm",
  "spring_arm_ghost",
]);

const RenderCameraAttributesSchema = z.strictObject({
  width: z.number().int().min(64).max(8192),
  height: z.number().int().min(64).max(8192),
  fov: z.number().positive().max(Math.PI),
  clipNear: z.number().positive(),
  clipFar: z.number().positive(),
  enablePostprocessEffects: z.boolean(),
}).refine((value) => value.clipFar > value.clipNear, {
  message: "clipFar must be greater than clipNear",
  path: ["clipFar"],
});

const RenderLidarAttributesSchema = z.strictObject({
  channels: z.number().int().min(1).max(256),
  range: z.number().positive().max(1_000),
  pointsPerSecond: z.number().int().positive(),
  rotationFrequency: z.number().positive().max(240),
  upperFov: z.number().min(-Math.PI).max(Math.PI),
  lowerFov: z.number().min(-Math.PI).max(Math.PI),
}).refine((value) => value.upperFov > value.lowerFov, {
  message: "upperFov must be greater than lowerFov",
  path: ["upperFov"],
});

const RenderRadarAttributesSchema = z.strictObject({
  horizontalFov: z.number().positive().max(Math.PI),
  verticalFov: z.number().positive().max(Math.PI),
  range: z.number().positive().max(1_000),
  pointsPerSecond: z.number().int().positive(),
});

const RenderSensorCommonShape = {
  id: z.string().trim().min(1).max(100),
  attachTo: z.string().trim().min(1).max(200),
  transform: RenderSensorTransformSchema,
} as const;

export const UniScenarioRenderSensorSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    ...RenderSensorCommonShape,
    kind: z.enum(["rgb", "depth", "semantic", "instance", "normals"]),
    attachment: RenderSensorAttachmentSchema,
    attributes: RenderCameraAttributesSchema,
  }),
  z.strictObject({
    ...RenderSensorCommonShape,
    kind: z.enum(["lidar", "semantic_lidar"]),
    attachment: z.literal("rigid"),
    attributes: RenderLidarAttributesSchema,
  }),
  z.strictObject({
    ...RenderSensorCommonShape,
    kind: z.literal("radar"),
    attachment: z.literal("rigid"),
    attributes: RenderRadarAttributesSchema,
  }),
]);
export type UniScenarioRenderSensor = z.infer<
  typeof UniScenarioRenderSensorSchema
>;

export const UniScenarioRenderSpecSchema = z.strictObject({
  schema: z.literal("uniscenario.render-spec/v1").default("uniscenario.render-spec/v1"),
  width: z.number().int().min(64).max(8192),
  height: z.number().int().min(64).max(8192),
  fps: z.number().positive().max(240),
  sensors: z.array(UniScenarioRenderSensorSchema).min(1).max(64),
  quality: z.enum(["preview", "standard", "high", "cinematic"]).default("standard"),
  environment: z.object({
    cloudiness: z.number().min(0).max(100).optional(),
    precipitation: z.number().min(0).max(100).optional(),
    deposits: z.number().min(0).max(100).optional(),
    wind: z.number().min(0).max(100).optional(),
    sunAzimuth: z.number().min(0).max(360).optional(),
    sunAltitude: z.number().min(-90).max(90).optional(),
    fogDensity: z.number().min(0).max(100).optional(),
    fogDistance: z.number().nonnegative().optional(),
    wetness: z.number().min(0).max(100).optional(),
  }).default({}),
  outputs: z.array(z.enum(["frames", "video", "trace", "manifest", "annotations"])).min(1),
  formats: z.array(z.enum(["png", "ply", "csv", "mp4-h264", "json", "jsonl"])).min(1).default(["png", "mp4-h264", "json", "jsonl"]),
  executionMode: z.enum(["native-physics", "diagnostic-replay"]).default("native-physics"),
}).superRefine((value, context) => {
  const ids = new Set<string>();
  value.sensors.forEach((sensor, index) => {
    if (ids.has(sensor.id)) {
      context.addIssue({
        code: "custom",
        path: ["sensors", index, "id"],
        message: `Sensor id "${sensor.id}" is duplicated.`,
      });
    }
    ids.add(sensor.id);
  });
  if (value.outputs.includes("frames")) {
    const formats = new Set(value.formats);
    for (const sensor of value.sensors) {
      const expected = sensor.kind === "lidar" || sensor.kind === "semantic_lidar"
        ? "ply"
        : sensor.kind === "radar"
          ? "csv"
          : "png";
      if (!formats.has(expected)) {
        context.addIssue({
          code: "custom",
          path: ["formats"],
          message: `Sensor "${sensor.id}" requires ${expected} frame output.`,
        });
      }
    }
  }
  if (value.outputs.includes("video") && !value.sensors.some((sensor) => sensor.kind === "rgb")) {
    context.addIssue({
      code: "custom",
      path: ["outputs"],
      message: "Video output requires at least one RGB sensor.",
    });
  }
});
export type UniScenarioRenderSpec = z.infer<typeof UniScenarioRenderSpecSchema>;

/**
 * Render job modes a row may carry. Both full_render and browser_render execute the same immutable
 * render intent through the registered GPU lease lane; interaction_2d remains the non-render control
 * mode used by legacy validation flows.
 */
export const UniScenarioJobModeSchema = z.enum(["interaction_2d", "full_render", "browser_render"]);
export type UniScenarioJobMode = z.infer<typeof UniScenarioJobModeSchema>;

export const ParityThresholdsSchema = z.strictObject({
  positionM: z.number().nonnegative().max(UNISCENARIO_NATIVE_PHYSICS_ACCEPTANCE_LIMITS.positionM),
  headingDeg: z.number().nonnegative().max(UNISCENARIO_NATIVE_PHYSICS_ACCEPTANCE_LIMITS.headingDeg),
  speedMps: z.number().nonnegative().max(UNISCENARIO_NATIVE_PHYSICS_ACCEPTANCE_LIMITS.speedMps),
});

export const CreateRenderJobSchema = z.object({
  mode: UniScenarioJobModeSchema.default("full_render"),
  revisionId: z.string().trim().min(1),
  executionPackageId: z.string().trim().min(1),
  originRecordingJobId: z.string().trim().min(1).nullable().optional(),
  renderProfileId: z.string().trim().min(1).nullable().optional(),
  renderSpec: UniScenarioRenderSpecSchema.optional(),
  parityThresholds: ParityThresholdsSchema.optional(),
  idempotencyKey: z.string().trim().min(1).max(200),
  priority: z.number().int().min(-100).max(100).optional(),
}).superRefine((value, context) => {
  if (value.mode === "browser_render") {
    context.addIssue({ code: "custom", path: ["mode"], message: "Browser renders are created through the browser-render request contract." });
  }
  if (value.mode === "full_render" && !value.renderSpec) {
    context.addIssue({ code: "custom", path: ["renderSpec"], message: "Full renders require a render specification." });
  }
  if (value.mode === "interaction_2d" && value.renderSpec?.sensors.length) {
    context.addIssue({ code: "custom", path: ["renderSpec", "sensors"], message: "2D interactions are sensor-free." });
  }
});

export const CreateArtifactReservationSchema = z.object({
  revisionId: z.string().trim().min(1).nullable().optional(),
  artifactKind: z.string().trim().min(1).max(100),
  mediaType: z.string().trim().min(1).max(200),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
  byteLength: z.number().int().nonnegative(),
  metadata: z.record(z.string(), z.unknown()).optional(),
});

export const CompleteArtifactSchema = z.object({
  artifactId: z.string().trim().min(1),
});

export const RegisterWorkerSchema = z.object({
  workerNodeId: z.string().trim().min(1).max(200),
  environment: z.enum(["dev", "staging", "prod"]),
  workerVersion: z.string().trim().min(1).max(200),
  imageDigest: z.string().trim().min(1).max(500),
  capabilities: z.record(z.string(), z.unknown()),
  metadata: z.record(z.string(), z.unknown()).optional(),
});

export const SetRenderWorkerStateSchema = z.strictObject({
  state: z.enum(["active", "draining", "disabled"]),
  reason: z.string().trim().min(3).max(500),
});

export const ProvisionRenderWorkerCredentialSchema = z.strictObject({
  token: z.string().trim().min(32).max(4096),
  reason: z.string().trim().min(3).max(500),
});

export const RevokeRenderWorkerCredentialSchema = z.strictObject({
  reason: z.string().trim().min(3).max(500),
});

export const RenderWorkerIdleHeartbeatSchema = z.strictObject({
  workerNodeId: z.string().trim().min(1).max(200),
  identity: UniScenarioRenderWorkerIdentitySchema,
});

export const LeaseRenderJobSchema = z.object({
  workerNodeId: z.string().trim().min(1).max(200),
  leaseSeconds: z.number().int().min(30).max(180).default(90),
});

export const LeaseHeartbeatSchema = z.object({
  leaseToken: z.string().trim().min(32),
  attempt: z.number().int().positive(),
  progress: z.number().min(0).max(1).optional(),
});

export const BindArtifactUploadSchema = z.object({
  leaseToken: z.string().trim().min(32),
  attempt: z.number().int().positive(),
  kind: z.string().trim().min(1).max(100),
  mediaType: z.string().trim().min(1).max(200),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
  sizeBytes: z.number().int().nonnegative().max(5 * 1024 * 1024 * 1024),
});

export const AppendJobEventSchema = z.object({
  leaseToken: z.string().trim().min(32),
  attempt: z.number().int().positive(),
  sequence: z.number().int().positive(),
  type: z.enum(["accepted", "assets_validated", "plan_compiled", "interaction_started", "render_started", "progress", "artifact_uploaded"]),
  timestamp: z.string().datetime({ offset: true }),
  payload: z.record(z.string(), z.unknown()).optional(),
});

export const CompleteRenderJobSchema = z.object({
  leaseToken: z.string().trim().min(32),
  attempt: z.number().int().positive(),
  result: z.object({
    planSha256: z.string().regex(/^[a-f0-9]{64}$/),
    sourceInputDigest: z.string().regex(/^[a-f0-9]{64}$/),
    attestation: z.record(z.string(), z.unknown()),
    parityEvidence: UniScenarioParityEvidenceV1Schema,
    artifacts: z.array(z.object({
      kind: z.string().trim().min(1).max(100),
      artifactUrl: z.string().trim().min(1).max(1024),
      sha256: z.string().regex(/^[a-f0-9]{64}$/),
      sizeBytes: z.number().int().nonnegative(),
      mediaType: z.string().trim().min(1).max(200),
      metadata: z.record(z.string(), z.unknown()).optional(),
    })).max(100),
  }),
});

export const FailRenderJobSchema = z.object({
  leaseToken: z.string().trim().min(32),
  attempt: z.number().int().positive(),
  error: z.object({
    code: z.string().trim().min(1).max(100),
    message: z.string().trim().min(1).max(2000),
    retryable: z.boolean(),
    details: z.record(z.string(), z.unknown()).optional(),
  }),
});

export type UniScenarioDocumentDto = {
  id: string;
  workspaceId: string;
  title: string;
  draftVersion: number;
  schemaVersion: string;
  /**
   * Server-computed digest of the draft's canonical content, from the same
   * `canonicalContentSha256` a revision is frozen with. The render tab compares it against a
   * render's `revisionContentSha256` to decide whether that render is outdated; the client's own
   * `contentHash` uses a different serializer and MUST NOT be compared against either.
   */
  contentSha256: string;
  content: ScenarioTemplateV2;
  mapVersionId: string | null;
  datasetId: string;
  authoringQualityId: UniScenarioAuthoringQuality;
  createdAt: string;
  updatedAt: string;
  latestRevisionId: string | null;
};

export type UniScenarioDatasetDto = {
  id: string;
  workspaceId: string;
  name: string;
  description: string | null;
  visibility: UniScenarioDatasetVisibility;
  isSystemManaged: boolean;
  systemSlug: string | null;
  isDefault: boolean;
  /** Pinned revision × render-job pairs. Zero until someone pins a revision. */
  itemCount: number;
  /** Live documents in the dataset — the number the list actually wants. */
  documentCount: number;
  renderSubmittedCount: number;
  renderCompletedCount: number;
  exportCompletedCount: number;
  createdByUserName: string | null;
  updatedByUserName: string | null;
  createdAt: string;
  updatedAt: string;
};

export type UniScenarioDatasetReadinessDto = {
  summary: { total: number; rendered: number; cosmosed: number; vlmed: number };
  scenarios: Array<{ id: string; has_render: boolean }>;
};

/**
 * The per-row shape for the document list.
 *
 * Deliberately carries NO `content`. `UniScenarioDocumentDto` ships the whole
 * `ScenarioTemplateV2` and costs a full Zod `parseTemplate()` per row; at 50 rows a page that is
 * fifty schema parses to render a table of titles. Everything here that comes from the template
 * comes from the STORED GENERATED projections added by migration `20260805010000`, so it can never
 * disagree with `content_sha256`.
 *
 * `contentTags` is the template's authored `meta.tags` (hashed content). `tags` is the workspace's
 * organizational catalog (mutable metadata). They are different things — see §6.3.
 */
export type UniScenarioDocumentSummaryDto = {
  id: string;
  workspaceId: string;
  title: string;
  description: string | null;
  datasetId: string;
  datasetSortOrder: number;
  mapVersionId: string | null;
  mapLabel: string | null;
  /** Canonical map-assets identity shared by immutable versions of the same source map. */
  mapSourceMapId?: string | null;
  /** Stable first-party preview route for the exact immutable map version used by this document. */
  mapThumbnailUrl?: string | null;
  latestRevisionId: string | null;
  revisionCount: number;
  archetype: string | null;
  author: string | null;
  contentTags: string[];
  tags: Array<{ id: string; label: string; color: string | null }>;
  roleCount: number;
  /** Whether at least one actor has an authored sensor configuration. */
  hasSensorProfile: boolean;
  propCount: number;
  variantCount: number;
  clipSeconds: number | null;
  negativeControl: boolean;
  derivationKind: "copy" | "variation" | "cross_map_variation" | "import" | null;
  derivedFromDocumentId: string | null;
  hasRender: boolean;
  createdByUserName: string | null;
  updatedByUserName: string | null;
  createdAt: string;
  updatedAt: string;
};

export type UniScenarioDocumentSummaryPageDto = {
  documents: UniScenarioDocumentSummaryDto[];
  nextCursor: string | null;
};

/**
 * A workspace organizational tag.
 *
 * Strictly separate from the template's authored `meta.tags`, which is hashed content and surfaces
 * as `UniScenarioDocumentSummaryDto.contentTags` (§6.3). Nothing here ever reaches
 * `canonical_content`, so renaming or recolouring a tag can never change a document digest.
 */
export type UniScenarioTagDto = {
  id: string;
  workspaceId: string;
  slug: string;
  label: string;
  color: string | null;
  isSystemDefault: boolean;
  /** Live documents carrying this tag, for the filter dropdown's counts. */
  documentCount: number;
};

export type UniScenarioDocumentRatingDto = {
  documentId: string;
  revisionId: string | null;
  renderJobId: string | null;
  raterUserId: string;
  score: number;
  comment: string | null;
  reviewedVia: (typeof UNISCENARIO_RATING_REVIEWED_VIA)[number];
  createdAt: string;
  updatedAt: string;
};

/** Ports v1's `ScenarioRatingAggregate` one-to-one. */
export type UniScenarioRatingAggregateDto = {
  documentId: string;
  ratingCount: number;
  averageScore: number;
  minimumScore: number | null;
  reviewState: "pending" | "accepted" | "rejected";
  viewerScore: number | null;
};

export type UniScenarioRenderJobDto = {
  id: string;
  revisionId: string;
  executionPackageId: string;
  originRecordingJobId: string | null;
  mode: UniScenarioJobMode;
  status: "queued" | "leased" | "running" | "succeeded" | "failed" | "cancelled";
  progress: number;
  billingMode: "free";
  estimatedCost: 0;
  renderSpec: UniScenarioRenderSpec | RenderSpecV3 | null;
  telemetry: { gpuSeconds?: number; wallSeconds?: number; storageBytes?: number; outputBytes?: number };
  parityResult: Record<string, unknown> | null;
  parityEvidence: UniScenarioParityEvidenceV1 | null;
  resourceRequest: UniScenarioRenderResourceRequest | object | null;
  /** Sanitized product signal. Raw node, GPU and host attestation stays attempt-internal. */
  workerAttestation: Record<string, unknown> | null;
  failureCode: string | null;
  failureDetail: unknown;
  createdAt: string;
  updatedAt: string;
};

export type UniScenarioJobProvenanceDto = {
  documentId: string;
  revisionId: string;
  revisionNumber: number;
  sourceRevisionSha256: string;
  /** Canonical concrete simulation input hash bound into the XOSC and CARLA execution evidence. */
  sourceInputDigest: string | null;
  openScenarioProfile: typeof OPENSCENARIO_NATIVE_PROFILE;
  compilerVersion: string;
  validationStatus: string | null;
  xoscArtifactId: string;
  xoscSha256: string;
  executionPackageId: string;
  executionPackageSha256: string;
  mapVersionId: string;
  xodrSha256: string;
  assetCatalogSha256: string | null;
  coordinateSystemId: string;
  coordinateSystemSha256: string;
  ambient: Record<string, unknown>;
  /** @deprecated Read `ambient`; retained for one UI compatibility window. */
  traffic: Record<string, unknown>;
  capabilityWarnings: unknown[];
  artifacts: Array<{
    id: string;
    kind: string;
    sha256: string;
    sizeBytes: number;
    mediaType: string;
    metadata: Record<string, unknown>;
  }>;
  events: Array<{ sequence: number; type: string; occurredAt: string; payload: Record<string, unknown> }>;
};

export type UniScenarioRevisionDto = {
  id: string;
  workspaceId: string;
  documentId: string;
  revisionNumber: number;
  sourceDraftVersion: number;
  schemaVersion: string;
  contentSha256: string;
  mapVersionId: string | null;
  openScenarioProfile: typeof OPENSCENARIO_NATIVE_PROFILE;
  export: {
    id: string;
    format: "openscenario_xml_1_4";
    status: "queued" | "running" | "succeeded" | "failed" | "cancelled";
    artifactId: string | null;
  };
  createdAt: string;
};

export type CreateUniScenarioRevisionResultDto = {
  revisionId: string;
  exportId: string;
  exportStatus: UniScenarioRevisionDto["export"]["status"];
  revision: UniScenarioRevisionDto;
};

export type UniScenarioExportDto = {
  id: string;
  revisionId: string;
  format: "openscenario_xml_1_4";
  status: "queued" | "running" | "succeeded" | "failed" | "cancelled";
  artifactId: string | null;
  executionPackageId: string | null;
  compilerVersion: string;
  errorCode: string | null;
  errorDetail: unknown;
  createdAt: string;
  startedAt: string | null;
  completedAt: string | null;
};

export type UniScenarioArtifactDto = {
  id: string;
  revisionId: string | null;
  kind: string;
  mediaType: string;
  sha256: string;
  sizeBytes: number;
  metadata: Record<string, unknown>;
  downloadUrl: string;
  downloadExpiresAt: string;
  createdAt: string;
};

export type UniScenarioMapDescriptorDto = {
  mapVersionId: string;
  /** FK-backed `map_versions.source_map_asset_id`: full timestamped `public.map_assets.id`, never a logical display slug. */
  sourceMapId: string;
  label: string;
  locality: string | null;
  /** Stable route root for every member of this immutable browser bundle. */
  browserAssetRootUrl: string;
  browserManifestUrl: string;
  /** Identity of the complete published browser member closure. */
  browserClosureSha256: string;
  artifacts: {
    xodrSha256: string;
    topologySha256: string;
    derivedTopologySha256: string;
    locationsSha256: string;
    signalsSha256: string;
    lanePolygonsSha256: string;
  };
  /** Digest of the network bytes referenced by the optional SUMO manifest. */
  sumoNetworkSha256: string | null;
  topologyArtifactUrl: string;
  /** Presigned gzipped derived topology; null when the map version has no available artifact. */
  derivedTopologyUrl: string | null;
  /** Presigned gzipped locations; null when the map version has no available artifact. */
  locationsUrl: string | null;
  /** Presigned SUMO network; null when the map version has no matching available artifact. */
  sumoNetworkUrl: string | null;
  /** Stable first-party route for the independently versioned UniScenario preview artifact. */
  thumbnailUrl: string | null;
  /**
   * Presigned `signals.geojson`, or null when the map version publishes none.
   *
   * The browser needs the FEATURES, not the XODR: `buildSignalOverlay` (and so
   * `buildTrafficLightOrbLayer`, which reads that overlay's `userData.byId`)
   * takes `SignalFeature[]` from this artifact. `map_versions.signals_artifact_id`
   * has always carried it and `compiler-control-store.ts` already reads it; it
   * was simply not exposed to the editor, which is why v2's renderer builds no
   * signal overlay at all today.
   *
   * The editor's *authoring* surface does not use this. Its
   * `EditorSignalControlProjection` is built server-side from the artifact bytes
   * (`signals/projection-store.server.ts`), because the inputs are tens of
   * megabytes and the answer is tens of kilobytes.
   *
   * Presigned per request like the other artifact URLs here, and never cached:
   * `MEDIA_URL_TTL_SECONDS` is 3600 at the IAM role ceiling and no `cacheLife`
   * profile is safe (plan §2.5.3).
   */
  signalsArtifactUrl: string | null;
  xodr: { artifactId: string; sha256: string };
  coordinateSystem: { id: string; sha256: string };
};

export type UniScenarioConflictDto = {
  error: "draft_version_conflict";
  refetch: true;
  currentDraftVersion: number;
  current: UniScenarioDocumentDto;
};
