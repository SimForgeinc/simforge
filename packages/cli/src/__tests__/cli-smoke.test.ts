/**
 * `simforge` end to end, through the real binary.
 *
 * These exist because the CLI's contract is not its TypeScript signatures — it
 * is *stdout is JSON, stderr is a structured error, and the exit code says
 * which kind of answer this is*. Only a subprocess can assert that.
 */

import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { execa, type ExecaError } from 'execa';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { DEV_ASSETS, REPO_ROOT } from '@simforge/compiler/node';
import { readTraceFile, writeTraceFile } from '@simforge/compiler/node';

const BIN = path.join(REPO_ROOT, 'packages', 'cli', 'bin', 'simforge.js');
const LTAP = path.join(REPO_ROOT, 'examples', 'ltap-opposing.template.json');
const MAP = 'yale-st-palo-alto-ca';
const SUMO_SCENARIO = path.join(REPO_ROOT, 'examples', 'edge-cases', '03-red-light-ambulance-preemption', 'scenario.instance.json');
const haveArtifacts =
  existsSync(path.join(DEV_ASSETS, MAP, 'derived', 'topology-derived.json.gz')) && existsSync(LTAP);
const haveSumo = haveArtifacts
  && existsSync(path.join(DEV_ASSETS, 'sumo-runtime', 'sumo.mjs'))
  && existsSync(path.join(DEV_ASSETS, MAP, 'derived', 'sumo', 'sumo-network-manifest.json'))
  && existsSync(SUMO_SCENARIO);

interface Run {
  code: number;
  stdout: string;
  stderr: string;
}

async function simforge(...args: string[]): Promise<Run> {
  try {
    const r = await execa('node', [BIN, ...args], { reject: false, timeout: 180_000 });
    return { code: r.exitCode ?? 0, stdout: r.stdout, stderr: r.stderr };
  } catch (error) {
    const e = error as ExecaError;
    return { code: e.exitCode ?? 1, stdout: String(e.stdout ?? ''), stderr: String(e.stderr ?? '') };
  }
}

function json<T = Record<string, unknown>>(run: Run): T {
  return JSON.parse(run.stdout) as T;
}

let tmp: string;
beforeAll(async () => {
  tmp = await mkdtemp(path.join(os.tmpdir(), 'simforge-smoke-'));
});
afterAll(async () => {
  if (tmp) await rm(tmp, { recursive: true, force: true });
});

describe('simforge — contract', () => {
  it('prints its command surface as JSON', async () => {
    const run = await simforge();
    expect(run.code).toBe(0);
    const payload = json<{ bin: string; commands: Array<{ name: string }> }>(run);
    expect(payload.bin).toBe('simforge');
    expect(payload.commands.map((c) => c.name)).toContain('sites match');
    expect(payload.commands.map((c) => c.name)).toContain('export');
    expect(payload.commands.map((c) => c.name)).toContain('debug');
  });

  it('rejects unknown ASAM export formats before touching the input file', async () => {
    const run = await simforge('export', 'missing.instance.json', '--format', 'xosc-0.9', '--out', 'out.xosc');
    expect(run.code).toBe(1);
    const error = JSON.parse(run.stderr) as { code: string; path: string; detail: { known: string[] } };
    expect(error.code).toBe('bad_value');
    expect(error.path).toBe('--format');
    expect(error.detail.known).toEqual(['xosc-1.4', 'xosc-1.3-esmini', 'osc-2.2']);
  }, 60_000);

  it('reports an unknown flag as a structured error on stderr, exit 1', async () => {
    const run = await simforge('maps', 'list', '--limt', '3');
    expect(run.code).toBe(1);
    expect(run.stdout).toBe('');
    const error = JSON.parse(run.stderr) as { code: string; path: string; detail: { known: string[] } };
    expect(error.code).toBe('unknown_flag');
    expect(error.path).toBe('--limt');
    expect(error.detail.known).toContain('pretty');
  });

  it('reports an unknown map with the closed vocabulary attached', async () => {
    const run = await simforge('locations', 'find', '--map', 'not-a-map');
    expect(run.code).toBe(1);
    const error = JSON.parse(run.stderr) as { code: string; detail: { known: string[] } };
    expect(error.code).toBe('unknown_map');
    expect(error.detail.known).toContain(MAP);
  });

  it('lists the five maps and their artifacts', async () => {
    const run = await simforge('maps', 'list');
    expect(run.code).toBe(0);
    const payload = json<{ maps: Array<{ mapId: string; artifacts: Record<string, boolean> }> }>(run);
    expect(payload.maps).toHaveLength(5);
    expect(payload.maps.map((m) => m.mapId)).toContain(MAP);
  });

  it('prints the published JSON Schema paths', async () => {
    const run = await simforge('schemas');
    expect(run.code).toBe(0);
    const payload = json<{ schemas: Array<{ name: string; exists: boolean }> }>(run);
    expect(payload.schemas.map((s) => s.name).sort()).toEqual(['anchor', 'interactions', 'template']);
    expect(payload.schemas.every((s) => s.exists)).toBe(true);
  });

  it('exits 2 with structured issues on a malformed template', async () => {
    const run = await simforge('template', 'validate', path.join(REPO_ROOT, 'package.json'));
    expect(run.code).toBe(2);
    const payload = json<{ ok: boolean; issues: Array<{ code: string }> }>(run);
    expect(payload.ok).toBe(false);
    expect(payload.issues.length).toBeGreaterThan(0);
  });
});

