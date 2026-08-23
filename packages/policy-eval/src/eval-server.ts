#!/usr/bin/env node
/**
 * policy-eval-server — deterministic env server over the frozen suite.
 *
 * Protocol-compatible with the rl env servers (framed msgpack over a unix
 * socket; hello/reset/step/batch_step), plus three additive fields on every
 * step frame, mirroring how `reactive-env-server.mjs` extended the wire:
 *
 *   col  — 1 when an ego collision terminated the episode
 *   goal — 1 when the routeEnd goal term fired
 *   min  — ego-involving pair minima [a, b, minDistanceM, minTtcS,
 *          minPathTtcS, minPetS] so the runner computes Bench2Drive-style
 *          metrics from engine-grade data without touching traces.
 *
 * Deployment perturbations are deliberately NOT here: they wrap policies at
 * the client layer (tools/policy-eval-runner), never the environment.
 *
 *   node dist/eval-server.js --suite qualification/policy-eval-suite.v1.json \
 *     --socket /tmp/policy-eval.sock [--decision-hz 5] [--max-decisions K]
 */

import path from 'node:path';
import { rm } from 'node:fs/promises';
import { loadSuiteFile, sessionForEntry } from './catalog.js';
import { resolveRlRuntime } from './runtime.js';
import type { SuiteEntry } from './suite.js';
import type { StepResult } from './rl-bridge-types.js';

interface Flags {
  suite: string;
  socket: string;
  decisionHz?: number | undefined;
  maxDecisions?: number | undefined;
}

function parseArgs(argv: readonly string[]): Flags {
  const flags: Flags = {
    suite: 'qualification/policy-eval-suite.v1.json',
    socket: '/tmp/policy-eval.sock',
    decisionHz: undefined,
    maxDecisions: undefined,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]!;
    const value = () => {
      const v = argv[++i];
      if (v === undefined) throw new Error(`${arg} requires a value`);
      return v;
    };
    switch (arg) {
      case '--suite': flags.suite = value(); break;
      case '--socket': flags.socket = value(); break;
      case '--decision-hz': flags.decisionHz = Number(value()); break;
      case '--max-decisions': flags.maxDecisions = Number(value()); break;
      default: throw new Error(`unknown flag ${arg}`);
    }
  }
  return flags;
}

interface LoadedSession {
  entry: SuiteEntry;
  session: Awaited<ReturnType<typeof makeSession>>;
}

async function makeSession(
  runtime: Awaited<ReturnType<typeof resolveRlRuntime>>,
  repoRoot: string,
  entry: SuiteEntry,
  decisionHz: number,
  reward: Record<string, unknown>,
  maxDecisions: number | undefined,
) {
  return sessionForEntry(runtime, repoRoot, entry, {
    decisionHz,
    reward,
    maxDecisions,
  });
}

/** Ego-pair minima flattened onto the wire. */
function encodeMinima(result: StepResult, egoId: string): unknown[] {
  return result.info.minima
    .filter((m) => m.a === egoId || m.b === egoId)
    .map((m) => [m.a, m.b, m.minDistanceM, m.minTtcS, m.minPathTtcS, m.minPetS]);
}

class PolicyEvalServer {
  private readonly loaded: LoadedSession[] = [];
  private readonly lastCollision: boolean[] = [];
  private readonly lastGoal: boolean[] = [];
  private readonly lastDoc: Array<Record<string, unknown> | null> = [];

  constructor(
    private readonly runtime: Awaited<ReturnType<typeof resolveRlRuntime>>,
    private readonly suite: import('./suite.js').PolicyEvalSuite,
    private readonly sessions: LoadedSession['session'][],
    entries: SuiteEntry[],
    private readonly decisionHz: number,
  ) {
    void this.decisionHz;
    for (let i = 0; i < sessions.length; i += 1) {
      this.loaded.push({ entry: entries[i]!, session: sessions[i]! });
      this.lastCollision.push(false);
      this.lastGoal.push(false);
      this.lastDoc.push(null);
    }
  }

  info() {
    return {
      proto: 1,
      suiteHash: this.suite.suiteHash,
      suiteName: this.suite.name,
      sessions: this.loaded.length,
      decisionHz: this.suite.decisionHz,
      engineHz: 50,
      egos: this.loaded.map((l) => l.session.ego),
      entries: this.loaded.map((l) => ({
        entryId: l.entry.entryId,
        ability: l.entry.ability,
        shift: l.entry.shift,
        mapId: l.entry.mapId,
        seed: l.entry.seed,
      })),
      obs: { sv: true, bev: true },
    };
  }

  require(index: unknown): { session: LoadedSession['session']; i: number } {
    const i = index === undefined || index === null ? 0 : Number(index);
    const loaded = this.loaded[i];
    if (!loaded) throw new Error(`no session ${i} (server hosts ${this.loaded.length})`);
    return { session: loaded.session, i };
  }

