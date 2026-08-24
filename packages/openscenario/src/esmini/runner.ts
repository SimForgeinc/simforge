import { createHash } from 'node:crypto';
import { chmod, lstat, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { spawn } from 'node:child_process';
import type {
  EsminiExecutionJob, EsminiRunnerLimits, ExternalRunArtifact, ExternalRunLog,
  ExternalRunResult, ExternalRunnerIdentity, Sha256Digest,
} from './contracts.js';
import { immutableCacheKey, MemoryResultCache, type ResultCache } from './cache.js';
import { BundleSecurityError, validateJobShape, validateXmlContent } from './security.js';
import { buildDockerInvocation } from './docker.js';

export const DEFAULT_LIMITS: EsminiRunnerLimits = Object.freeze({
  maxBundleBytes: 256 * 1024 * 1024, maxFileCount: 2_048, timeoutMs: 45_000,
  maxOutputBytes: 512 * 1024 * 1024, memoryMiB: 2_048, cpuCount: 2, maxConcurrentJobs: 2,
});

export interface ContentStore { read(contentId: string): Promise<Uint8Array>; }
export interface ArtifactStore { put(name: string, content: Uint8Array): Promise<string>; }
export interface ExecuteRequest { readonly inputDir: string; readonly outputDir: string; readonly entrypoint: string; readonly signal: AbortSignal; readonly limits: EsminiRunnerLimits; readonly record: EsminiExecutionJob['options']['record']; readonly render?: EsminiExecutionJob['options']['render']; }
export interface ExecuteResponse { readonly exitCode: number | null; readonly signal?: string; readonly stdout: string; readonly stderr: string; readonly timedOut: boolean; }
export interface IsolatedExecutor { readonly identity: ExternalRunnerIdentity; readonly supportsEvidenceRendering?: boolean; execute(request: ExecuteRequest): Promise<ExecuteResponse>; }

export class LocalProcessExecutor implements IsolatedExecutor {
  constructor(readonly binaryPath: string, readonly identity: ExternalRunnerIdentity) {}
  execute(request: ExecuteRequest): Promise<ExecuteResponse> {
    const scenario = join(request.inputDir, request.entrypoint);
    const args = buildLocalEsminiArguments(scenario, request.outputDir, request.record);
    return boundedSpawn(this.binaryPath, args, request);
  }
}

export function buildLocalEsminiArguments(scenario: string, outputDir: string, record: EsminiExecutionJob['options']['record'] = ['csv', 'dat', 'osi', 'log']): readonly string[] {
  const args = ['--osc', scenario, '--headless', '--fixed_timestep', '0.02', '--traj_filter', '0', '--collision'];
  if (record.includes('dat')) args.push('--record', join(outputDir, 'replay.dat'));
  if (record.includes('csv')) args.push('--csv_logger', join(outputDir, 'replay.csv'));
  if (record.includes('osi')) args.push('--osi_file', join(outputDir, 'replay.osi'));
  if (record.includes('log')) args.push('--logfile_path', join(outputDir, 'esmini.log'));
  return args;
}

/** Create a local executor only after hashing the installed official binary. */
export async function createVerifiedMacOsLocalExecutor(binaryPath: string): Promise<LocalProcessExecutor> {
  const { ESMINI_PIN, runnerIdentity } = await import('./pin.js');
  const bytes = await readFile(binaryPath); const actual = createHash('sha256').update(bytes).digest('hex');
  if (actual !== ESMINI_PIN.archives.macosUniversal.binarySha256) throw new Error(`esmini binary digest mismatch: expected ${ESMINI_PIN.archives.macosUniversal.binarySha256}, got ${actual}`);
  return new LocalProcessExecutor(binaryPath, runnerIdentity(`sha256:${actual}`, 'developer-local'));
}

export class DockerExecutor implements IsolatedExecutor {
  constructor(readonly dockerPath: string, readonly image: string, readonly identity: ExternalRunnerIdentity) {
    if (identity.isolation !== 'container') throw new Error('DockerExecutor identity must declare container isolation');
    buildDockerInvocation({ inputDir: '/validation/input', outputDir: '/validation/output' }, DEFAULT_LIMITS, 'scenario.xosc', image);
  }
  execute(request: ExecuteRequest): Promise<ExecuteResponse> {
    const args = buildDockerInvocation({ inputDir: request.inputDir, outputDir: request.outputDir }, request.limits, request.entrypoint, this.image);
    return boundedSpawn(this.dockerPath, args, request);
  }
}

async function boundedSpawn(command: string, args: readonly string[], request: ExecuteRequest): Promise<ExecuteResponse> {
  return await new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: request.inputDir, env: { PATH: process.env.PATH ?? '' }, stdio: ['ignore', 'pipe', 'pipe'], detached: process.platform !== 'win32' });
    let stdout = '', stderr = '', timedOut = false;
    const capture = (current: string, chunk: Buffer): string => (current + chunk.toString('utf8')).slice(-256_000);
    child.stdout.on('data', (chunk: Buffer) => { stdout = capture(stdout, chunk); });
    child.stderr.on('data', (chunk: Buffer) => { stderr = capture(stderr, chunk); });
    const stop = () => { try { process.kill(child.pid! * (process.platform === 'win32' ? 1 : -1), 'SIGKILL'); } catch { child.kill('SIGKILL'); } };
    const timeout = setTimeout(() => { timedOut = true; stop(); }, request.limits.timeoutMs);
    request.signal.addEventListener('abort', stop, { once: true });
    child.once('error', (error) => { clearTimeout(timeout); reject(error); });
    child.once('close', (code, signal) => { clearTimeout(timeout); resolve({ exitCode: code, ...(signal ? { signal } : {}), stdout, stderr, timedOut }); });
  });
}

