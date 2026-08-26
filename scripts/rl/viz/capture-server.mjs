#!/usr/bin/env node
/**
 * capture-server — visualization rollout host over @simforge-oss/training-env dist.
 *
 * Mirrors scripts/rl/reactive-env-server.mjs session construction exactly
 * (reactive ambient traffic, BEV shim, decisionHz 5, goal routeEnd) so captured
 * rollouts are byte-for-byte the same environment training used, but speaks
 * newline-delimited JSON over stdio instead of framed msgpack so the Python
 * viz driver needs no extra deps, and additionally reports full actor poses +
 * lane geometry for rendering.
 *
 * Protocol (one JSON doc per line):
 *   → {"op":"hello"}                        ← {ok, ego, static:[{id,kind,dims,laneRsl}], geometry:{lanes:[{rsl,polyline,widthM}]}}
 *   → {"op":"reset","seed":"9000"}          ← frame (t=..., no reward)
 *   → {"op":"step","a":{...}|null}          ← frame {t,rw,terms,col,goal,term,trunc,actors:[{id,x,y,h,v,a}],minima}
 *   → {"op":"close"}
 *
 * Deterministic: no wall clock in the dispatch path; identical seeds and
 * action sequences produce identical frames.
 */
import { fileURLToPath } from 'node:url';
import path from 'node:path';
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
import readline from 'node:readline';
const { loadEpisodeSpec } = await import(path.join(repoRoot, 'packages/training-env/dist/env-server.js'));
const { EnvSession } = await import(path.join(repoRoot, 'packages/training-env/dist/index.js'));

/** Mid-level BEV geometry — identical to reactive-env-server.mjs. */
const BEV_CONFIG = { resolutionM: 0.5, forwardM: 32, backwardM: 8, halfWidthM: 10 };

function parseArgs(argv) {
  const flags = { episodes: [], decisionHz: 5 };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const value = () => {
      const v = argv[++i];
      if (v === undefined) throw new Error(`${arg} requires a value`);
      return v;
    };
    switch (arg) {
      case '--episodes': for (const f of value().split(',')) flags.episodes.push(f.trim()); break;
      case '--decision-hz': flags.decisionHz = Number(value()); break;
      default: throw new Error(`unknown flag ${arg}`);
    }
  }
  if (flags.episodes.length === 0) throw new Error('--episodes <a.json,…> is required');
  return flags;
}

/**
 * Driving-lane sketch for rendering: every `driving` lane whose polyline comes
 * within `nearM` of the actors' routed lanes. Honest geometry straight from
 * the map graph — no invented corridors.
 */
function routeGeometry(session) {
  const input = session.baseInput;
  const routedRsls = new Set();
  for (const actor of input.actors) {
    const route = actor.behavior?.route;
    if (route?.kind === 'lanePath') for (const rsl of route.lanes) routedRsls.add(rsl);
    else if (actor.initial?.laneRef?.rsl) routedRsls.add(actor.initial.laneRef.rsl);
  }
  const routedLanes = [...routedRsls].map((rsl) => session.graph.geom.get(rsl)).filter(Boolean);
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  for (const lane of routedLanes) {
    for (const p of lane.lane.polyline ?? []) {
      minX = Math.min(minX, p.x); maxX = Math.max(maxX, p.x);
      minY = Math.min(minY, p.y); maxY = Math.max(maxY, p.y);
    }
  }
  const nearM = 18;
  const lanes = [];
  for (const entry of session.graph.geom.values()) {
    const lane = entry.lane;
    if (lane.laneType !== 'driving') continue;
    const pts = lane.polyline ?? [];
    if (pts.length === 0) continue;
    const inside = pts.some((p) => p.x >= minX - nearM && p.x <= maxX + nearM && p.y >= minY - nearM && p.y <= maxY + nearM);
    if (!inside) continue;
    lanes.push({
      rsl: lane.rsl,
      widthM: lane.representativeWidthM,
      polyline: pts.map((p) => [Number(p.x.toFixed(3)), Number(p.y.toFixed(3))]),
    });
  }
  lanes.sort((a, b) => (a.rsl < b.rsl ? -1 : 1));
  return lanes;
}

class CaptureHost {
  constructor({ episodes, decisionHz }) {
    this.decisionHz = decisionHz;
    this.sessions = episodes.map(
      ({ input, graph }) =>
        new EnvSession({
          input,
          graph,
          runOptions: { ambientReactivity: 'reactive' },
          episode: {
            decisionHz,
            goal: { routeEnd: true },
            observation: { stateVector: true, bev: BEV_CONFIG },
          },
        }),
    );
    this.lastCollision = this.sessions.map(() => false);
    this.lastGoal = this.sessions.map(() => false);
    this.lastDoc = this.sessions.map(() => null);
  }

  requireSession(index) {
    const i = index ?? 0;
    const session = this.sessions[i];
    if (!session) throw new Error(`no session ${i} (hosting ${this.sessions.length})`);
    return [session, i];
  }

