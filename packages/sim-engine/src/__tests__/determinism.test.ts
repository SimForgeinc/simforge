/**
 * The determinism contract, as a test rather than an aspiration.
 *
 * Two claims:
 *
 * 1. **Repeatability** — the same input produces byte-identical canonical trace
 *    bytes on every run.
 * 2. **Order independence** — permuting the declaration order of actors and
 *    interactions produces the *same* trace after id-sort normalisation. That
 *    is what makes an adapter free to emit in whatever order it likes.
 *
 * The source guard at the bottom is the tripwire for the two banned
 * non-determinism sources: `Math.random` and the wall clock.
 */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { Rng } from '../core/rng.js';
import { createFixedStepSimulation, runSimulation } from '../sim/engine.js';
import { serializeTrace, traceDigest } from '../trace/gzip.js';
import { LANE_LEFT, LANE_RIGHT, scenario, syntheticGraph, vehicle } from './fixtures/scenarios.js';
import type { SimScenarioInput } from '../schema/input.js';

const graph = syntheticGraph();

function busyScenario(): SimScenarioInput {
  return scenario(graph, {
    seed: 'determinism-probe',
    metricSubject: 'ego',
    actors: [
      vehicle(graph, { id: 'ego', rsl: LANE_LEFT, s: 80, speedMps: 14, cruiseSpeedMps: 14 }),
      vehicle(graph, { id: 'challenger', rsl: LANE_RIGHT, s: 20, speedMps: 18, cruiseSpeedMps: 18 }),
      vehicle(graph, { id: 'lead', rsl: LANE_LEFT, s: 190, speedMps: 11, cruiseSpeedMps: 11 }),
      vehicle(graph, { id: 'tail', rsl: LANE_RIGHT, s: 150, speedMps: 12, cruiseSpeedMps: 12 }),
    ],
    interactions: [
      {
        id: 'cut-in',
        actorId: 'challenger',
        trigger: {
          kind: 'when',
          condition: { kind: 'distance', a: 'challenger', b: 'ego', mode: 'euclidean', cmp: 'lte', value: 22 },
          byLatest: 14,
          ifNever: 'skip',
        },
        verb: 'changeLane',
        target: { mode: 'left', count: 1 },
        dynamics: { shape: 'sinusoidal', constraint: 'rate', value: 1.0 },
      },
      {
        id: 'brake',
        actorId: 'challenger',
        trigger: { kind: 'after', interactionId: 'cut-in', delayS: 1.5 },
        verb: 'speed',
        target: { mode: 'delta', value: -6 },
        dynamics: { shape: 'cubic', constraint: 'rate', value: 3 },
      },
      {
        id: 'commit',
        actorId: 'challenger',
        trigger: { kind: 'at', t: 2 },
        verb: 'set',
        target: { key: 'rules.collisionAvoidance', value: false },
      },
      {
        id: 'follow-lead',
        actorId: 'tail',
        trigger: { kind: 'at', t: 0 },
        verb: 'gap',
        target: { actorId: 'lead' },
        value: 1.6,
        mode: 'time',
        dynamics: { shape: 'linear', constraint: 'time', value: 3 },
      },
    ],
  });
}

function permute<T>(list: readonly T[], offset: number): T[] {
  const out = [...list];
  for (let i = 0; i < offset; i++) out.push(out.shift()!);
  return out.reverse();
}