export interface EsminiRunnerOptions {
  readonly executor: IsolatedExecutor; readonly contentStore: ContentStore; readonly artifactStore: ArtifactStore;
  readonly cache?: ResultCache; readonly limits?: Partial<EsminiRunnerLimits>;
}

export class EsminiRunner {
  readonly #limits: EsminiRunnerLimits;
  readonly #cache: ResultCache;
  #active = 0;
  readonly #waiters: { activate(): void }[] = [];
  constructor(readonly options: EsminiRunnerOptions) {
    this.#limits = { ...DEFAULT_LIMITS, ...options.limits };
    this.#cache = options.cache ?? new MemoryResultCache();
  }

  async run(job: EsminiExecutionJob, signal = new AbortController().signal, onProgress?: (status: 'queued' | 'running') => void): Promise<ExternalRunResult> {
    const started = Date.now();
    let cacheKey = rejectionCacheKey(job, this.options.executor.identity.digest);
    try { validateJobShape(job, this.#limits); cacheKey = immutableCacheKey(job, this.options.executor.identity.digest); }
    catch (error) { return this.failure(typeof job?.id === 'string' ? job.id : 'invalid-job', cacheKey, started, 'rejected', 'security-validation', error); }
    const cached = await this.#cache.get(cacheKey);
    if (cached) return { ...cached, jobId: job.id, cacheHit: true, finishedAt: new Date().toISOString() };
    onProgress?.('queued');
    const acquired = await this.acquire(signal);
    if (!acquired) return this.failure(job.id, cacheKey, started, 'cancelled', 'security-validation', new Error('job cancelled while queued'));
    onProgress?.('running');
    try {
      if (signal.aborted) return this.failure(job.id, cacheKey, started, 'cancelled', 'security-validation', new Error('job cancelled'));
      return await this.execute(job, cacheKey, started, signal);
    } finally { this.release(); }
  }

  private async execute(job: EsminiExecutionJob, cacheKey: Sha256Digest, started: number, signal: AbortSignal): Promise<ExternalRunResult> {
    const root = await import('node:fs/promises').then(({ mkdtemp }) => mkdtemp(join(tmpdir(), 'uniscenarios-esmini-')));
    const inputDir = join(root, 'input'), outputDir = join(root, 'output');
    await mkdir(inputDir); await mkdir(outputDir);
    const filePaths = new Set(job.bundle.manifest.files.map((file) => file.path));
    try {
      if (job.options.render && !this.options.executor.supportsEvidenceRendering) {
        throw new Error('selected esmini executor does not support optional offscreen evidence rendering');
      }
      for (const file of job.bundle.manifest.files) {
        const content = await this.options.contentStore.read(job.bundle.contentIds[file.path]!);
        if (content.byteLength !== file.bytes || sha256(content) !== `sha256:${file.sha256}`) throw new BundleSecurityError('content_digest_mismatch', `content mismatch for ${file.path}`);
        if (/xml|text/iu.test(file.mediaType)) validateXmlContent(new TextDecoder().decode(content), filePaths, file.path);
        const target = join(inputDir, file.path);
        await mkdir(dirname(target), { recursive: true }); await writeFile(target, content, { mode: 0o400 }); await chmod(target, 0o400);
      }
      const response = await this.options.executor.execute({ inputDir, outputDir, entrypoint: job.bundle.manifest.scenarioEntry, signal, limits: this.#limits, record: job.options.record, ...(job.options.render ? { render: job.options.render } : {}) });
      if (signal.aborted) return this.failure(job.id, cacheKey, started, 'cancelled', 'executing', new Error('job cancelled'), response);
      if (response.timedOut) return this.failure(job.id, cacheKey, started, 'timed-out', 'executing', new Error('runner time limit exceeded'), response);
      if (response.exitCode !== 0) return this.failure(job.id, cacheKey, started, 'failed', 'executing', new Error(`esmini exited with code ${response.exitCode}`), response);
      const artifacts = await collectArtifacts(outputDir, this.options.artifactStore, this.#limits.maxOutputBytes);
      const artifactKinds = new Set(artifacts.map((artifact) => artifact.kind));
      const missing = job.options.record.filter((kind) => !artifactKinds.has(kind));
      if (missing.length > 0) throw new Error(`esmini did not produce required evidence: ${missing.join(', ')}`);
      const result: ExternalRunResult = {
        schema: 'uniscenarios.external-run-result/v1', jobId: job.id, status: 'succeeded', stage: 'complete', cacheKey, cacheHit: false,
        runner: this.options.executor.identity, startedAt: new Date(started).toISOString(), finishedAt: new Date().toISOString(), durationMs: Date.now() - started,
        exitCode: response.exitCode ?? undefined, artifacts, logs: processLogs(response),
      };
      await this.#cache.put(cacheKey, result); return result;
    } catch (error) {
      return this.failure(job.id, cacheKey, started, error instanceof BundleSecurityError ? 'rejected' : 'failed', error instanceof BundleSecurityError ? 'security-validation' : 'executing', error);
    } finally {
      if (root.startsWith(`${tmpdir()}/uniscenarios-esmini-`)) await rm(root, { recursive: true, force: false }).catch(() => undefined);
    }
  }

  private failure(jobId: string, cacheKey: Sha256Digest, started: number, status: ExternalRunResult['status'], stage: ExternalRunResult['stage'], error: unknown, response?: ExecuteResponse): ExternalRunResult {
    const code = error instanceof BundleSecurityError ? error.code : status.replace('-', '_');
    return { schema: 'uniscenarios.external-run-result/v1', jobId, status, stage, cacheKey, cacheHit: false, runner: this.options.executor.identity,
      startedAt: new Date(started).toISOString(), finishedAt: new Date().toISOString(), durationMs: Date.now() - started,
      ...(response?.exitCode !== null && response?.exitCode !== undefined ? { exitCode: response.exitCode } : {}), ...(response?.signal ? { signal: response.signal } : {}),
      artifacts: [], logs: response ? processLogs(response) : [], error: { code, message: error instanceof Error ? error.message : String(error) } };
  }
  private async acquire(signal: AbortSignal): Promise<boolean> {
    if (signal.aborted) return false;
    if (this.#active < this.#limits.maxConcurrentJobs) { this.#active++; return true; }
    return await new Promise<boolean>((resolve) => {
      let settled = false;
      const waiter = { activate: () => { if (settled) return; settled = true; signal.removeEventListener('abort', abort); this.#active++; resolve(true); } };
      const abort = () => { if (settled) return; settled = true; const index = this.#waiters.indexOf(waiter); if (index >= 0) this.#waiters.splice(index, 1); resolve(false); };
      this.#waiters.push(waiter); signal.addEventListener('abort', abort, { once: true });
    });
  }
  private release(): void { this.#active--; this.#waiters.shift()?.activate(); }
}

function sha256(content: Uint8Array): Sha256Digest { return `sha256:${createHash('sha256').update(content).digest('hex')}`; }
function rejectionCacheKey(job: unknown, runnerDigest: Sha256Digest): Sha256Digest {
  let serialized = 'unserializable';
  try { serialized = JSON.stringify(job) ?? 'undefined'; } catch { /* safe fallback */ }
  return sha256(new TextEncoder().encode(`rejected\0${runnerDigest}\0${serialized}`));
}
function processLogs(response: ExecuteResponse): ExternalRunLog[] {
  const logs: ExternalRunLog[] = [];
  for (const [stream, text] of ([['stdout', response.stdout], ['stderr', response.stderr]] as const)) {
    for (const message of text.split(/\r?\n/u).map((line) => line.trim()).filter(Boolean)) {
      const level = /\[(?:error|fatal)\]|\berror\b/iu.test(message) ? 'error'
        : /\[(?:warn|warning)\]|\bwarning\b/iu.test(message) || stream === 'stderr' ? 'warning' : 'info';
      logs.push({ stream, level, message });
    }
  }
  return logs;
}
async function collectArtifacts(dir: string, store: ArtifactStore, maxBytes: number): Promise<ExternalRunArtifact[]> {
  const kinds: Record<string, ExternalRunArtifact['kind']> = { '.csv': 'csv', '.dat': 'dat', '.osi': 'osi', '.log': 'log', '.mp4': 'video', '.png': 'frame' };
  const media: Record<string, string> = { '.csv': 'text/csv', '.dat': 'application/octet-stream', '.osi': 'application/octet-stream', '.log': 'text/plain', '.mp4': 'video/mp4', '.png': 'image/png' };
  const result: ExternalRunArtifact[] = []; let total = 0;
  for (const name of (await readdir(dir)).sort()) {
    const extension = name.slice(name.lastIndexOf('.')).toLowerCase(), kind = kinds[extension]; if (!kind) continue;
    const path = join(dir, name), info = await lstat(path);
    if (!info.isFile() || info.isSymbolicLink()) throw new BundleSecurityError('unsafe_output', `runner output is not a regular file: ${name}`);
    total += info.size; if (total > maxBytes) throw new BundleSecurityError('output_too_large', 'runner outputs exceed byte limit');
    const content = await readFile(path), artifactId = await store.put(name, content);
    result.push({ kind, name, mediaType: media[extension]!, digest: sha256(content), byteLength: content.byteLength, artifactId, authoritative: kind !== 'frame' && kind !== 'video' });
  }
  return result;
}
