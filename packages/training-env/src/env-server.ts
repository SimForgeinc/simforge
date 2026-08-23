#!/usr/bin/env node
/**
 * uniscenarios-env-server — deterministic env-server for Gymnasium clients.
 *
 * Spins N in-process {@link EnvSession}s loaded from an episode spec and
 * serves reset/step traffic over length-prefixed msgpack frames (4-byte
 * little-endian u32 length, then one msgpack document) on a unix socket or
 * stdio. The primary path is the batched API: one round trip carries K
 * actions and returns K results, so vectorized rollout workers pay the
 * transport cost once per batch. Heavy observation payloads (state vector,
 * BEV raster) ride as packed little-endian typed arrays (`bin` fields),
 * never per-step JSON structures.
 *
 * Determinism invariant: the server emits no wall-clock data anywhere in the
 * protocol — same spec, same action stream, byte-identical responses.
 *
 * Wire protocol (msgpack maps, compact keys):
 *
 *   request   {i: u64 id, op: string, ...}
 *   response  {i, ok: 1, r: payload} | {i, ok: 0, e: message}
 *
 *   hello                     → {proto, sessions, decisionHz, egos, obs}
 *   reset  {s?, seed?}        → step frame
 *   step   {s?, a?}           → step frame
 *   reset_all {seeds?[]}      → {rs: [step frame × N]}  (session-index order)
 *   batch_step {as: [[s,a]…]} → {rs: [step frame × K]}  (request order;
 *                               repeated session indices apply sequentially)
 *   ping                      → {pong: true}
 *   close                     → {bye: true}; the server then exits
 *
 * Step frame (one decision):
 *
 *   {t, rw, term, trunc,
 *    sv:   float64[10] LE bin | null,          // ego state vector
 *    objs: [[id, rangeM, bearingRad, rateMps, los01], …],
 *    bev:  null | {w, h, c, res, d: float32 LE bin},
 *    cw:   {t, los: [[obs, tgt, vis01]…],
 *             trg: [[t, kind, interaction, actor, cond|null, forced|null, reason|null]…],
 *             cg:  [[a, b, metric, threshold, value]…]},
 *    terms: [progress, proximity, comfort]}
 *
 * Action (compact keys): {ts: targetSpeedMps, ta: targetAccelerationMps2,
 * dir: -1|1, ctrl: [throttle, brake, steer]} — every field optional.
 */

import { createHash } from 'node:crypto';
import { readFile, realpath } from 'node:fs/promises';
import { gunzipSync } from 'node:zlib';
import path from 'node:path';
import net from 'node:net';
import { fileURLToPath } from 'node:url';

import { decode, encode } from '@msgpack/msgpack';
import { z } from 'zod';

import {
  buildLaneGraph,
  parseSimScenarioInput,
  type EngineTickObservation,
  type LaneGraph,
  type SimScenarioInput,
  type TopologyIndex,
} from '@simforge/engine';

import { availableMaps, findSite, loadMap, materialize, readTemplate } from '@simforge/compiler';

import { EnvSession } from './session.js';
import {
  SubscriberQueue,
  TruthStreamBuilder,
  type SceneStateMeta,
  type TruthTickDocument,
} from './truth-stream.js';


import type { CausalConflictGenesis, CausalFrame, CausalLosTransition, CausalTriggerRecord } from './causal.js';
import type { RewardTerms } from './reward.js';
import type { EnvAction, EpisodeConfig, Observation } from './types.js';

/** Wire protocol version; bumped on any breaking frame change. */
export const ENV_SERVER_PROTOCOL_VERSION = 1;

/** Hard cap on one framed message; guards against a corrupt length prefix. */
const MAX_FRAME_BYTES = 64 * 1024 * 1024;

const ENGINE_HZ = 50;
const DEFAULT_DECISION_HZ = 10;

/* --------------------------------------------------------------- framing */

/** Incremental frame splitter: feed transport chunks, pull complete payloads. */
export class FrameReader {
  private buffer: Buffer<ArrayBufferLike> = Buffer.alloc(0);

