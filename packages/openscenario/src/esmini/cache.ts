import { createHash } from 'node:crypto';
import type { EsminiExecutionJob, ExternalRunResult, Sha256Digest } from './contracts.js';

export function immutableCacheKey(job: EsminiExecutionJob, runnerDigest: Sha256Digest): Sha256Digest {
  const scenario = job.bundle.manifest.files.find((file) => file.path === job.bundle.manifest.scenarioEntry);
  const map = job.bundle.manifest.files.find((file) => file.path === job.bundle.manifest.roadEntry);
  const canonical = JSON.stringify({
    exportDigest: scenario?.sha256,
    mapDigest: map?.sha256,
    runnerDigest,
    parityScope: job.bundle.manifest.behaviorParityScope,
    options: job.options,
  });
  return `sha256:${createHash('sha256').update(canonical).digest('hex')}`;
}

export interface ResultCache {
  get(key: Sha256Digest): Promise<ExternalRunResult | undefined>;
  put(key: Sha256Digest, value: ExternalRunResult): Promise<void>;
}

export class MemoryResultCache implements ResultCache {
  readonly #entries = new Map<Sha256Digest, ExternalRunResult>();
  async get(key: Sha256Digest): Promise<ExternalRunResult | undefined> { return this.#entries.get(key); }
  async put(key: Sha256Digest, value: ExternalRunResult): Promise<void> { this.#entries.set(key, value); }
}
