/**
 * Pre-run feasibility guards. These fire before a tick is simulated, so a
 * generation loop never pays for a scenario that was structurally broken.
 */

import { describe, expect, it } from 'vitest';
import { SimEngineError } from '../errors.js';
import { checkFeasibility } from '../solve/guards.js';
import { runSimulation } from '../sim/engine.js';
import { parseSimScenarioInput } from '../schema/input.js';
import { LANE_LEFT, LANE_RIGHT, poseOnLane, scenario, syntheticGraph, vehicle } from './fixtures/scenarios.js';
import { LANE_DEAD_END } from './fixtures/synthetic-map.js';

const graph = syntheticGraph();

describe('feasibility guards', () => {
  it('catches a dead-end route (whole-clip runway)', () => {
    const input = scenario(graph, {
      actors: [vehicle(graph, { id: 'ego', rsl: LANE_DEAD_END, s: 5, speedMps: 12, cruiseSpeedMps: 12 })],
    });
    const issues = checkFeasibility(input, graph);
    const runway = issues.find((i) => i.code === 'runway_insufficient');
    expect(runway).toBeDefined();
    expect(runway!.severity).toBe('warning');
    expect(runway!.path).toBe('actors.ego.behavior.route');
    expect(runway!.detail!.neededM).toBeGreaterThan(200);
    expect(runway!.detail!.availableM).toBeCloseTo(55, 0);
  });

  it('runSimulation throws a structured SimEngineError by default', () => {
    const input = scenario(graph, {
      actors: [
        vehicle(graph, { id: 'a', s: 100, speedMps: 10, cruiseSpeedMps: 10 }),
        vehicle(graph, { id: 'b', s: 102, speedMps: 10, cruiseSpeedMps: 10 }),
      ],
    });
    expect(() => runSimulation(input, { graph })).toThrow(SimEngineError);
    try {
      runSimulation(input, { graph });
    } catch (e) {
      expect((e as SimEngineError).issues[0]!.code).toBe('spawn_overlap');
    }
    // …but `guards: 'collect'` lets a study run anyway.
    const { issues } = runSimulation(input, { graph, guards: 'collect' });
    expect(issues.some((i) => i.code === 'spawn_overlap')).toBe(true);
  });

  it('accepts a route with enough runway', () => {
    const input = scenario(graph, {
      actors: [vehicle(graph, { id: 'ego', s: 10, speedMps: 12, cruiseSpeedMps: 12 })],
    });
    expect(checkFeasibility(input, graph).filter((i) => i.severity === 'error')).toHaveLength(0);
  });

  it('uses future speed actions and bus acceleration limits for a dwelling actor runway', () => {
    const dwelling = {
      ...vehicle(graph, { id: 'bus', rsl: LANE_DEAD_END, s: 5, speedMps: 0, cruiseSpeedMps: 0 }),
      kind: 'bus' as const,
    };
    const build = (departureSpeedMps: number) => parseSimScenarioInput({
      mapId: 'action-aware-runway',
      clipSeconds: 14,
      warmupSeconds: 2,
      dt: 0.02,
      actors: [dwelling],
      interactions: [{
        id: 'bus-accelerates',
        actorId: 'bus',
        trigger: { kind: 'at', t: 0.5 },
        verb: 'speed',
        target: { mode: 'absolute', value: departureSpeedMps },
        dynamics: { shape: 'linear', constraint: 'time', value: 3 },
      }],
    });

    const fast = checkFeasibility(build(6.67), graph).find((issue) => issue.code === 'runway_insufficient');
    expect(fast).toBeDefined();
    expect(fast!.detail!.neededM).toBeGreaterThan(55);
    // The bound follows the 0→target transition and bus acceleration envelope;
    // it must not fall back to 14 seconds at the road speed.
    expect(fast!.detail!.neededM).toBeLessThan(90);

    expect(checkFeasibility(build(3), graph).some((issue) => issue.code === 'runway_insufficient')).toBe(false);
  });

  it('catches overlapping spawn footprints with real dimensions', () => {
    const input = scenario(graph, {
      actors: [
        vehicle(graph, { id: 'a', s: 100, speedMps: 10, cruiseSpeedMps: 10 }),
        vehicle(graph, { id: 'b', s: 102, speedMps: 10, cruiseSpeedMps: 10 }),
      ],
    });
    const overlap = checkFeasibility(input, graph).find((i) => i.code === 'spawn_overlap');
    expect(overlap).toBeDefined();
    expect(overlap!.detail).toEqual({ a: 'a', b: 'b' });

    // 5 m apart with 4.5 m cars is fine.
    const ok = scenario(graph, {
      actors: [
        vehicle(graph, { id: 'a', s: 100, speedMps: 10, cruiseSpeedMps: 10 }),
        vehicle(graph, { id: 'b', s: 105, speedMps: 10, cruiseSpeedMps: 10 }),
      ],
    });
    expect(checkFeasibility(ok, graph).some((i) => i.code === 'spawn_overlap')).toBe(false);
  });

  it('catches a spawn s beyond the end of its lane', () => {
    const input = scenario(graph, {
      actors: [vehicle(graph, { id: 'ego', s: 900, speedMps: 10, cruiseSpeedMps: 10 })],
    });
    const found = checkFeasibility(input, graph).find((i) => i.code === 'spawn_off_lane');
    expect(found).toBeDefined();
  });

  it('treats a spawn lane outside the route as an error', () => {
    const actor = vehicle(graph, { id: 'ego', s: 10, speedMps: 10, cruiseSpeedMps: 10 });
    const input = scenario(graph, {
      actors: [{
        ...actor,
        behavior: {
          ...actor.behavior,
          route: { kind: 'follow', startRsl: LANE_RIGHT, turns: [], maxLengthM: 2000 },
        },
      }],
    });
    const found = checkFeasibility(input, graph).find((i) => i.code === 'spawn_lane_not_on_route');
    expect(found).toEqual(expect.objectContaining({
      severity: 'error',
      path: 'actors.ego.initial.laneRef.rsl',
      detail: { rsl: LANE_LEFT },
    }));
  });

  it('catches a decel budget blown by the dynamics', () => {
    const base = scenario(graph, {
      actors: [vehicle(graph, { id: 'ego', s: 10, speedMps: 25, cruiseSpeedMps: 25 })],
    });
    const input = {
      ...base,
      interactions: [
        {
          id: 'slam',
          actorId: 'ego',
          trigger: { kind: 'at' as const, t: 5 },
          verb: 'speed' as const,
          target: { mode: 'stop' as const },
          dynamics: { shape: 'linear' as const, constraint: 'time' as const, value: 1 },
        },
      ],
    };
    const found = checkFeasibility(input, graph).find((i) => i.code === 'decel_budget_exceeded');
    expect(found).toBeDefined();
    expect(found!.severity).toBe('warning');
    expect(found!.path).toBe('interactions.slam.dynamics');
    expect(found!.detail!.budget).toBe(8);
    expect(found!.detail!.impliedDecel).toBeCloseTo(25, 0);
  });

  it('catches a disconnected explicit lane path', () => {
    const input = parseSimScenarioInput({
      mapId: 'synthetic-straight',
      seed: 1,
      actors: [
        {
          id: 'ego',
          kind: 'vehicle',
          dims: { l: 4.5, w: 1.9, h: 1.5 },
          initial: { pose: poseOnLane(graph, LANE_LEFT, 10), speedMps: 10 },
          behavior: {
            // `1:0:-1` ends at (400, 0); `2:0:-2` starts at (400, -3.5).
            route: { kind: 'lanePath', lanes: [LANE_LEFT, '2:0:-2'] },
          },
        },
      ],
    });
    const issues = checkFeasibility(input, graph);
    expect(issues.some((i) => i.code === 'route_disconnected')).toBe(true);
    void LANE_RIGHT;
  });
});