  /** Returns every complete frame contained in `chunk` (plus any backlog). */
  push(chunk: Buffer): Buffer[] {
    this.buffer = this.buffer.length === 0 ? chunk : Buffer.concat([this.buffer, chunk]);
    const frames: Buffer[] = [];
    for (;;) {
      if (this.buffer.length < 4) return frames;
      const length = this.buffer.readUInt32LE(0);
      if (length > MAX_FRAME_BYTES) throw new Error(`frame of ${length} bytes exceeds the ${MAX_FRAME_BYTES} limit`);
      if (this.buffer.length < 4 + length) return frames;
      frames.push(this.buffer.subarray(4, 4 + length));
      this.buffer = this.buffer.subarray(4 + length);
    }
  }
}

/** Writes one length-prefixed frame to a writable byte sink. */
export function writeFrame(sink: NodeJS.WritableStream, payload: Uint8Array): void {
  const header = Buffer.alloc(4);
  header.writeUInt32LE(payload.byteLength, 0);
  sink.write(Buffer.concat([header, payload]));
}

/* ------------------------------------------------------- wire codecs */

/** Loose wire-document shape; the request boundary validates fields before use. */
type Wire = Record<string, unknown>;

/** Float64/Float32 payloads ride as little-endian `bin` — one memcpy, no per-element cost. */
function asBin(values: Float64Array | Float32Array): Uint8Array {
  return Buffer.from(values.buffer, values.byteOffset, values.byteLength);
}

function encodeCausalFrame(frame: CausalFrame): Wire {
  const los = frame.losTransitions.map((t) => [t.observerId, t.targetId, t.becameVisible ? 1 : 0]);
  const trg = frame.triggers.map((t) => [
    t.tS,
    t.kind,
    t.interactionId,
    t.actorId,
    t.condition ?? null,
    t.forced === undefined ? null : t.forced ? 1 : 0,
    t.reason ?? null,
  ]);
  const cg = frame.conflictGenesis.map((g) => [g.a, g.b, g.metric, g.threshold, g.value]);
  return { t: frame.tS, los, trg, cg };
}

/** One decision on the wire. Compact keys keep per-step overhead small. */
export function encodeStepResult(result: {
  observation: Observation;
  reward: number;
  terminated: boolean;
  truncated: boolean;
  info: { tS: number; causal: CausalFrame; rewardTerms: RewardTerms };
}): Wire {
  const obs = result.observation;
  return {
    t: result.info.tS,
    rw: result.reward,
    term: result.terminated ? 1 : 0,
    trunc: result.truncated ? 1 : 0,
    sv: obs.stateVector ? asBin(obs.stateVector) : null,
    objs: obs.objects.map((o) => [o.id, o.rangeM, o.bearingRad, o.rangeRateMps, o.lineOfSight ? 1 : 0]),
    bev: obs.bev
      ? { w: obs.bev.width, h: obs.bev.height, c: obs.bev.channels, res: obs.bev.resolutionM, d: asBin(obs.bev.data) }
      : null,
    cw: encodeCausalFrame(result.info.causal),
    terms: [result.info.rewardTerms.progress, result.info.rewardTerms.proximity, result.info.rewardTerms.comfort],
  };
}

const actionSchema = z.object({
  ts: z.number().optional(),
  ta: z.number().optional(),
  dir: z.union([z.literal(-1), z.literal(1)]).optional(),
  ctrl: z.tuple([z.number(), z.number(), z.number()]).optional(),
});

/** Decode a compact-key action into the engine's {@link EnvAction}. */
export function decodeAction(a: unknown): EnvAction {
  if (a === null || a === undefined) return {};
  const wire = actionSchema.parse(a);
  return {
    ...(wire.ts === undefined ? {} : { targetSpeedMps: wire.ts }),
    ...(wire.ta === undefined ? {} : { targetAccelerationMps2: wire.ta }),
    ...(wire.dir === undefined ? {} : { motionDirection: wire.dir }),
    ...(wire.ctrl === undefined ? {} : { control: { throttle: wire.ctrl[0], brake: wire.ctrl[1], steer: wire.ctrl[2] } }),
  };
}

/* ------------------------------------------------------- episode loading */

/**
 * One materialized episode: the parsed scenario input plus the lane graph of
 * its map. Session order follows spec order everywhere downstream.
 */
export interface LoadedEpisode {
  readonly input: SimScenarioInput;
  readonly graph: LaneGraph;
  /**
   * Map identity for the truth stream's digest pair ({mapId, xodrSha256}).
   * Absent/null when the episode rides an unnamed or synthetic topology.
   */
  readonly mapId: string | null;
  readonly xodrSha256: string | null;
}

