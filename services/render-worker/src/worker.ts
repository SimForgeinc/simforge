import { mkdir, rm } from 'node:fs/promises';
import { resolve } from 'node:path';

import {
  ArtifactIdentitySchema,
  RENDER_WORKER_CONTROL_V2_SCHEMA,
  RenderArtifactManifestSchema,
  RenderCanceledError,
  RenderProgressRecordSchema,
  UnsupportedRenderIntentError,
  abortableDelay,
  assertEngineSupportsIntent,
  createFixedSchedules,
  hashFile,
  hashRenderIntent,
  loadBuiltinRenderEngine,
  loadRenderEngine,
  type CompletedArtifact,
  type JobLeasedResponse,
  type RenderEngineAdapter,
  type RenderProgressRecord,
} from '@simforge-oss/render';

import type { RenderWorkerConfig } from './config.js';
import { acquireGpuJobLock, type GpuJobLock } from './gpu-lock.js';
import type { WorkerHealth } from './health.js';
import { withBoundedRetry } from './retry.js';
import { downloadInputs, uploadFile } from './transfers.js';
import type { RenderControlTransport } from './transport.js';

interface ActiveJobState {
  progressSequence: number;
  readonly controller: AbortController;
  readonly heartbeatController: AbortController;
  heartbeatError?: unknown;
}

function failureOf(error: unknown): { code: string; message: string; retryable: boolean } {
  const message = error instanceof Error ? error.message : String(error);
  if (error instanceof RenderCanceledError) return { code: 'render.canceled', message, retryable: false };
  if (error instanceof UnsupportedRenderIntentError) return { code: error.code, message, retryable: false };
  if (/integrity mismatch|intent hash mismatch|invalid/i.test(message)) return { code: 'render.invalid_input', message, retryable: false };
  return { code: 'render.execution_failed', message, retryable: true };
}

async function loadConfiguredEngine(config: RenderWorkerConfig): Promise<RenderEngineAdapter> {
  if ('id' in config.engine) return loadBuiltinRenderEngine(config.engine.id, config.engine.options);
  return loadRenderEngine(config.engine.module, config.engine.options);
}

async function runHeartbeat(
  transport: RenderControlTransport,
  job: JobLeasedResponse,
  state: ActiveJobState,
  intervalMs: number,
  retryConfig: RenderWorkerConfig['retries'],
): Promise<void> {
  const heartbeatSignal = AbortSignal.any([state.controller.signal, state.heartbeatController.signal]);
  while (!heartbeatSignal.aborted) {
    try {
      await abortableDelay(intervalMs, heartbeatSignal);
    } catch (error) {
      if (heartbeatSignal.aborted) return;
      throw error;
    }
    if (heartbeatSignal.aborted) return;
    try {
      const ack = await withBoundedRetry('lease heartbeat', retryConfig, heartbeatSignal, () => transport.heartbeat({
        schema: RENDER_WORKER_CONTROL_V2_SCHEMA,
        type: 'lease.heartbeat',
        leaseId: job.lease.leaseId,
        fenceToken: job.lease.fenceToken,
        progressSequence: state.progressSequence === 0 ? 0 : state.progressSequence - 1,
      }, heartbeatSignal));
      if (ack.cancelRequested) {
        state.controller.abort(new RenderCanceledError(ack.cancelReason ?? 'control plane requested cancellation'));
      }
    } catch (error) {
      if (state.heartbeatController.signal.aborted || state.controller.signal.aborted) return;
      state.heartbeatError = error;
      state.controller.abort(new Error('lease heartbeat failed', { cause: error }));
    }
  }
}

