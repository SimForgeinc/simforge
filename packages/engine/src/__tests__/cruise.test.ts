/**
 * The warm-up contract: `t ∈ [-warmup, 0)` is unrecorded, and by `t = 0` every
 * actor has converged on its commanded speed. Nothing downstream should ever
 * see a spawn transient.
 */

import { describe, expect, it } from 'vitest';
import { runSimulation } from '../sim/engine.js';
import { LANE_LEFT, scenario, syntheticGraph, vehicle } from './fixtures/scenarios.js';

describe('warm-up and cruise', () => {
  const graph = syntheticGraph();

  it('holds a commanded speed exactly when it starts there', () => {
    const input = scenario(graph, {
      actors: [vehicle(graph, { id: 'ego', s: 20, speedMps: 15, cruiseSpeedMps: 15 })],
    });
    const { trace } = runSimulation(input, { graph });
    const v = trace.ticks.actors['ego']!.speedMps;
    expect(trace.ticks.t[0]).toBeCloseTo(0, 9);
    expect(v[0]!).toBeCloseTo(15, 6);
    expect(v[v.length - 1]!).toBeCloseTo(15, 6);
  });

  it('converges on the commanded speed during the warm-up prologue', () => {
    const input = scenario(graph, {
      actors: [vehicle(graph, { id: 'ego', s: 20, speedMps: 12, cruiseSpeedMps: 15 })],
    });
    const { trace } = runSimulation(input, { graph });
    // At t = 0 the transient must be gone: 5 s of a τ = 0.5 s law.
    expect(trace.ticks.actors['ego']!.speedMps[0]!).toBeCloseTo(15, 3);
  });

  it('excludes the prologue from the trace and starts at t = 0', () => {
    const input = scenario(graph, {
      clipSeconds: 10,
      warmupSeconds: 5,
      actors: [vehicle(graph, { id: 'ego', s: 20, speedMps: 15, cruiseSpeedMps: 15 })],
    });
    const { trace } = runSimulation(input, { graph });
    expect(trace.ticks.t[0]).toBeCloseTo(0, 9);
    expect(trace.ticks.t[trace.ticks.t.length - 1]).toBeCloseTo(10, 6);
    expect(trace.ticks.t.length).toBe(Math.round(10 / 0.02) + 1);
    // The prologue moved the actor: s at t=0 is spawn + 5 s of travel.
    expect(trace.ticks.actors['ego']!.s[0]!).toBeCloseTo(20 + 15 * 5, 1);
  });

  it('drives along the lane centreline in the xodr-local frame', () => {
    const input = scenario(graph, {
      actors: [vehicle(graph, { id: 'ego', rsl: LANE_LEFT, s: 20, speedMps: 15, cruiseSpeedMps: 15 })],
    });
    const { trace } = runSimulation(input, { graph });
    const track = trace.ticks.actors['ego']!;
    for (const y of track.y) expect(Math.abs(y)).toBeLessThan(1e-6);
    expect(track.x[track.x.length - 1]! - track.x[0]!).toBeCloseTo(15 * 20, 0);
    expect(track.laneRsl[0]).toBe(LANE_LEFT);
  });
});
