import { createHash } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import { cpus, totalmem } from 'node:os';
import { performance } from 'node:perf_hooks';
import { pathToFileURL } from 'node:url';
import { gzipSync } from 'node:zlib';

const [modulePath, networkPath] = process.argv.slice(2);
if (!modulePath || !networkPath) {
  console.error('usage: node benchmark.mjs <sumo.mjs> <grid.net.xml>');
  process.exit(2);
}

const network = await readFile(networkPath);
const wasmPath = modulePath.replace(/\.mjs$/, '.wasm');
const wasm = await readFile(wasmPath);
const moduleBytes = (await stat(wasmPath)).size;
const glueBytes = (await stat(modulePath)).size;
const compressedModuleBytes = gzipSync(wasm, { level: 9 }).byteLength;
const importedAt = performance.now();
const { default: createSumo } = await import(pathToFileURL(modulePath));
const sumo = await createSumo({ noInitialRun: true });
const factoryMilliseconds = performance.now() - importedAt;

const results = [];
for (const requestedActors of [32, 100, 500]) {
  const first = run(requestedActors, 1);
  const second = run(requestedActors, 1);
  results.push({
    requestedActors,
    actualActors: first.actualActors,
    startMilliseconds: first.startMilliseconds,
    stepP50Milliseconds: percentile(first.steps, 0.5),
    stepP95Milliseconds: percentile(first.steps, 0.95),
    stepP99Milliseconds: percentile(first.steps, 0.99),
    deterministic: first.digest === second.digest,
    heapBytes: sumo.HEAPU8.buffer.byteLength,
    residentBytes: process.memoryUsage().rss,
  });
}

console.log(JSON.stringify({
  host: { cpu: cpus()[0]?.model ?? 'unknown', logicalCpus: cpus().length, totalMemoryBytes: totalmem() },
  moduleBytes,
  compressedModuleBytes,
  glueBytes,
  factoryMilliseconds,
  results,
}, null, 2));

function run(actorCount, seed) {
  const routes = Buffer.from(routeDocument(actorCount));
  const netPointer = copy(network);
  const routePointer = copy(routes);
  const started = performance.now();
  assertOk(sumo._us_sumo_start(netPointer, network.byteLength, routePointer, routes.byteLength, 0.1, seed));
  const startMilliseconds = performance.now() - started;
  sumo._free(netPointer);
  sumo._free(routePointer);

  // Populate the 5x5 grid, then time a stable 20-second window before the
  // first full-width trips can leave the network.
  for (let index = 0; index < 450; index += 1) assertOk(sumo._us_sumo_step(0.1));
  const steps = [];
  const digest = createHash('sha256');
  let actualActors = 0;
  for (let index = 0; index < 200; index += 1) {
    const before = performance.now();
    assertOk(sumo._us_sumo_step(0.1));
    steps.push(performance.now() - before);
    actualActors = sumo._us_sumo_state_count();
    const length = actualActors * 32;
    if (length > 0) digest.update(new Uint8Array(sumo.HEAPU8.buffer, sumo._us_sumo_state_pointer(), length));
  }
  sumo._us_sumo_close();
  return { actualActors, startMilliseconds, steps, digest: digest.digest('hex') };
}

function copy(bytes) {
  const pointer = sumo._malloc(bytes.byteLength);
  sumo.HEAPU8.set(bytes, pointer);
  return pointer;
}

function assertOk(code) {
  if (code === 0) return;
  throw new Error(sumo.UTF8ToString(sumo._us_sumo_last_error()) || `SUMO failed (${code})`);
}

function percentile(values, fraction) {
  const ordered = [...values].sort((left, right) => left - right);
  return ordered[Math.min(ordered.length - 1, Math.floor(ordered.length * fraction))];
}

function routeDocument(count) {
  const pairs = [];
  for (let row = 0; row < 5; row += 1) {
    pairs.push([`left${row}A${row}`, `E${row}right${row}`]);
    pairs.push([`right${row}E${row}`, `A${row}left${row}`]);
  }
  const base = Math.floor(count / pairs.length);
  let remainder = count % pairs.length;
  const flows = pairs.map(([from, to], index) => {
    const number = base + (remainder-- > 0 ? 1 : 0);
    return `  <flow id="flow-${index}" type="browserCar" begin="0" end="40" number="${number}" from="${from}" to="${to}" departLane="best" departSpeed="max"/>`;
  }).join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>
<routes>
  <vType id="browserCar" carFollowModel="EIDM" laneChangeModel="SL2015" accel="2.6" decel="4.5" sigma="0.4" tau="1.0"/>
${flows}
</routes>`;
}