  hello() {
    const [session] = this.requireSession(0);
    const statics = session.baseInput.actors.map((a) => ({
      id: a.id, kind: a.kind, dims: a.dims ?? null,
      initial: a.initial?.pose ?? null,
    }));
    return {
      ok: 1,
      ego: session.ego,
      decisionHz: this.decisionHz,
      engineHz: 50,
      clipSeconds: session.episode.clipSeconds,
      warmupSeconds: session.baseInput.warmupSeconds,
      static: statics,
      lanes: routeGeometry(session),
    };
  }

  encodeFrame(result, index, session) {
    const snap = result.snapshot;
    const obs = result.observation;
    return {
      t: result.info.tS,
      sv: obs.stateVector ? Array.from(obs.stateVector, (v) => Number(Number(v).toFixed(5))) : null,
      bev: obs.bev
        ? { w: obs.bev.width, h: obs.bev.height, c: obs.bev.channels, d: Array.from(obs.bev.data, (v) => Number(Number(v).toFixed(3))) }
        : null,
      rw: result.reward,
      terms: [
        result.info.rewardTerms.progress,
        result.info.rewardTerms.proximity,
        result.info.rewardTerms.comfort,
      ],
      col: this.lastCollision[index] ? 1 : 0,
      goal: this.lastGoal[index] ? 1 : 0,
      term: result.terminated ? 1 : 0,
      trunc: result.truncated ? 1 : 0,
      done: result.terminated || result.truncated ? 1 : 0,
      decisions: session.decisionCount,
      actors: snap.actors.map((a) => [
        a.id,
        Number(a.x.toFixed(4)),
        Number(a.y.toFixed(4)),
        Number(a.headingRad.toFixed(5)),
        Number(a.speedMps.toFixed(4)),
        Number(a.accelMps2.toFixed(4)),
        a.present === false ? 0 : 1,
      ]),
      minima: (result.info.minima ?? []).map((m) => ({
        a: m.a, b: m.b,
        d: m.minDistanceM == null ? null : Number(m.minDistanceM.toFixed(3)),
        ttc: m.minTtcS == null ? null : Number(m.minTtcS.toFixed(3)),
        pttc: m.minPathTtcS == null ? null : Number(m.minPathTtcS.toFixed(3)),
        pet: m.minPetS == null ? null : Number(m.minPetS.toFixed(3)),
      })),
    };
  }

  step(index, action) {
    const [session, i] = this.requireSession(index);
    let result;
    try {
      result = session.step(action ?? {});
    } catch (error) {
      if (/finished or un-reset/.test(String(error?.message)) && this.lastDoc[i]) return this.lastDoc[i];
      throw error;
    }
    this.lastCollision[i] =
      'collision' in result.info.rewardTerms ? true : result.terminated && result.reward <= -1 && !result.info.rewardTerms?.goal;
    this.lastGoal[i] = Boolean(result.info.rewardTerms.goal);
    // Attach the raw engine snapshot (poses) before encoding.
    result.snapshot = session.engineSession.peek();
    const doc = this.encodeFrame(result, i, session);
    this.lastDoc[i] = doc;
    return doc;
  }

  reset(index, seed) {
    const [session, i] = this.requireSession(index);
    const result = seed === undefined || seed === null ? session.reset() : session.reset(seed);
    this.lastCollision[i] = false;
    this.lastGoal[i] = false;
    result.snapshot = session.engineSession.peek();
    const doc = this.encodeFrame(result, i, session);
    this.lastDoc[i] = doc;
    return doc;
  }
}


const flags = parseArgs(process.argv.slice(2));
const loaded = [];
for (const specFile of flags.episodes) {
  const { episodes } = await loadEpisodeSpec(path.resolve(specFile));
  loaded.push(...episodes);
}
process.stderr.write(`capture-server: ${loaded.length} episodes loaded\n`);
const host = new CaptureHost({ ...flags, episodes: loaded });

const rl = readline.createInterface({ input: process.stdin, terminal: false });
for await (const line of rl) {
  if (!line.trim()) continue;
  let req;
  try {
    req = JSON.parse(line);
  } catch {
    process.stdout.write(JSON.stringify({ ok: 0, e: 'bad json' }) + '\n');
    continue;
  }
  const id = req.i ?? 0;
  let res;
  try {
    switch (req.op) {
      case 'hello': res = { ok: 1, r: host.hello() }; break;
      case 'reset': res = { ok: 1, r: host.reset(req.s, req.seed) }; break;
      case 'step': res = { ok: 1, r: host.step(req.s, decodeActionShorthand(req.a)) }; break;
      case 'ping': res = { ok: 1, r: { pong: true } }; break;
      case 'close': res = { ok: 1, r: { bye: true } }; break;
      default: throw new Error(`unknown op ${String(req.op)}`);
    }
  } catch (error) {
    res = { ok: 0, e: error instanceof Error ? error.message : String(error) };
  }
  process.stdout.write(JSON.stringify({ i: id, ...res }) + '\n');
  if (req.op === 'close') break;
}

/** {ts,ta,dir} wire shorthand → EnvSession action keys (mirrors env-server decodeAction). */
function decodeActionShorthand(a) {
  if (a === null || a === undefined) return {};
  return {
    ...(a.ts === undefined ? {} : { targetSpeedMps: a.ts }),
    ...(a.ta === undefined ? {} : { targetAccelerationMps2: a.ta }),
    ...(a.dir === undefined ? {} : { motionDirection: a.dir }),
  };
}
