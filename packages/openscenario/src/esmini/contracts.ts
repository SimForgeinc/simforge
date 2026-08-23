/** Browser-safe external execution contracts. No Node.js types belong here. */
import type { EsminiBundleManifest } from '../node/index.js';

export type Sha256Digest = `sha256:${string}`;

export interface EsminiRunnerBundle {
  /** Exact manifest emitted by ../index.js; the runner never rewrites it. */
  readonly manifest: EsminiBundleManifest;
  /** Path-to-opaque-content-handle mapping. Handles are never URLs or paths. */
  readonly contentIds: Readonly<Record<string, string>>;
}

export interface EsminiExecutionOptions {
  readonly fixedTimestepS: 0.02;
  readonly durationS: number;
  readonly record: readonly ('csv' | 'dat' | 'osi' | 'log')[];
  /**
   * Local macOS validation may omit OSI when the pinned esmini OSI writer is
   * known to crash for a map. Full evidence remains the default contract.
   */
  readonly evidenceProfile?: 'full' | 'local-trace-no-osi';
  /** Optional and non-authoritative human evidence. */
  readonly render?: Readonly<{ width: number; height: number; fps: number }>;
}

export interface EsminiExecutionJob {
  readonly schema: 'uniscenarios.esmini-job/v1';
  readonly id: string;
  readonly bundle: EsminiRunnerBundle;
  readonly options: EsminiExecutionOptions;
}

export type ExternalRunStatus = 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled' | 'timed-out' | 'rejected';
export type ExternalRunStage = 'security-validation' | 'materializing-input' | 'executing' | 'collecting-artifacts' | 'complete';

export interface ExternalRunArtifact {
  readonly kind: 'csv' | 'dat' | 'osi' | 'log' | 'frame' | 'video';
  readonly name: string;
  readonly mediaType: string;
  readonly digest: Sha256Digest;
  readonly byteLength: number;
  /** Opaque result-store handle; the UI resolves it through its own API. */
  readonly artifactId: string;
  readonly authoritative: boolean;
}

export interface ExternalRunLog {
  readonly stream: 'stdout' | 'stderr' | 'runner';
  readonly level: 'info' | 'warning' | 'error';
  readonly message: string;
}

export interface ExternalRunnerIdentity {
  readonly name: 'esmini';
  readonly version: '3.6.0';
  readonly sourceRevision: '131a5651737fd1e8bd5d800d8e77e89bb3178a1e';
  readonly digest: Sha256Digest;
  readonly isolation: 'container' | 'developer-local';
}

export interface ExternalRunResult {
  readonly schema: 'uniscenarios.external-run-result/v1';
  readonly jobId: string;
  readonly status: ExternalRunStatus;
  readonly stage: ExternalRunStage;
  readonly cacheKey: Sha256Digest;
  readonly cacheHit: boolean;
  readonly runner: ExternalRunnerIdentity;
  readonly startedAt?: string;
  readonly finishedAt: string;
  readonly durationMs: number;
  readonly exitCode?: number;
  readonly signal?: string;
  readonly artifacts: readonly ExternalRunArtifact[];
  readonly logs: readonly ExternalRunLog[];
  readonly error?: Readonly<{ code: string; message: string }>;
}

export interface ExternalRunSnapshot {
  readonly jobId: string;
  readonly status: ExternalRunStatus;
  readonly stage: ExternalRunStage;
  readonly submittedAt: string;
  readonly updatedAt: string;
  readonly result?: ExternalRunResult;
}

export interface EsminiRunnerLimits {
  readonly maxBundleBytes: number;
  readonly maxFileCount: number;
  readonly timeoutMs: number;
  readonly maxOutputBytes: number;
  readonly memoryMiB: number;
  readonly cpuCount: number;
  readonly maxConcurrentJobs: number;
}
