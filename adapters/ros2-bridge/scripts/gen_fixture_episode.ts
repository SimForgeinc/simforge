/**
 * Emit the synthetic straight-road episode spec used by the bridge smoke test.
 *
 * Reuses the training-env test fixture (two-lane 400 m straight, ego-only)
 * so the bridge depends on zero external map assets.  Run from the repo root:
 *
 *   pnpm exec tsx adapters/ros2-bridge/scripts/gen_fixture_episode.ts \
 *     adapters/ros2-bridge/config/episodes/synthetic-straight.episodes.json
 */

import { writeFileSync } from 'node:fs';

import { scenario, syntheticGraph, syntheticTopology, vehicle } from '../../../packages/training-env/src/fixture.js';

const graph = syntheticGraph();
const input = scenario(graph, {
  clipSeconds: 30,
  warmupSeconds: 2,
  // dynamic-v1 honours raw VehicleControl passthrough (throttle/brake/steer);
  // kinematic-v1 ignores it (see engine action-hook-determinism test).
  physics: { mode: 'dynamic-v1' },
  actors: [vehicle(graph, { id: 'ego', s: 50, speedMps: 8, cruiseSpeedMps: 8 })],
});

const spec = {
  version: 1,
  episode: { decisionHz: 10 },
  instances: [{ input, topology: syntheticTopology() }],
};

const out = process.argv[2];
if (!out) throw new Error('usage: gen_fixture_episode.ts <out.json>');
writeFileSync(out, JSON.stringify(spec, null, 2) + '\n');
console.log(`wrote ${out}`);
