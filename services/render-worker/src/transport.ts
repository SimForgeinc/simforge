import type { ZodType } from 'zod';

import {
  ArtifactReservedResponseSchema,
  FencedMutationResponseSchema,
  JobClaimResponseSchema,
  LeaseHeartbeatResponseSchema,
  LeaseProgressResponseSchema,
  RENDER_WORKER_CONTROL_V2_SCHEMA,
  WorkerDrainResponseSchema,
  WorkerRegisteredResponseSchema,
  type ArtifactReserveRequest,
  type ArtifactReservedResponse,
  type FencedMutationResponse,
  type JobClaimRequest,
  type JobClaimResponse,
  type JobCompleteRequest,
  type JobFailRequest,
  type LeaseHeartbeatRequest,
  type LeaseHeartbeatResponse,
  type LeaseProgressRequest,
  type LeaseProgressResponse,
  type WorkerDrainRequest,
  type WorkerDrainResponse,
  type WorkerRegisterRequest,
  type WorkerRegisteredResponse,
} from '@simforge-oss/render';

import type { RenderWorkerConfig } from './config.js';

export interface RenderControlTransport {
  register(request: WorkerRegisterRequest, signal: AbortSignal): Promise<WorkerRegisteredResponse>;
  claim(request: JobClaimRequest, signal: AbortSignal): Promise<JobClaimResponse>;
  heartbeat(request: LeaseHeartbeatRequest, signal: AbortSignal): Promise<LeaseHeartbeatResponse>;
  progress(request: LeaseProgressRequest, signal: AbortSignal): Promise<LeaseProgressResponse>;
  reserveArtifact(request: ArtifactReserveRequest, signal: AbortSignal): Promise<ArtifactReservedResponse>;
  complete(request: JobCompleteRequest, signal: AbortSignal): Promise<FencedMutationResponse>;
  fail(request: JobFailRequest, signal: AbortSignal): Promise<FencedMutationResponse>;
  drain(request: WorkerDrainRequest, signal: AbortSignal): Promise<WorkerDrainResponse>;
  close?(): Promise<void>;
}

export type RenderControlTransportModule = {
  createRenderControlTransport(options: Readonly<Record<string, unknown>>): Promise<RenderControlTransport> | RenderControlTransport;
};

class HttpRenderControlTransport implements RenderControlTransport {
  constructor(
    private readonly baseUrl: URL,
    private readonly headers: Readonly<Record<string, string>>,
    private readonly requestTimeoutMs: number,
  ) {}

  private async post<T>(path: string, body: unknown, schema: ZodType<T>, signal: AbortSignal): Promise<T> {
    const timeoutSignal = AbortSignal.timeout(this.requestTimeoutMs);
    const response = await fetch(new URL(path, this.baseUrl), {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...this.headers },
      body: JSON.stringify(body),
      signal: AbortSignal.any([signal, timeoutSignal]),
    });
    if (!response.ok) {
      const text = await response.text();
      throw new Error(`render control ${path} returned ${response.status}: ${text.slice(0, 2048)}`);
    }
    return schema.parse(await response.json());
  }

  register(request: WorkerRegisterRequest, signal: AbortSignal): Promise<WorkerRegisteredResponse> {
    return this.post('/v2/workers/register', request, WorkerRegisteredResponseSchema, signal);
  }
  claim(request: JobClaimRequest, signal: AbortSignal): Promise<JobClaimResponse> {
    return this.post('/v2/jobs/claim', request, JobClaimResponseSchema, signal);
  }
  heartbeat(request: LeaseHeartbeatRequest, signal: AbortSignal): Promise<LeaseHeartbeatResponse> {
    return this.post(`/v2/leases/${encodeURIComponent(request.leaseId)}/heartbeat`, request, LeaseHeartbeatResponseSchema, signal);
  }
  progress(request: LeaseProgressRequest, signal: AbortSignal): Promise<LeaseProgressResponse> {
    return this.post(`/v2/leases/${encodeURIComponent(request.leaseId)}/progress`, request, LeaseProgressResponseSchema, signal);
  }
  reserveArtifact(request: ArtifactReserveRequest, signal: AbortSignal): Promise<ArtifactReservedResponse> {
    return this.post(`/v2/leases/${encodeURIComponent(request.leaseId)}/artifacts/reserve`, request, ArtifactReservedResponseSchema, signal);
  }
  complete(request: JobCompleteRequest, signal: AbortSignal): Promise<FencedMutationResponse> {
    return this.post(`/v2/leases/${encodeURIComponent(request.leaseId)}/complete`, request, FencedMutationResponseSchema, signal);
  }
  fail(request: JobFailRequest, signal: AbortSignal): Promise<FencedMutationResponse> {
    return this.post(`/v2/leases/${encodeURIComponent(request.leaseId)}/fail`, request, FencedMutationResponseSchema, signal);
  }
  drain(request: WorkerDrainRequest, signal: AbortSignal): Promise<WorkerDrainResponse> {
    return this.post('/v2/workers/drain', request, WorkerDrainResponseSchema, signal);
  }
}

export async function createControlTransport(config: RenderWorkerConfig): Promise<RenderControlTransport> {
  if (config.control.kind === 'http') {
    const headers: Record<string, string> = { ...config.control.headers };
    if (config.control.tokenEnv) {
      const token = process.env[config.control.tokenEnv];
      if (!token) throw new Error(`control token environment variable ${config.control.tokenEnv} is not set`);
      headers.authorization = `Bearer ${token}`;
    }
    return new HttpRenderControlTransport(new URL(config.control.baseUrl), headers, config.control.requestTimeoutMs);
  }

  // The module path is operator configuration, so it cannot be a static import.
  const imported = await import(config.control.module) as Partial<RenderControlTransportModule>;
  if (typeof imported.createRenderControlTransport !== 'function') {
    throw new TypeError(`${config.control.module} must export createRenderControlTransport(options)`);
  }
  const transport = await imported.createRenderControlTransport(config.control.options);
  for (const method of ['register', 'claim', 'heartbeat', 'progress', 'reserveArtifact', 'complete', 'fail', 'drain'] as const) {
    if (typeof transport[method] !== 'function') throw new TypeError(`control transport is missing ${method}()`);
  }
  return transport;
}

export { RENDER_WORKER_CONTROL_V2_SCHEMA };
