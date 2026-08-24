import { readFile } from 'node:fs/promises';
import { performance } from 'node:perf_hooks';
import { pathToFileURL } from 'node:url';

const [modulePath, networkPath, manifestPath] = process.argv.slice(2);
if (!modulePath || !networkPath || !manifestPath) {
  console.error('usage: node signal-queue-smoke.mjs <sumo.mjs> <map.net.xml> <sumo-network-manifest.json>');
  process.exit(2);
}

const [{ default: factory }, sourceNetwork, manifest] = await Promise.all([
  import(pathToFileURL(modulePath).href),
  readFile(networkPath, 'utf8'),
  readFile(manifestPath, 'utf8').then(JSON.parse),
]);
const network = fitCycles(sourceNetwork, 18);
const controlledStops = controlledStopPoints(network);
const routes = routeDocument(manifest.routeCandidates.slice(0, 64));
const sumo = await factory({ noInitialRun: true, printErr: () => {} });
const net = copy(sumo, new TextEncoder().encode(network));
const route = copy(sumo, new TextEncoder().encode(routes));
assertOk(sumo, sumo._us_sumo_start(net.pointer, net.length, route.pointer, route.length, .05, 2711));
sumo._free(net.pointer);
sumo._free(route.pointer);

const previousSignals = new Map();
const candidates = [];
const stepTimes = [];
for (let tick = 1; tick <= 400; tick += 1) {
  const started = performance.now();
  assertOk(sumo, sumo._us_sumo_step(.05));
  stepTimes.push(performance.now() - started);
  const time = tick * .05;
  const actors = actorSpeeds(sumo);
  const signals = linkStates(sumo);
  for (const [key, state] of signals) {
    if (previousSignals.get(key) === 'r' && state === 'g') {
      const stops = controlledStops.get(key) ?? [];
      const stopped = new Set([...actors]
        .filter(([, actor]) => actor.speed < .2 && stops.some((stop) => Math.hypot(actor.x - stop.x, actor.y - stop.y) < 35))
        .map(([id]) => id));
      candidates.push({ time, stopped, released: new Set() });
    }
    previousSignals.set(key, state);
  }
  for (const candidate of candidates) {
    if (time - candidate.time > 6) continue;
    for (const id of candidate.stopped) if ((actors.get(id)?.speed ?? 0) > 1) candidate.released.add(id);
  }
}
sumo._us_sumo_close();
const accepted = candidates.filter((candidate) => candidate.stopped.size > 0 && candidate.released.size > 0);
const best = accepted.sort((a, b) => b.released.size - a.released.size)[0];
const ordered = stepTimes.toSorted((a, b) => a - b);
const report = {
  simulatedSeconds: 20,
  redToGreenTransitions: candidates.length,
  queueReleaseTransitions: accepted.length,
  bestQueuedActors: best?.stopped.size ?? 0,
  bestReleasedActors: best?.released.size ?? 0,
  stepP95Milliseconds: Number(ordered[Math.floor(ordered.length * .95)].toFixed(3)),
};
console.log(JSON.stringify(report, null, 2));
if (!best) throw new Error('No stopped SUMO actor resumed after a controlled link changed red to green');

function actorSpeeds(sumo) {
  const count = sumo._us_sumo_state_count();
  const view = new DataView(sumo.HEAPU8.buffer, sumo._us_sumo_state_pointer(), count * 32);
  const values = new Map();
  for (let index = 0; index < count; index += 1) {
    const offset = index * 32;
    values.set(view.getUint32(offset, true), {
      x: view.getFloat32(offset + 4, true),
      y: view.getFloat32(offset + 8, true),
      speed: view.getFloat32(offset + 16, true),
    });
  }
  return values;
}

