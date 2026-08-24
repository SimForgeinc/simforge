import type {
  RenderArtifactManifest,
  RenderInputFile,
  RenderProgressRecord,
} from "@simforge/render";

export type LocalRenderEngine = "browser" | "native";

export type RemoteInput = {
  readonly inputId: string;
  /** Workspace-relative materialization path; preserves map-manifest relative URL closure. */
  readonly relativePath?: string;
  readonly sha256: string;
  readonly sizeBytes: number;
  readonly download: {
    readonly url: string;
    readonly headers: Readonly<Record<string, string>>;
  };
};

export type CpuJobClaim = {
  readonly contract: "uniscenario.cpu-job-claim/v1";
  readonly jobFamily: "openscenario_render";
  readonly jobId: string;
  readonly attemptId: string;
  readonly fenceToken: string;
  readonly leaseExpiresAt: string;
  readonly payload: {
    readonly mode: "browser_render";
    readonly engine: LocalRenderEngine;
    readonly intent: Record<string, unknown>;
    readonly intentSha256: string;
    readonly inputs: readonly RemoteInput[];
    /** CreateBrowserRecordingSchema payload resolved from the immutable revision before execution. */
    readonly recording: Record<string, unknown>;
  };
};

export type CpuFence = Pick<CpuJobClaim, "jobFamily" | "attemptId" | "fenceToken">;

export type RecordingSensorIdentity = {
  readonly actorId: string;
  readonly sensorId: string;
  readonly modality: "rgb" | "depth" | "semantic" | "instance" | "lidar" | "radar";
};

export type RecordingArtifact =
  | {
    readonly kind: "manifest" | "video";
    readonly sensor?: never;
    readonly path: string;
    readonly mediaType: "application/json" | "video/mp4";
    readonly sha256: string;
    readonly sizeBytes: number;
  }
  | {
    readonly kind: "frames";
    readonly sensor?: never;
    readonly path: string;
    readonly mediaType: "application/x-ndjson";
    readonly sha256: string;
    readonly sizeBytes: number;
  }
  | {
    readonly kind: "sensor_video";
    readonly sensor: RecordingSensorIdentity;
    readonly path: string;
    readonly mediaType: "video/webm";
    readonly sha256: string;
    readonly sizeBytes: number;
  }
  | {
    readonly kind: "sensor_archive";
    readonly sensor: RecordingSensorIdentity;
    readonly path: string;
    readonly mediaType: "application/zip";
    readonly sha256: string;
    readonly sizeBytes: number;
  };

export type RenderExecutionRequest = {
  readonly jobId: string;
  readonly attempt: number;
  readonly engine: LocalRenderEngine;
  readonly intent: Record<string, unknown>;
  readonly intentSha256?: string;
  readonly inputs: ReadonlyMap<string, RenderInputFile>;
  readonly workspace: string;
  readonly signal: AbortSignal;
  readonly reportProgress?: (record: RenderProgressRecord) => Promise<void>;
};

export type RenderExecutionResult = {
  readonly intentSha256: string;
  readonly frameCount: number;
  readonly durationSeconds: number;
  readonly runtimeManifest: RenderArtifactManifest;
  readonly artifacts: readonly RecordingArtifact[];
  /** Wall-clock stage costs for local profiling and progress diagnostics. */
  readonly stageTimingsMs: Readonly<Record<string, number>>;
};
