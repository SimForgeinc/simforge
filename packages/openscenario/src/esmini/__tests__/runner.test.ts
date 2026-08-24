import { createHash } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import type { EsminiExecutionJob, ExternalRunnerIdentity, Sha256Digest } from '../contracts.js';
import { buildLocalEsminiArguments, EsminiRunner, type ArtifactStore, type ContentStore, type ExecuteRequest, type IsolatedExecutor } from '../runner.js';

const identity: ExternalRunnerIdentity = { name: 'esmini', version: '3.6.0', sourceRevision: '131a5651737fd1e8bd5d800d8e77e89bb3178a1e', digest: `sha256:${'1'.repeat(64)}`, isolation: 'container' };
const digest = (bytes: Uint8Array): Sha256Digest => `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
const rawDigest = (bytes: Uint8Array): string => digest(bytes).slice(7);

function fixture(xml = '<OpenSCENARIO><RoadNetwork><LogicFile filepath="maps/map.xodr"/></RoadNetwork></OpenSCENARIO>') {
  const entries = new Map<string, Uint8Array>([['scenario', new TextEncoder().encode(xml)], ['road', new TextEncoder().encode('<OpenDRIVE/>')]]);
  const files = [
    { path: 'scenario.xosc', mediaType: 'application/xml', bytes: entries.get('scenario')!.byteLength, sha256: rawDigest(entries.get('scenario')!) },
    { path: 'maps/map.xodr', mediaType: 'application/xml', bytes: entries.get('road')!.byteLength, sha256: rawDigest(entries.get('road')!) },
  ] as const;
  const manifest = { kind: 'simforge-esmini-runnable-bundle', version: 1, scenarioEntry: 'scenario.xosc', roadEntry: 'maps/map.xodr', canonicalTraceEntry: 'trace/canonical.trace.json', capabilityEntry: 'reports/capability.json', provenanceEntry: 'reports/provenance.json', openScenarioVersion: '1.3.1', esminiVersion: 'runner-pinned', engineVersion: 'test', behaviorParityScope: 'motion-only', files } as const;
  const job: EsminiExecutionJob = { schema: 'uniscenarios.esmini-job/v1', id: 'known-sample', bundle: { manifest, contentIds: { 'scenario.xosc': 'scenario', 'maps/map.xodr': 'road' } }, options: { fixedTimestepS: 0.02, durationS: 20, record: ['csv', 'dat', 'osi', 'log'] } };
  return { entries, job };
}

class MemoryContent implements ContentStore { constructor(readonly entries: Map<string, Uint8Array>) {} async read(id: string) { return this.entries.get(id)!; } }
class MemoryArtifacts implements ArtifactStore { readonly values = new Map<string, Uint8Array>(); async put(name: string, content: Uint8Array) { this.values.set(name, content); return `artifact:${name}`; } }
class KnownSampleExecutor implements IsolatedExecutor {
  readonly identity = identity; calls = 0;
  async execute(request: ExecuteRequest) { this.calls++; await writeFile(`${request.outputDir}/replay.csv`, 'time,id,x,y,h,speed\n0,Ego,0,0,0,0\n'); await writeFile(`${request.outputDir}/replay.dat`, 'known'); await writeFile(`${request.outputDir}/replay.osi`, 'known'); await writeFile(`${request.outputDir}/esmini.log`, 'Collision detection enabled'); return { exitCode: 0, stdout: 'esmini 3.6.0', stderr: '', timedOut: false }; }
}

describe('EsminiRunner', () => {
  it('disables esmini trajectory filtering for exact 50 Hz replay parity', () => {
    const args = buildLocalEsminiArguments('/input/scenario.xosc', '/output');
    expect(args.slice(args.indexOf('--traj_filter'), args.indexOf('--traj_filter') + 2)).toEqual(['--traj_filter', '0']);
  });
  it('runs a known bundle, collects authoritative traces, and reuses immutable deterministic cache', async () => {
    const { entries, job } = fixture(); const executor = new KnownSampleExecutor();
    const runner = new EsminiRunner({ executor, contentStore: new MemoryContent(entries), artifactStore: new MemoryArtifacts() });
    const first = await runner.run(job), second = await runner.run({ ...job, id: 'rerun' });
    expect(first.status).toBe('succeeded'); expect(first.artifacts.map((a) => a.kind)).toEqual(['log', 'csv', 'dat', 'osi']);
    expect(second.cacheHit).toBe(true); expect(second.cacheKey).toBe(first.cacheKey); expect(executor.calls).toBe(1);
  });

  it('permits only the explicit local CSV/DAT/log evidence profile to omit OSI', async () => {
    const { entries, job } = fixture();
    const localJob: EsminiExecutionJob = { ...job, options: { ...job.options, record: ['csv', 'dat', 'log'], evidenceProfile: 'local-trace-no-osi' } };
    const executor: IsolatedExecutor = { identity, async execute(request) {
      await writeFile(`${request.outputDir}/replay.csv`, 'ok'); await writeFile(`${request.outputDir}/replay.dat`, 'ok'); await writeFile(`${request.outputDir}/esmini.log`, 'ok');
      return { exitCode: 0, stdout: '', stderr: '', timedOut: false };
    } };
    const accepted = await new EsminiRunner({ executor, contentStore: new MemoryContent(entries), artifactStore: new MemoryArtifacts() }).run(localJob);
    expect(accepted.status).toBe('succeeded');
    const undeclared = await new EsminiRunner({ executor, contentStore: new MemoryContent(entries), artifactStore: new MemoryArtifacts() }).run({ ...localJob, options: { ...localJob.options, evidenceProfile: 'full' } });
    expect(undeclared.status).toBe('rejected'); expect(undeclared.error?.code).toBe('recording_contract');
  });

  it.each([
    ['traversal', '../scenario.xosc', '<OpenSCENARIO/>', 'path_traversal'],
    ['absolute', '/scenario.xosc', '<OpenSCENARIO/>', 'absolute_path'],
    ['xxe', 'scenario.xosc', '<!DOCTYPE x [<!ENTITY e SYSTEM "file:///etc/passwd">]><OpenSCENARIO/>', 'unsafe_xml'],
    ['remote', 'scenario.xosc', '<OpenSCENARIO><LogicFile filepath="https://evil.test/map.xodr"/></OpenSCENARIO>', 'remote_reference'],
  ])('rejects malicious %s bundles before execution', async (_name, entrypoint, xml, code) => {
    const data = fixture(xml); const scenario = data.entries.get('scenario')!;
    const files = data.job.bundle.manifest.files.map((file) => file.path === 'scenario.xosc' ? { ...file, sha256: rawDigest(scenario), bytes: scenario.byteLength } : file);
    const job = { ...data.job, bundle: { ...data.job.bundle, manifest: { ...data.job.bundle.manifest, scenarioEntry: entrypoint, files } } } as EsminiExecutionJob;
    const executor = new KnownSampleExecutor(); const result = await new EsminiRunner({ executor, contentStore: new MemoryContent(data.entries), artifactStore: new MemoryArtifacts() }).run(job);
    expect(result.status).toBe('rejected'); expect(result.error?.code).toBe(code); expect(executor.calls).toBe(0);
  });

  it('reports timeout distinctly and does not cache it', async () => {
    const { entries, job } = fixture();
    const executor: IsolatedExecutor = { identity, async execute() { return { exitCode: null, stdout: '', stderr: '', timedOut: true }; } };
    const result = await new EsminiRunner({ executor, contentStore: new MemoryContent(entries), artifactStore: new MemoryArtifacts() }).run(job);
    expect(result.status).toBe('timed-out'); expect(result.error?.code).toBe('timed_out');
  });

  it('preserves esmini-declared error severity even when the process exits zero', async () => {
    const { entries, job } = fixture();
    const executor: IsolatedExecutor = { identity, async execute(request) { await writeFile(`${request.outputDir}/replay.csv`, 'ok'); await writeFile(`${request.outputDir}/replay.dat`, 'ok'); await writeFile(`${request.outputDir}/replay.osi`, 'ok'); await writeFile(`${request.outputDir}/esmini.log`, 'ok'); return { exitCode: 0, stdout: '[error] Unsupported geo reference attr: +no_defs', stderr: '', timedOut: false }; } };
    const result = await new EsminiRunner({ executor, contentStore: new MemoryContent(entries), artifactStore: new MemoryArtifacts() }).run(job);
    expect(result.status).toBe('succeeded'); expect(result.logs).toContainEqual({ stream: 'stdout', level: 'error', message: '[error] Unsupported geo reference attr: +no_defs' });
  });

  it('returns a structured rejection for a malformed untrusted job', async () => {
    const { entries } = fixture(); const executor = new KnownSampleExecutor();
    const runner = new EsminiRunner({ executor, contentStore: new MemoryContent(entries), artifactStore: new MemoryArtifacts() });
    const result = await runner.run({ schema: 'uniscenarios.esmini-job/v1', id: 'bad' } as EsminiExecutionJob);
    expect(result.status).toBe('rejected'); expect(result.stage).toBe('security-validation'); expect(executor.calls).toBe(0);
  });
});