function controlledStopPoints(xml) {
  const lanes = new Map([...xml.matchAll(/<lane\b([^>]*)\/?\s*>/g)].flatMap((match) => {
    const id = attribute(match[1], 'id');
    const shape = attribute(match[1], 'shape');
    if (!id || !shape) return [];
    const last = shape.trim().split(/\s+/).at(-1)?.split(',').map(Number);
    return last?.length >= 2 ? [[id, { x: last[0], y: last[1] }]] : [];
  }));
  const result = new Map();
  for (const match of xml.matchAll(/<connection\b([^>]*)/g)) {
    const controller = attribute(match[1], 'tl');
    const linkIndex = Number(attribute(match[1], 'linkIndex'));
    const from = attribute(match[1], 'from');
    const fromLane = attribute(match[1], 'fromLane');
    const stop = lanes.get(`${from}_${fromLane}`);
    if (!controller || !Number.isInteger(linkIndex) || !stop) continue;
    const key = `${fnv1a(controller)}:${linkIndex}`;
    result.set(key, [...(result.get(key) ?? []), stop]);
  }
  return result;
}

function linkStates(sumo) {
  const count = sumo._us_sumo_signal_state_count();
  const view = new DataView(sumo.HEAPU8.buffer, sumo._us_sumo_signal_state_pointer(), count * 8);
  const values = new Map();
  for (let index = 0; index < count; index += 1) {
    const offset = index * 8;
    values.set(
      `${view.getUint32(offset, true)}:${view.getUint16(offset + 4, true)}`,
      String.fromCharCode(view.getUint8(offset + 6)).toLowerCase(),
    );
  }
  return values;
}

function fitCycles(xml, target) {
  return xml.replace(/(<tlLogic\b[^>]*>)([\s\S]*?)(<\/tlLogic>)/g, (whole, open, body, close) => {
    const phases = [...body.matchAll(/<phase\b([^>]*)\/?\s*>/g)].map((match) => ({
      duration: Number(attribute(match[1], 'duration')),
      state: attribute(match[1], 'state') ?? '',
    }));
    const total = phases.reduce((sum, phase) => sum + phase.duration, 0);
    if (phases.length < 2 || total <= target) return whole;
    const clearance = phases.map((phase) => phase.state.match(/[yY]/) ? 2 : /^[rso]+$/i.test(phase.state) ? 1 : 0);
    const active = phases.map((phase, index) => clearance[index] === 0 ? phase.duration : 0);
    const activeTotal = active.reduce((sum, value) => sum + value, 0);
    const remaining = target - clearance.reduce((sum, value) => sum + value, 0);
    if (activeTotal <= 0 || remaining < active.filter((value) => value > 0).length * 2) return whole;
    let index = 0;
    return open + body.replace(/(<phase\b[^>]*duration=")[\d.]+("[^>]*>)/g, (_phase, before, after) => {
      const duration = clearance[index] || remaining * active[index] / activeTotal;
      index += 1;
      return `${before}${duration.toFixed(2)}${after}`;
    }) + close;
  });
}

function routeDocument(candidates) {
  const vehicles = candidates.map((edges, index) =>
    `<vehicle id="queue-${index}" type="ambient" depart="0" departLane="best" departPos="random_free" departSpeed="max"><route edges="${edges.join(' ')}"/></vehicle>`,
  ).join('\n');
  return `<routes><vType id="ambient" carFollowModel="EIDM" laneChangeModel="SL2015" accel="2.5" decel="4.5" emergencyDecel="9" tau="1.2"/>${vehicles}</routes>`;
}

function copy(sumo, bytes) {
  const pointer = sumo._malloc(bytes.byteLength);
  sumo.HEAPU8.set(bytes, pointer);
  return { pointer, length: bytes.byteLength };
}

function assertOk(sumo, code) {
  if (code === 0) return;
  throw new Error(sumo.UTF8ToString(sumo._us_sumo_last_error()) || `SUMO failed (${code})`);
}

function attribute(source, name) {
  return source.match(new RegExp(`\\b${name}="([^"]*)"`))?.[1];
}

function fnv1a(value) {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}