  step(index: unknown, action: unknown) {
    const { session: raw, i } = this.require(index);
    let result: StepResult | null = null;
    try {
      result = raw.step(this.runtime.decodeAction(action) as Record<string, unknown>);
    } catch (error) {
      // Gymnasium semantics: post-episode stepping is undefined; serve the
      // cached final frame so vectorized clients keep batching.
      if (/finished or un-reset/.test(String(error instanceof Error ? error.message : error)) && this.lastDoc[i]) {
        return this.lastDoc[i];
      }
      throw error;
    }
    this.lastCollision[i] =
      'collision' in result.info.rewardTerms ||
      (result.terminated && result.reward <= -1 && !('goal' in result.info.rewardTerms));
    this.lastGoal[i] = Boolean(result.info.rewardTerms.goal);
    const doc = {
      ...this.runtime.encodeStepResult({
        observation: (result as unknown as { observation: unknown }).observation,
        reward: result.reward,
        terminated: result.terminated,
        truncated: result.truncated,
        info: { tS: result.info.tS, causal: { tS: result.info.tS, losTransitions: [], triggers: [], conflictGenesis: [] }, rewardTerms: result.info.rewardTerms },
      }),
      col: this.lastCollision[i] ? 1 : 0,
      goal: this.lastGoal[i] ? 1 : 0,
      min: encodeMinima(result, raw.ego),
    };
    this.lastDoc[i] = doc;
    return doc;
  }

  reset(index: unknown, seed: unknown) {
    const { session: raw, i } = this.require(index);
    const seedValue = seed === undefined || seed === null ? undefined : String(seed);
    const result =
      seedValue === undefined ? raw.reset() : raw.reset(seedValue);
    this.lastCollision[i] = false;
    this.lastGoal[i] = false;
    const doc = {
      ...this.runtime.encodeStepResult({
        observation: (result as unknown as { observation: unknown }).observation,
        reward: 0,
        terminated: false,
        truncated: false,
        info: { tS: result.info.tS, causal: { tS: result.info.tS, losTransitions: [], triggers: [], conflictGenesis: [] }, rewardTerms: result.info.rewardTerms },
      }),
      col: 0,
      goal: 0,
      min: encodeMinima(result, raw.ego),
    };
    this.lastDoc[i] = doc;
    return doc;
  }

  handle(request: { i?: number; op?: string; s?: unknown; a?: unknown; seed?: unknown; seeds?: unknown; as?: unknown }) {
    const id = request.i ?? 0;
    try {
      switch (request.op) {
        case 'hello': return { i: id, ok: 1, r: this.info() };
        case 'ping': return { i: id, ok: 1, r: { pong: true } };
        case 'reset': return { i: id, ok: 1, r: this.reset(request.s, request.seed) };
        case 'step': return { i: id, ok: 1, r: this.step(request.s, request.a) };
        case 'reset_all': {
          const seeds = request.seeds;
          if (seeds !== undefined && !Array.isArray(seeds)) throw new Error('"seeds" must be an array');
          const rs = this.loaded.map((_, index) => this.reset(index, seeds?.[index]));
          return { i: id, ok: 1, r: { rs } };
        }
        case 'batch_step': {
          const actions = request.as;
          if (!Array.isArray(actions)) throw new Error('batch_step needs "as": [[session, action], …]');
          const rs = actions.map((pair) => {
            if (!Array.isArray(pair) || pair.length !== 2) throw new Error('batch entries must be [session, action] pairs');
            return this.step(pair[0], pair[1]);
          });
          return { i: id, ok: 1, r: { rs } };
        }
        case 'close': return { i: id, ok: 1, r: { bye: true } };
        default: throw new Error(`unknown op ${String(request.op)}`);
      }
    } catch (error) {
      return { i: id, ok: 0, e: error instanceof Error ? error.message : String(error) };
    }
  }

  closes(request: { op?: string }): boolean {
    return request.op === 'close';
  }
}

const repoRoot = process.cwd();
const flags = parseArgs(process.argv.slice(2));
const runtime = await resolveRlRuntime();
const suite = await loadSuiteFile(path.resolve(repoRoot, flags.suite));
const decisionHz = flags.decisionHz ?? suite.decisionHz;

process.stderr.write(`policy-eval-server: materializing ${suite.entries.length} suite entries…\n`);
const entries: SuiteEntry[] = [];
const sessions: Array<LoadedSession['session']> = [];
for (const entry of suite.entries) {
  entries.push(entry);
  sessions.push(await makeSession(runtime, repoRoot, entry, decisionHz, suite.reward, flags.maxDecisions));
}
process.stderr.write(`policy-eval-server: suite ${suite.suiteHash.slice(0, 12)} ready\n`);

await rm(flags.socket, { force: true });
const server = new PolicyEvalServer(runtime, suite, sessions, entries, decisionHz);
const listener = runtime.serveSocket(server, flags.socket);
listener.once('error', (...args: unknown[]) => {
  process.stderr.write(`${String(args[0])}\n`);
  process.exit(1);
});
