import { describe, expect, it } from 'vitest';
import { parseSimScenarioInput } from '../schema/input.js';
import { runSimulation } from '../sim/engine.js';
import { LANE_LEFT, syntheticGraph, vehicle } from './fixtures/scenarios.js';

describe('audio state timeline keys', () => {
  it('accepts audio.horn and emits exact state transitions into the trace', () => {
    const graph = syntheticGraph();
    const ambulance = vehicle(graph, { id: 'ambulance', rsl: LANE_LEFT, s: 10, speedMps: 2, cruiseSpeedMps: 2 });
    const input = parseSimScenarioInput({
      mapId: 'synthetic-straight', clipSeconds: 1, warmupSeconds: 0, dt: 0.05,
      seed: 'ambulance-horn', actors: [ambulance], interactions: [
        { id: 'horn-on', actorId: 'ambulance', trigger: { kind: 'at', t: 0.2 }, verb: 'set', target: { key: 'audio.horn', value: true } },
        { id: 'horn-off', actorId: 'ambulance', trigger: { kind: 'at', t: 0.5 }, verb: 'set', target: { key: 'audio.horn', value: false } },
      ],
    });
    const { trace } = runSimulation(input, { graph, guards: 'collect' });
    expect(trace.events.filter((event) => event.kind === 'state_set' && event.key === 'audio.horn'))
      .toEqual([
        { t: 0.2, kind: 'state_set', actorId: 'ambulance', key: 'audio.horn', value: true },
        { t: 0.5, kind: 'state_set', actorId: 'ambulance', key: 'audio.horn', value: false },
      ]);
  });
});