async function executeClaim(
  config: RenderWorkerConfig,
  transport: RenderControlTransport,
  engine: RenderEngineAdapter,
  job: JobLeasedResponse,
  heartbeatIntervalMs: number,
): Promise<void> {

  const workspace = resolve(config.scratchDir, `${job.jobId}-${job.attempt}`);
  const state: ActiveJobState = {
    progressSequence: 0,
    controller: new AbortController(),
    heartbeatController: new AbortController(),
  };
  const heartbeat = runHeartbeat(transport, job, state, heartbeatIntervalMs, config.retries);
  let gpuLock: GpuJobLock | undefined;

  const forward = async (candidate: RenderProgressRecord): Promise<void> => {
    const record = RenderProgressRecordSchema.parse({
      ...candidate,
      jobId: job.jobId,
      attempt: job.attempt,
      sequence: state.progressSequence,
      timestamp: new Date().toISOString(),
    });
    const ack = await withBoundedRetry('progress forwarding', config.retries, state.controller.signal, () => transport.progress({
      schema: RENDER_WORKER_CONTROL_V2_SCHEMA,
      type: 'lease.progress',
      leaseId: job.lease.leaseId,
      fenceToken: job.lease.fenceToken,
      records: [record],
    }, state.controller.signal));
    if (ack.acceptedThroughSequence < record.sequence) throw new Error('control plane did not accept forwarded progress sequence');
    state.progressSequence += 1;
  };

  try {
    const actualIntentSha256 = hashRenderIntent(job.intent);
    if (actualIntentSha256 !== job.intentSha256) {
      throw new Error(`intent hash mismatch: claim=${job.intentSha256} computed=${actualIntentSha256}`);
    }
    assertEngineSupportsIntent(engine.capabilities, job.intent);
    const expectedInputs = new Map<string, { sha256: string; sizeBytes: number }>([
      ['scenario.xosc', job.intent.scenarioRevision.openScenario],
      ...job.intent.assets.map((asset) => [asset.assetId, asset] as const),
    ]);
    const claimedInputIds = new Set<string>();
    for (const input of job.inputs) {
      if (claimedInputIds.has(input.inputId)) throw new Error(`invalid duplicate claimed input ${input.inputId}`);
      claimedInputIds.add(input.inputId);
      const expected = expectedInputs.get(input.inputId);
      if (!expected) throw new Error(`invalid unreferenced claimed input ${input.inputId}`);
      if (expected.sha256 !== input.sha256 || expected.sizeBytes !== input.sizeBytes) {
        throw new Error(`invalid claimed input metadata for ${input.inputId}`);
      }
    }
    for (const inputId of expectedInputs.keys()) {
      if (!claimedInputIds.has(inputId)) throw new Error(`invalid missing claimed input ${inputId}`);
    }
    await rm(workspace, { recursive: true, force: true });
    await mkdir(workspace, { recursive: true, mode: 0o700 });
    await forward({ schema: 'uniscenario.render-progress/v1', event: 'job.started', jobId: job.jobId, attempt: job.attempt, sequence: 0, timestamp: new Date().toISOString() });
    const inputs = await withBoundedRetry('input download', config.retries, state.controller.signal, () => downloadInputs(
      job.inputs,
      workspace,
      config.cacheDir,
      state.controller.signal,
    ));
    if (engine.capabilities.requiresGpu) gpuLock = await acquireGpuJobLock(config.gpuLockPath, job.jobId);
    const manifest = RenderArtifactManifestSchema.parse(await engine.execute({
      jobId: job.jobId,
      attempt: job.attempt,
      intent: job.intent,
      intentSha256: job.intentSha256,
      schedules: createFixedSchedules(job.intent),
      inputs,
      workspace,
      signal: state.controller.signal,
      reportProgress: forward,
    }));
    if (manifest.intentSha256 !== job.intentSha256) throw new Error('engine manifest intentSha256 does not match claimed intent');

    // Hash + reserve + upload artifacts through a small worker pool: large
    // sensor archives and videos otherwise serialize behind one another. The
    // completion manifest preserves engine artifact order by index.
    const completed: CompletedArtifact[] = new Array<CompletedArtifact>(manifest.artifacts.length);
    let nextArtifactIndex = 0;
    const uploadOne = async (): Promise<void> => {
      while (true) {
        const index = nextArtifactIndex;
        nextArtifactIndex += 1;
        if (index >= manifest.artifacts.length) return;
        const artifact = manifest.artifacts[index]!;
        const absolutePath = resolve(workspace, artifact.relativePath);
        if (absolutePath !== workspace && !absolutePath.startsWith(`${workspace}/`)) throw new Error(`artifact escapes workspace: ${artifact.relativePath}`);
        const digest = await hashFile(absolutePath);
        if (digest.sha256 !== artifact.sha256 || digest.sizeBytes !== artifact.sizeBytes) {
          throw new Error(`artifact integrity mismatch for ${artifact.relativePath}`);
        }
        const reservation = await withBoundedRetry('artifact reservation', config.retries, state.controller.signal, () => transport.reserveArtifact({
          schema: RENDER_WORKER_CONTROL_V2_SCHEMA,
          type: 'artifact.reserve',
          leaseId: job.lease.leaseId,
          fenceToken: job.lease.fenceToken,
          identity: ArtifactIdentitySchema.parse(artifact.identity),
          sha256: artifact.sha256,
          sizeBytes: artifact.sizeBytes,
          mediaType: artifact.mediaType,
        }, state.controller.signal));
        await withBoundedRetry('artifact upload', config.retries, state.controller.signal, () => uploadFile(
          reservation.upload.url,
          reservation.upload.headers,
          absolutePath,
          state.controller.signal,
        ));
        completed[index] = {
          artifactId: reservation.artifactId,
          identity: artifact.identity,
          sha256: artifact.sha256,
          sizeBytes: artifact.sizeBytes,
          mediaType: artifact.mediaType,
        };
      }
    };
    await Promise.all(Array.from(
      { length: Math.max(1, Math.min(config.uploadConcurrency, manifest.artifacts.length)) },
      uploadOne,
    ));
    if (completed.length === 0) throw new Error('engine produced no artifacts');
    state.heartbeatController.abort(new Error('render complete; stop heartbeats before fencing completion'));
    await heartbeat;
    if (state.heartbeatError) throw state.heartbeatError;
    await withBoundedRetry('fenced completion', config.retries, state.controller.signal, () => transport.complete({
      schema: RENDER_WORKER_CONTROL_V2_SCHEMA,
      type: 'job.complete',
      leaseId: job.lease.leaseId,
      fenceToken: job.lease.fenceToken,
      intentSha256: job.intentSha256,
      manifest: { artifacts: completed },
    }, state.controller.signal));
  } catch (error) {
    state.heartbeatController.abort(new Error('render failed; stop heartbeats before fenced failure'));
    await heartbeat.catch(() => undefined);
    const effectiveError = state.heartbeatError
      ?? (state.controller.signal.aborted ? state.controller.signal.reason : error);
    const failure = failureOf(effectiveError);
    const reportingSignal = AbortSignal.timeout(30_000);
    if (failure.code === 'render.canceled') {
      const canceled = RenderProgressRecordSchema.parse({
        schema: 'uniscenario.render-progress/v1',
        event: 'job.canceled',
        jobId: job.jobId,
        attempt: job.attempt,
        sequence: state.progressSequence,
        timestamp: new Date().toISOString(),
        reason: failure.message,
      });
      await withBoundedRetry('cancellation progress', config.retries, reportingSignal, () => transport.progress({
        schema: RENDER_WORKER_CONTROL_V2_SCHEMA,
        type: 'lease.progress',
        leaseId: job.lease.leaseId,
        fenceToken: job.lease.fenceToken,
        records: [canceled],
      }, reportingSignal)).catch(() => undefined);
    }
    try {
      await withBoundedRetry('fenced failure', config.retries, reportingSignal, () => transport.fail({
        schema: RENDER_WORKER_CONTROL_V2_SCHEMA,
        type: 'job.fail',
        leaseId: job.lease.leaseId,
        fenceToken: job.lease.fenceToken,
        intentSha256: job.intentSha256,
        failure,
      }, reportingSignal));
    } catch (reportError) {
      throw new AggregateError([effectiveError, reportError], 'render failed and fenced failure reporting also failed');
    }
  } finally {
    state.heartbeatController.abort(new Error('job finalized'));
    state.controller.abort(new RenderCanceledError('job finalized'));
    await heartbeat.catch(() => undefined);
    await gpuLock?.release();
  }
}

