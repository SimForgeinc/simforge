import { describe, expect, it } from 'vitest';

import { applyAmbientTraffic, runSimulation } from '../index.js';
import { LANE_LEFT_2 } from './fixtures/synthetic-map.js';
import { LANE_LEFT, scenario, syntheticGraph, vehicle } from './fixtures/scenarios.js';

const graph = syntheticGraph();
const STOP_LINE_S = 350;

function controlledActor(
  phases: Array<{ phase: 'red' | 'yellow' | 'green'; durationS: number }>,
  options: { s?: number; speedMps?: number; clipSeconds?: number } = {},
) {
  return scenario(graph, {
    clipSeconds: options.clipSeconds ?? 12,
    warmupSeconds: 0,
    dt: 0.05,
    actors: [vehicle(graph, {
      id: 'ambient-test-car',
      rsl: LANE_LEFT,
      s: options.s ?? 300,
      speedMps: options.speedMps ?? 12,
      cruiseSpeedMps: 12,
      rules: { obeySignals: true, collisionAvoidance: true },
    })],
    signalPrograms: [{
      id: 'physical-head-main',
      phases,
      loop: false,
      stopLines: [{ rsl: LANE_LEFT, s: STOP_LINE_S, connectingLaneRsls: [LANE_LEFT_2] }],
    }],
  });
}

