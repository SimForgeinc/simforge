import type { EsminiExecutionJob, ExternalRunSnapshot } from './contracts.js';
import { EsminiRunner } from './runner.js';

interface JobRecord { snapshot: ExternalRunSnapshot; readonly controller: AbortController; readonly promise: Promise<ExternalRunSnapshot>; }

/** In-process service boundary suitable for an HTTP/queue adapter. */
export class EsminiRunnerService {
  readonly #jobs = new Map<string, JobRecord>();
  constructor(readonly runner: EsminiRunner) {}

  submit(job: EsminiExecutionJob): Promise<ExternalRunSnapshot> {
    if (this.#jobs.has(job.id)) throw new Error(`duplicate external runner job id: ${job.id}`);
    const controller = new AbortController(); const submittedAt = new Date().toISOString();
    const initial: ExternalRunSnapshot = { jobId: job.id, status: 'queued', stage: 'security-validation', submittedAt, updatedAt: submittedAt };
    const record = {} as JobRecord;
    const promise = this.runner.run(job, controller.signal, (status) => {
      record.snapshot = { ...record.snapshot, status, stage: status === 'running' ? 'executing' : 'security-validation', updatedAt: new Date().toISOString() };
    }).then((result) => {
      record.snapshot = { ...record.snapshot, status: result.status, stage: result.stage, updatedAt: result.finishedAt, result }; return record.snapshot;
    });
    record.snapshot = initial; Object.assign(record, { controller, promise }); this.#jobs.set(job.id, record); return promise;
  }

  status(jobId: string): ExternalRunSnapshot | undefined { return this.#jobs.get(jobId)?.snapshot; }
  cancel(jobId: string): boolean { const record = this.#jobs.get(jobId); if (!record || terminal(record.snapshot.status)) return false; record.controller.abort(); return true; }
}

function terminal(status: ExternalRunSnapshot['status']): boolean {
  return status === 'succeeded' || status === 'failed' || status === 'cancelled' || status === 'timed-out' || status === 'rejected';
}
