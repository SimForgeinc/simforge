import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';

import { exportOpenScenarioXml13Esmini } from '../../openscenario/src/export/index.js';
import { buildLaneGraph, parseSimScenarioInput, runSimulation, type TopologyIndex } from '../../sim-engine/src/index.js';
import { compareNormalizedTraces, normalizeCanonicalTrace, normalizeExternalTrace } from '../../trace-comparator/src/index.js';
import { parseEsminiCsv } from '../src/esmini-csv.js';
import { createVerifiedMacOsLocalExecutor } from '../src/runner.js';

const binaryArg = process.argv[2];
const sourceXodrArg = process.argv[3];
if (!binaryArg || !sourceXodrArg) throw new Error('Usage: tsx run-pinned-trajectory-smoke.ts /path/to/esmini /path/to/straight_500m.xodr');
const binary = path.resolve(binaryArg);
const sourceXodr = path.resolve(sourceXodrArg);
const expectedXodrSha256 = 'af763016da63ab2f072e8a6d340bd0136b77c34eb9d6ea7b62db728e07430b5b';

// Hash verification is a mandatory precondition even though this compact smoke
// invokes the process directly to retain its exact stdout/stderr and CSV path.
await createVerifiedMacOsLocalExecutor(binary);
const root = await mkdtemp(path.join(os.tmpdir(), 'uniscenarios-real-esmini-'));
const xodr = path.join(root, 'straight_500m.xodr');
const sourceXodrBytes = await readFile(sourceXodr);
const sourceXodrSha256 = createHash('sha256').update(sourceXodrBytes).digest('hex');
if (sourceXodrSha256 !== expectedXodrSha256) {
  throw new Error(`Pinned straight_500m.xodr digest mismatch: expected ${expectedXodrSha256}, got ${sourceXodrSha256}`);
}
await writeFile(xodr, sourceXodrBytes);

const graph = buildLaneGraph({
  schemaVersion: 1, mapName: 'straight-500m', source: { xodrSha256: sourceXodrSha256 },
  lanes: {
    '1:0:-1': {
      rsl: '1:0:-1', roadId: 1, section: 0, laneId: -1, laneType: 'driving',
      isJunction: false, junctionId: null, predecessors: [], successors: [],
      speedLimitKph: null, representativeWidthM: 3.07,
      widthSamples: [{ s: 0, widthM: 3.07 }], adjacentLanes: null,
      laneChangePermissions: [], polyline: [{ x: 0, y: -1.535 }, { x: 500, y: -1.535 }],
    },
  },
  gates: [], junctions: {},
} satisfies TopologyIndex);
const input = parseSimScenarioInput({
  mapId: 'straight-500m', clipSeconds: 20, warmupSeconds: 0, dt: 0.02,
  physics: { mode: 'kinematic-v1' }, metricSubject: 'ego',
  actors: [{
    id: 'ego', kind: 'vehicle', dims: { l: 4.5, w: 1.8, h: 1.5 },
    initial: { pose: { x: 10, z: 1.535, headingRad: 0 }, speedMps: 5 },
    behavior: { route: { kind: 'lanePath', lanes: ['1:0:-1'] } },
  }],
  props: [], interactions: [], occlusionPairs: [], signalPrograms: [],
});
const canonical = runSimulation(input, { graph }).trace;
const exported = exportOpenScenarioXml13Esmini(input, {
  graph, executionMode: 'trajectory-replay', esminiMode: 'deterministic-trajectory',
  roadFile: 'straight_500m.xodr', headerDate: '1970-01-01T00:00:00.000Z',
});
const scenario = path.join(root, 'scenario.xosc');
const csv = path.join(root, 'replay.csv');
const log = path.join(root, 'esmini.log');
await writeFile(scenario, exported.content, 'utf8');

const args = ['--osc', scenario, '--headless', '--fixed_timestep', '0.02', '--traj_filter', '0', '--collision', '--csv_logger', csv, '--logfile_path', log];
const execution = await new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
  const child = spawn(binary, args, { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '', stderr = '';
  child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
  child.stdout.on('data', (chunk: string) => { stdout += chunk; });
  child.stderr.on('data', (chunk: string) => { stderr += chunk; });
  child.on('error', reject);
  child.on('close', (code) => resolve({ code, stdout, stderr }));
});
if (execution.code !== 0) throw new Error(`esmini exited ${execution.code}: ${execution.stderr || execution.stdout}`);

const parsedExternalRaw = parseEsminiCsv(await readFile(csv, 'utf8'), {
  durationS: 20, expectedVersion: '3.6.0', entityIdMap: { actor_ego: 'ego' },
});
// esmini's CSV exposes lane_id and lane_offset but omits road/section IDs. This
// smoke uses one digest-pinned road and section, so those identities are exact.
const externalRaw = {
  ...parsedExternalRaw,
  entities: parsedExternalRaw.entities.map((entity) => ({
    ...entity,
    samples: entity.samples.map((sample) => ({
      ...sample,
      roadId: sample.laneId === null ? null : '1',
      laneRsl: sample.laneId === null ? null : `1:0:${sample.laneId}`,
    })),
  })),
};
const canonicalNormalized = normalizeCanonicalTrace(canonical);
const externalNormalized = normalizeExternalTrace(externalRaw, canonical.header.actorIds);
const comparison = compareNormalizedTraces(canonicalNormalized, externalNormalized.trace, externalNormalized.mapping, {
  profile: 'strict-trajectory-v1',
});
const report = {
  schema: 'uniscenarios.real-esmini-smoke/v1',
  runner: externalRaw.simulator,
  runnerBinaryVerified: true,
  sourceRevision: '131a5651737fd1e8bd5d800d8e77e89bb3178a1e',
  sourceXodrSha256,
  exercisedSemantics: ['trajectory replay', 'road/lane occupancy'],
  unexercisedSemantics: ['traffic signals', 'storyboard events', 'collisions'],
  externalExitCode: execution.code,
  externalCompleted: externalRaw.completed,
  outputDirectory: root,
  comparison: {
    verdict: comparison.verdict,
    actorCount: comparison.actorMetrics.length,
    positionRmseM: comparison.globalMetrics.xyM.rmse,
    positionP95M: comparison.globalMetrics.xyM.p95,
    positionMaxM: comparison.globalMetrics.xyM.max,
    headingP95Deg: comparison.globalMetrics.headingRad.p95 * 180 / Math.PI,
    speedP95Mps: comparison.globalMetrics.speedMps.p95,
    presenceAgreement: comparison.globalMetrics.presenceAgreement,
    laneRslAgreement: comparison.actorMetrics[0]?.laneRslAgreement ?? null,
    collisionEdges: comparison.collisionComparison.length,
    signalEdges: comparison.signalComparison.length,
    findings: comparison.findings,
  },
};
process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
if (comparison.verdict !== 'pass') process.exitCode = 1;
