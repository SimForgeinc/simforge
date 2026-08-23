import { describe, expect, it } from 'vitest';

import { parseSimScenarioInput } from '../schema/input.js';
import { runSimulation } from '../sim/engine.js';
import { traceDigest } from '../trace/gzip.js';
import { syntheticGraph } from './fixtures/scenarios.js';

function crossingActor(
  id: string,
  points: Array<{ x: number; z: number }>,
  speedMps: number,
  tags: string[] = [],
) {
  const start = points[0]!;
  const end = points[1]!;
  return {
    id,
    kind: 'car' as const,
    dims: { l: 4.5, w: 1.9, h: 1.5 },
    initial: {
      pose: { x: start.x, z: start.z, headingRad: Math.atan2(-(end.z - start.z), end.x - start.x) },
      speedMps,
    },
    behavior: {
      rules: {
        yield: true,
        yieldToVehicles: true,
        collisionAvoidance: true,
        obeySignals: false,
      },
      route: { kind: 'polyline' as const, points },
      cruiseSpeedMps: speedMps,
    },
    presentAtStart: true,
    tags,
  };
}

function priorityScenario(ambient: boolean, reverse = false) {
  const actors = [
    crossingActor('authored', [{ x: -20, z: 0 }, { x: 40, z: 0 }], 10),
    crossingActor('background', [{ x: 0, z: 10 }, { x: 0, z: -40 }], 10, ambient ? ['ambient'] : []),
  ];
  return parseSimScenarioInput({
    mapId: 'ambient-priority',
    clipSeconds: 1,
    warmupSeconds: 0,
    dt: 0.1,
    seed: 'ambient-priority',
    actors: reverse ? actors.reverse() : actors,
  });
}

describe('ambient crossing priority', () => {
  it('never changes authored same-lane motion to follow an ambient leader', () => {
    const graph = syntheticGraph();
    const authored = crossingActor('authored', [{ x: 0, z: 0 }, { x: 80, z: 0 }], 10);
    // Keep the leader outside physical contact range for the whole assertion;
    // this test isolates semantic following priority, while contact parity is
    // covered by the dynamic collision tests.
    const ambientLeader = crossingActor('background', [{ x: 40, z: 0 }, { x: 120, z: 0 }], 3, ['ambient']);
    const solo = runSimulation(parseSimScenarioInput({
      mapId: 'ambient-following-priority', clipSeconds: 1, warmupSeconds: 0, dt: 0.1, actors: [authored],
    }), { graph, guards: 'collect' }).trace;
    const populated = runSimulation(parseSimScenarioInput({
      mapId: 'ambient-following-priority', clipSeconds: 1, warmupSeconds: 0, dt: 0.1, actors: [authored, ambientLeader],
    }), { graph, guards: 'collect' }).trace;
    expect(populated.ticks.actors.authored!.speedMps).toEqual(solo.ticks.actors.authored!.speedMps);
    expect(populated.ticks.actors.authored!.x).toEqual(solo.ticks.actors.authored!.x);
  });

  it('never makes an authored actor yield solely to an ambient crossing actor', () => {
    const graph = syntheticGraph();
    const normal = runSimulation(priorityScenario(false), { graph, guards: 'collect' }).trace;
    const ambient = runSimulation(priorityScenario(true), { graph, guards: 'collect' }).trace;
    expect(ambient.ticks.actors.authored!.speedMps.at(-1)!)
      .toBeGreaterThan(normal.ticks.actors.authored!.speedMps.at(-1)! + 0.5);
  });

  it('makes ambient traffic yield to authored traffic even when ambient arrives first', () => {
    const graph = syntheticGraph();
    const normal = runSimulation(priorityScenario(false), { graph, guards: 'collect' }).trace;
    const ambient = runSimulation(priorityScenario(true), { graph, guards: 'collect' }).trace;
    expect(ambient.ticks.actors.background!.speedMps.at(-1)!)
      .toBeLessThan(normal.ticks.actors.background!.speedMps.at(-1)! - 0.5);
  });

  it('keeps ambient broadphase traces deterministic under declaration permutation', () => {
    const graph = syntheticGraph();
    const first = runSimulation(priorityScenario(true), { graph, guards: 'collect' }).trace;
    const second = runSimulation(priorityScenario(true, true), { graph, guards: 'collect' }).trace;
    expect(traceDigest(first)).toBe(traceDigest(second));
  });

  it('does not miss a swept collision between distant grid cells', () => {
    const graph = syntheticGraph();
    const input = parseSimScenarioInput({
      mapId: 'ambient-sweep',
      clipSeconds: 0.2,
      warmupSeconds: 0,
      dt: 0.2,
      actors: [
        {
          ...crossingActor('ambient-fast', [{ x: -20, z: 0 }, { x: 100, z: 0 }], 200, ['ambient']),
          behavior: {
            ...crossingActor('ambient-fast', [{ x: -20, z: 0 }, { x: 100, z: 0 }], 200, ['ambient']).behavior,
            rules: { collisionAvoidance: false, obeySignals: false },
          },
        },
        {
          ...crossingActor('authored-static', [{ x: 0, z: 0 }, { x: 1, z: 0 }], 0),
          static: true,
        },
      ],
    });
    const trace = runSimulation(input, { graph, guards: 'collect' }).trace;
    expect(trace.metrics.collisions).toEqual([
      expect.objectContaining({ a: 'ambient-fast', b: 'authored-static' }),
    ]);
  });
});
