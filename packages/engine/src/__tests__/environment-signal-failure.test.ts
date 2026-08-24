/**
 * Signal failure modes.
 *
 * A signal program can only ever be a rotation through working indications, so
 * the two states that actually change right-of-way law are unrepresentable:
 *
 *  - a **blackout** (`off`): a dark head is not "no control", it legally
 *    becomes an all-way stop. The engine currently reads `off` as permissive,
 *    which is the opposite of the rule.
 *  - a **flashing red / flashing yellow arrow**: flashing red is a stop sign
 *    (stop, then proceed when clear), flashing yellow is a permissive turn.
 *
 * These are per-program *fallback authority*, not new phases bolted onto the
 * cycle, so any program may black out and any author may say what the law does
 * when it happens.
 */

import { describe, expect, it } from 'vitest';

import { parseSimScenarioInput } from '../schema/input.js';
import { runSimulation } from '../sim/engine.js';
import { SignalBook, phaseForbidsEntry } from '../sim/signals.js';
import { LANE_LEFT, scenario, syntheticGraph, vehicle } from './fixtures/scenarios.js';

const graph = syntheticGraph();
const STOP_LINE_S = 180;

function approach(phase: 'off' | 'flashing_red' | 'green', darkFallback?: 'all_way_stop' | 'uncontrolled') {
  const input = parseSimScenarioInput(scenario(graph, {
    clipSeconds: 25,
    warmupSeconds: 0,
    physics: { mode: 'kinematic-v1' },
    actors: [vehicle(graph, { id: 'ego', rsl: LANE_LEFT, s: 20, speedMps: 12, cruiseSpeedMps: 12 })],
    signalPrograms: [{
      id: 'sig-main',
      phases: [{ phase, durationS: 600 }],
      loop: false,
      stopLines: [{ rsl: LANE_LEFT, s: STOP_LINE_S }],
      ...(darkFallback ? { darkFallback } : {}),
    }],
  }));
  const { trace } = runSimulation(input, { graph, guards: 'collect' });
  const ticks = trace.ticks.actors.ego!;
  const stoppedIndex = ticks.speedMps.findIndex((v) => v <= 0.05);
  return {
    minSpeedMps: Math.min(...ticks.speedMps),
    stoppedAtS: stoppedIndex < 0 ? null : ticks.s[stoppedIndex]!,
    finalS: ticks.s.at(-1)!,
  };
}

describe('signal blackout', () => {
  it('treats a dark head as an all-way stop rather than as no control at all', () => {
    const green = approach('green');
    expect(green.minSpeedMps).toBeGreaterThan(5);

    const dark = approach('off');
    // Stops at the line...
    expect(dark.stoppedAtS).not.toBeNull();
    expect(dark.stoppedAtS!).toBeGreaterThan(STOP_LINE_S - 8);
    expect(dark.stoppedAtS!).toBeLessThan(STOP_LINE_S + 1);
    // ...then, unlike a red, is released and carries on.
    expect(dark.finalS).toBeGreaterThan(STOP_LINE_S + 20);
  });

  it('lets an author declare a blackout that is legally uncontrolled instead', () => {
    const dark = approach('off', 'uncontrolled');
    expect(dark.minSpeedMps).toBeGreaterThan(5);
  });

  it('gives flashing red stop-and-proceed semantics', () => {
    const flashing = approach('flashing_red');
    expect(flashing.stoppedAtS).not.toBeNull();
    expect(flashing.finalS).toBeGreaterThan(STOP_LINE_S + 20);
  });
});

describe('turn-arrow indications', () => {
  it('accepts flashing arrows and gives them the documented right of way', () => {
    expect(phaseForbidsEntry('flashing_yellow_arrow')).toBe(false);
    expect(phaseForbidsEntry('flashing_red_arrow')).toBe(true);
    expect(phaseForbidsEntry('green_arrow')).toBe(false);
    expect(phaseForbidsEntry('red_x')).toBe(true);
  });

  it('carries a flashing yellow arrow through a program', () => {
    const book = new SignalBook([{
      id: 'turn-head',
      phases: [
        { phase: 'flashing_yellow_arrow', durationS: 20 },
        { phase: 'green_arrow', durationS: 10 },
      ],
      offsetS: 0,
      loop: true,
      stopLines: [],
    }], 0);
    expect(book.phaseAt('turn-head', 1)).toBe('flashing_yellow_arrow');
    expect(book.phaseAt('turn-head', 25)).toBe('green_arrow');
  });
});
