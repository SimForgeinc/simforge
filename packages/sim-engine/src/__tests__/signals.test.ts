/**
 * Signal compliance and the `set(rules.*)` switches.
 *
 * `rules.obeySignals = false` is how C3's red-light-violation archetype is
 * authored, and `rules.collisionAvoidance = false` is the make-or-break flag
 * that stops a challenger chickening out of a critical approach.
 */

import { describe, expect, it } from 'vitest';
import { parseSimScenarioInput } from '../schema/input.js';
import { runSimulation } from '../sim/engine.js';
import { SignalBook, phaseForbidsEntry } from '../sim/signals.js';
import { contentHash } from '../core/hash.js';
import { resolveSimScenarioInput } from '../solve/resolve.js';
import { LANE_LEFT, scenario, syntheticGraph, vehicle } from './fixtures/scenarios.js';

const graph = syntheticGraph();
const STOP_LINE_S = 180;

function signalScenario(obeySignals: boolean) {
  return scenario(graph, {
    actors: [
      vehicle(graph, {
        id: 'ego',
        rsl: LANE_LEFT,
        s: 20,
        speedMps: 12,
        cruiseSpeedMps: 12,
        rules: { obeySignals },
      }),
    ],
    signalPrograms: [
      {
        id: 'sig-main',
        phases: [{ phase: 'red', durationS: 120 }],
        loop: false,
        stopLines: [{ rsl: LANE_LEFT, s: STOP_LINE_S }],
      },
    ],
  });
}