export async function runRenderWorker(
  config: RenderWorkerConfig,
  transport: RenderControlTransport,
  health: WorkerHealth,
  drainSignal: AbortSignal,
): Promise<void> {
  await mkdir(config.scratchDir, { recursive: true });
  await mkdir(config.cacheDir, { recursive: true });
  const engine = await loadConfiguredEngine(config);
  const operationSignal = new AbortController().signal;
  const registration = await withBoundedRetry('worker registration', config.retries, operationSignal, () => transport.register({
    schema: RENDER_WORKER_CONTROL_V2_SCHEMA,
    type: 'worker.register',
    workerId: config.workerId,
    instanceId: config.instanceId,
    engine: engine.capabilities,
    labels: config.labels,
  }, operationSignal));
  health.set('ready');
  const markDraining = (): void => health.set('draining');
  drainSignal.addEventListener('abort', markDraining, { once: true });

  try {
    while (!drainSignal.aborted) {
      const claim = await withBoundedRetry('job claim', config.retries, drainSignal, () => transport.claim({
        schema: RENDER_WORKER_CONTROL_V2_SCHEMA,
        type: 'job.claim',
        registrationId: registration.registrationId,
      }, drainSignal));
      if (claim.type === 'job.none') {
        await new Promise<void>((resolveDelay) => {
          const finish = (): void => {
            drainSignal.removeEventListener('abort', abort);
            resolveDelay();
          };
          const timer = setTimeout(finish, claim.retryAfterMs);
          const abort = (): void => {
            clearTimeout(timer);
            resolveDelay();
          };
          timer.unref();
          drainSignal.addEventListener('abort', abort, { once: true });
        });
        continue;
      }
      health.set('busy', claim.jobId);
      await executeClaim(config, transport, engine, claim, registration.heartbeatIntervalMs);
      if (!drainSignal.aborted) health.set('ready');
    }
  } finally {
    health.set('draining');
    drainSignal.removeEventListener('abort', markDraining);
    const drainRequestSignal = AbortSignal.timeout(30_000);
    await withBoundedRetry('worker drain', config.retries, drainRequestSignal, () => transport.drain({
      schema: RENDER_WORKER_CONTROL_V2_SCHEMA,
      type: 'worker.drain',
      registrationId: registration.registrationId,
    }, drainRequestSignal)).catch(() => undefined);
    await engine.close?.();
    await transport.close?.();
  }
}
