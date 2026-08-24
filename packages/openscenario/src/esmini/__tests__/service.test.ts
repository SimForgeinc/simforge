import { createHash } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import type { EsminiExecutionJob, ExternalRunnerIdentity } from '../contracts.js';
import { EsminiRunner, type ArtifactStore, type ContentStore, type ExecuteRequest, type IsolatedExecutor } from '../runner.js';
import { EsminiRunnerService } from '../service.js';

const bytes = new TextEncoder().encode('<OpenSCENARIO/>');
const road = new TextEncoder().encode('<OpenDRIVE/>');
const hash = (value: Uint8Array) => createHash('sha256').update(value).digest('hex');
const manifest = { kind: 'simforge-esmini-runnable-bundle', version: 1, scenarioEntry: 'scenario.xosc', roadEntry: 'maps/map.xodr', canonicalTraceEntry: 'trace/canonical.trace.json', capabilityEntry: 'reports/capability.json', provenanceEntry: 'reports/provenance.json', openScenarioVersion: '1.3.1', esminiVersion: 'runner-pinned', engineVersion: 'test', behaviorParityScope: 'motion-only', files: [{ path: 'scenario.xosc', mediaType: 'application/xml', bytes: bytes.byteLength, sha256: hash(bytes) }, { path: 'maps/map.xodr', mediaType: 'application/xml', bytes: road.byteLength, sha256: hash(road) }] } as const;
const job = (id: string): EsminiExecutionJob => ({ schema: 'uniscenarios.esmini-job/v1', id, bundle: { manifest, contentIds: { 'scenario.xosc': 'scenario', 'maps/map.xodr': 'road' } }, options: { fixedTimestepS: 0.02, durationS: 20, record: ['csv', 'dat', 'osi', 'log'] } });

describe('EsminiRunnerService', () => {
  it('cancels a queued job without starting it', async () => {
    let release!: () => void; let started!: () => void; const didStart = new Promise<void>((resolve) => { started = resolve; }); let calls = 0;
    const identity: ExternalRunnerIdentity = { name: 'esmini', version: '3.6.0', sourceRevision: '131a5651737fd1e8bd5d800d8e77e89bb3178a1e', digest: `sha256:${'1'.repeat(64)}`, isolation: 'container' };
    const executor: IsolatedExecutor = { identity, async execute(request: ExecuteRequest) { calls++; started(); await new Promise<void>((resolve) => { release = resolve; }); for (const name of ['replay.csv', 'replay.dat', 'replay.osi', 'esmini.log']) await writeFile(`${request.outputDir}/${name}`, 'ok'); return { exitCode: 0, stdout: '', stderr: '', timedOut: false }; } };
    const content: ContentStore = { async read(id) { return id === 'scenario' ? bytes : road; } }; const artifacts: ArtifactStore = { async put(name) { return name; } };
    const service = new EsminiRunnerService(new EsminiRunner({ executor, contentStore: content, artifactStore: artifacts, limits: { maxConcurrentJobs: 1 } }));
    const first = service.submit(job('first')); await didStart; const second = service.submit(job('second'));
    await new Promise((resolve) => setTimeout(resolve, 1)); expect(service.status('second')?.status).toBe('queued'); expect(service.cancel('second')).toBe(true);
    release(); expect((await first).status).toBe('succeeded'); expect((await second).status).toBe('cancelled'); expect(calls).toBe(1);
  });
});
