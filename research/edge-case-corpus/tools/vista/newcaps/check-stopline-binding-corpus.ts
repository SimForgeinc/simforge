import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { buildLaneGraph, parseSimScenarioInput, runSimulation, type LaneGraph } from '../../../../../packages/engine/src/index.js';
const graphs = new Map<string, LaneGraph>();
let withPrograms = 0, onRoute = 0;
for (const path of process.argv.slice(2)) {
  try {
    const doc = JSON.parse(readFileSync(path, 'utf8'));
    const raw = doc.input ?? doc;
    const input = parseSimScenarioInput(raw);
    if (input.signalPrograms.length === 0 && input.roadControls.length === 0) continue;
    withPrograms += 1;
    const mapId = input.mapId;
    if (!graphs.has(mapId)) graphs.set(mapId, buildLaneGraph(JSON.parse(gunzipSync(readFileSync(`dev-assets/${mapId}/topology-index.json.gz`)).toString('utf8'))));
    const { trace } = runSimulation(input, { graph: graphs.get(mapId)!, guards: 'collect' });
    const subject = input.metricSubject ?? 'ego';
    const track = trace.ticks.actors[subject] ?? Object.values(trace.ticks.actors)[0]!;
    const lanes = new Set(track.laneRsl.filter((r): r is string => r !== null));
    const hit = [
      ...input.signalPrograms.filter((p) => p.stopLines.some((l) => lanes.has(l.rsl))).map((p) => p.id),
      ...input.roadControls.filter((c) => c.stopLines.some((l) => lanes.has(l.rsl))).map((c) => c.id),
    ];
    if (hit.length > 0) onRoute += 1;
    console.log(JSON.stringify({ cell: path.split('/').slice(-2)[0], mapId, programs: input.signalPrograms.length, roadControls: input.roadControls.length, controlsOnSubjectRoute: hit }));
  } catch (e) { console.log(JSON.stringify({ cell: path.split('/').slice(-2)[0], error: String(e).slice(0, 90) })); }
}
console.error(`instances carrying controls: ${withPrograms}; of those, controls actually on the metric subject's route: ${onRoute}`);