describe('determinism', () => {
  it('produces byte-identical traces across runs', () => {
    const input = busyScenario();
    const a = serializeTrace(runSimulation(input, { graph, guards: 'collect' }).trace);
    const b = serializeTrace(runSimulation(input, { graph, guards: 'collect' }).trace);
    expect(a.length).toBe(b.length);
    expect(Buffer.from(a).equals(Buffer.from(b))).toBe(true);
  });

  it.each([1, 3, 10, 97])('streamed fixed-step batches of %i ticks equal the offline trace', (batch) => {
    const input = busyScenario();
    const expected = serializeTrace(runSimulation(input, { graph, guards: 'collect' }).trace);
    const live = createFixedStepSimulation(input, { graph, guards: 'collect' });
    let progress = live.advance(batch);
    while (!progress.done) progress = live.advance(batch);
    const actual = serializeTrace(progress.trace!);
    expect(Buffer.from(actual).equals(Buffer.from(expected))).toBe(true);
    expect(progress.recordedUntil).toBe(input.clipSeconds);
  });

  it('exposes a valid warmed prefix without completing the 20-second clip', () => {
    const input: SimScenarioInput = { ...busyScenario(), physics: { mode: 'dynamic-v1' } };
    const live = createFixedStepSimulation(input, { graph, guards: 'collect' });
    const prefix = live.advance(Math.round(input.warmupSeconds / input.dt) + Math.ceil(0.25 / input.dt), { trace: true });
    expect(prefix.done).toBe(false);
    expect(prefix.recordedUntil).toBeGreaterThanOrEqual(0.15);
    expect(prefix.recordedUntil).toBeLessThan(0.5);
    expect(prefix.trace!.header.physics.mode).toBe('dynamic-v1');
  });

  it('never mutates or drops state from the authored input while streaming', () => {
    const input = busyScenario();
    const before = structuredClone(input);
    const live = createFixedStepSimulation(input, { graph, guards: 'collect' });
    live.advance(73);
    live.advance(29);
    expect(input).toEqual(before);
  });

  it('is independent of actor and interaction declaration order', () => {
    const base = busyScenario();
    const reference = traceDigest(runSimulation(base, { graph, guards: 'collect' }).trace);
    for (let offset = 1; offset <= 3; offset++) {
      const permuted: SimScenarioInput = {
        ...base,
        actors: permute(base.actors, offset),
        interactions: permute(base.interactions, offset),
      };
      expect(permuted.actors.map((a) => a.id)).not.toEqual(base.actors.map((a) => a.id));
      const digest = traceDigest(runSimulation(permuted, { graph, guards: 'collect' }).trace);
      expect(digest).toBe(reference);
    }
  }, 15_000);

  it('records the input hash and engine version in the header', () => {
    const { trace } = runSimulation(busyScenario(), { graph, guards: 'collect' });
    expect(trace.header.inputHash).toMatch(/^[0-9a-f]{64}$/);
    expect(trace.header.engineVersion).toMatch(/^\d+\.\d+\.\d+$/);
    expect(trace.header.frame).toBe('xodr-local');
    expect(trace.header.actorIds).toEqual(['challenger', 'ego', 'lead', 'tail']);
  });

  it('a different seed leaves the deterministic core unchanged', () => {
    // Nothing in the current controller set draws from the RNG, so the seed
    // only enters the header. This test pins that: if a future controller adds
    // jitter, it must be seed-driven and this expectation flips deliberately.
    const a = runSimulation(busyScenario(), { graph, guards: 'collect' }).trace;
    const b = runSimulation({ ...busyScenario(), seed: 'other' }, { graph, guards: 'collect' }).trace;
    expect(JSON.stringify(a.ticks)).toBe(JSON.stringify(b.ticks));
    expect(a.header.inputHash).not.toBe(b.header.inputHash);
  });

  it('the seeded RNG is reproducible and platform-independent', () => {
    const draw = (seed: string) => {
      const rng = new Rng(seed);
      return [rng.next(), rng.next(), rng.next()];
    };
    expect(draw('abc')).toEqual(draw('abc'));
    expect(draw('abc')).not.toEqual(draw('abd'));
    for (const v of draw('abc')) {
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(1);
    }
  });
});

describe('non-determinism tripwire', () => {
  const srcRoot = fileURLToPath(new URL('..', import.meta.url));

  function walk(dir: string, out: string[] = []): string[] {
    for (const entry of readdirSync(dir).sort()) {
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) {
        if (entry === '__tests__' || entry === 'bench' || entry === 'node_modules') continue;
        walk(full, out);
      } else if (entry.endsWith('.ts')) {
        out.push(full);
      }
    }
    return out;
  }

  it('never calls Math.random or reads the wall clock', () => {
    const offenders: string[] = [];
    for (const file of walk(srcRoot)) {
      const text = readFileSync(file, 'utf8');
      // Strip block and line comments so prose about the ban does not trip it.
      const code = text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
      if (/Math\s*\.\s*random/.test(code)) offenders.push(`${file}: Math.random`);
      if (/\bDate\s*\.\s*now\b|new\s+Date\b|performance\s*\.\s*now/.test(code)) {
        offenders.push(`${file}: wall clock`);
      }
    }
    expect(offenders).toEqual([]);
  });
});
