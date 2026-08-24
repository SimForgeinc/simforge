import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { exportOpenScenarioXml13Esmini } from '../../openscenario/src/export/index.js';
import { buildLaneGraph, parseSimScenarioInput, runSimulation, type SimScenarioInput, type TopologyIndex } from '../../sim-engine/src/index.js';
import { compareNormalizedTraces, normalizeCanonicalTrace, normalizeExternalTrace } from '../../trace-comparator/src/index.js';
import { parseEsminiCsv } from '../src/esmini-csv.js';
import { createVerifiedMacOsLocalExecutor } from '../src/runner.js';

const binaryArg = process.argv[2];
const sourceXodrArg = process.argv[3];
if (!binaryArg || !sourceXodrArg) {
  throw new Error('Usage: tsx run-pinned-capability-probe.ts /path/to/esmini /path/to/straight_500m.xodr');
}
const binary = path.resolve(binaryArg);
const sourceXodr = path.resolve(sourceXodrArg);
const expectedXodrSha256 = 'af763016da63ab2f072e8a6d340bd0136b77c34eb9d6ea7b62db728e07430b5b';
const sha256 = (value: string | Uint8Array): string => createHash('sha256').update(value).digest('hex');

await createVerifiedMacOsLocalExecutor(binary);
const root = await mkdtemp(path.join(os.tmpdir(), 'simforge-esmini-capability-'));
const xodr = path.join(root, 'straight_500m.xodr');
const sourceXodrBytes = await readFile(sourceXodr);
const sourceXodrSha256 = sha256(sourceXodrBytes);
if (sourceXodrSha256 !== expectedXodrSha256) {
  throw new Error(`Pinned straight_500m.xodr digest mismatch: expected ${expectedXodrSha256}, got ${sourceXodrSha256}`);
}
await writeFile(xodr, sourceXodrBytes);

const graph = buildLaneGraph({
  schemaVersion: 1,
  mapName: 'straight-500m',
  source: { xodrSha256: sourceXodrSha256 },
  lanes: {
    '1:0:-1': {
      rsl: '1:0:-1', roadId: 1, section: 0, laneId: -1, laneType: 'driving',
      isJunction: false, junctionId: null, predecessors: [], successors: [],
      speedLimitKph: null, representativeWidthM: 3.07,
      widthSamples: [{ s: 0, widthM: 3.07 }], adjacentLanes: null,
      laneChangePermissions: [], polyline: [{ x: 0, y: -1.535 }, { x: 500, y: -1.535 }],
    },
  },
  gates: [],
  junctions: {},
} satisfies TopologyIndex);

const rules = { obeySignals: true, yield: false, yieldToVehicles: false, yieldToPedestrians: false, collisionAvoidance: false, aggression: 1, speedFactor: 1 };
const input = parseSimScenarioInput({
  mapId: 'straight-500m', clipSeconds: 20, warmupSeconds: 0, dt: 0.02,
  physics: { mode: 'kinematic-v1' }, metricSubject: 'ego',
  actors: [
    {
      id: 'ego', kind: 'vehicle', dims: { l: 4.5, w: 1.8, h: 1.5 },
      initial: { pose: { x: 10, z: 1.535, headingRad: 0 }, speedMps: 8 },
      behavior: { route: { kind: 'lanePath', lanes: ['1:0:-1'] }, rules },
    },
    {
      id: 'blocker', kind: 'vehicle', dims: { l: 4.5, w: 1.8, h: 1.5 },
      initial: { pose: { x: 25, z: 1.535, headingRad: 0 }, speedMps: 0 },
      behavior: { route: { kind: 'lanePath', lanes: ['1:0:-1'] }, rules },
    },
  ],
  props: [], interactions: [], occlusionPairs: [], signalPrograms: [],
} satisfies SimScenarioInput);
const canonical = runSimulation(input, { graph }).trace;
const canonicalCollisions = canonical.metrics.collisions;
if (canonicalCollisions.length !== 1) {
  throw new Error(`Capability fixture must produce exactly one canonical collision, got ${canonicalCollisions.length}`);
}

const exported = exportOpenScenarioXml13Esmini(input, {
  graph,
  executionMode: 'trajectory-replay',
  esminiMode: 'deterministic-trajectory',
  roadFile: 'straight_500m.xodr',
  headerDate: '1970-01-01T00:00:00.000Z',
});
const scenario = path.join(root, 'collision.xosc');
const csv = path.join(root, 'collision.csv');
const log = path.join(root, 'collision.log');
await writeFile(scenario, exported.content, 'utf8');

const args = ['--osc', scenario, '--headless', '--fixed_timestep', '0.02', '--traj_filter', '0', '--collision', '--csv_logger', csv, '--logfile_path', log];
const execution = await new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
  const child = spawn(binary, args, { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (chunk: string) => { stdout += chunk; });
  child.stderr.on('data', (chunk: string) => { stderr += chunk; });
  child.on('error', reject);
  child.on('close', (code) => resolve({ code, stdout, stderr }));
});
if (execution.code !== 0) throw new Error(`esmini exited ${execution.code}: ${execution.stderr || execution.stdout}`);

