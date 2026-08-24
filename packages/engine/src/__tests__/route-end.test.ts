import { describe, expect, it } from 'vitest';

import { buildLaneGraph } from '../map/lane-graph.js';
import { parseSimScenarioInput } from '../schema/input.js';
import { runSimulation } from '../sim/engine.js';
import { syntheticTopology } from './fixtures/synthetic-map.js';

const graph = buildLaneGraph(syntheticTopology());

describe('terminal actor poses', () => {
  it('holds a pedestrian at the end of its route through the aftermath', () => {
    const input = parseSimScenarioInput({
      mapId: 'synthetic-straight',
      clipSeconds: 3,
      warmupSeconds: 0,
      dt: 0.02,
      seed: 'pedestrian-terminal-pose',
      actors: [{
        id: 'ped',
        kind: 'pedestrian',
        dims: { l: 0.6, w: 0.6, h: 1.7 },
        initial: { pose: { x: 0, z: 0, headingRad: 0 }, speedMps: 2 },
        behavior: {
          route: { kind: 'polyline', points: [{ x: 0, z: 0 }, { x: 2, z: 0 }] },
          cruiseSpeedMps: 2,
        },
      }],
    });

    const { trace } = runSimulation(input, { graph, guards: 'collect' });
    const track = trace.ticks.actors.ped!;
    expect(track.present.every((present) => present === 1)).toBe(true);
    expect(track.x.at(-1)).toBeCloseTo(2, 4);
    expect(track.y.at(-1)).toBeCloseTo(0, 4);
    expect(track.speedMps.at(-1)).toBe(0);
    expect(trace.events.some((event) => event.kind === 'despawn' && event.actorId === 'ped')).toBe(false);
  });

  it.each(['car', 'bicycle', 'animal'] as const)(
    'holds a terminal %s without implicit despawn or nonzero frozen speed',
    (kind) => {
      const input = parseSimScenarioInput({
        mapId: 'synthetic-straight',
        clipSeconds: 3,
        warmupSeconds: 0,
        dt: 0.02,
        seed: `terminal-${kind}`,
        actors: [{
          id: kind,
          kind,
          initial: { pose: { x: 0, z: 0, headingRad: 0 }, speedMps: 3 },
          behavior: {
            route: { kind: 'polyline', points: [{ x: 0, z: 0 }, { x: 2, z: 0 }] },
            cruiseSpeedMps: 3,
          },
        }],
      });

      const { trace } = runSimulation(input, { graph, guards: 'collect' });
      const track = trace.ticks.actors[kind]!;
      expect(track.present.every((present) => present === 1)).toBe(true);
      expect(track.x.at(-1)).toBeCloseTo(2, 4);
      expect(track.speedMps.at(-1)).toBe(0);
      expect(trace.events.some((event) => event.kind === 'despawn')).toBe(false);
    },
  );
});
