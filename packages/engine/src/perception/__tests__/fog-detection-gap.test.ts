/**
 * The perception layer's acceptance test.
 *
 * A pedestrian standing in the ego's lane is *geometrically* visible for the
 * whole clip — there is no occluder and the operational visibility range is
 * effectively unlimited. What changes between the two runs below is only the
 * air: dense fog attenuates the contrast the ego's dash camera needs, so the
 * camera does not report the pedestrian until it is much closer, and the ego
 * therefore brakes late. That distinction — geometry says "visible", the sensor
 * says "not detected" — is the whole point of the layer.
 */

import { describe, expect, it } from 'vitest';

import { runSimulation } from '../../sim/engine.js';
import { parseSimScenarioInput, type SimScenarioInputSpec } from '../../schema/input.js';
import { LANE_LEFT, poseOnLane, syntheticGraph, vehicle } from '../../__tests__/fixtures/scenarios.js';

const PED_S = 250;
const CLIP_S = 30;

function pedestrian(graph: ReturnType<typeof syntheticGraph>): SimScenarioInputSpec['actors'][number] {
  const pose = poseOnLane(graph, LANE_LEFT, PED_S);
  return {
    id: 'ped',
    kind: 'pedestrian',
    initial: { laneRef: { rsl: LANE_LEFT, s: PED_S, tFrac: 0 }, pose, speedMps: 0 },
    behavior: {
      rules: { collisionAvoidance: false },
      route: { kind: 'follow', startRsl: LANE_LEFT, turns: [], maxLengthM: 400 },
      cruiseSpeedMps: 0,
    },
    static: true,
  };
}

/** Identical scenarios apart from the declared atmosphere. */
function fixture(fogVisibilityM: number): SimScenarioInputSpec {
  const graph = syntheticGraph();
  const ego = vehicle(graph, { id: 'ego', rsl: LANE_LEFT, s: 0, speedMps: 12, cruiseSpeedMps: 12 });
  return {
    mapId: 'synthetic-straight',
    clipSeconds: CLIP_S,
    warmupSeconds: 0,
    dt: 0.02,
    seed: 'perception-fixture',
    physics: { mode: 'kinematic-v1' },
    // Geometry must never be the reason: unlimited LOS range, no occluders.
    operationalConditions: { effects: { visibilityRangeM: 10_000 } },
    perception: {
      atmosphere: { fogVisibilityM },
    },
    actors: [
      {
        ...ego,
        rules: undefined,
        sensors: [
          {
            id: 'ego-dash',
            type: 'dash_camera',
            mount: { position: { x: 1.8, y: 1.1, z: 0 } },
            aperture: { horizontalFovDeg: 90, verticalFovDeg: 60, nearM: 0.05, farM: 400 },
          },
        ],
      } as SimScenarioInputSpec['actors'][number],
      pedestrian(graph),
    ],
    interactions: [
      {
        id: 'ego-brakes',
        actorId: 'ego',
        trigger: {
          kind: 'when',
          condition: { kind: 'detected', a: 'ped', by: 'ego', value: true },
          byLatest: CLIP_S,
          ifNever: 'skip',
        },
        verb: 'speed',
        target: { mode: 'stop' },
        dynamics: { shape: 'linear', constraint: 'rate', value: 3.5 },
      },
    ],
  } as SimScenarioInputSpec;
}

function run(fogVisibilityM: number) {
  const graph = syntheticGraph();
  const input = parseSimScenarioInput(fixture(fogVisibilityM));
  return runSimulation(input, { graph, guards: 'skip' });
}

const CLEAR_AIR_M = 20_000;
const DENSE_FOG_M = 120;

describe('perception: sensors are consumed by the engine', () => {
  it('keeps declared sensors on the parsed engine input instead of dropping them', () => {
    const input = parseSimScenarioInput(fixture(CLEAR_AIR_M));
    const ego = input.actors.find((a) => a.id === 'ego')!;
    expect(ego.sensors).toHaveLength(1);
    expect(ego.sensors![0]!.id).toBe('ego-dash');
  });

  it('writes a first-class per-sensor detection channel into the trace', () => {
    const { trace } = run(CLEAR_AIR_M);
    const channel = trace.ticks.sensors?.['ego/ego-dash'];
    expect(channel).toBeDefined();
    expect(channel!.targets['ped']!.status).toHaveLength(trace.ticks.t.length);
    expect(new Set(channel!.targets['ped']!.status)).toContain(3); // 3 = detected
  });

  it('reports the pedestrian as geometrically visible but undetected in dense fog', () => {
    const { trace } = run(DENSE_FOG_M);
    const entry = trace.metrics.perception!.sensors.find(
      (s) => s.observer === 'ego' && s.target === 'ped',
    )!;
    expect(entry.firstLineOfSightT).toBe(0);
    expect(entry.perceptionLagS).toBeGreaterThan(5);
  });

  it('detects the pedestrian later in fog than in clear air, so the ego brakes later', () => {
    const clear = run(CLEAR_AIR_M);
    const fog = run(DENSE_FOG_M);

    const detect = (r: typeof clear) =>
      r.trace.metrics.perception!.sensors.find((s) => s.observer === 'ego' && s.target === 'ped')!
        .timeToFirstDetectionS!;
    expect(detect(fog)).toBeGreaterThan(detect(clear) + 5);

    const brake = (r: typeof clear) =>
      r.trace.events.find((e) => e.kind === 'trigger_fired' && e.interactionId === 'ego-brakes')!.t;
    expect(brake(fog)).toBeGreaterThan(brake(clear) + 5);

    // The late reaction has to be visible in the dynamics, not only in the log.
    const gapAt = (r: typeof clear, t: number) => {
      const i = r.trace.ticks.t.findIndex((v) => v >= t - 1e-9);
      return r.trace.ticks.actors['ped']!.x[i]! - r.trace.ticks.actors['ego']!.x[i]!;
    };
    expect(gapAt(fog, CLIP_S - 1)).toBeLessThan(gapAt(clear, CLIP_S - 1));
  });

  it('is replay deterministic', () => {
    const a = run(DENSE_FOG_M);
    const b = run(DENSE_FOG_M);
    expect(JSON.stringify(b.trace)).toBe(JSON.stringify(a.trace));
  });
});