const csvText = await readFile(csv, 'utf8');
const normalizedCsv = csvText.replace(/^Scenario File Name:.*$/mu, 'Scenario File Name: collision.xosc');
const parsed = parseEsminiCsv(csvText, {
  durationS: input.clipSeconds,
  expectedVersion: '3.6.0',
  entityIdMap: { actor_ego: 'ego', actor_blocker: 'blocker' },
});
const externalRaw = {
  ...parsed,
  entities: parsed.entities.map((entity) => ({
    ...entity,
    samples: entity.samples.map((sample) => ({
      ...sample,
      roadId: sample.laneId === null ? null : '1',
      laneRsl: sample.laneId === null ? null : `1:0:${sample.laneId}`,
    })),
  })),
};
const normalizedExternal = normalizeExternalTrace(externalRaw, canonical.header.actorIds);
const comparison = compareNormalizedTraces(
  normalizeCanonicalTrace(canonical),
  normalizedExternal.trace,
  normalizedExternal.mapping,
  { profile: 'strict-trajectory-v1' },
);
const collision = comparison.collisionComparison.find((item) => item.pair.join('+') === 'blocker+ego');
if (!collision || collision.canonicalT === null || collision.externalT === null || (collision.onsetErrorS ?? Infinity) > input.dt + 1e-9) {
  throw new Error(`External collision evidence failed the one-step gate: ${JSON.stringify(collision)}`);
}

// esmini 3.6.0's wide CSV is the runner's strict, versioned evidence adapter.
// It contains actor motion/lane occupancy and collision_ids, but no traffic-
// signal identity or state field. The compatibility exporter therefore labels
// signal programs trajectory-baked and motion-only. Do not infer a signal edge
// from a stopped trajectory: that proves motion, not signal execution.
const header = csvText.split(/\r?\n/u).find((line) => line.includes('TimeStamp [s]')) ?? '';
const csvSignalFields = header.split(',').filter((field) => /traffic|signal|light.*state/iu.test(field));
if (csvSignalFields.length > 0) {
  throw new Error(`Unexpected signal evidence fields require a reviewed adapter: ${csvSignalFields.join(', ')}`);
}

const digests = {
  binarySha256: sha256(await readFile(binary)),
  inputSha256: sha256(JSON.stringify(input)),
  scenarioSha256: sha256(exported.content),
  normalizedOutputCsvSha256: sha256(normalizedCsv),
};
const receipt = {
  schema: 'uniscenarios.esmini-collision-receipt/v1',
  recordedDate: '2026-08-03',
  runner: {
    tag: 'v3.6.0',
    sourceRevision: '131a5651737fd1e8bd5d800d8e77e89bb3178a1e',
    binarySha256: digests.binarySha256,
  },
  fixture: {
    xodrSha256: sourceXodrSha256,
    inputSha256: digests.inputSha256,
    scenarioSha256: digests.scenarioSha256,
    normalizedOutputCsvSha256: digests.normalizedOutputCsvSha256,
  },
  execution: { durationS: input.clipSeconds, fixedTimestepS: input.dt, externalExitCode: execution.code },
  collision: {
    pair: collision.pair,
    canonicalOnsetS: collision.canonicalT,
    externalOnsetS: collision.externalT,
    onsetErrorS: collision.onsetErrorS,
    toleranceS: input.dt,
    outcome: 'contact-present',
  },
  comparison: {
    verdict: comparison.verdict,
    actorCount: comparison.actorMetrics.length,
    positionP95M: comparison.globalMetrics.xyM.p95,
    headingP95Deg: comparison.globalMetrics.headingRad.p95 * 180 / Math.PI,
    speedP95Mps: comparison.globalMetrics.speedMps.p95,
    laneRslAgreement: comparison.actorMetrics.map((actor) => ({ actorId: actor.actorId, agreement: actor.laneRslAgreement })),
  },
  unobservable: { trafficSignalEdges: true, signalCausedStopLineBehavior: true, nativeOpenScenario14: true },
};
const pinnedReceipt = JSON.parse(await readFile(new URL('../evidence/esmini-3.6.0-collision-receipt.json', import.meta.url), 'utf8')) as unknown;
if (JSON.stringify(pinnedReceipt) !== JSON.stringify(receipt)) {
  throw new Error(`Pinned collision receipt does not reproduce:\n${JSON.stringify(receipt, null, 2)}`);
}

const report = {
  schema: 'uniscenarios.real-esmini-capability-probe/v1',
  runner: externalRaw.simulator,
  runnerBinaryVerified: true,
  sourceRevision: '131a5651737fd1e8bd5d800d8e77e89bb3178a1e',
  sourceXodrSha256,
  digests,
  receiptVerified: true,
  externalExitCode: execution.code,
  outputDirectory: root,
  collision: {
    disposition: 'externally-observable',
    pair: collision.pair,
    canonicalOnsetS: collision.canonicalT,
    externalOnsetS: collision.externalT,
    onsetErrorS: collision.onsetErrorS,
    toleranceS: input.dt,
    outcome: 'contact-present',
  },
  trafficSignals: {
    disposition: 'unsupported-fail-closed',
    reason: 'esmini 3.6.0 CSV has no traffic-signal identity/state channel and the XML 1.3 compatibility profile promises motion-only replay for signal programs; stop-line motion cannot prove signal causality.',
    csvSignalFields,
    nativeOpenScenario14: 'unsupported',
    stopLineBehavior: 'not-externally-attributable-to-signal-state',
  },
  comparison: {
    verdict: comparison.verdict,
    actorCount: comparison.actorMetrics.length,
    positionP95M: comparison.globalMetrics.xyM.p95,
    headingP95Deg: comparison.globalMetrics.headingRad.p95 * 180 / Math.PI,
    speedP95Mps: comparison.globalMetrics.speedMps.p95,
    laneRslAgreement: comparison.actorMetrics.map((actor) => ({ actorId: actor.actorId, agreement: actor.laneRslAgreement })),
    collisionEdges: comparison.collisionComparison,
    signalEdges: comparison.signalComparison,
    findings: comparison.findings,
  },
};
process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
if (comparison.verdict !== 'pass') process.exitCode = 1;
