/**
 * Env-server transport benchmark: batched-step round-trip latency at K=8
 * with state-vector observations, over a real unix socket, against the
 * Phase-0 five-actor scenario conventions.
 *
 * Run from the package directory: `npx tsx src/bench/env-server-bench.ts`.
 */
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import net from 'node:net';

import { decode, encode } from '@msgpack/msgpack';

import { LANE_LEFT, LANE_RIGHT, scenario, syntheticGraph, syntheticTopology, vehicle } from '../fixture.js';
import { EnvServer, loadEpisodeSpec, serveSocket } from '../env-server.js';
import type { SimScenarioInput } from '@simforge-oss/engine';

const BATCH_K = 8;
const WARMUP_BATCHES = 20;
const MEASURED_BATCHES = 400;

const graph = syntheticGraph();
const topology = syntheticTopology();

function benchScenario(): SimScenarioInput {
  return scenario(graph, {
    physics: { mode: 'dynamic-v1' },
    metricSubject: 'car-0',
    warmupSeconds: 2,
    clipSeconds: 400,
    actors: Array.from({ length: 5 }, (_, i) =>
      vehicle(graph, {
        id: `car-${i}`,
        rsl: i % 2 === 0 ? LANE_LEFT : LANE_RIGHT,
        s: 20 + i * 15,
        speedMps: 8 + (i % 4),
        cruiseSpeedMps: 9 + (i % 3),
      })),
  });
}

function percentile(sorted: readonly number[], q: number): number {
  return sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))]!;
}

/** ES2022 lib has no Promise.withResolvers; a local deferred keeps call sites linear. */
function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void; reject: (error: unknown) => void } {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

class LatencyClient {
  private readonly socket: net.Socket;
  private backlog = Buffer.alloc(0);
  private readonly pending: Array<(value: Record<string, unknown>) => void> = [];
  private nextId = 1;

  constructor(socketPath: string) {
    this.socket = net.connect(socketPath);
    this.socket.on('data', (chunk: Buffer) => {
      this.backlog = Buffer.concat([this.backlog, chunk]);
      for (;;) {
        if (this.backlog.length < 4) return;
        const length = this.backlog.readUInt32LE(0);
        if (this.backlog.length < 4 + length) return;
        const frame = this.backlog.subarray(4, 4 + length);
        this.backlog = this.backlog.subarray(4 + length);
        this.pending.shift()!(decode(frame) as Record<string, unknown>);
      }
    });
  }

  async ready(): Promise<void> {
    const { promise, resolve, reject } = deferred<void>();
    this.socket.once('connect', resolve);
    this.socket.once('error', reject);
    await promise;
  }

  request(op: string, fields: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
    const payload = encode({ i: this.nextId++, op, ...fields });
    const header = Buffer.alloc(4);
    header.writeUInt32LE(payload.byteLength, 0);
    const { promise, resolve } = deferred<Record<string, unknown>>();
    this.pending.push(resolve);
    this.socket.write(Buffer.concat([header, Buffer.from(payload)]));
    return promise;
  }

  close(): void {
    this.socket.destroy();
  }
}

const N_SESSIONS = 4;

interface BenchSample {
  batchMedianUs: number;
  batchP95Us: number;
  singleMedianUs: number;
  batchPerDecisionUs: number;
  pingMedianUs: number;
}

async function measure(): Promise<BenchSample> {
  const dir = await mkdtemp(path.join(tmpdir(), 'env-server-bench-'));
  const specPath = path.join(dir, 'episodes.json');

  await writeFile(
    specPath,
    JSON.stringify({ version: 1, instances: Array.from({ length: N_SESSIONS }, () => ({ input: benchScenario(), topology })) }),
  );
  const { episodes } = await loadEpisodeSpec(specPath);
  const listener = serveSocket(new EnvServer({ episodes, episode: { decisionHz: 10 } }), path.join(dir, 'env.sock'));
  await new Promise<void>((resolve) => listener.once('listening', resolve));

  const client = new LatencyClient(path.join(dir, 'env.sock'));
  await client.ready();
  await client.request('reset_all', { seeds: Array.from({ length: N_SESSIONS }, (_, i) => `seed-${i}`) });

  const batch = Array.from({ length: BATCH_K }, (_, k) => [k % N_SESSIONS, { ts: 9 }] as const);
  const batchTimes: number[] = [];
  const singleTimes: number[] = [];
  for (let i = 0; i < WARMUP_BATCHES + MEASURED_BATCHES; i += 1) {
    const start = performance.now();
    await client.request('batch_step', { as: batch });
    const elapsed = performance.now() - start;
    if (i >= WARMUP_BATCHES) batchTimes.push(elapsed * 1000);
    if (i < WARMUP_BATCHES) await client.request('step', { s: 0, a: { ts: 9 } });
  }
  const pingTimes: number[] = [];
  for (let i = 0; i < 200; i += 1) {
    const start = performance.now();
    await client.request('ping');
    pingTimes.push((performance.now() - start) * 1000);
  }
  for (let i = 0; i < 100; i += 1) {
    const start = performance.now();
    await client.request('step', { s: 0, a: { ts: 9 } });
    singleTimes.push((performance.now() - start) * 1000);
  }

  const sortedPing = [...pingTimes].sort((a, b) => a - b);
  client.close();
  const sortedBatch = [...batchTimes].sort((a, b) => a - b);
  const sortedSingle = [...singleTimes].sort((a, b) => a - b);
  await new Promise<void>((resolve) => listener.close(() => resolve()));
  return {
    batchMedianUs: sortedBatch[Math.floor(sortedBatch.length / 2)]!,
    batchP95Us: percentile(sortedBatch, 0.95),
    pingMedianUs: sortedPing[Math.floor(sortedPing.length / 2)]!,
    singleMedianUs: sortedSingle[Math.floor(sortedSingle.length / 2)]!,
    batchPerDecisionUs: sortedBatch[Math.floor(sortedBatch.length / 2)]! / BATCH_K,
  };
}
const samples: BenchSample[] = [];
for (let i = 0; i < 3; i += 1) samples.push(await measure());
const median = (values: number[]): number => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)]!;

console.log(`| Transport (unix socket, ${N_SESSIONS} sessions, state-vector obs) | median | p95 |`);
console.log('|---|---:|---:|');
console.log(`| batch_step K=${BATCH_K} | ${median(samples.map((s) => s.batchMedianUs)).toFixed(0)} µs | ${median(samples.map((s) => s.batchP95Us)).toFixed(0)} µs |`);
console.log(`| batch_step per decision | ${median(samples.map((s) => s.batchPerDecisionUs)).toFixed(0)} µs | — |`);
console.log(`| single step | ${median(samples.map((s) => s.singleMedianUs)).toFixed(0)} µs | — |`);
console.log(`| ping round trip (framing overhead floor) | ${median(samples.map((s) => s.pingMedianUs)).toFixed(0)} µs | — |`);
