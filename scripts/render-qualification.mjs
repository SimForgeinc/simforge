#!/usr/bin/env node

import {
  benchmark5080,
  comparePair,
  createBenchmarkSpec,
  eightCameraMatrix,
  inventoryDev,
  materializeRunBundle,
  prepareQualificationRequests,
  readJson,
  selectQualification,
} from './render-qualification-lib.mjs';

function usage() {
  return `SimForge render qualification

Commands:
  inventory --output inventory.json
    Read current nondeleted scenarios from SIMFORGE_DEV_DATABASE_URL using a
    read-only transaction. Generic DATABASE_URL is ignored by design.

  select --inventory inventory.json --output qualification.json [--count 5]
    Deterministically select coverage-diverse, hard-gated real dev scenarios.

  prepare --manifest qualification.json --output requests.json
    Emit five lineage-preserving derived-copy requests and ten deferred render
    requests (browser + CARLA) with the exact 18-sensor Pronto port-E rig.

  bundle --request-set requests.json --output-dir qualification-run
    Materialize five shared intents, lineage-preserving copy requests, and an
    exact ten-job local plan using stable --engine browser|carla commands.

  benchmark-spec --request-set requests.json --pair-id ID --engine browser|carla \\
                 --image-digest SHA256 --source-revision REV \\
                 --output-dir qualification-run --output benchmark-spec.json
    Create a concrete local RTX 5080 benchmark spec for one paired job.

  benchmark --spec benchmark-spec.json --output timing-report.json
    Run one cold and N warm local RTX 5080 iterations under an exclusive lock.
    The spec command is an argv array; no shell is used.

  compare --request-set requests.json --pair-id ID --browser result.json \\
          --carla result.json --output comparison.json
    Compare intention identity, closure, checksums, divergence, and media. Pixel
    equality is deliberately not a qualification gate.

  matrix --reports one.json,two.json,three.json,four.json,five.json --output matrix.json
    Emit the separate compact eight-camera conformance matrix.
`;
}

function parse(argv) {
  const command = argv[0];
  const options = {};
  for (let index = 1; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith('--')) throw new Error(`unexpected positional argument: ${token}`);
    const key = token.slice(2);
    const value = argv[index + 1];
    if (!value || value.startsWith('--')) throw new Error(`missing value for --${key}`);
    options[key] = value;
    index += 1;
  }
  return { command, options };
}

function required(options, name) {
  const value = options[name];
  if (!value) throw new Error(`--${name} is required`);
  return value;
}

async function main() {
  const { command, options } = parse(process.argv.slice(2));
  if (!command || command === 'help' || command === '--help') {
    process.stdout.write(usage());
    return;
  }
  if (command === 'inventory') {
    const output = required(options, 'output');
    const result = await inventoryDev({ output });
    process.stdout.write(`Wrote ${result.scenarios.length} qualifying-role-count dev inventory rows to ${output}\n`);
    return;
  }
  if (command === 'select') {
    const output = required(options, 'output');
    const result = selectQualification(readJson(required(options, 'inventory')), {
      output,
      count: options.count === undefined ? undefined : Number(options.count),
    });
    process.stdout.write(`Selected ${result.scenarios.length} deterministic qualification scenarios in ${output}\n`);
    return;
  }
  if (command === 'prepare') {
    const output = required(options, 'output');
    const result = prepareQualificationRequests(readJson(required(options, 'manifest')), { output });
    process.stdout.write(`Prepared ${result.jobCount} deferred paired jobs without live submission in ${output}\n`);
    return;
  }
  if (command === 'bundle') {
    const outputDirectory = required(options, 'output-dir');
    const result = materializeRunBundle(readJson(required(options, 'request-set')), outputDirectory);
    process.stdout.write(`Materialized ${result.jobs.length} stable-engine commands in ${outputDirectory}\n`);
    return;
  }
  if (command === 'benchmark-spec') {
    const result = createBenchmarkSpec(readJson(required(options, 'request-set')), {
      pairId: required(options, 'pair-id'),
      engine: required(options, 'engine'),
      imageDigest: required(options, 'image-digest'),
      sourceRevision: required(options, 'source-revision'),
      outputDirectory: required(options, 'output-dir'),
      output: required(options, 'output'),
    });
    process.stdout.write(`Prepared concrete ${result.id} RTX 5080 benchmark spec\n`);
    return;
  }
  if (command === 'benchmark') {
    const output = required(options, 'output');
    const result = await benchmark5080(readJson(required(options, 'spec')), { output });
    process.stdout.write(`Wrote RTX 5080 timing report ${result.reportSha256} to ${output}\n`);
    return;
  }
  if (command === 'compare') {
    const requestSet = readJson(required(options, 'request-set'));
    const pairId = required(options, 'pair-id');
    const pair = requestSet.pairs?.find((candidate) => candidate.pairId === pairId);
    if (!pair) throw new Error(`pair ${pairId} does not exist in request set`);
    const output = required(options, 'output');
    const result = comparePair(pair, readJson(required(options, 'browser')), readJson(required(options, 'carla')), { output });
    process.stdout.write(`Pair ${pairId}: ${result.passed ? 'PASS' : 'FAIL'} (${output})\n`);
    process.exitCode = result.passed ? 0 : 2;
    return;
  }
  if (command === 'matrix') {
    const paths = required(options, 'reports').split(',').filter(Boolean);
    const output = required(options, 'output');
    const result = eightCameraMatrix(paths.map(readJson), { output });
    process.stdout.write(`Eight-camera conformance: ${result.passed ? 'PASS' : 'FAIL'} (${output})\n`);
    process.exitCode = result.passed ? 0 : 2;
    return;
  }
  throw new Error(`unknown command ${command}\n\n${usage()}`);
}

main().catch((error) => {
  process.stderr.write(`render-qualification: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
