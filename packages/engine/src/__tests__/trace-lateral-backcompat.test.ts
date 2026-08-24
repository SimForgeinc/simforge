import { describe, expect, it } from 'vitest';
import {
  quantizeTrace,
  traceToSceneFrame,
  TRACE_FORMAT_VERSION,
  type SimTrace,
} from '../index.js';

function trace(traceVersion: number, lateralOffsetM?: unknown): SimTrace {
  const actor: Record<string, unknown> = {
    x: [1, 2],
    y: [3, 4],
    headingRad: [0, 0.1],
    speedMps: [5, 6],
    laneRsl: ['1:0:-1', '1:0:-1'],
    s: [0, 1],
    present: [1, 1],
  };
  if (lateralOffsetM !== undefined) actor.lateralOffsetM = lateralOffsetM;
  return {
    header: {
      traceVersion,
      engineVersion: 'test',
      inputHash: 'input',
      seed: 'seed',
      mapId: 'map',
      engineGraphDigest: 'graph',
      topologyDigest: 'graph',
      dt: 1,
      clipSeconds: 1,
      warmupSeconds: 0,
      frame: 'xodr-local',
      actorIds: ['ego'],
      metricSubject: 'ego',
      physics: { mode: 'kinematic-v1', solver: 'test', solverVersion: 'test', substepS: 1, vehicleProfileDigest: null },
    },
    ticks: { t: [0, 1], actors: { ego: actor } },
    events: [],
    metrics: {
      minTTC: null,
      minDistance: [],
      requiredDecelMax: { ego: 0 },
      collisions: [],
      triggerNeverFired: [],
      clippedCriticality: false,
      ticksSimulated: 2,
    },
  } as unknown as SimTrace;
}

describe('trace lateral-offset version compatibility', () => {
  it.each([1, 2, 3])('synthesizes deterministic zeros for absent legacy v%s channels', (version) => {
    expect(traceToSceneFrame(trace(version)).ticks.actors.ego?.lateralOffsetM).toEqual([0, 0]);
    expect(quantizeTrace(trace(version)).ticks.actors.ego?.lateralOffsetM).toEqual([0, 0]);
  });

  it('preserves the exact current channel through scene conversion and quantization', () => {
    expect(TRACE_FORMAT_VERSION).toBe(4);
    const current = trace(TRACE_FORMAT_VERSION, [-0.125, 1.23456]);
    expect(traceToSceneFrame(current).ticks.actors.ego?.lateralOffsetM).toEqual([-0.125, 1.23456]);
    expect(quantizeTrace(current).ticks.actors.ego?.lateralOffsetM).toEqual([-0.125, 1.2346]);
  });

  it.each([
    [3, [0]],
    [3, [0, Number.NaN]],
    [4, undefined],
    [4, [0]],
  ])('rejects malformed or missing required channels for v%s', (version, lateral) => {
    expect(() => traceToSceneFrame(trace(version as number, lateral))).toThrow(/lateralOffsetM/);
    expect(() => quantizeTrace(trace(version as number, lateral))).toThrow(/lateralOffsetM/);
  });

  it('fails closed when direct conversion receives an unknown trace version', () => {
    expect(() => traceToSceneFrame(trace(5, [0, 0]))).toThrow(/traceVersion/);
    expect(() => quantizeTrace(trace(5, [0, 0]))).toThrow(/traceVersion/);
  });
});
