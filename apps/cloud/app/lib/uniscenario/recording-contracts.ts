import { z } from "zod";
import {
  ResolvedCaptureManifestSchema,
  RenderSpecV2Schema,
  RenderSpecV3Schema,
  type RenderSpecV2,
  type RenderSpecV3,
  type ResolvedCaptureManifest,
} from "@uniscenarios/scenario-model";

export const BROWSER_RECORDING_KIND = "browser_threejs_recording" as const;
export const BROWSER_RECORDING_REQUEST_CONTRACT =
  "uniscenario.browser-threejs-recording-request/v1" as const;
export const BROWSER_RECORDING_RESULT_CONTRACT =
  "uniscenario.browser-threejs-recording-result/v1" as const;

/**
 * The renderer the browser lane records with, named once for both sides of the wire.
 *
 * The recording panel stamps this into every capture manifest and `createBrowserRecording`
 * re-derives it before admitting one, so the two strings have to be the same string. They were not:
 * the panel moved to `/v2` while the server kept requiring `/v1`, and because the fence is one
 * conjunction reported as `recording_revision_document_mismatch`, a browser render answered "this
 * revision belongs to another document" for 36 hours when nothing about the document was wrong.
 * The store's own tests passed throughout — they built their manifests with the same literal the
 * store checked, so both sides were stale together and agreed.
 */
export const BROWSER_RECORDING_ADAPTER_VERSION = "browser-recording-adapter/v2" as const;

export const BrowserRecordingDigestSchema = z
  .string()
  .regex(/^[a-f0-9]{64}$/);

const JsonPrimitiveSchema = z.union([z.string(), z.number().finite(), z.boolean(), z.null()]);
export type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { [key: string]: JsonValue };
export const JsonValueSchema: z.ZodType<JsonValue> = z.lazy(() =>
  z.union([JsonPrimitiveSchema, z.array(JsonValueSchema), z.record(z.string(), JsonValueSchema)]),
);

/** Generic versioned JSON remains useful for bounded progress and result details. */
export const VersionedJsonContractSchema = z
  .record(z.string(), JsonValueSchema)
  .refine(
    (value) =>
      typeof value.schema === "string" &&
      value.schema.trim().length > 0 &&
      value.schema.length <= 200,
    "A versioned contract must contain a non-empty schema field.",
  )
  .refine(
    (value) => JSON.stringify(value).length <= 512 * 1024,
    "Versioned contract exceeds the 512 KiB recording limit.",
  );

const BoundedDetailSchema = z
  .record(z.string(), JsonValueSchema)
  .refine(
    (value) => JSON.stringify(value).length <= 64 * 1024,
    "Recording detail exceeds 64 KiB.",
  );

type PortableSchemaIssue = {
  message: string;
  path?: readonly PropertyKey[];
};

type PortableSchema<T> = {
  safeParse(value: unknown):
    | { success: true; data: T }
    | { success: false; error: { issues: readonly PortableSchemaIssue[] } };
  parse(value: unknown): T;
};

/**
 * The dashboard currently uses Zod 3 while the portable UniScenarios packages
 * use Zod 4. Nesting a Zod-4 schema inside a Zod-3 object crashes because each
 * major has a different parser protocol. Keep the package schema authoritative,
 * but call it through a Zod-3 refinement/transform boundary.
 */
function portableContractSchema<T>(schema: PortableSchema<T>) {
  return z
    .unknown()
    .superRefine((value, context) => {
      const parsed = schema.safeParse(value);
      if (parsed.success) return;
      for (const issue of parsed.error.issues) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: issue.message,
          path: (issue.path ?? []).filter(
            (part): part is string | number =>
              typeof part === "string" || typeof part === "number",
          ),
        });
      }
    })
    .transform((value) => schema.parse(value));
}

// v2 is parsed only as the fallback branch of the union below: a persisted legacy recording spec.
const ResolvedCaptureManifestContractSchema =
  portableContractSchema<ResolvedCaptureManifest>(ResolvedCaptureManifestSchema);
export type BrowserRecordingRenderSpec = RenderSpecV2 | RenderSpecV3;
const BrowserRecordingRenderSpecContractSchema = portableContractSchema<BrowserRecordingRenderSpec>({
  safeParse(value) {
    const v3 = RenderSpecV3Schema.safeParse(value);
    return v3.success ? v3 : RenderSpecV2Schema.safeParse(value);
  },
  parse(value) {
    const v3 = RenderSpecV3Schema.safeParse(value);
    return v3.success ? v3.data : RenderSpecV2Schema.parse(value);
  },
});


