/**
 * Emit the Autoware W2 episode spec: the synthetic two-lane straight with the
 * externally controlled ego plus one PARKED ground-truth vehicle in the ego's
 * start lane. The Autoware route (authored in autoware_bridge.py) lane-changes
 * around it — the parked car is what the bridge publishes as
 * autoware_perception_msgs/PredictedObjects (injected ground truth, no
 * perception stack).
 *
 *   pnpm exec tsx adapters/ros2-bridge/scripts/gen_autoware_episode.ts \
 *     adapters/ros2-bridge/config/episodes/autoware-lanechange.episodes.json
 */

import { writeFileSync } from 'node:fs';

import { scenario, syntheticGraph, syntheticTopology, vehicle } from '../../../packages/training-env/src/fixture.js';

const graph = syntheticGraph();
const input = scenario(graph, {
  clipSeconds: 30,
  warmupSeconds: 2,
  // dynamic-v1 honours raw VehicleControl passthrough (throttle/brake/steer).
  physics: { mode: 'dynamic-v1' },
  actors: [
    vehicle(graph, { id: 'ego', s: 50, speedMps: 8, cruiseSpeedMps: 8 }),
    // Parked in the ego's start lane (1:0:-1, y=0) past the lane-change zone.
    vehicle(graph, { id: 'npc-parked', s: 185, speedMps: 0, cruiseSpeedMps: 0 }),
  ],
});

const spec = {
  version: 1,
  episode: { decisionHz: 10 },
  instances: [{ input, topology: syntheticTopology() }],
};

const out = process.argv[2];
if (!out) throw new Error('usage: gen_autoware_episode.ts <out.json>');
writeFileSync(out, JSON.stringify(spec, null, 2) + '\n');
console.log(`wrote ${out}`);