/** Spec-level episode configuration; validated by EnvSession itself. */
const episodeConfigSchema = z.record(z.string(), z.unknown());

const instanceEntrySchema = z.union([
  z.string(),
  z.object({
    input: z.union([z.string(), z.record(z.string(), z.unknown())]),
    topology: z.union([z.string(), z.record(z.string(), z.unknown())]).optional(),
  }),
]);

export const episodeSpecSchema = z.object({
  version: z.number().optional(),
  /** Shared episode configuration; CLI flags take precedence for timing. */
  episode: episodeConfigSchema.optional(),
  /* Form A — pre-materialized instances. */
  instances: z.array(instanceEntrySchema).min(1).optional(),
  /** Fallback topology (path or inline) for instances that name none. */
  topology: z.union([z.string(), z.record(z.string(), z.unknown())]).optional(),
  /* Form B — template × map × site × seeds. */
  template: z.string().optional(),
  map: z.string().optional(),
  site: z.string().optional(),
  seeds: z.array(z.union([z.number(), z.string()])).min(1).optional(),
});

export type EpisodeSpecFile = z.infer<typeof episodeSpecSchema>;

async function readJsonFile(file: string): Promise<unknown> {
  const raw = await readFile(file);
  const text = file.endsWith('.gz') ? gunzipSync(raw).toString('utf8') : raw.toString('utf8');
  return JSON.parse(text);
}

/**
 * Lane graphs are the expensive artifact; identical topologies (same file or
 * same digest) share one build across all sessions.
 */
class GraphCache {
  private readonly byPath = new Map<string, LaneGraph>();
  private readonly byDigest = new Map<string, LaneGraph>();

  async forPath(file: string): Promise<LaneGraph> {
    const resolved = await realpath(file);
    const cached = this.byPath.get(resolved);
    if (cached) return cached;
    const topology = (await readJsonFile(resolved)) as TopologyIndex; // engine parses lanes on build
    const digest = createHash('sha256').update(JSON.stringify(topology)).digest('hex');
    const graph = this.byDigest.get(digest) ?? buildLaneGraph(topology);
    this.byDigest.set(digest, graph);
    this.byPath.set(resolved, graph);
    return graph;
  }

  forInline(topology: TopologyIndex): LaneGraph {
    const digest = createHash('sha256').update(JSON.stringify(topology)).digest('hex');
    const cached = this.byDigest.get(digest);
    if (cached) return cached;
    const graph = buildLaneGraph(topology);
    this.byDigest.set(digest, graph);
    return graph;
  }
}

function resolveRelative(specDir: string, candidate: string): string {
  return path.isAbsolute(candidate) ? candidate : path.resolve(specDir, candidate);
}

/** An instance file is either the CLI's `scenario-instance` envelope or a raw input. */
function unwrapInstance(json: unknown): unknown {
  const envelope = z.object({ kind: z.string(), input: z.unknown() }).safeParse(json);
  if (envelope.success && envelope.data.kind === 'scenario-instance' && envelope.data.input !== undefined) {
    return envelope.data.input;
  }
  return json;
}

async function loadInstances(specDir: string, spec: EpisodeSpecFile, graphs: GraphCache): Promise<LoadedEpisode[]> {
  const episodes: LoadedEpisode[] = [];
  for (const entry of spec.instances ?? []) {
    let rawInput: unknown;
    let topologyRef: string | Record<string, unknown> | undefined;

    if (typeof entry === 'string') {
      rawInput = unwrapInstance(await readJsonFile(resolveRelative(specDir, entry)));
    } else {
      const inline = typeof entry.input === 'string'
        ? unwrapInstance(await readJsonFile(resolveRelative(specDir, entry.input)))
        : entry.input;
      rawInput = inline;
      topologyRef = entry.topology;
    }
    if (topologyRef === undefined) {
      // No explicit topology: fall back to the map named by the input itself.
      const mapId = (rawInput as { mapId?: unknown } | null)?.mapId; // validated by parse below
      if (typeof mapId === 'string' && availableMaps().includes(mapId)) {
        const bundle = await loadMap(mapId);
        const input = parseSimScenarioInput(rawInput as SimScenarioInput);
        episodes.push({ input, graph: bundle.graph, mapId, xodrSha256: bundle.graph.topologyDigest || null });
        continue;
      }
      throw new Error('episode instance needs a topology: an entry "topology", a spec-level "topology", or a known map id');
    }

    // parseSimScenarioInput is the validating boundary; the fixture precedent
    // hands it untyped JSON the same way.
    const input = parseSimScenarioInput(rawInput as SimScenarioInput);
    const graph =
      typeof topologyRef === 'string'
        ? await graphs.forPath(resolveRelative(specDir, topologyRef))
        : graphs.forInline(topologyRef as unknown as TopologyIndex);
    episodes.push({
      input,
      graph,
      mapId: typeof (rawInput as { mapId?: unknown } | null)?.mapId === 'string'
        ? (rawInput as { mapId: string }).mapId
        : null,
      xodrSha256: graph.topologyDigest || null,
    });
  }
  return episodes;
}

