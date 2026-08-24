import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { buildLaneGraph, parseSimScenarioInput, runSimulation } from '../../../../../packages/engine/src/index.js';
const doc = JSON.parse(readFileSync(process.argv[2]!, 'utf8'));
const graph = buildLaneGraph(JSON.parse(gunzipSync(readFileSync(`dev-assets/${doc.input.mapId}/topology-index.json.gz`)).toString('utf8')));
const input = parseSimScenarioInput(doc.input);
const { trace } = runSimulation(input, { graph, guards: 'collect' });
const r = (v: number) => Math.round(v * 100) / 100;
const out: any = {
  mapId: input.mapId,
  signalPrograms: input.signalPrograms.map((p) => ({ id: p.id, phases: p.phases, darkFallback: p.darkFallback, stopLines: p.stopLines })),
  actors: {},
  signals: Object.fromEntries(Object.entries(trace.ticks.signals ?? {}).map(([k, v]: any) => [k, [...new Set(v.phase)]])),
};
for (const [id, tk] of Object.entries<any>(trace.ticks.actors)) {
  out.actors[id] = {
    speed: { start: r(tk.speedMps[0]), min: r(Math.min(...tk.speedMps)), end: r(tk.speedMps.at(-1)) },
    sRange: [r(tk.s[0]), r(tk.s.at(-1))],
    lanes: [...new Set(tk.laneRsl)].slice(0, 6),
  };
}
const ids = Object.keys(trace.ticks.actors);
if (ids.length === 2) {
  const [a, b] = ids as [string, string];
  const A = trace.ticks.actors[a]!, B = trace.ticks.actors[b]!;
  let min = Infinity, at = 0;
  for (let i = 0; i < trace.ticks.t.length; i++) {
    const dd = Math.hypot(A.x[i]! - B.x[i]!, A.y[i]! - B.y[i]!);
    if (dd < min) { min = dd; at = trace.ticks.t[i]!; }
  }
  out.closest = { pair: [a, b], m: r(min), t: at };
}
out.minTTC = trace.metrics.minTTC;
console.log(JSON.stringify(out, null, 1));