describe('ambient signal traffic behavior', () => {
  it('uses one deterministic stop-sign queue for ambient and authored default-route cars', () => {
    const lead = vehicle(graph, {
      id: 'ambient-lead', rsl: LANE_LEFT, s: 320, speedMps: 9, cruiseSpeedMps: 10,
    });
    const follow = vehicle(graph, {
      id: 'authored-follow', rsl: LANE_LEFT, s: 302, speedMps: 9, cruiseSpeedMps: 10,
    });
    const input = scenario(graph, {
      clipSeconds: 26,
      warmupSeconds: 0,
      dt: 0.05,
      seed: 'shared-live-driver',
      physics: { mode: 'dynamic-v1' },
      actors: [{ ...lead, tags: ['ambient'] }, follow],
      roadControls: [{
        id: 'physical-stop-main', kind: 'stop', dwellS: 0.8,
        stopLines: [{ rsl: LANE_LEFT, s: STOP_LINE_S, connectingLaneRsls: [LANE_LEFT_2] }],
      }],
    });
    const first = runSimulation(input, { graph, guards: 'collect' }).trace;
    const second = runSimulation(input, { graph, guards: 'collect' }).trace;
    expect(JSON.stringify(second.ticks)).toBe(JSON.stringify(first.ticks));
    const leadTrack = first.ticks.actors['ambient-lead']!;
    const followTrack = first.ticks.actors['authored-follow']!;
    const leadCross = leadTrack.x.findIndex((x) => x > STOP_LINE_S + 1);
    const followCross = followTrack.x.findIndex((x) => x > STOP_LINE_S + 1);
    expect(leadTrack.speedMps.some((speed, index) => speed < 0.05 && leadTrack.x[index]! < STOP_LINE_S)).toBe(true);
    expect(followTrack.speedMps.some((speed, index) => speed < 0.05 && followTrack.x[index]! < STOP_LINE_S)).toBe(true);
    expect(leadCross).toBeGreaterThan(0);
    expect(followCross).toBeGreaterThan(leadCross);
    expect(first.metrics.collisions).toEqual([]);
  }, 20_000);

  it('stops behind a physical red stop line', () => {
    const trace = runSimulation(controlledActor([{ phase: 'red', durationS: 60 }]), { graph }).trace;
    const track = trace.ticks.actors['ambient-test-car']!;
    expect(track.x.at(-1)).toBeGreaterThan(STOP_LINE_S - 3);
    expect(track.x.at(-1)).toBeLessThan(STOP_LINE_S);
    expect(track.speedMps.at(-1)).toBeLessThan(0.05);
  });

  it('keeps the generated population deterministic around physical heads', () => {
    const base = controlledActor([{ phase: 'red', durationS: 60 }], { s: 700, speedMps: 0, clipSeconds: 8 });
    const profile = {
      version: 1 as const,
      preset: 'custom' as const,
      densityVehiclesPerKm: 20,
      seed: 'physical-queue',
      maxActors: 12,
      radiusM: 1_000,
      exclusionRadiusM: 4,
      pedestrianShare: 0,
      cyclistShare: 0,
    };
    const first = applyAmbientTraffic(base, graph, profile);
    const second = applyAmbientTraffic(base, graph, profile);
    const ambient = first.input.actors.filter((actor) => actor.tags.includes('ambient'));
    expect(ambient.length).toBeGreaterThanOrEqual(2);
    expect(ambient.every((actor) => actor.behavior.rules.obeySignals)).toBe(true);
    expect(second.input.actors).toEqual(first.input.actors);
  });

  it('releases a stopped queue smoothly when the controller turns green', () => {
    const trace = runSimulation(controlledActor([
      { phase: 'red', durationS: 2 },
      { phase: 'green', durationS: 30 },
    ], { s: 346.5, speedMps: 0, clipSeconds: 8 }), { graph }).trace;
    const track = trace.ticks.actors['ambient-test-car']!;
    const beforeGreen = trace.ticks.t.findIndex((time) => time >= 1.95);
    const afterGreen = trace.ticks.t.findIndex((time) => time >= 4);
    expect(track.speedMps[beforeGreen]).toBeLessThan(0.05);
    expect(track.speedMps[afterGreen]).toBeGreaterThan(2);
    expect(track.x.at(-1)).toBeGreaterThan(STOP_LINE_S + 10);
  });

  it('uses a comfort-deceleration dilemma decision and commits through yellow', () => {
    const trace = runSimulation(controlledActor(
      [{ phase: 'yellow', durationS: 30 }],
      { s: 334, speedMps: 12, clipSeconds: 4 },
    ), { graph }).trace;
    const track = trace.ticks.actors['ambient-test-car']!;
    expect(track.x.at(-1)).toBeGreaterThan(STOP_LINE_S + 10);
    expect(track.speedMps.at(-1)).toBeGreaterThan(8);
  });

  it('falls back to ordinary car-following when no physical signal is present', () => {
    const input = scenario(graph, {
      clipSeconds: 4,
      warmupSeconds: 0,
      dt: 0.05,
      actors: [vehicle(graph, {
        id: 'ambient-test-car', rsl: LANE_LEFT, s: 334, speedMps: 12, cruiseSpeedMps: 12,
      })],
      signalPrograms: [],
    });
    const trace = runSimulation(input, { graph }).trace;
    expect(trace.ticks.actors['ambient-test-car']!.x.at(-1)).toBeGreaterThan(STOP_LINE_S + 10);
  });

  it('holds a green approach when a stopped downstream queue would block the intersection', () => {
    const follower = vehicle(graph, {
      id: 'ambient-follower', rsl: LANE_LEFT, s: 300, speedMps: 10, cruiseSpeedMps: 10,
    });
    const leader = vehicle(graph, {
      id: 'ambient-leader', rsl: LANE_LEFT, s: 370, speedMps: 0, cruiseSpeedMps: 0,
    });
    const input = scenario(graph, {
      clipSeconds: 10,
      warmupSeconds: 0,
      dt: 0.05,
      actors: [
        { ...follower, tags: ['ambient'] },
        { ...leader, tags: ['ambient'] },
      ],
      signalPrograms: [{
        id: 'physical-head-main',
        phases: [{ phase: 'green', durationS: 60 }],
        loop: false,
        stopLines: [{ rsl: LANE_LEFT, s: STOP_LINE_S, connectingLaneRsls: [LANE_LEFT_2] }],
      }],
    });
    const trace = runSimulation(input, { graph, guards: 'collect' }).trace;
    const track = trace.ticks.actors['ambient-follower']!;
    expect(track.x.at(-1)).toBeGreaterThan(STOP_LINE_S - 3);
    expect(track.x.at(-1)).toBeLessThan(STOP_LINE_S);
    expect(track.speedMps.at(-1)).toBeLessThan(0.05);
    expect(trace.metrics.collisions).toEqual([]);
  });
});