async function loadTemplate(specDir: string, spec: EpisodeSpecFile): Promise<LoadedEpisode[]> {
  if (!spec.template || !spec.map || !spec.site || !spec.seeds) {
    throw new Error('template episode spec needs "template", "map", "site" and "seeds"');
  }
  const template = await readTemplate(resolveRelative(specDir, spec.template));
  const { bundle, site } = await findSite(template, spec.map, spec.site);
  // Site matching runs once; each seed re-draws parameters deterministically.
  const episodes: LoadedEpisode[] = [];
  for (const seed of spec.seeds) {
    const seedOverride = typeof seed === 'number' ? String(seed) : seed;
    const result = materialize(template, bundle, site, { seed: seedOverride });
    episodes.push({ input: result.input, graph: bundle.graph, mapId: spec.map, xodrSha256: bundle.graph.topologyDigest || null });
  }
  return episodes;
}

/**
 * Load an episode spec file into ordered {@link LoadedEpisode}s. Exactly one
 * of the two forms must be present; form A reads pre-materialized instances
 * (paths resolved against the spec file's directory), form B materializes
 * template × map × site once per seed through the standard materializer.
 */
export async function loadEpisodeSpec(specPath: string): Promise<{ episodes: LoadedEpisode[]; spec: EpisodeSpecFile }> {
  const absolute = path.resolve(specPath);
  const raw = episodeSpecSchema.parse(await readJsonFile(absolute));
  const specDir = path.dirname(absolute);

  const hasFormA = raw.instances !== undefined;
  const hasFormB = raw.template !== undefined || raw.seeds !== undefined;
  if (hasFormA === hasFormB) {
    throw new Error('episode spec must declare exactly one of "instances" (pre-materialized) or "template"/"map"/"site"/"seeds"');
  }

  const graphs = new GraphCache();
  const episodes = hasFormA ? await loadInstances(specDir, raw, graphs) : await loadTemplate(specDir, raw);
  return { episodes, spec: raw };
}

/* --------------------------------------------------------------- serving */

export interface EnvServerOptions {
  readonly episodes: readonly LoadedEpisode[];
  /** Spec-level episode configuration (timing, goals, reward weights). */
  readonly episode?: Partial<EpisodeConfig>;
  /** Overrides the spec's decision rate. */
  readonly decisionHz?: number;
}

/** The `hello` payload: everything a client needs to size its spaces. */
export interface HelloInfo {
  proto: number;
  sessions: number;
  decisionHz: number;
  engineHz: number;
  egos: string[];
  obs: { sv: boolean; bev: boolean };
  /** Live per-tick ground-truth side channel (`subscribe`/`unsubscribe`). */
  truthStream: boolean;
}

/** Loose request shape; `handle` validates each op's fields before use. */
export interface WireRequest extends Wire {
  i?: number;
  op?: string;
}

export interface WireResponse {
  i: number;
  ok: 1 | 0;
  r?: unknown;
  e?: string;
}

/** Request envelope; op-specific fields stay loosely typed by design. */
const requestEnvelopeSchema = z.looseObject({ i: z.number().int().nonnegative().default(0), op: z.string() });

/**
 * The in-process server core: N sessions, synchronous deterministic
 * dispatch. Transport-agnostic — socket and stdio frontends attach below.
 */
export class EnvServer {
  readonly sessions: EnvSession[];
  readonly decisionHz: number;