export const CreateBrowserRecordingSchema = z.strictObject({
  revisionId: z.string().trim().min(1).max(200),
  documentId: z.string().trim().min(1).max(200),
  renderSpec: BrowserRecordingRenderSpecContractSchema,
  resolvedManifest: ResolvedCaptureManifestContractSchema,
  idempotencyKey: z.string().trim().min(8).max(200),
});

export const BROWSER_RECORDING_ACTIVE_PHASES = [
  "preparing_assets",
  "capturing",
  "encoding",
  "uploading",
] as const;

export const UpdateBrowserRecordingProgressSchema = z.strictObject({
  phase: z.enum(BROWSER_RECORDING_ACTIVE_PHASES),
  progress: z.number().min(0).max(0.999999),
  detail: BoundedDetailSchema.default({}),
});

export const BROWSER_RECORDING_ARTIFACT_ROLES = [
  "video",
  "poster",
  "manifest",
  "frames",
  "sensor_archive",
  "sensor_video",
  "trace",
  "log",
] as const;
export const BrowserRecordingArtifactRoleSchema = z.enum(
  BROWSER_RECORDING_ARTIFACT_ROLES,
);

export const BrowserRecordingSensorIdentitySchema = z.strictObject({
  actorId: z.string().trim().min(1).max(200),
  sensorId: z.string().trim().min(1).max(200),
  modality: z.enum(["rgb", "depth", "semantic", "instance", "lidar", "radar"]),
});
export type BrowserRecordingSensorIdentity = z.infer<
  typeof BrowserRecordingSensorIdentitySchema
>;
const MAX_ARTIFACT_BYTES = 4 * 1024 * 1024 * 1024;
const BrowserRecordingArtifactDeclarationSchema = z.discriminatedUnion("role", [
  z.strictObject({
    role: z.enum(["sensor_archive", "sensor_video"]),
    sensor: BrowserRecordingSensorIdentitySchema,
    mediaType: z.string().trim().min(1).max(200),
    sha256: BrowserRecordingDigestSchema,
    sizeBytes: z.number().int().positive().max(MAX_ARTIFACT_BYTES),
  }),
  z.strictObject({
    role: z.enum(["video", "poster", "manifest", "frames", "trace", "log"]),
    mediaType: z.string().trim().min(1).max(200),
    sha256: BrowserRecordingDigestSchema,
    sizeBytes: z.number().int().positive().max(MAX_ARTIFACT_BYTES),
  }),
]);

function isMediaTypeAllowed(role: BrowserRecordingArtifactRole, mediaType: string) {
  const normalized = mediaType.toLowerCase().split(";", 1)[0]?.trim();
  if (role === "video") return normalized === "video/mp4" || normalized === "video/webm";
  if (role === "poster") {
    return normalized === "image/png" || normalized === "image/jpeg" || normalized === "image/webp";
  }
  if (role === "log") return normalized === "text/plain" || normalized === "application/json";
  if (role === "sensor_archive") return normalized === "application/zip";
  if (role === "sensor_video") return normalized === "video/webm";
  return normalized === "application/json" || normalized === "application/x-ndjson" || normalized === "application/gzip";
}

export const ReserveBrowserRecordingArtifactsSchema = z
  .strictObject({
    artifacts: z.array(BrowserRecordingArtifactDeclarationSchema).min(1).max(132),
  })
  .superRefine((value, context) => {
    const seen = new Set<string>();
    for (const [index, artifact] of value.artifacts.entries()) {
      const identity = artifact.role === "sensor_archive" || artifact.role === "sensor_video"
        ? `${artifact.role}\u0000${artifact.sensor.actorId}\u0000${artifact.sensor.sensorId}\u0000${artifact.sensor.modality}`
        : artifact.role;
      if (seen.has(identity)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["artifacts", index, "role"],
          message: `Duplicate artifact identity: ${artifact.role}`,
        });
      }
      seen.add(identity);
      if (!isMediaTypeAllowed(artifact.role, artifact.mediaType)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["artifacts", index, "mediaType"],
          message: `Unsupported ${artifact.role} media type.`,
        });
      }
    }
  });

export const CompleteBrowserRecordingArtifactSchema = z.discriminatedUnion("role", [
  z.strictObject({
    artifactId: z.string().trim().min(1).max(200),
    role: z.enum(["sensor_archive", "sensor_video"]),
    sensor: BrowserRecordingSensorIdentitySchema,
    sha256: BrowserRecordingDigestSchema,
    sizeBytes: z.number().int().positive().max(MAX_ARTIFACT_BYTES),
  }),
  z.strictObject({
    artifactId: z.string().trim().min(1).max(200),
    role: z.enum(["video", "poster", "manifest", "frames", "trace", "log"]),
    sha256: BrowserRecordingDigestSchema,
    sizeBytes: z.number().int().positive().max(MAX_ARTIFACT_BYTES),
  }),
]);