describe('signal compliance', () => {
  it('requires flattened physical ids to close over controller-stage membership', () => {
    const base = signalScenario(true);
    const binding = {
      junctionId: 'j1',
      controllerIds: ['stage-a', 'stage-b'],
      headIds: ['h1'],
      controllerHeadGroups: [
        { controllerId: 'stage-a', headIds: ['h1'] },
        { controllerId: 'stage-b', headIds: ['h1'] },
      ],
      timingSource: 'synthetic-default' as const,
    };
    expect(() => parseSimScenarioInput({
      ...base,
      signalPrograms: [{ ...base.signalPrograms[0]!, mapBinding: binding }],
    })).not.toThrow();
    expect(() => parseSimScenarioInput({
      ...base,
      signalPrograms: [{
        ...base.signalPrograms[0]!,
        mapBinding: { ...binding, controllerIds: ['stage-a'] },
      }],
    })).toThrow(/controllerIds must equal controllerHeadGroups/);
    expect(() => parseSimScenarioInput({
      ...base,
      signalPrograms: [{
        ...base.signalPrograms[0]!,
        mapBinding: { ...binding, headIds: ['h1', 'invented'] },
      }],
    })).toThrow(/headIds must equal controllerHeadGroups/);
  });

  it('carries program timing and runtime override provenance', () => {
    const book = new SignalBook([
      {
        id: 'map-head',
        phases: [
          { phase: 'green', durationS: 10 },
          { phase: 'yellow', durationS: 3 },
          { phase: 'red', durationS: 10 },
        ],
        offsetS: 0,
        loop: true,
        stopLines: [],
        mapBinding: {
          junctionId: 'j1',
          controllerIds: ['c1'],
          headIds: ['h1'],
          timingSource: 'synthetic-default',
        },
      },
    ], 0);
    expect(book.stateAt('map-head', 0)).toEqual({
      phase: 'green',
      source: 'program',
      timingSource: 'synthetic-default',
    });
    book.setOverride('map-head', 'red');
    expect(book.stateAt('map-head', 0)).toEqual({
      phase: 'red',
      source: 'override',
      timingSource: 'synthetic-default',
    });
  });

  it('permits green and treats yellow/red as stop-line controls', () => {
    expect(phaseForbidsEntry('green')).toBe(false);
    expect(phaseForbidsEntry('yellow')).toBe(true);
    expect(phaseForbidsEntry('red')).toBe(true);
    expect(phaseForbidsEntry('green_arrow')).toBe(false);
    expect(phaseForbidsEntry('proceed')).toBe(false);
    expect(phaseForbidsEntry('flashing_yellow')).toBe(false);
    // `off` used to be listed permissive here, which said a dark head means
    // "proceed". It does not: a blackout resolves to `stop` AUTHORITY in
    // `SignalBook.authorityAt` before this predicate is consulted, and leaving
    // it permissive here as well would let whichever check ran first wave a
    // dark head through. See DEFECT-signal-authority.md.
    expect(phaseForbidsEntry('off')).toBe(true);
    expect(phaseForbidsEntry('red_x')).toBe(true);
    expect(phaseForbidsEntry('stop')).toBe(true);
  });

  it('executes and traces a deterministic 20 s human-director stop/release program', () => {
    const input = scenario(graph, {
      actors: [vehicle(graph, { id: 'ego', rsl: LANE_LEFT, s: 20, speedMps: 12, cruiseSpeedMps: 12 })],
      signalPrograms: [{
        id: 'director-west',
        phases: [{ phase: 'stop', durationS: 120 }],
        loop: false,
        stopLines: [{ rsl: LANE_LEFT, s: 100 }],
      }],
      interactions: [{
        id: 'director-release', actorId: 'ego',
        trigger: { kind: 'at', t: 10 }, verb: 'set',
        target: { key: 'control:director-west.indication', value: 'proceed' },
      }],
    });
    const first = runSimulation(input, { graph }).trace;
    const second = runSimulation(input, { graph }).trace;
    const track = first.ticks.actors['ego']!;
    const beforeRelease = first.ticks.t.findIndex((t) => t >= 9.9);
    expect(track.speedMps[beforeRelease]).toBeLessThan(0.1);
    expect(track.x.at(-1)).toBeGreaterThan(120);
    expect(first.ticks.signals?.['director-west']?.phase[beforeRelease]).toBe('stop');
    expect(first.ticks.signals?.['director-west']?.phase.at(-1)).toBe('proceed');
    expect(first.events).toContainEqual(expect.objectContaining({ kind: 'state_set', key: 'control:director-west.indication', value: 'proceed' }));
    expect(second.ticks.signals).toEqual(first.ticks.signals);
    expect(second.events).toEqual(first.events);
  });

  it('treats a dark failed normal signal as an all-way stop, then releases it', () => {
    // This test used to be called "…as uncontrolled" and asserted only that the
    // ego ended up past the line, which a stop-and-release also satisfies. The
    // law is that a dark head reverts the junction to an all-way stop, so the
    // standstill is the assertion that matters.
    const base = signalScenario(true);
    const input = parseSimScenarioInput({
      ...base,
      signalPrograms: [{ ...base.signalPrograms[0]!, phases: [{ phase: 'off', durationS: 120 }] }],
    });
    const { trace } = runSimulation(input, { graph });
    expect(Math.min(...trace.ticks.actors['ego']!.speedMps)).toBeLessThanOrEqual(0.05);
    expect(trace.ticks.actors['ego']!.x.at(-1)).toBeGreaterThan(STOP_LINE_S);
    expect(trace.ticks.signals?.['sig-main']?.phase.at(-1)).toBe('off');
  });

  it('honours an authored blackout that is genuinely uncontrolled', () => {
    const base = signalScenario(true);
    const input = parseSimScenarioInput({
      ...base,
      signalPrograms: [{
        ...base.signalPrograms[0]!,
        phases: [{ phase: 'off', durationS: 120 }],
        darkFallback: 'uncontrolled',
      }],
    });
    const { trace } = runSimulation(input, { graph });
    expect(Math.min(...trace.ticks.actors['ego']!.speedMps)).toBeGreaterThan(5);
  });

  it('stops, dwells continuously, and releases once at a static stop control', () => {
    const input = scenario(graph, {
      actors: [
        vehicle(graph, {
          id: 'ego',
          rsl: LANE_LEFT,
          s: 20,
          speedMps: 12,
          cruiseSpeedMps: 12,
          rules: { obeySignals: true },
        }),
      ],
      roadControls: [{
        id: 'stop-main',
        kind: 'stop',
        dwellS: 1,
        stopLines: [{ rsl: LANE_LEFT, s: STOP_LINE_S }],
      }],
    });
    const { trace } = runSimulation(input, { graph });
    const track = trace.ticks.actors['ego']!;
    const stoppedTimes = trace.ticks.t.filter(
      (_, index) =>
        track.speedMps[index]! < 0.05 &&
        track.x[index]! > STOP_LINE_S - 3 &&
        track.x[index]! < STOP_LINE_S,
    );
    expect(stoppedTimes.at(-1)! - stoppedTimes[0]!).toBeGreaterThanOrEqual(0.98);
    expect(track.x.at(-1)).toBeGreaterThan(STOP_LINE_S + 5);
  });

  it('stops at the line on red', () => {
    const { trace } = runSimulation(signalScenario(true), { graph });
    const track = trace.ticks.actors['ego']!;
    const last = track.x.length - 1;
    expect(track.x[last]!).toBeLessThan(STOP_LINE_S);
    expect(track.x[last]!).toBeGreaterThan(STOP_LINE_S - 3);
    expect(track.speedMps[last]!).toBeLessThan(0.05);
  });

  it('runs the red when rules.obeySignals is false', () => {
    const { trace } = runSimulation(signalScenario(false), { graph });
    const track = trace.ticks.actors['ego']!;
    const last = track.x.length - 1;
    expect(track.x[last]!).toBeGreaterThan(STOP_LINE_S);
    expect(track.speedMps[last]!).toBeCloseTo(12, 1);
  });

  it('a set(rules.obeySignals=false) mid-clip releases a stopped actor', () => {
    const base = signalScenario(true);
    const input = {
      ...base,
      interactions: [
        {
          id: 'jump-the-light',
          actorId: 'ego',
          trigger: { kind: 'at' as const, t: 16 },
          verb: 'set' as const,
          target: { key: 'rules.obeySignals', value: false },
        },
      ],
    };
    const { trace } = runSimulation(input, { graph });
    const track = trace.ticks.actors['ego']!;
    const atFire = trace.ticks.t.findIndex((v) => v >= 16 - 1e-9);
    expect(track.speedMps[atFire]!).toBeLessThan(0.5);
    expect(track.speedMps[track.speedMps.length - 1]!).toBeGreaterThan(3);
    expect(trace.events.some((e) => e.kind === 'state_set' && e.key === 'rules.obeySignals')).toBe(true);
  });

  it('the signal phase timeline is queryable as a trigger condition', () => {
    const base = signalScenario(false);
    const input = {
      ...base,
      signalPrograms: [
        {
          ...base.signalPrograms[0]!,
          // green for the warm-up + 8 s, then red.
          phases: [
            { phase: 'green' as const, durationS: 13 },
            { phase: 'red' as const, durationS: 120 },
          ],
        },
      ],
      interactions: [
        {
          id: 'brake-on-red',
          actorId: 'ego',
          trigger: {
            kind: 'when' as const,
            condition: { kind: 'signal' as const, signalId: 'sig-main', phase: 'red' as const },
            byLatest: 19,
            ifNever: 'skip' as const,
          },
          verb: 'speed' as const,
          target: { mode: 'stop' as const },
          dynamics: { shape: 'linear' as const, constraint: 'rate' as const, value: 4 },
        },
      ],
    };
    const { trace } = runSimulation(input, { graph });
    const fired = trace.events.find((e) => e.kind === 'trigger_fired');
    expect(fired?.t).toBeCloseTo(8, 1);
    expect(trace.ticks.actors['ego']!.speedMps[trace.ticks.t.length - 1]!).toBeLessThan(0.05);
    expect(trace.ticks.signals?.['sig-main']?.phase).toHaveLength(trace.ticks.t.length);
    expect(trace.ticks.signals?.['sig-main']?.phase[0]).toBe('green');
    expect(trace.ticks.signals?.['sig-main']?.phase.at(-1)).toBe('red');
  });

  it('records a forced signal phase and applies it to the same controller book', () => {
    const base = signalScenario(false);
    const input = {
      ...base,
      interactions: [
        {
          id: 'force-green',
          actorId: 'ego',
          trigger: { kind: 'at' as const, t: 2 },
          verb: 'set' as const,
          target: { key: 'signal:sig-main.phase', value: 'green' },
        },
      ],
    };
    const { trace } = runSimulation(input, { graph });
    const at = trace.ticks.t.findIndex((time) => time >= 2);
    expect(trace.ticks.signals?.['sig-main']?.phase[at]).toBe('green');
    expect(trace.ticks.signals?.['sig-main']?.phase.at(-1)).toBe('green');
  });

  it('filters a stop line to its bound junction movement', () => {
    const base = signalScenario(true);
    const unrelated = {
      ...base,
      signalPrograms: base.signalPrograms.map((program) => ({
        ...program,
        stopLines: program.stopLines.map((line) => ({
          ...line,
          connectingLaneRsls: ['junction:other'],
        })),
      })),
    };
    const { trace } = runSimulation(unrelated, { graph });
    expect(trace.ticks.actors['ego']!.x.at(-1)).toBeGreaterThan(STOP_LINE_S);
  }, 10_000);

  it('leaves a document with no coincident control lane untouched', () => {
    // Both hash sites (the materializer's `manifest.inputHash` and the engine's
    // `trace.header.inputHash`) run `resolveSimScenarioInput`. A document that
    // needs no resolution must come back byte-identical, so no historical
    // digest moves.
    const input = signalScenario(true);
    const resolved = resolveSimScenarioInput(input, graph);
    expect(resolved.issues).toEqual([]);
    expect(resolved.arrival).toEqual([]);
    expect(contentHash(resolved.input)).toBe(contentHash(input));
  });
});

describe('rules.collisionAvoidance', () => {
  function approach(collisionAvoidance: boolean) {
    return scenario(graph, {
      actors: [
        vehicle(graph, { id: 'lead', rsl: LANE_LEFT, s: 120, speedMps: 0, cruiseSpeedMps: 0 }),
        vehicle(graph, {
          id: 'challenger',
          rsl: LANE_LEFT,
          s: 20,
          speedMps: 14,
          cruiseSpeedMps: 14,
          rules: { collisionAvoidance },
        }),
      ],
    });
  }

  it('brakes for a stopped leader when enabled', () => {
    const { trace } = runSimulation(approach(true), { graph, guards: 'collect' });
    expect(trace.metrics.collisions).toHaveLength(0);
    const gap =
      trace.ticks.actors['lead']!.x[trace.ticks.t.length - 1]! -
      trace.ticks.actors['challenger']!.x[trace.ticks.t.length - 1]!;
    expect(gap).toBeGreaterThan(2);
  });

  it('commits and collides when disabled', () => {
    const { trace } = runSimulation(approach(false), { graph, guards: 'collect' });
    expect(trace.metrics.collisions.length).toBeGreaterThan(0);
    expect(trace.metrics.minTTC!.value).toBeLessThan(1);
  });
});