  /** Outbound frame sinks by connection id (request replies AND tick pushes). */
  private readonly sinks = new Map<number, (doc: WireResponse | TruthTickDocument) => void>();
  /** Per-connection, per-session subscription queues. */
  private readonly subscriptions = new Map<number, Map<number, SubscriberQueue>>();
  /** Per-session scene metadata for the truth stream. */
  private readonly truthMeta: SceneStateMeta[];
  private nextConnectionId = 1;

  constructor(options: EnvServerOptions) {
    this.decisionHz = options.decisionHz ?? options.episode?.decisionHz ?? DEFAULT_DECISION_HZ;
    this.truthMeta = options.episodes.map(({ input, mapId, xodrSha256 }) => ({
      mapId,
      xodrSha256,
      dtS: input.dt,
    }));
    const builders = options.episodes.map((episode) => new TruthStreamBuilder(this.truthMetaFor(episode)));
    this.sessions = options.episodes.map(
      ({ input, graph }, index) =>
        new EnvSession({
          input,
          graph,
          episode: { ...options.episode, decisionHz: this.decisionHz },
          // Fan-out observer: built once per engine tick, shared by every
          // subscriber of the session; pure read of frozen snapshot data.
          tickObserver: (obs) => this.onEngineTick(index, obs, builders[index]!),
        }),
    );
  }

  private truthMetaFor(episode: LoadedEpisode): SceneStateMeta {
    return { mapId: episode.mapId, xodrSha256: episode.xodrSha256, dtS: episode.input.dt };
  }

  /** Engine-tick fan-out: no-op unless someone subscribes; never blocks. */
  private onEngineTick(index: number, obs: EngineTickObservation, builder: TruthStreamBuilder): void {
    if (!this.subscriptions.size) return;
    const book = this.sessions[index]?.signalBook();
    if (!book) return;
    let anyListener = false;
    for (const perSession of this.subscriptions.values()) {
      const queue = perSession.get(index);
      if (!queue) continue;
      anyListener = true;
      break;
    }
    if (!anyListener) return;
    const payload = builder.observe(obs, book);
    for (const perSession of this.subscriptions.values()) {
      perSession.get(index)?.push(payload);
    }
  }

  /* -- connection sink registry (used by chunkHandler/attachDuplex) -- */

  /** Register one connection's outbound sink; returns its connection id. */
  openSink(send: (doc: WireResponse | TruthTickDocument) => void): number {
    const id = this.nextConnectionId++;
    this.sinks.set(id, send);
    return id;
  }

  /** Drop a connection's sink and any live subscriptions it holds. */
  closeSink(connectionId: number): void {
    this.sinks.delete(connectionId);
    this.subscriptions.delete(connectionId);
  }

  /**
   * Drain every subscription queue to its connection's wire. Called between
   * request/reply exchanges — never during a tick — so the engine loop never
   * waits on socket writes.
   */
  flush(): void {
    for (const [connectionId, send] of this.sinks) {
      const perSession = this.subscriptions.get(connectionId);
      if (!perSession) continue;
      for (const [sessionIndex, queue] of perSession) {
        for (const doc of queue.drain(sessionIndex)) send(doc);
      }
    }
  }

  info(): HelloInfo {
    return {
      proto: ENV_SERVER_PROTOCOL_VERSION,
      sessions: this.sessions.length,
      decisionHz: this.decisionHz,
      engineHz: ENGINE_HZ,
      egos: this.sessions.map((session) => session.ego),
      obs: { sv: true, bev: false },
      truthStream: true,
    };
  }

  private requireSession(index: unknown): EnvSession {
    const sessionIndex = index === undefined || index === null ? 0 : z.number().int().nonnegative().parse(index);
    const session = this.sessions[sessionIndex];
    if (!session) throw new Error(`no session ${sessionIndex} (server hosts ${this.sessions.length})`);
    return session;
  }

  private reset(index: unknown, seed: unknown): Wire {
    const session = this.requireSession(index);
    if (seed === undefined || seed === null) return encodeStepResult(session.reset());
    if (typeof seed !== 'number' && typeof seed !== 'string') throw new Error('seed must be a number or string');
    return encodeStepResult(session.reset(seed));
  }

  private step(index: unknown, action: unknown): Wire {
    return encodeStepResult(this.requireSession(index).step(decodeAction(action)));
  }

