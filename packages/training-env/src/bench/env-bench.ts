/**
 * Phase-1 rl-env benchmark: end-to-end decision throughput (observation
 * build + reward + causal collection + engine ticks) at 5 actors, per
 * observation configuration, using the Phase-0 harness conventions.
 *
 * Run from the package directory: `npx tsx src/bench/env-bench.ts`.
 * Committed numbers live in this package's BENCHMARK.md.
 */

import { performance } from 'node:perf_hooks';

import { LANE_LEFT, LANE_RIGHT, scenario, syntheticGraph, vehicle } from '../fixture.js';
import { EnvSession } from '../session.js';
import type { SimScenarioInput } from '@simforge/engine';

const graph = syntheticGraph();
const DT = 0.02;
const WARMUP_SECONDS = 2;
const CLIP_SECONDS = 20;
const DECISION_HZ = 10;
const ACTOR_COUNT = 5;
const REPEATS = 3;

function benchScenario(): SimScenarioInput {
  return scenario(graph, {
    physics: { mode: 'dynamic-v1' },
    metricSubject: 'car-0',
    warmupSeconds: WARMUP_SECONDS,
    clipSeconds: CLIP_SECONDS,
    actors: Array.from({ length: ACTOR_COUNT }, (_, i) =>
      vehicle(graph, {
        id: `car-${i}`,
        rsl: i % 2 === 0 ? LANE_LEFT : LANE_RIGHT,
        s: 20 + i * 15,
        speedMps: 8 + (i % 4),
        cruiseSpeedMps: 9 + (i % 3),
      })),
  });
}

function median(values: readonly number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

const VARIANTS = [
  { name: 'state-vector only', observation: { bev: null } },
  { name: 'state + object list', observation: { bev: null } },
  { name: 'state + objects + BEV', observation: { bev: {} } },
] as const;

function measure(variant: (typeof VARIANTS)[number]): { decisionsPerS: number; resetMs: number } {
  const input = benchScenario();
  const start = performance.now();
  const env = new EnvSession({
    input,
    graph,
    episode: { decisionHz: DECISION_HZ, clipSeconds: CLIP_SECONDS, observation: variant.observation },
  });
  env.reset();
  const resetMs = performance.now() - start;
  const t0 = performance.now();
  let decisions = 0;
  let result = env.step({});
  decisions += 1;
  while (!result.truncated && !result.terminated) {
    result = env.step({});
    decisions += 1;
  }
  const seconds = (performance.now() - t0) / 1000;
  return { decisionsPerS: decisions / seconds, resetMs };
}

const rows = VARIANTS.map((variant) => {
  const samples = Array.from({ length: REPEATS }, () => measure(variant));
  return {
    variant: variant.name,
    resetMs: median(samples.map((s) => s.resetMs)),
    decisionsPerS: median(samples.map((s) => s.decisionsPerS)),
  };
});

console.log(`| Observation config | Reset (ms) | Decisions/s (5 actors, ${DECISION_HZ} Hz) |`);
console.log('|---|---:|---:|');
for (const row of rows) {
  console.log(`| ${row.variant} | ${row.resetMs.toFixed(1)} | ${Math.round(row.decisionsPerS).toLocaleString('en-US')} |`);
}
