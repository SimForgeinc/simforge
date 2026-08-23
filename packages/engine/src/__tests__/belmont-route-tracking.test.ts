import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { gunzipSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';

import { toSceneXZ } from '../frames.js';
import { buildLaneGraph, type LaneGraph } from '../map/lane-graph.js';
import { buildLanePathRoute } from '../map/route.js';
import type { TopologyIndex } from '../map/topology.js';
import { parseSimScenarioInput } from '../schema/input.js';
import { runSimulation } from '../sim/engine.js';

const INDEX_PATH = fileURLToPath(
  new URL('../../../../dev-assets/belmont-research-center/topology-index.json.gz', import.meta.url),
);
const HAVE_MAP = existsSync(INDEX_PATH);

function loadGraph(): LaneGraph {
  const raw = JSON.parse(gunzipSync(readFileSync(INDEX_PATH)).toString('utf8')) as TopologyIndex;
  return buildLaneGraph(raw);
}

describe.skipIf(!HAVE_MAP)('Belmont authored-route tracking', () => {
  it('keeps a dynamically simulated sedan on the placed route through compact junction turns', () => {
    const graph = loadGraph();
    // Regression for the middle-lane placement that previously cut across the
    // inside of junction 68/1074, hit the route guard, and appeared to drive
    // toward the adjacent building instead of following the dotted preview.
    const lanes = [
      '914:0:-1',
      '67:0:-1',
      '805:0:-1',
      '68:0:-3',
      '1074:0:-1',
      '118:0:2',
      '1230:0:1',
      '105:0:2',
      '3149:0:1',
      '127:0:2',
      '368:0:1',
    ];
    const built = buildLanePathRoute(graph, lanes);
    expect(built.ok).toBe(true);
    if (!built.ok) return;

    const start = built.route.poseAt(3.5);
    const scene = toSceneXZ(start.point);
    const input = parseSimScenarioInput({
      mapId: 'belmont-research-center',
      clipSeconds: 20,
      warmupSeconds: 0,
      dt: 0.02,
      seed: 'belmont-middle-lane-regression',
      physics: { mode: 'dynamic-v1' },
      actors: [{
        id: 'sedan',
        kind: 'vehicle',
        dims: { l: 4.6, w: 1.9, h: 1.5 },
        initial: {
          laneRef: { rsl: start.rsl!, s: start.storageS, tFrac: 0 },
          pose: { x: scene.x, z: scene.z, headingRad: start.headingRad },
          speedMps: 0,
        },
        behavior: {
          route: { kind: 'lanePath', lanes },
          cruiseSpeedMps: 13.4112,
        },
      }],
    });

    const { trace } = runSimulation(input, { graph, guards: 'collect' });
    const track = trace.ticks.actors.sedan!;
    let maxCrossTrackM = 0;
    for (let i = 0; i < track.x.length; i += 1) {
      const point = { x: track.x[i]!, y: track.y[i]! };
      const projected = built.route.projectPoint(point);
      maxCrossTrackM = Math.max(
        maxCrossTrackM,
        Math.abs(built.route.lateralOffsetAt(projected.s, point)),
      );
    }

    expect(trace.header.physics.actorBackends?.sedan).toEqual({
      mode: 'dynamic-v1',
      reason: 'selected',
      profile: 'vehicle',
    });
    expect(trace.events.filter((event) => event.kind === 'road_departure_prevented')).toEqual([]);
    expect(trace.events.filter((event) => event.kind.startsWith('collision'))).toEqual([]);
    expect(maxCrossTrackM).toBeLessThan(1.1);
    expect(track.s.at(-1)!).toBeGreaterThan(150);
    expect(track.speedMps.at(-1)!).toBeGreaterThan(1);
  });
});