  /**
   * Handles one decoded request; throws become `{ok: 0}` error responses.
   * `connectionId` identifies the transport sink the request arrived on; the
   * subscription ops bind their pushes to it and are rejected without one.
   */
  handle(request: WireRequest, connectionId: number | null = null): WireResponse {
    const id = request.i ?? 0;
    try {
      switch (request.op) {
        case 'hello':
          return { i: id, ok: 1, r: this.info() };
        case 'ping':
          return { i: id, ok: 1, r: { pong: true } };
        case 'reset':
          return { i: id, ok: 1, r: this.reset(request['s'], request['seed']) };
        case 'step':
          return { i: id, ok: 1, r: this.step(request['s'], request['a']) };
        case 'reset_all': {
          const seeds = request['seeds'];
          if (seeds !== undefined && !Array.isArray(seeds)) throw new Error('"seeds" must be an array');
          const rs = this.sessions.map((_, index) => this.reset(index, seeds?.[index]));
          return { i: id, ok: 1, r: { rs } };
        }
        case 'batch_step': {
          const actions = request['as'];
          if (!Array.isArray(actions)) throw new Error('batch_step needs "as": [[session, action], …]');
          // Request order preserved; repeated sessions apply sequentially so a
          // client may advance one environment several decisions per batch.
          const rs = actions.map((pair) => {
            if (!Array.isArray(pair) || pair.length !== 2) throw new Error('batch entries must be [session, action] pairs');
            return this.step(pair[0], pair[1]);
          });
          return { i: id, ok: 1, r: { rs } };
        }
        case 'subscribe': {
          if (connectionId === null || !this.sinks.has(connectionId)) {
            throw new Error('subscribe requires a transport connection');
          }
          const sessionIndex = z.number().int().nonnegative().parse(request['s'] ?? 0);
          this.requireSession(sessionIndex);
          let perSession = this.subscriptions.get(connectionId);
          if (!perSession) {
            perSession = new Map();
            this.subscriptions.set(connectionId, perSession);
          }
          perSession.set(sessionIndex, new SubscriberQueue());
          return { i: id, ok: 1, r: { subscribed: true, s: sessionIndex, engineHz: ENGINE_HZ } };
        }
        case 'unsubscribe': {
          if (connectionId === null) throw new Error('unsubscribe requires a transport connection');
          this.subscriptions.get(connectionId)?.delete(z.number().int().nonnegative().parse(request['s'] ?? 0));
          return { i: id, ok: 1, r: { subscribed: false } };
        }
        case 'close':
          return { i: id, ok: 1, r: { bye: true } };
        default:
          throw new Error(`unknown op ${String(request.op)}`);
      }
    } catch (error) {
      return { i: id, ok: 0, e: error instanceof Error ? error.message : String(error) };
    }
  }

  /** True when the request terminates the serving loop. */
  closes(request: WireRequest): boolean {
    return request.op === 'close';
  }
}

/* ------------------------------------------------------------- transports */

/** Decode one framed request; the transport boundary validates the envelope. */
function decodeRequest(frame: Buffer): WireRequest {
  const request = requestEnvelopeSchema.parse(decode(frame)) as WireRequest & { i: number; op: string };
  return request;
}

/**
 * Build a chunk handler that drains complete frames, dispatches them in
 * arrival order, and stops at the first `close` or protocol error. The
 * connection's sink is registered with the server on creation so truth-stream
 * pushes can ride the same wire; every handled request is followed by a
 * flush of any queued subscription frames.
 */
export function chunkHandler(
  server: EnvServer,
  reader: FrameReader,
  send: (doc: WireResponse | TruthTickDocument) => void,
  finish: () => void,
): (chunk: Buffer) => void {
  let closing = false;
  const connectionId = server.openSink(send);
  return (chunk: Buffer) => {
    if (closing) return;
    try {
      for (const frame of reader.push(chunk)) {
        const request = decodeRequest(frame);
        send(server.handle(request, connectionId));
        server.flush();
        if (server.closes(request)) {
          closing = true;
          server.closeSink(connectionId);
          finish();
          return;
        }
      }
    } catch (error) {
      console.error(error instanceof Error ? error.message : String(error));
      closing = true;
      server.closeSink(connectionId);
      finish();
    }
  };
}

/** Attach the server to a bidirectional duplex (socket or stdio pair). */
export function attachDuplex(server: EnvServer, input: NodeJS.ReadableStream, output: NodeJS.WritableStream, onEnd: () => void): void {
  const reader = new FrameReader();
  input.on('data', chunkHandler(server, reader, (doc) => writeFrame(output, encode(doc)), onEnd));
  input.on('end', onEnd);
  input.on('error', onEnd);
  input.resume();
}

