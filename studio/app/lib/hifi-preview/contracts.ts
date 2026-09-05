/**
 * simforge.hifi-preview/v1 — on-demand single-frame Bevy preview beside the
 * Three viewport.
 *
 * The editor POSTs the CURRENT viewport state: one scene-state.v1 tick
 * document (the render service's live-stream shape), the contract camera
 * report (`CameraStateReport` from simforge.renderer-contract/v1), the tick,
 * and a profile. The `hifi_preview` worker renders exactly one frame through
 * `native-render-service` on source-digest-matched native-ready corpus
 * payloads and completes the request with a PNG artifact URL plus provenance.
 *
 * The request camera is preserved verbatim in provenance. When coverage
 * proves it sees no geometry, the worker retries once with world-bounds
 * framing and records the actual rendered pose separately.
 */
import { z } from "zod";
import type { CameraStateReport } from "@simforge-oss/viewer";
import { RENDERER_CONTRACT_VERSION } from "@simforge-oss/viewer";

export const HIFI_PREVIEW_REQUEST_SCHEMA = "simforge.hifi-preview-request/v1";
export const HIFI_PREVIEW_PROVENANCE_SCHEMA = "simforge.hifi-preview-provenance/v1";
export { RENDERER_CONTRACT_VERSION };

export const HIFI_PREVIEW_PROFILES = ["cinematic", "sensor"] as const;
export type HifiPreviewProfile = (typeof HIFI_PREVIEW_PROFILES)[number];

const finite = () => z.number().finite();
const Vec3Schema = z.tuple([finite(), finite(), finite()]);
const QuatSchema = z.tuple([finite(), finite(), finite(), finite()]);
const Mat4Schema = z.array(finite()).length(16);

export const CameraPoseSchema = z.object({
  position: Vec3Schema,
  target: Vec3Schema,
  up: Vec3Schema.optional(),
});

export const CameraIntrinsicsSchema = z.object({
  fovYDeg: z.number().gt(0).lt(180),
  aspect: z.number().gt(0).finite(),
  near: z.number().gt(0).finite(),
  far: z.number().gt(0).finite(),
});

/** Wire form of the contract `CameraStateReport` (column-major matrices). */
export const CameraStateReportSchema = z.object({
  pose: CameraPoseSchema,
  intrinsics: CameraIntrinsicsSchema,
  viewMatrix: Mat4Schema,
  projectionMatrix: Mat4Schema,
});

/** Wire alias — the schema's inferred shape, named for consumers. */
export type WireCameraStateReport = z.infer<typeof CameraStateReportSchema>;
// Compile pins: the wire schema IS the renderer-contract camera report.
// Either side drifting breaks the studio build.
export const wireCameraReportAsContract = (report: WireCameraStateReport): CameraStateReport => report;
/** Contract report -> wire JSON (readonly tuples copied to plain arrays). */
export const contractCameraReportAsWire = (report: CameraStateReport): WireCameraStateReport => ({
  pose: {
    position: [...report.pose.position] as [number, number, number],
    target: [...report.pose.target] as [number, number, number],
    ...(report.pose.up ? { up: [...report.pose.up] as [number, number, number] } : {}),
  },
  intrinsics: { ...report.intrinsics },
  viewMatrix: [...report.viewMatrix],
  projectionMatrix: [...report.projectionMatrix],
});

/**
 * One actor of the single-tick scene snapshot, in the render service's
 * scene-state.v1 live-stream shape (renderer/service/src/scene.rs).
 */
export const HifiPreviewActorSchema = z.object({
  id: z.string().trim().min(1).max(200),
  kind: z.enum(["spawn", "update", "despawn"]).default("spawn"),
  catalogId: z.string().trim().min(1).max(200),
  actorClass: z.enum(["car", "truck", "bus", "motorcycle", "bicycle", "pedestrian", "prop"]),
  transform: z.object({
    /** Scene y-up metres; y is a ground hint (service snaps via its height field). */
    position: Vec3Schema,
    /** Y-up quaternion [x, y, z, w]. */
    rotation: QuatSchema,
  }),
  velocity: Vec3Schema.default([0, 0, 0]),
});

/** Single-tick scene-state.v1 stream document for the render service. */
export const HifiPreviewSceneSchema = z.object({
  version: z.literal("scene-state.v1"),
  mapId: z.string().trim().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/),
  tick: z.number().int().nonnegative().default(0),
  tickHz: z.number().positive().finite().default(50),
  timeOfDay: z.number().min(0).max(24).optional(),
  groundY: z.number().finite().nullable().default(null),
  actors: z.array(HifiPreviewActorSchema).max(512).default([]),
});

export const CreateHifiPreviewSchema = z.object({
  documentId: z.string().trim().min(1).max(200).nullish(),
  scenarioRevision: z.number().int().nonnegative().nullable().default(null),
  mapVersionId: z.string().trim().min(1).max(200),
  profile: z.enum(HIFI_PREVIEW_PROFILES).default("cinematic"),
  /** Editor timeline tick the snapshot represents (provenance + render tick id). */
  tick: z.number().int().nonnegative().default(0),
  /** Output frame size; the worker renders exactly this backing buffer. */
  width: z.number().int().min(64).max(1920).refine((n) => n % 2 === 0, "width must be even"),
  height: z.number().int().min(64).max(1080).refine((n) => n % 2 === 0, "height must be even"),
  camera: CameraStateReportSchema,
  scene: HifiPreviewSceneSchema,
});
export type CreateHifiPreviewInput = z.infer<typeof CreateHifiPreviewSchema>;

export type HifiPreviewProvenance = {
  schema: typeof HIFI_PREVIEW_PROVENANCE_SCHEMA;
  renderer: "bevy-native";
  rendererProtocol: number;
  contractVersion: typeof RENDERER_CONTRACT_VERSION;
  profile: HifiPreviewProfile;
  tick: number;
  mapVersionId: string;
  mapId: string;
  /** Registry release identity shared across web, semantic and native profiles. */
  mapDigest: string;
  payloadDigests: string[];
  /** Request camera echoed verbatim for contract auditability. */
  camera: z.infer<typeof CameraStateReportSchema>;
  /** Actual Bevy pose, which differs when world-bounds fallback framing ran. */
  renderedCamera: { position: [number, number, number]; target: [number, number, number] };
  /** Fraction of frame pixels with a non-zero instance ID. */
  coverage: number;
  fallbackFraming: boolean;
  worldBounds: {
    min: [number, number, number];
    max: [number, number, number];
  };
  frame: { width: number; height: number; pass: "rgb"; sha256: string; sizeBytes: number };
  map: {
    tileCount: number;
    /** Complete receipt-verified native master closure. */
    payloads: Array<{ path: string; sha256: string; sizeBytes: number }>;
  };
  timings: { prewarmMs: number; renderMs: number; totalMs: number };
  renderedAt: string;
};

export type HifiPreviewStatus = "queued" | "running" | "succeeded" | "failed";

export type HifiPreviewRecord = {
  id: string;
  documentId: string | null;
  mapVersionId: string;
  profile: HifiPreviewProfile;
  tick: number;
  status: HifiPreviewStatus;
  errorCode: string | null;
  errorDetail: Record<string, unknown> | null;
  /** Fetchable PNG URL under the studio cloud root once succeeded. */
  artifactUrl: string | null;
  provenance: HifiPreviewProvenance | null;
  createdAt: string;
  startedAt: string | null;
  completedAt: string | null;
};
