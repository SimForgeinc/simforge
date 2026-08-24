/**
 * Acceptance proof (b) for the signal blackout.
 *
 * Every CLI-materialized cell is run twice: once as authored (a dark head is an
 * all-way stop, which is the law) and once with `darkFallback: 'uncontrolled'`,
 * which is exactly the behaviour the engine had before — `off` in the
 * permissive list, drive on through.
 *
 * Nothing else differs. Same site, same actors, same seed, same program, same
 * phase timeline. The only variable is what the law says a dark head means.
 *
 *   npx tsx research/edge-case-corpus/tools/vista/newcaps/blackout-control.ts <instance.json> [...]
 */
import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';

import {
  buildLaneGraph, parseSimScenarioInput, runSimulation, type LaneGraph,
} from '../../../../../packages/engine/src/index.js';

const graphs = new Map<string, LaneGraph>();
const r2 = (v: number) => Math.round(v * 100) / 100;

function run(doc: any, darkFallback: 'all_way_stop' | 'uncontrolled') {
  const input = parseSimScenarioInput({
    ...doc.input,
    signalPrograms: doc.input.signalPrograms.map((p: any) => ({ ...p, darkFallback })),
    // Keep everything else, including the `set(signal:…phase, off)` that fails the head.
  });
  const mapId = input.mapId;
  if (!graphs.has(mapId)) graphs.set(mapId, buildLaneGraph(JSON.parse(
    gunzipSync(readFileSync(`dev-assets/${mapId}/topology-index.json.gz`)).toString('utf8'))));
  const { trace } = runSimulation(input, { graph: graphs.get(mapId)!, guards: 'collect' });
  const ego = trace.ticks.actors['ego']!;
  const cross = trace.ticks.actors['cross']!;
  const t = trace.ticks.t;
  const dark = Object.values(trace.ticks.signals ?? {})
    .map((s: any) => s.phase.indexOf('off'))
    .filter((i: number) => i >= 0)
    .sort((a: number, b: number) => a - b)[0] ?? -1;
  const after = dark < 0 ? 0 : dark;
  let minLate = Infinity;
  for (let i = 0; i < t.length; i++) {
    if (t[i]! < 1) continue;
    minLate = Math.min(minLate, Math.hypot(ego.x[i]! - cross.x[i]!, ego.y[i]! - cross.y[i]!));
  }
  return {
    egoMinSpeedAfterBlackout: r2(Math.min(...ego.speedMps.slice(after))),
    egoStoodStill: Math.min(...ego.speedMps.slice(after)) <= 0.3,
    egoDistanceAfterBlackout: r2(ego.s.at(-1)! - ego.s[after]!),
    minGapAfter1sM: r2(minLate),
  };
}

let stopsUnderLaw = 0;
let stopsUnderOldBehaviour = 0;
const rows: unknown[] = [];
for (const path of process.argv.slice(2)) {
  const doc = JSON.parse(readFileSync(path, 'utf8'));
  const law = run(doc, 'all_way_stop');
  const old = run(doc, 'uncontrolled');
  if (law.egoStoodStill) stopsUnderLaw += 1;
  if (old.egoStoodStill) stopsUnderOldBehaviour += 1;
  rows.push({
    cell: path.replace(/^.*blackout-proof\//, ''),
    allWayStop: law,
    uncontrolled: old,
    changed: JSON.stringify(law) !== JSON.stringify(old),
  });
}
console.log(JSON.stringify({
  cells: rows.length,
  egoStoppedAtTheDarkHead: { asLaw: stopsUnderLaw, asBeforeThisChange: stopsUnderOldBehaviour },
  rows,
}, null, 1));