/** Serve one unix socket at `socketPath`; a new connection replaces the old. */
export function serveSocket(server: EnvServer, socketPath: string): net.Server {
  return net.createServer((socket) => {
    attachDuplex(server, socket, socket, () => socket.destroy());
  }).listen(socketPath);
}

/** Serve one client over stdio; exits cleanly on EOF or `close`. */
export function serveStdio(server: EnvServer): void {
  attachDuplex(server, process.stdin, process.stdout, () => process.exit(0));
}

/* -------------------------------------------------------------------- cli */

interface CliFlags {
  episodes?: string;
  socket?: string;
  decisionHz?: number;
  obs: Set<string>;
  clipSeconds?: number;
  maxDecisions?: number;
}

function parseArgs(argv: readonly string[]): CliFlags {
  const flags: CliFlags = { obs: new Set(['state-vector', 'objects']) };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]!;
    const value = (): string => {
      const v = argv[++i];
      if (v === undefined) throw new Error(`${arg} requires a value`);
      return v;
    };
    switch (arg) {
      case '--episodes':
        flags.episodes = value();
        break;
      case '--socket':
        flags.socket = value();
        break;
      case '--decision-hz':
        flags.decisionHz = Number(value());
        break;
      case '--obs':
        flags.obs = new Set(
          value()
            .split(',')
            .map((s) => s.trim())
            .filter(Boolean),
        );
        break;
      case '--clip-seconds':
        flags.clipSeconds = Number(value());
        break;
      case '--max-decisions':
        flags.maxDecisions = Number(value());
        break;
      case '--help':
        printUsage();
        process.exit(0);
        break;
      default:
        throw new Error(`unknown flag ${arg}`);
    }
  }
  if (!flags.episodes) throw new Error('--episodes <spec.json> is required');
  return flags;
}

function printUsage(): void {
  process.stdout.write(`uniscenarios-env-server — framed msgpack env-server

Usage:
  uniscenarios-env-server --episodes <spec.json> [--socket <path>] [--decision-hz N]
                          [--obs state-vector,objects,bev] [--clip-seconds S]
                          [--max-decisions K]

Transports: unix socket at --socket, else stdio. See src/env-server.ts for the
wire protocol. Episode spec: either pre-materialized "instances" or a
"template"/"map"/"site"/"seeds" materialization form.
`);
}

export async function main(argv: readonly string[]): Promise<void> {
  const flags = parseArgs(argv);
  const episodesFile = flags.episodes;
  if (episodesFile === undefined) throw new Error('--episodes <spec.json> is required');
  const { episodes, spec } = await loadEpisodeSpec(episodesFile);

  const observation = {
    stateVector: flags.obs.has('state-vector'),
    bev: flags.obs.has('bev') ? {} : null,
  };
  // The spec episode block is free-form JSON; EnvSession validates its fields.
  const specEpisode = spec.episode as Partial<EpisodeConfig> | undefined;
  const server = new EnvServer({
    episodes,
    episode: {
      ...specEpisode,
      ...(flags.clipSeconds === undefined ? {} : { clipSeconds: flags.clipSeconds }),
      ...(flags.maxDecisions === undefined ? {} : { maxDecisions: flags.maxDecisions }),
      observation: { ...specEpisode?.observation, ...observation },
    },
    ...(flags.decisionHz === undefined ? {} : { decisionHz: flags.decisionHz }),
  });

  if (flags.socket) {
    await new Promise<void>((resolve, reject) => {
      const listener = serveSocket(server, flags.socket!);
      listener.once('listening', resolve);
      listener.once('error', reject);
    });
    // Readiness line for supervisors that launch us as a subprocess.
    process.stdout.write(`uniscenarios-env-server listening on ${flags.socket}\n`);
  } else {
    serveStdio(server);
  }
}

if (process.argv[1]) {
  const invoked = await realpath(process.argv[1]).catch(() => process.argv[1]);
  if (invoked !== undefined && invoked === fileURLToPath(import.meta.url)) {
    await main(process.argv.slice(2)).catch((error: unknown) => {
      console.error(error instanceof Error ? error.message : String(error));
      process.exit(1);
    });
  }
}