export const FinalizeBrowserRecordingSchema = z
  .strictObject({
    artifacts: z.array(CompleteBrowserRecordingArtifactSchema).min(1).max(132),
    summary: BoundedDetailSchema.default({}),
  })
  .superRefine((value, context) => {
    const identities = value.artifacts.map((artifact) =>
      artifact.role === "sensor_archive" || artifact.role === "sensor_video"
        ? `${artifact.role}\u0000${artifact.sensor.actorId}\u0000${artifact.sensor.sensorId}\u0000${artifact.sensor.modality}`
        : artifact.role
    );
    if (new Set(identities).size !== identities.length) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["artifacts"],
        message: "Artifact identities must be unique.",
      });
    }
  });

export const CancelBrowserRecordingSchema = z.strictObject({
  reason: z.string().trim().min(1).max(500).default("user_requested"),
});

export const FailBrowserRecordingSchema = z.strictObject({
  code: z.string().trim().min(1).max(100),
  detail: BoundedDetailSchema.default({}),
});

export type BrowserRecordingArtifactRole = z.infer<
  typeof BrowserRecordingArtifactRoleSchema
>;
export type CreateBrowserRecordingInput = z.infer<
  typeof CreateBrowserRecordingSchema
>;
export type UpdateBrowserRecordingProgressInput = z.infer<
  typeof UpdateBrowserRecordingProgressSchema
>;
export type ReserveBrowserRecordingArtifactsInput = z.infer<
  typeof ReserveBrowserRecordingArtifactsSchema
>;
export type FinalizeBrowserRecordingInput = z.infer<
  typeof FinalizeBrowserRecordingSchema
>;

export const BrowserRecordingRequestPayloadSchema = z.strictObject({
  contract: z.literal(BROWSER_RECORDING_REQUEST_CONTRACT),
  revisionId: z.string().trim().min(1).max(200),
  documentId: z.string().trim().min(1).max(200),
  revisionContentSha256: BrowserRecordingDigestSchema,
  idempotencyKey: z.string().trim().min(8).max(200),
  renderSpec: BrowserRecordingRenderSpecContractSchema,
  renderSpecSha256: BrowserRecordingDigestSchema,
  resolvedManifest: ResolvedCaptureManifestContractSchema,
  resolvedManifestSha256: BrowserRecordingDigestSchema,
});

export type BrowserRecordingRequestPayload = z.infer<
  typeof BrowserRecordingRequestPayloadSchema
>;

export type BrowserRecordingArtifactDto = {
  artifactId: string;
  role: BrowserRecordingArtifactRole;
  sensor: BrowserRecordingSensorIdentity | null;
  kind: string;
  mediaType: string;
  sha256: string;
  sizeBytes: number;
  state: "pending" | "available" | "quarantined" | "deleted";
  reused: boolean;
  downloadUrl: string | null;
};

export type BrowserRecordingResultPayload = {
  contract: typeof BROWSER_RECORDING_RESULT_CONTRACT;
  requestPayloadSha256: string;
  artifacts: Array<Omit<BrowserRecordingArtifactDto, "state" | "downloadUrl">>;
  summary: Record<string, JsonValue>;
};

export type BrowserRecordingSummaryDto = {
  id: string;
  family: "artifact_postprocess";
  type: typeof BROWSER_RECORDING_KIND;
  revisionId: string;
  documentId: string;
  status: "running" | "succeeded" | "failed" | "cancelled";
  phase: string;
  progress: number;
  requestPayloadSha256: string;
  cancelRequestedAt: string | null;
  failureCode: string | null;
  failureDetail: Record<string, JsonValue> | null;
  createdAt: string;
  updatedAt: string;
  startedAt: string | null;
  completedAt: string | null;
  expiresAt: string | null;
};

export type BrowserRecordingDetailDto = BrowserRecordingSummaryDto & {
  request: BrowserRecordingRequestPayload;
  progressDetail: Record<string, JsonValue>;
  result: BrowserRecordingResultPayload | null;
  artifacts: BrowserRecordingArtifactDto[];
};

export type BrowserRecordingArtifactReservationDto = {
  artifactId: string;
  role: BrowserRecordingArtifactRole;
  sensor: BrowserRecordingSensorIdentity | null;
  uploadRequired: boolean;
  uploadUrl: string | null;
  headers: Readonly<Record<string, string>>;
};
