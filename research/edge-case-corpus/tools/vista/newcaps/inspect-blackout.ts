import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { buildLaneGraph, parseSimScenarioInput, runSimulation, type LaneGraph } from '../../../../../packages/engine/src/index.js';
const graphs = new Map<string, LaneGraph>();
const r = (v: number) => Math.round(v * 100) / 100;
for (const path of process.argv.slice(2)) {
  const doc = JSON.parse(readFileSync(path, 'utf8'));
  const mapId = doc.input.mapId;
  if (!graphs.has(mapId)) graphs.set(mapId, buildLaneGraph(JSON.parse(gunzipSync(readFileSync(`dev-assets/${mapId}/topology-index.json.gz`)).toString('utf8'))));
  const input = parseSimScenarioInput(doc.input);
  const { trace } = runSimulation(input, { graph: graphs.get(mapId)!, guards: 'collect' });
  const t = trace.ticks.t;
  const ego = trace.ticks.actors['ego']!, cross = trace.ticks.actors['cross']!;
  const phases = trace.ticks.signals?.['control:ego-head']?.phase ?? [];
  const darkAt = phases.findIndex((p: string) => p === 'off');
  // The ego's standstill and its recovery.
  const stoppedIdx = ego.speedMps.findIndex((v: number, i: number) => i > darkAt && v <= 0.3);
  let min = Infinity, at = -1;
  for (let i = 0; i < t.length; i++) {
    const dd = Math.hypot(ego.x[i]! - cross.x[i]!, ego.y[i]! - cross.y[i]!);
    if (dd < min) { min = dd; at = i; }
  }
  // Closest approach that is NOT at spawn.
  let minLate = Infinity, atLate = -1;
  for (let i = 0; i < t.length; i++) {
    if (t[i]! < 1) continue;
    const dd = Math.hypot(ego.x[i]! - cross.x[i]!, ego.y[i]! - cross.y[i]!);
    if (dd < minLate) { minLate = dd; atLate = i; }
  }
  console.log(JSON.stringify({
    cell: path.replace(/^.*bo7\//, ''),
    blackoutAtS: darkAt < 0 ? null : t[darkAt],
    egoSpeedAtBlackout: darkAt < 0 ? null : r(ego.speedMps[darkAt]!),
    egoStoodStill: stoppedIdx >= 0,
    egoStoppedAtS: stoppedIdx < 0 ? null : t[stoppedIdx],
    egoMinSpeed: r(Math.min(...ego.speedMps.slice(Math.max(darkAt, 0)))),
    egoRecoveredTo: r(ego.speedMps.at(-1)!),
    crossKeptMoving: r(Math.min(...cross.speedMps)) > 1,
    crossSpeed: { min: r(Math.min(...cross.speedMps)), max: r(Math.max(...cross.speedMps)) },
    closest: { m: r(min), t: t[at] },
    closestAfter1s: { m: r(minLate), t: t[atLate] },
    minTTC: trace.metrics.minTTC,
  }));
}
