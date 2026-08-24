import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { buildLaneGraph, parseSimScenarioInput, runSimulation, SignalBook, buildRoute } from '../../../../../packages/engine/src/index.js';
const doc = JSON.parse(readFileSync(process.argv[2]!, 'utf8'));
const graph = buildLaneGraph(JSON.parse(gunzipSync(readFileSync(`dev-assets/${doc.input.mapId}/topology-index.json.gz`)).toString('utf8')));
const input = parseSimScenarioInput(doc.input);
const { trace } = runSimulation(input, { graph, guards: 'collect' });
const ego = input.actors.find((a) => a.id === 'ego')!;
const egoLanes = new Set(trace.ticks.actors['ego']!.laneRsl.filter((r): r is string => r !== null));
const book = new SignalBook(input.signalPrograms, input.warmupSeconds, input.roadControls);
console.log(JSON.stringify({
  mapId: input.mapId,
  egoRules: ego.behavior.rules.obeySignals,
  egoLanesDriven: [...egoLanes],
  programs: input.signalPrograms.map((p) => ({
    id: p.id, darkFallback: p.darkFallback,
    phases: p.phases.map((x) => `${x.phase}:${x.durationS}`),
    stopLineLanes: p.stopLines.map((l) => l.rsl),
    stopLineOnEgoRoute: p.stopLines.some((l) => egoLanes.has(l.rsl)),
  })),
  setInteractions: input.interactions.filter((i) => i.verb === 'set').map((i: any) => ({ id: i.id, key: i.target.key, value: i.target.value, trigger: i.trigger })),
  signalPhasesSeen: Object.fromEntries(Object.entries(trace.ticks.signals ?? {}).map(([k, v]: any) => [k, [...new Set(v.phase)]])),
  authorityAtEnd: book.stopLines.map((l) => ({ control: l.controlId, rsl: l.rsl, onEgoRoute: egoLanes.has(l.rsl), authority: book.authorityAt(l, 11) })),
  events: trace.events.filter((e: any) => e.kind === 'state_set' || e.kind === 'trigger_fired').slice(0, 10),
}, null, 1));
