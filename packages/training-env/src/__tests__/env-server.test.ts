/**
 * Env-server integration test: a real unix socket, N=4 in-process sessions,
 * batched steps, and the determinism identity — two server runs fed the same
 * spec, seeds and action stream must return byte-identical response frames.
 */
import { createHash } from 'node:crypto';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import net from 'node:net';

import { decode, encode } from '@msgpack/msgpack';
import { afterAll, describe, expect, it } from 'vitest';

import { LANE_LEFT, LANE_RIGHT, scenario, syntheticGraph, syntheticTopology, vehicle } from '../fixture.js';
import { EnvServer, loadEpisodeSpec, serveSocket } from '../env-server.js';
import type { SimScenarioInput } from '@simforge/engine';

const graph = syntheticGraph();
const topology = syntheticTopology();

function twoCarInput(): SimScenarioInput {
  return scenario(graph, {
    physics: { mode: 'kinematic-v1' },
    metricSubject: 'ego',
    clipSeconds: 4,
    warmupSeconds: 1,
    actors: [
      vehicle(graph, { id: 'ego', rsl: LANE_LEFT, s: 20, speedMps: 10, cruiseSpeedMps: 10 }),
      vehicle(graph, { id: 'other', rsl: LANE_RIGHT, s: 40, speedMps: 8, cruiseSpeedMps: 8 }),
    ],
  });
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

/** One framed request/response exchange over a live socket connection. */
class FrameClient {
  private socket: net.Socket | null = null;
  private backlog = Buffer.alloc(0);
  private readonly pending: Array<(value: Record<string, unknown>) => void> = [];
  private nextId = 1;
  /** Raw response frames, captured for byte-level determinism comparison. */
  readonly rawFrames: Buffer[] = [];

  async connect(socketPath: string): Promise<void> {
    this.socket = net.connect(socketPath);
    this.socket.on('data', (chunk: Buffer) => {
      this.backlog = Buffer.concat([this.backlog, chunk]);
      for (;;) {
        if (this.backlog.length < 4) return;
        const length = this.backlog.readUInt32LE(0);
        if (this.backlog.length < 4 + length) return;
        const frame = Buffer.from(this.backlog.subarray(4, 4 + length));
        this.rawFrames.push(frame);
        this.backlog = this.backlog.subarray(4 + length);
        this.pending.shift()!(decode(frame) as Record<string, unknown>);
      }
    });
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
    this.socket!.write(Buffer.concat([header, Buffer.from(payload)]));
    return promise;
  }

  end(): void {
    this.socket?.destroy();
  }
}

interface ServerHandle {
  socketPath: string;
  close: () => Promise<void>;
}

async function startServer(): Promise<ServerHandle> {
  const dir = await mkdtemp(path.join(tmpdir(), 'env-server-test-'));
  const specPath = path.join(dir, 'episodes.json');
  await writeFile(
    specPath,
    JSON.stringify({ version: 1, instances: Array.from({ length: 4 }, () => ({ input: twoCarInput(), topology })) }),
  );
  const { episodes } = await loadEpisodeSpec(specPath);
  const socketPath = path.join(dir, 'env.sock');
  const listener = serveSocket(new EnvServer({ episodes, episode: { decisionHz: 10 } }), socketPath);
  const { promise, resolve } = deferred<void>();
  listener.once('listening', resolve);
  await promise;
  return {
    socketPath,
    close: () => new Promise((resolve) => listener.close(() => resolve())),
  };
}

/** The scripted rollout every server run must reproduce byte-for-byte. */
async function scriptedRollout(socketPath: string): Promise<Buffer[]> {
  const client = new FrameClient();
  await client.connect(socketPath);
  const hello = await client.request('hello');
  expect(hello['ok']).toBe(1);

  const seeds = ['seed-0', 'seed-1', 'seed-2', 'seed-3'];
  const resetAll = await client.request('reset_all', { seeds });
  expect(resetAll['ok']).toBe(1);

  // K=8 batched decisions cycling the four sessions, deterministic actions.
  const batch: Array<[number, Record<string, unknown>]> = [];
  for (let k = 0; k < 8; k += 1) {
    const session = k % 4;
    const action = k < 4 ? { ts: 9 } : { ta: -1 };
    batch.push([session, action]);
  }
  const batched = await client.request('batch_step', { as: batch });
  expect(batched['ok']).toBe(1);

  // Single-step path on session 0 as well.
  const single = await client.request('step', { s: 0, a: { ts: 8 } });
  expect(single['ok']).toBe(1);

  const unknownOp = await client.request('teleport', {});
  expect(unknownOp['ok']).toBe(0);
  const close = await client.request('close');
  expect(close['r']).toEqual({ bye: true });
  client.end();
  return client.rawFrames;
}

describe('env-server over a real unix socket', () => {
  const servers: ServerHandle[] = [];

  afterAll(async () => {
    await Promise.all(servers.map((server) => server.close()));
  });

  it('serves N=4 sessions with batched steps and is byte-deterministic across runs', async () => {
    servers.push(await startServer(), await startServer());
    const first = await scriptedRollout(servers[0]!.socketPath);
    const second = await scriptedRollout(servers[1]!.socketPath);

    expect(first.length).toBe(second.length);
    const digest = (frames: Buffer[]): string =>
      createHash('sha256').update(Buffer.concat(frames)).digest('hex');
    expect(digest(second)).toBe(digest(first));

    // The batch reply carries K=8 results in request order.
    const batchFrame = decode(first[2]!) as { r: { rs: Array<Record<string, unknown>> } };
    expect(batchFrame.r.rs).toHaveLength(8);
    for (let k = 0; k < 8; k += 1) {
      const result = batchFrame.r.rs[k]!;
      expect(result['t']).toBeCloseTo((Math.floor(k / 4) + 1) / 10, 10);
      expect(Array.isArray(result['sv'])).toBe(false); // bin payload, not an array
    }

    // reset_all returned N=4 results in session order with the requested seeds.
    const resetFrame = decode(first[1]!) as { r: { rs: Array<Record<string, unknown>> } };
    expect(resetFrame.r.rs).toHaveLength(4);
    for (const result of resetFrame.r.rs) expect(result['t']).toBe(0);
  });

  it('rejects a spec declaring both episode forms', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'env-server-test-'));
    const specPath = path.join(dir, 'bad.json');
    await writeFile(specPath, JSON.stringify({ instances: [{ input: twoCarInput(), topology }], seeds: ['x'] }));
    await expect(loadEpisodeSpec(specPath)).rejects.toThrow(/exactly one/);
  });
});

