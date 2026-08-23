import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { buildLaneGraph, parseSimScenarioInput, runSimulation, type LaneGraph } from '../../../../../packages/engine/src/index.js';
const graphs = new Map<string, LaneGraph>();
let onRoute = 0;
for (const path of process.argv.slice(2)) {
  const doc = JSON.parse(readFileSync(path, 'utf8'));
  const mapId = doc.input.mapId;
  if (!graphs.has(mapId)) graphs.set(mapId, buildLaneGraph(JSON.parse(gunzipSync(readFileSync(`dev-assets/${mapId}/topology-index.json.gz`)).toString('utf8'))));
  const input = parseSimScenarioInput(doc.input);
  const { trace } = runSimulation(input, { graph: graphs.get(mapId)!, guards: 'collect' });
  const egoLanes = new Set(trace.ticks.actors['ego']!.laneRsl.filter((r): r is string => r !== null));
  const hit = input.signalPrograms.filter((p) => p.stopLines.some((l) => egoLanes.has(l.rsl))).map((p) => p.id);
  const stopHit = input.roadControls.filter((c) => c.stopLines.some((l) => egoLanes.has(l.rsl))).map((c) => c.id);
  if (hit.length > 0) onRoute += 1;
  console.log(JSON.stringify({ cell: path.replace(/^.*proof\//, '').slice(0, 46), programs: input.signalPrograms.length,
    signalStopLinesOnEgoRoute: hit, staticStopControlsOnEgoRoute: stopHit }));
}
console.error(`cells with a signal stop line on the ego route: ${onRoute}/${process.argv.length - 2}`);
