/**
 * DTOs for the render tab, render details tab, and artifacts tab.
 *
 * Kept in this directory rather than added to `app/lib/uniscenario/contracts.ts` because that file is
 * shared with every other port lane; a render-only type does not need to widen it.
 */

import type { RenderArtifactIdentity, RenderProgressRecord, UniScenarioRendererEngine } from "../render-wire-contracts";
/** Job states the worker control plane advances. Mirrors `uniscenario.render_jobs.job_state`. */
export type UniScenarioRenderJobState =
  | "queued"
  | "leased"
  | "running"
  | "succeeded"
  | "failed"
  | "cancelled";

/** `uniscenario.render_jobs.job_mode`. The last two are postprocess modes from 20260805016000. */
export type UniScenarioRenderJobMode =
  | "interaction_2d"
  | "full_render"
  | "browser_render"
  | "cosmos_augment"
  | "vlm_annotate";

/** A gallery tile. Deliberately narrow: the list must not carry render specs or telemetry blobs. */
export type UniScenarioGalleryItemDto = {
  id: string;
  revisionId: string;
  documentId: string | null;
  jobMode: UniScenarioRenderJobMode;
  jobState: UniScenarioRenderJobState;
  /** 0-100 where the worker reports it, else null. Advanced by the worker; never cached. */
  progressPercent: number | null;
  failureCode: string | null;
  attemptCount: number;
  createdAt: string;
  completedAt: string | null;
  /** Postprocess lineage: set only for `cosmos_augment` / `vlm_annotate`. */
  parentRenderJobId: string | null;
  modelFamily: string | null;
  /**
   * Immutable content digest of the snapshot this render was produced from. Compared against the
   * open draft's digest to mark a tile outdated, which is why it ships on the tile rather than
   * costing one revision fetch per render.
   */
  revisionContentSha256: string | null;
  /** The draft version the render's snapshot was frozen from. */
  revisionSourceDraftVersion: number | null;
  /** Counts by kind, for the tile's badges. */
  artifactCount: number;
  /** The preview artifact id, if one exists. Presigned separately, per request. */
  previewArtifactId: string | null;
  previewMediaType: string | null;
};

export type UniScenarioRenderAttemptDto = {
  id: string;
  attemptNumber: number;
  /** Immutable digest of the exact execution controls issued with this attempt's lease. */
  executionPackageControlSha256: string;
  /** Public correlation status. Mirrors `attemptState` while existing UI callers migrate. */
  status: string;
  attemptState: string;
  workerNodeId: string;
  workerClass: string;
  runtimeVersion: string;
  rendererEngine: UniScenarioRendererEngine | null;
  baseImageDigest: string | null;
  baseImagePlatformDigest: string | null;
  engineCapabilitiesSha256: string | null;
  imageDigest: string;
  leasedAt: string;
  startedAt: string | null;
  completedAt: string | null;
};

export type UniScenarioJobEventDto = {
  eventOrdinal: number;
  eventKind: string;
  attemptId: string | null;
  /** Public details never include the worker-controlled event payload. */
  detail: null;
  createdAt: string;
};

/** One artifact row. `url` is absent by design — see `presignRenderArtifacts`. */
export type UniScenarioRenderArtifactDto = {
  id: string;
  artifactKind: string;
  mediaType: string;
  byteLength: number;
  sha256: string;
  /** `pending` | `available` | `quarantined` | `deleted`. Advanced by the verification worker. */
  artifactState: string;
  relationship: string | null;
  renderAttemptId: string | null;
  identity: RenderArtifactIdentity | null;
  createdAt: string;
  verifiedAt: string | null;
};

/** An artifact paired with a freshly minted, short-lived URL. Never cached, never persisted. */
export type UniScenarioPresignedArtifactDto = UniScenarioRenderArtifactDto & {
  url: string;
  /** Seconds until the signature expires, from the moment this object was built. */
  expiresInSeconds: number;
};

export type UniScenarioRenderJobDetailDto = {
  id: string;
  revisionId: string;
  executionPackageId: string;
  /** Immutable digest shared by every authoritative attempt issued for this job. */
  executionPackageControlSha256: string;
  renderProfileId: string | null;
  jobMode: UniScenarioRenderJobMode;
  jobState: UniScenarioRenderJobState;
  progressPercent: number | null;
  progressDetail: RenderProgressRecord | null;
  rendererEngine: UniScenarioRendererEngine | null;
  intentSha256: string | null;
  priority: number;
  attemptCount: number;
  maxAttempts: number;
  failureCode: string | null;
  failureDetail: string | null;
  billingMode: string;
  estimatedCostCents: number;
  renderSpecSha256: string;
  hiddenAt: string | null;
  hiddenByUserId: string | null;
  parentRenderJobId: string | null;
  sourceArtifactId: string | null;
  modelFamily: string | null;
  modelConfigSha256: string | null;
  createdAt: string;
  updatedAt: string;
  startedAt: string | null;
  completedAt: string | null;
  cancelRequestedAt: string | null;
  attempts: UniScenarioRenderAttemptDto[];
  events: UniScenarioJobEventDto[];
  artifacts: UniScenarioRenderArtifactDto[];
};

export type UniScenarioPostprocessInput = {
  parentRenderJobId: string;
  sourceArtifactId: string;
  jobMode: Extract<UniScenarioRenderJobMode, "cosmos_augment" | "vlm_annotate">;
  modelFamily: string;
  modelConfig: Record<string, unknown>;
  idempotencyKey: string;
  priority?: number;
};

/** Exact compiler evidence for one completed OpenSCENARIO export. */
export type UniScenarioExportInspectionDto = {
  exportId: string;
  revisionId: string;
  executionPackageId: string;
  executionPackageSha256: string;
  compilerVersion: string;
  capabilityProfile: string;
  xoscArtifactId: string;
  xoscSha256: string;
  xsdValidation: {
    valid: boolean;
    standard: string;
    xsdSha256: string;
    diagnostics: string[];
  };
  capability: {
    contract: string;
    profile: string;
    intent: string;
    roundTrip: string;
    externalSimulatorValidation: string;
    summary: Record<string, number>;
    warningCount: number;
    /** Plain compiler-authored losses or approximations bound to this exact package. */
    warnings: Array<{
      code: string;
      path: string;
      reason: string;
    }>;
  };
};
