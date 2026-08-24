/**
 * Phase-0 stepping benchmark for the fixed-step engine.
 *
 * Measures, per actor count and advance-batch size:
 *  - session construction ("reset") wall time
 *  - stepping throughput in engine ticks/s over a full episode
 *
 * The stepping path uses plain `advance(batch)` calls WITHOUT the `trace`
 * flag, i.e. exactly the RL rollout / playback refill pattern: no
 * `buildTrace` is paid per batch, only once when the episode completes.
 *
 * Phase 2.5 adds ambient rows: the same populations tagged `ambient`, run
 * under the default scripted planning and under the opt-in reactive mode, so
 * BENCHMARK.md can record what live re-evaluation costs.
 *
 * Run from the package directory:
 *
 *   npx tsx src/bench/step-bench.ts
 *
 * The committed table lives in `packages/engine/BENCHMARK.md`.
 */

import { performance } from 'node:perf_hooks';

import { createFixedStepSimulation } from '../sim/engine.js';
import type { RunOptions } from '../sim/engine.js';
import type { SimScenarioInput } from '../schema/input.js';
// Dev-only harness: reuses the test fixture graph/builders so the measured
// scenario stays diffable next to the suite that proves its semantics.
import { LANE_LEFT, LANE_RIGHT, scenario, syntheticGraph, vehicle } from '../__tests__/fixtures/scenarios.js';

const graph = syntheticGraph();
const DT = 0.02;
const WARMUP_SECONDS = 2;
const CLIP_SECONDS = 20;
const ACTOR_COUNTS = [1, 5, 10, 20] as const;
const AMBIENT_ACTOR_COUNTS = [5, 10] as const;
const BATCH_SIZES = [1, 10, 50] as const;
const REPEATS = 3;

type StepOptions = Omit<RunOptions, 'graph'>;

interface BenchVariant {
  readonly label: string;
  readonly actorCounts: readonly number[];
  readonly ambient: boolean;
  readonly opts: StepOptions;
}

function benchScenario(actorCount: number, ambient: boolean): SimScenarioInput {
  return scenario(graph, {
    physics: { mode: 'dynamic-v1' },
    warmupSeconds: WARMUP_SECONDS,
    clipSeconds: CLIP_SECONDS,
    actors: Array.from({ length: actorCount }, (_, i) => ({
      ...vehicle(graph, {
        id: `car-${i}`,
        rsl: i % 2 === 0 ? LANE_LEFT : LANE_RIGHT,
        s: 20 + i * 15,
        speedMps: 8 + (i % 4),
        cruiseSpeedMps: 9 + (i % 3),
      }),
      ...(ambient ? { tags: ['ambient'] } : {}),
    })),
  });
}

const VARIANTS: readonly BenchVariant[] = [
  { label: '', actorCounts: ACTOR_COUNTS, ambient: false, opts: {} },
  { label: 'ambient-scripted', actorCounts: AMBIENT_ACTOR_COUNTS, ambient: true, opts: {} },
  { label: 'ambient-reactive', actorCounts: AMBIENT_ACTOR_COUNTS, ambient: true, opts: { ambientReactivity: 'reactive' } },
];

function median(values: readonly number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

function measureResetMs(input: SimScenarioInput, opts: StepOptions): number[] {
  const samples: number[] = [];
  for (let i = 0; i < REPEATS; i += 1) {
    const start = performance.now();
    createFixedStepSimulation(input, { graph, guards: 'throw', ...opts });
    samples.push(performance.now() - start);
  }
  return samples;
}

function measureStepsPerSecond(input: SimScenarioInput, batchSize: number, opts: StepOptions): number[] {
  const totalTicks = Math.round(WARMUP_SECONDS / DT) + Math.round(CLIP_SECONDS / DT);
  const samples: number[] = [];
  for (let i = 0; i < REPEATS; i += 1) {
    const session = createFixedStepSimulation(input, { graph, guards: 'throw', ...opts });
    // Warm-up excluded from timing is not possible through the public API
    // without changing tick order, so the whole episode is timed and the
    // reported figure is honest end-to-end throughput.
    const start = performance.now();
    let progress = session.advance(batchSize);
    while (!progress.done) progress = session.advance(batchSize);
    if (progress.trace === null) throw new Error('completed episode must build its final trace');
    samples.push(totalTicks / ((performance.now() - start) / 1000));
  }
  return samples;
}

const rows: string[] = [];
for (const variant of VARIANTS) {
  for (const actorCount of variant.actorCounts) {
    const input = benchScenario(actorCount, variant.ambient);
    const resetMs = median(measureResetMs(input, variant.opts));
    const cells = BATCH_SIZES.map((batch) => {
      const stepsPerSecond = median(measureStepsPerSecond(input, batch, variant.opts));
      return `| ${variant.label ? `${variant.label} ` : ''}${actorCount} | ${batch} | ${resetMs.toFixed(1)} | ${Math.round(stepsPerSecond).toLocaleString('en-US')} |`;
    });
    rows.push(...cells);
  }
}

console.log('| Actors | Advance batch | Reset (ms) | Steps/s |');
console.log('|---:|---:|---:|---:|');
for (const row of rows) console.log(row);
