import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

function option(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  if (index === -1) return undefined;
  const value = process.argv[index + 1];
  if (!value || value.startsWith('--')) throw new Error(`${name} requires a value`);
  return value;
}

function hash(value: string | Uint8Array): string {
  return createHash('sha256').update(value).digest('hex');
}

function firstDifference(left: unknown, right: unknown, location = '$'): string | null {
  if (Object.is(left, right)) return null;
  if (typeof left !== typeof right || left === null || right === null) return location;
  if (typeof left !== 'object') return location;
  if (Array.isArray(left) !== Array.isArray(right)) return location;
  const leftObject = left as Record<string, unknown>;
  const rightObject = right as Record<string, unknown>;
  const keys = [...new Set([...Object.keys(leftObject), ...Object.keys(rightObject)])].sort();
  for (const key of keys) {
    const difference = firstDifference(leftObject[key], rightObject[key], `${location}.${key}`);
    if (difference) return difference;
  }
  return null;
}

async function main(): Promise<void> {
const platformArg = option('--platform-root') ?? process.env.SIMCLOUD_PLATFORM_ROOT;
if (!platformArg) throw new Error('Usage: compare-engine-behavior.ts --platform-root <path> [--out <file>] [--require-parity]');
const platformRoot = path.resolve(platformArg);

const upstream = await import(pathToFileURL(path.join(repoRoot, 'packages/engine/src/index.ts')).href);
const product = await import(pathToFileURL(path.join(platformRoot, 'packages/scenario-sim-engine/src/index.ts')).href);
const topologyFixture = await import(pathToFileURL(path.join(repoRoot, 'packages/engine/src/__tests__/fixtures/synthetic-map.ts')).href);
const topology = topologyFixture.syntheticTopology();

const fixtures = [
  {
    id: 'lane-cruise',
    input: {
      mapId: 'synthetic-straight', clipSeconds: 3, warmupSeconds: 0, dt: 0.02, seed: 'parity-lane-cruise',
      actors: [{
        id: 'ego', kind: 'car',
        initial: { laneRef: { rsl: '1:0:-1', s: 10 }, pose: { x: 10, z: 0, headingRad: 0 }, speedMps: 6 },
        behavior: { route: { kind: 'lanePath', lanes: ['1:0:-1', '2:0:-1'] }, cruiseSpeedMps: 6 },
      }],
      interactions: [],
    },
  },
  {
    id: 'freeform-custom-route',
    input: {
      mapId: 'synthetic-straight', clipSeconds: 4, warmupSeconds: 0, dt: 0.02, seed: 'parity-custom-route',
      actors: [{
        id: 'actor', kind: 'sidewalk_robot',
        initial: { pose: { x: 0, z: 5, headingRad: 0 }, speedMps: 1.2 },
        behavior: {
          route: { kind: 'polyline', points: [{ x: 0, z: 5 }, { x: 30, z: 5 }] },
          cruiseSpeedMps: 1.2,
          rules: { collisionAvoidance: false, yield: false },
        },
      }],
      interactions: [{
        id: 'route', actorId: 'actor', trigger: { kind: 'at', t: 0.8 }, verb: 'route',
        target: { kind: 'polyline', points: [{ x: 2, z: 5 }, { x: 20, z: 12 }] },
        joinFromCurrentPose: true, bestEffortWorldPath: true,
      }],
    },
  },
] as const;

const results = fixtures.map((fixture) => {
  const upstreamGraph = upstream.buildLaneGraph(structuredClone(topology));
  const productGraph = product.buildLaneGraph(structuredClone(topology));
  const upstreamResult = upstream.runSimulation(upstream.parseSimScenarioInput(fixture.input), { graph: upstreamGraph, guards: 'collect' });
  const productResult = product.runSimulation(product.parseSimScenarioInput(fixture.input), { graph: productGraph, guards: 'collect' });
  const upstreamTrace = upstream.serializeTrace(upstreamResult.trace);
  const productTrace = product.serializeTrace(productResult.trace);
  const upstreamIssues = JSON.stringify(upstreamResult.issues);
  const productIssues = JSON.stringify(productResult.issues);
  const upstreamTraceSha256 = hash(upstreamTrace);
  const productTraceSha256 = hash(productTrace);
  const upstreamIssuesSha256 = hash(upstreamIssues);
  const productIssuesSha256 = hash(productIssues);
  return {
    id: fixture.id,
    parity: upstreamTraceSha256 === productTraceSha256 && upstreamIssuesSha256 === productIssuesSha256,
    trace: {
      simforgeSha256: upstreamTraceSha256,
      simcloudSha256: productTraceSha256,
      firstDifference: firstDifference(upstreamResult.trace, productResult.trace),
    },
    issues: {
      simforgeSha256: upstreamIssuesSha256,
      simcloudSha256: productIssuesSha256,
      simforgeCodes: upstreamResult.issues.map((issue: { code: string }) => issue.code),
      simcloudCodes: productResult.issues.map((issue: { code: string }) => issue.code),
      firstDifference: firstDifference(upstreamResult.issues, productResult.issues),
    },
  };
});

const report = {
  schema: 'uniscenarios.engine-parity/v1',
  revisions: {
    simforge: (await import('node:child_process')).execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repoRoot, encoding: 'utf8' }).trim(),
    simcloud: (await import('node:child_process')).execFileSync('git', ['rev-parse', 'HEAD'], { cwd: platformRoot, encoding: 'utf8' }).trim(),
  },
  parity: results.every((result) => result.parity),
  results,
};

const serialized = `${JSON.stringify(report, null, 2)}\n`;
const outputArg = option('--out');
if (outputArg) {
  const output = path.resolve(repoRoot, outputArg);
  await mkdir(path.dirname(output), { recursive: true });
  await writeFile(output, serialized, 'utf8');
  process.stdout.write(`${path.relative(repoRoot, output)}\n`);
} else {
  process.stdout.write(serialized);
}
if (process.argv.includes('--require-parity') && !report.parity) process.exitCode = 1;
}

void main();
