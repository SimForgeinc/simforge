import { performance } from 'node:perf_hooks';

import type { SimScenarioInput } from '@simforge/engine';
import { describe, expect, it } from 'vitest';

import { scenario, syntheticGraph, vehicle } from '../fixture.js';
import { WorldSession } from '../world-session.js';

const graph = syntheticGraph();

function input(): SimScenarioInput {
  return scenario(graph, {
    actors: [vehicle(graph, { id: 'ego', s: 20, speedMps: 10, cruiseSpeedMps: 10 })],
  });
}

function measureSpawnAt(elapsedTicks: number): number {
  const world = new WorldSession({ input: input(), graph, mode: 'live' });
  if (elapsedTicks > 0) world.advance(elapsedTicks);
  const started = performance.now();
  const outcome = world.applyCommand('cost-probe', 0, {
    kind: 'spawn',
    spawn: { kind: 'car', pose: { x: 300, z: 3.5 } },
  });
  const elapsedMs = performance.now() - started;
  expect(outcome.ok).toBe(true);
  return elapsedMs;
}

function median(values: readonly number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)]!;
}

describe('world session structural mutation cost', () => {
  it('keeps spawn cost independent of elapsed tick count', () => {
    // Warm the JIT before collecting the fresh-world denominator.
    measureSpawnAt(0);
    const freshMs = median([measureSpawnAt(0), measureSpawnAt(0), measureSpawnAt(0)]);
    const oldWorldMs = median([measureSpawnAt(4_000), measureSpawnAt(4_000), measureSpawnAt(4_000)]);
    const ratio = oldWorldMs / freshMs;

    console.info(`world-session live spawn cost: fresh=${freshMs.toFixed(2)}ms, at-4000-ticks=${oldWorldMs.toFixed(2)}ms, ratio=${ratio.toFixed(2)}x`);
    // The additive allowance absorbs sub-millisecond timer/JIT noise while the
    // old 4,000-tick replay (measured before this fix) still fails decisively.
    expect(oldWorldMs).toBeLessThanOrEqual(freshMs * 3 + 5);
  });
});
