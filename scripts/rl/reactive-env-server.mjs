#!/usr/bin/env node
/**
 * reactive-env-server — Phase 3 training shim over @simforge/training-env.
 *
 * The stock `uniscenarios-env-server` does not expose RunOptions, so reactive
 * ambient traffic (RunOptions.ambientReactivity = 'reactive') and BEV
 * observation geometry cannot be enabled through it. This shim imports the
 * published dist surface (loadEpisodeSpec, EnvSession, wire codecs, socket
 * mid-level episode configuration:
 *
 *   - decisionHz from --decision-hz (default 5)
 *   - ego-centric BEV raster (coarse geometry for policy training)
 *   - goal { routeEnd: true } so the completion bonus is reachable
 *   - additive `col` field on step responses (1 when a collision involving
 *     the ego terminated the episode) — clients that ignore it stay
 *     protocol-compatible.
 *
 * Deterministic: no wall clock in the dispatch path; identical action
 * sequences against identical seeds produce identical response streams.
 */
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { existsSync } from 'node:fs';
import { rm } from 'node:fs/promises';
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
// pnpm isolates deps per package: resolve @msgpack/msgpack through rl-env's own
// node_modules rather than this script's location.
const { createRequire } = await import('node:module');
const { decode, encode } = createRequire(path.join(repoRoot, 'packages/training-env/package.json'))('@msgpack/msgpack');
const envServerDist = path.join(repoRoot, 'packages/training-env/dist/env-server.js');
const rlEnvDist = path.join(repoRoot, 'packages/training-env/dist/index.js');

const {
  FrameReader,
  writeFrame,
  encodeStepResult,
  decodeAction,
  loadEpisodeSpec,
  serveSocket,
} = await import(envServerDist);
const { EnvSession } = await import(rlEnvDist);

/** Mid-level BEV geometry: 0.5 m cells → 80 rows × 40 cols × 3 channels. */
const BEV_CONFIG = { resolutionM: 0.5, forwardM: 32, backwardM: 8, halfWidthM: 10 };

function parseArgs(argv) {
  const flags = {
    episodes: [],
    socket: null,
    decisionHz: 5,
    clipSeconds: undefined,
    maxDecisions: undefined,
    /** Provisional RewardConfig overrides (Phase 3 tuning), JSON object. */
    reward: undefined,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const value = () => {
      const v = argv[++i];
      if (v === undefined) throw new Error(`${arg} requires a value`);
      return v;
    };
    switch (arg) {
      case '--episodes':
        for (const f of value().split(',')) flags.episodes.push(f.trim());
        break;
      case '--socket': flags.socket = value(); break;
      case '--decision-hz': flags.decisionHz = Number(value()); break;
      case '--clip-seconds': flags.clipSeconds = Number(value()); break;
      case '--reward': flags.reward = JSON.parse(value()); break;
      case '--max-decisions': flags.maxDecisions = Number(value()); break;
      default: throw new Error(`unknown flag ${arg}`);
    }
  }
  if (flags.episodes.length === 0) throw new Error('--episodes <a.json,b.json,…> is required');
  if (!flags.socket) throw new Error('--socket <path> is required');
  return flags;
}

/**
 * Duck-typed EnvServer replacement: same handle()/closes() contract as
 * `EnvServer` from the dist, but sessions carry reactive-ambient RunOptions.
 */
class ReactiveEnvServer {
  constructor({ episodes, decisionHz, clipSeconds, maxDecisions, reward }) {
    this.decisionHz = decisionHz;
    this.sessions = episodes.map(
      ({ input, graph }) =>
        new EnvSession({
          input,
          graph,
          runOptions: { ambientReactivity: 'reactive' },
          episode: {
            decisionHz,
            ...(clipSeconds === undefined ? {} : { clipSeconds }),
            ...(maxDecisions === undefined ? {} : { maxDecisions }),
            ...(reward === undefined ? {} : { reward }),
            goal: { routeEnd: true },
            observation: { stateVector: true, bev: BEV_CONFIG },
          },
        }),
    );
    /** Collision/goal flags and last encoded frame per session. */
    this.lastCollision = this.sessions.map(() => false);
    this.lastGoal = this.sessions.map(() => false);
    this.lastDoc = this.sessions.map(() => null);
  }

  info() {
    return {
      proto: 1,
      sessions: this.sessions.length,
      decisionHz: this.decisionHz,
      engineHz: 50,
      egos: this.sessions.map((s) => s.ego),
      obs: { sv: true, bev: true },
      bevConfig: BEV_CONFIG,
    };
  }

  requireSession(index) {
    const i = index === undefined || index === null ? 0 : index;
    const session = this.sessions[i];
    if (!session) throw new Error(`no session ${i} (server hosts ${this.sessions.length})`);
    return [session, i];
  }

  encodeWithFlags(result, index) {
    const doc = encodeStepResult(result);
    doc.col = this.lastCollision[index] ? 1 : 0;
    doc.goal = this.lastGoal[index] ? 1 : 0;
    return doc;
  }
  step(index, action) {
    const [session, i] = this.requireSession(index);
    let result;
    try {
      result = session.step(decodeAction(action));
    } catch (error) {
      // Gymnasium semantics: post-episode stepping is undefined. Serve the
      // cached final frame so vectorized clients can keep batching.
      if (/finished or un-reset/.test(String(error?.message)) && this.lastDoc[i]) return this.lastDoc[i];
      throw error;
    }
    this.lastCollision[i] = 'collision' in result.info.rewardTerms ? true : result.terminated && result.reward <= -1 && !result.info.rewardTerms?.goal;
    this.lastGoal[i] = Boolean(result.info.rewardTerms.goal);
    const doc = this.encodeWithFlags(result, i);
    this.lastDoc[i] = doc;
    return doc;
  }

  reset(index, seed) {
    const [session, i] = this.requireSession(index);
    const result = seed === undefined || seed === null ? session.reset() : session.reset(seed);
    this.lastCollision[i] = false;
    this.lastGoal[i] = false;
    const doc = this.encodeWithFlags(result, i);
    this.lastDoc[i] = doc;
    return doc;
  }



  handle(request) {
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
          const rs = this.sessions.map((_, index) => this.reset(index, seeds?.[index]));
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

  closes(request) {
    return request.op === 'close';
  }
}

const flags = parseArgs(process.argv.slice(2));
const loaded = [];
for (const specFile of flags.episodes) {
  const { episodes } = await loadEpisodeSpec(specFile);
  loaded.push(...episodes);
}
process.stderr.write(`reactive-env-server: ${loaded.length} episodes loaded\n`);

const server = new ReactiveEnvServer({ ...flags, episodes: loaded });
const listener = serveSocket(server, flags.socket);
await new Promise((resolve, reject) => {
  listener.once('listening', resolve);
  listener.once('error', reject);
});
process.stdout.write(`reactive-env-server listening on ${flags.socket}\n`);