describe.skipIf(!haveArtifacts)('simforge — the pipeline', () => {
  it('compiles and runs a known scenario into complete agent-debug artifacts and compares deterministically', async () => {
    const input = path.join(tmp, 'debug.input.json');
    const project = path.join(tmp, 'debug.project.json');
    const out = path.join(tmp, 'debug-run');
    await writeFile(input, JSON.stringify({
      mapId: MAP,
      clipSeconds: 2,
      warmupSeconds: 0,
      dt: 0.02,
      seed: 'cli-debug-known',
      actors: [{
        id: 'sedan',
        kind: 'car',
        initial: { pose: { x: 400, z: -1600, headingRad: 0 }, speedMps: 4 },
        behavior: { cruiseSpeedMps: 4, route: { kind: 'polyline', points: [{ x: 400, z: -1600 }, { x: 450, z: -1600 }] } },
      }],
      interactions: [{
        id: 'brake', actorId: 'sedan', trigger: { kind: 'at', t: 1 }, verb: 'speed',
        target: { mode: 'absolute', value: 2 }, dynamics: { shape: 'linear', constraint: 'time', value: 0.5 },
      }],
    }), 'utf8');
    await writeFile(project, JSON.stringify({ kind: 'simforge-studio-record', version: 1, instance: path.basename(input) }), 'utf8');

    const first = await simforge('debug', project, '--sample', '0.1', '--out', out, '--fail-on-fallback');
    expect(first.code).toBe(0);
    const summary = json<{ schema: string; actorCount: number; acceptance: { ok: boolean }; files: string[] }>(first);
    expect(summary).toMatchObject({ schema: 'uniscenarios.scenario-debug.v1', actorCount: 1, acceptance: { ok: true } });
    expect(summary.files).toEqual(['report.json', 'summary.json', 'paths.json', 'input.json', 'compiled-instance.json', 'trace.json.gz']);
    const report = JSON.parse(await readFile(path.join(out, 'report.json'), 'utf8')) as {
      actors: { sedan: Array<{ t: number; x: number; accelerationMps2: number; roadId: string | null }> };
      interactions: Array<{ id: string; events: Array<{ kind: string }> }>;
      diagnostics: { routes: { sedan: { backend: { mode: string } } }; fallbacks: unknown[] };
      performance: { nativeTicksPerSecond: number };
    };
    expect(report.actors.sedan.length).toBeGreaterThanOrEqual(20);
    expect(report.actors.sedan[0]).toEqual(expect.objectContaining({ t: 0, roadId: null }));
    expect(report.interactions.find((item) => item.id === 'brake')?.events.map((event) => event.kind)).toContain('trigger_fired');
    expect(report.diagnostics.routes.sedan.backend.mode).toBe('dynamic-v1');
    expect(report.diagnostics.fallbacks).toEqual([]);
    expect(report.performance.nativeTicksPerSecond).toBeGreaterThan(0);

    const compared = await simforge('debug', input, '--sample', '0.1', '--compare', path.join(out, 'report.json'));
    expect(compared.code).toBe(0);
    expect(json<{ comparison: { ok: boolean } }>(compared).comparison.ok).toBe(true);

    const changedInput = path.join(tmp, 'debug.changed.input.json');
    const changed = JSON.parse(await readFile(input, 'utf8'));
    changed.actors[0].initial.speedMps = 5;
    await writeFile(changedInput, JSON.stringify(changed), 'utf8');
    const mismatch = await simforge('debug', changedInput, '--sample', '0.1', '--compare', path.join(out, 'report.json'));
    expect(mismatch.code).toBe(2);
    expect(json<{ acceptance: { failures: Array<{ code: string }> } }>(mismatch).acceptance.failures.map((failure) => failure.code)).toContain('comparison_mismatch');
  }, 180_000);

  it.runIf(haveSumo)('runs the packaged SUMO-Wasm provider headlessly and records ambient paths/performance', async () => {
    const out = path.join(tmp, 'sumo-debug-run');
    const run = await simforge('debug', SUMO_SCENARIO, '--provider', 'sumo', '--ambient-count', '8', '--duration', '1', '--sample', '0.1', '--out', out);
    expect(run.code).toBe(0);
    const summary = json<{ ambientActorCount: number; performance: { sumo: { version: string; stepMilliseconds: { p95: number } } } }>(run);
    expect(summary.ambientActorCount).toBeGreaterThan(0);
    expect(summary.performance.sumo.version).toBe('1.27.1');
    expect(summary.performance.sumo.stepMilliseconds.p95).toBeGreaterThanOrEqual(0);
    const report = JSON.parse(await readFile(path.join(out, 'report.json'), 'utf8')) as {
      actors: Record<string, Array<{ x: number; z: number }>>;
      ambientActors: Record<string, Array<{ t: number; x: number; z: number; speedMps: number; accelerationMps2: number; lanePositionM: number }>>;
      performance: { sumo: { heapBytes: number } };
    };
    expect(Object.values(report.ambientActors)[0]?.[0]).toEqual(expect.objectContaining({ t: 0 }));
    expect(report.performance.sumo.heapBytes).toBeGreaterThan(0);
    const authoredPoints = Object.values(report.actors).flat();
    const ambientPoints = Object.values(report.ambientActors).flat();
    const nearest = Math.min(...ambientPoints.flatMap((ambient) => authoredPoints.map((actor) => Math.hypot(
      ambient.x - actor.x,
      ambient.z - actor.z,
    ))));
    // A sign mismatch used to put Yale ambient traffic 3+ km from authored
    // actors. Routes are map-local and need not intersect in a one-second
    // smoke, but both populations must occupy the same few-hundred-metre area.
    expect(nearest).toBeLessThan(300);
  }, 180_000);

  it('exports a concrete instance through the real CLI in native and esmini-compatible ASAM formats', async () => {
    const instance = path.join(tmp, 'asam.instance.json');
    const xosc = path.join(tmp, 'asam.xosc');
    const esminiXosc = path.join(tmp, 'asam-esmini.xosc');
    const osc = path.join(tmp, 'asam.osc');
    await writeFile(instance, JSON.stringify({
      mapId: MAP,
      clipSeconds: 5,
      warmupSeconds: 0,
      actors: [{
        id: 'ego',
        kind: 'vehicle',
        dims: { l: 4.5, w: 1.8, h: 1.5 },
        initial: { pose: { x: 0, z: 0, headingRad: 0 }, speedMps: 2 },
        behavior: { route: { kind: 'polyline', points: [{ x: 0, z: 0 }, { x: 30, z: 0 }] } },
      }],
    }), 'utf8');

    const xmlRun = await simforge('export', instance, '--format', 'xosc-1.4', '--out', xosc);
    expect(xmlRun.code).toBe(0);
    expect(json<{ standard: string; out: string }>(xmlRun)).toMatchObject({
      standard: 'ASAM OpenSCENARIO XML 1.4.0',
      out: xosc,
    });
    expect(await readFile(xosc, 'utf8')).toContain('revMajor="1" revMinor="4"');

    const esminiRun = await simforge('export', instance, '--format', 'xosc-1.3-esmini', '--out', esminiXosc);
    expect(esminiRun.code).toBe(0);
    expect(json<{ standard: string; out: string }>(esminiRun)).toMatchObject({
      standard: 'ASAM OpenSCENARIO XML 1.3.1 · esmini compatibility',
      out: esminiXosc,
    });
    const esminiXml = await readFile(esminiXosc, 'utf8');
    expect(esminiXml).toContain('revMajor="1" revMinor="3"');
    expect(esminiXml).not.toContain('revMinor="4"');

    const dslRun = await simforge('export', instance, '--format', 'osc-2.2', '--out', osc);
    expect(dslRun.code).toBe(0);
    expect(json<{ standard: string; out: string }>(dslRun)).toMatchObject({
      standard: 'ASAM OpenSCENARIO DSL 2.2.0',
      out: osc,
    });
    expect(await readFile(osc, 'utf8')).toContain('import osc.standard');
  }, 180_000);

  it('validates the worked example clean', async () => {
    const run = await simforge('template', 'validate', LTAP);
    expect(run.code).toBe(0);
    const payload = json<{ ok: boolean; counts: { error: number } }>(run);
    expect(payload.ok).toBe(true);
    expect(payload.counts.error).toBe(0);
  });

  it('answers a structured location query with handles and road anchors', async () => {
    const run = await simforge(
      'locations',
      'find',
      '--map',
      MAP,
      '--type',
      'junction_movement',
      '--facts',
      'turn_relation=Left',
      '--limit',
      '5',
    );
    expect(run.code).toBe(0);
    const payload = json<{ results: Array<{ handle: string; roadAnchor: { rsl: string } | null; matchedReasons: string[] }> }>(run);
    expect(payload.results.length).toBeGreaterThan(0);
    for (const r of payload.results) {
      expect(r.handle).toMatch(/\//);
      expect(r.roadAnchor?.rsl).toBeTruthy();
      expect(r.matchedReasons.length).toBeGreaterThan(0);
    }
  });

  it('resolves free text to ranked handles', async () => {
    const run = await simforge('locations', 'resolve', '--map', MAP, 'the intersection on el camino real');
    expect(run.code).toBe(0);
    const payload = json<{ results: Array<{ handle: string; score: number }> }>(run);
    expect(payload.results.length).toBeGreaterThan(0);
  });

  it('matches sites and then runs one all the way to a verdict', async () => {
    const match = await simforge('sites', 'match', LTAP, '--map', MAP);
    expect(match.code).toBe(0);
    const sites = json<{ maps: Array<{ sites: Array<{ siteId: string; score: number }> }> }>(match)
      .maps[0]!.sites;
    expect(sites.length).toBeGreaterThan(0);

    const instanceFile = path.join(tmp, 'cell.instance.json');
    const traceFile = path.join(tmp, 'cell.trace.json.gz');

    const inst = await simforge(
      'instantiate',
      LTAP,
      '--map',
      MAP,
      '--site',
      sites[0]!.siteId,
      '--draw',
      '0',
      '--out',
      instanceFile,
    );
    expect([0, 2]).toContain(inst.code);
    expect(existsSync(instanceFile)).toBe(true);
    const instance = json<{ manifest: { replayKey: { siteId: string }; arrival: unknown[] } }>(inst);
    expect(instance.manifest.replayKey.siteId).toBe(sites[0]!.siteId);
    expect(instance.manifest.arrival.length).toBe(1);

    const sim = await simforge('simulate', instanceFile, '--trace', traceFile);
    expect([0, 2]).toContain(sim.code);
    expect(existsSync(traceFile)).toBe(true);
    const simulated = json<{ metrics: { minTTC: { value: number } | null }; traceDigest: string }>(sim);
    expect(simulated.metrics.minTTC).not.toBeNull();
    expect(simulated.traceDigest).toMatch(/^[0-9a-f]{64}$/);

    const evaluated = await simforge('evaluate', traceFile);
    expect([0, 2]).toContain(evaluated.code);
    const verdict = json<{ verdict: string; band: string }>(evaluated);
    expect(['accept', 'reject']).toContain(verdict.verdict);
    expect(verdict.band).toBeTruthy();
  });

  it('verifies instance/trace evidence hashes and actor ids, and fails stale/tampered pairs', async () => {
    const match = await simforge('sites', 'match', LTAP, '--map', MAP);
    expect(match.code).toBe(0);
    const siteId = json<{ maps: Array<{ sites: Array<{ siteId: string }> }> }>(match).maps[0]!.sites[0]!.siteId;
    const instanceFile = path.join(tmp, 'evidence.instance.json');
    const traceFile = path.join(tmp, 'evidence.trace.json.gz');

    const inst = await simforge('instantiate', LTAP, '--map', MAP, '--site', siteId, '--draw', '0', '--out', instanceFile);
    expect([0, 2]).toContain(inst.code);
    const sim = await simforge('simulate', instanceFile, '--trace', traceFile);
    expect([0, 2]).toContain(sim.code);

    const ok = await simforge('evidence', 'verify', instanceFile, traceFile);
    expect(ok.code).toBe(0);
    const okPayload = json<{ ok: boolean; actorCount: number; issues: Array<{ code: string }> }>(ok);
    expect(okPayload.ok).toBe(true);
    expect(okPayload.actorCount).toBeGreaterThan(0);
    expect(okPayload.issues).toEqual([]);

    const tamperedInstanceFile = path.join(tmp, 'evidence-tampered.instance.json');
    const tampered = JSON.parse(await readFile(instanceFile, 'utf8'));
    tampered.input.actors[0].initial.speedMps += 0.5;
    await writeFile(tamperedInstanceFile, `${JSON.stringify(tampered, null, 2)}\n`, 'utf8');
    const tamperedRun = await simforge('evidence', 'verify', tamperedInstanceFile, traceFile);
    expect(tamperedRun.code).toBe(2);
    expect(json<{ issues: Array<{ code: string }> }>(tamperedRun).issues.map((i) => i.code)).toContain('instance_input_hash_mismatch');

    const trace = await readTraceFile(traceFile);
    const badHashTrace = path.join(tmp, 'evidence-bad-hash.trace.json.gz');
    await writeTraceFile(badHashTrace, { ...trace, header: { ...trace.header, inputHash: '0'.repeat(64) } });
    const badHash = await simforge('evidence', 'verify', instanceFile, badHashTrace);
    expect(badHash.code).toBe(2);
    expect(json<{ issues: Array<{ code: string }> }>(badHash).issues.map((i) => i.code)).toContain('trace_input_hash_mismatch');

    const missingActorTrace = path.join(tmp, 'evidence-missing-actor.trace.json.gz');
    await writeTraceFile(missingActorTrace, {
      ...trace,
      header: { ...trace.header, actorIds: trace.header.actorIds.slice(0, -1) },
    });
    const missingActor = await simforge('evidence', 'verify', instanceFile, missingActorTrace);
    expect(missingActor.code).toBe(2);
    expect(json<{ issues: Array<{ code: string }> }>(missingActor).issues.map((i) => i.code)).toContain('trace_actor_ids_mismatch');

    const extraActorTrace = path.join(tmp, 'evidence-extra-actor.trace.json.gz');
    await writeTraceFile(extraActorTrace, {
      ...trace,
      header: { ...trace.header, actorIds: [...trace.header.actorIds, '__ghost'].sort() },
    });
    const extraActor = await simforge('evidence', 'verify', instanceFile, extraActorTrace);
    expect(extraActor.code).toBe(2);
    expect(json<{ issues: Array<{ code: string }> }>(extraActor).issues.map((i) => i.code)).toContain('trace_actor_ids_mismatch');
  }, 240_000);

  it('runs tier-2 validation with invariant residuals', async () => {
    const run = await simforge('validate', LTAP, '--tier', '2', '--map', MAP, '--draw', '0');
    expect([0, 2]).toContain(run.code);
    const payload = json<{ invariants: Array<{ id: string; status: string }> }>(run);
    expect(payload.invariants.map((i) => i.id)).toContain('criticality');
    expect(payload.invariants.map((i) => i.id)).toContain('arrival-band');
  });

  it('runs a resumable batch and reproduces every cell on the second pass', async () => {
    const out = path.join(tmp, 'batch');
    const first = await simforge('batch', LTAP, '--map', MAP, '--draws', '2', '--out', out, '--concurrency', '2');
    expect(first.code).toBe(0);
    const a = json<{ cells: number; resumed: number; results: Array<{ traceDigest: string; instanceId: string }> }>(first);
    expect(a.cells).toBeGreaterThan(0);
    expect(a.resumed).toBe(0);

    const second = await simforge('batch', LTAP, '--map', MAP, '--draws', '2', '--out', out, '--concurrency', '2');
    expect(second.code).toBe(0);
    const b = json<{ cells: number; resumed: number; results: Array<{ traceDigest: string; instanceId: string }> }>(second);
    expect(b.resumed).toBe(b.cells);
    expect(b.results.map((r) => r.traceDigest)).toEqual(a.results.map((r) => r.traceDigest));

    const forced = await simforge('batch', LTAP, '--map', MAP, '--draws', '2', '--out', out, '--force', '--concurrency', '2');
    expect(forced.code).toBe(0);
    const c = json<{ resumed: number; results: Array<{ traceDigest: string }> }>(forced);
    expect(c.resumed).toBe(0);
    // Recomputed from scratch, in a different worker, and byte-identical.
    expect(c.results.map((r) => r.traceDigest)).toEqual(a.results.map((r) => r.traceDigest));
  }, 240_000);
});
