import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { fileURLToPath } from 'node:url';

import { runSimulation } from '../sim/engine.js';
import { buildLaneGraph, type LaneGraph } from '../map/lane-graph.js';
import { buildFollowRoute } from '../map/route.js';
import { parseSimScenarioInput } from '../schema/input.js';
import { toSceneXZ } from '../frames.js';
import type { TopologyIndex } from '../map/topology.js';
import { LANE_LEFT, scenario, syntheticGraph, vehicle } from './fixtures/scenarios.js';
import { syntheticTopology } from './fixtures/synthetic-map.js';

const YALE_INDEX = fileURLToPath(new URL('../../../../dev-assets/yale-street/topology-index.json.gz', import.meta.url));
const HAVE_YALE = existsSync(YALE_INDEX);

describe('motorcycle route tracking stability', () => {
  it('holds a straight lane without visible lateral or yaw oscillation', () => {
    const graph = syntheticGraph();
    const base = vehicle(graph, {
      id: 'motorcycle',
      rsl: LANE_LEFT,
      s: 20,
      speedMps: 8,
      cruiseSpeedMps: 12,
    });
    const actor = {
      ...base,
      kind: 'motorcycle' as const,
      dims: { l: 2.1, w: 0.75, h: 1.23 },
    };
    const input = scenario(graph, {
      actors: [actor],
      clipSeconds: 12,
      warmupSeconds: 0,
      dt: 0.02,
      physics: { mode: 'dynamic-v1' },
    });
    const { trace } = runSimulation(input, { graph, guards: 'collect' });
    const track = trace.ticks.actors.motorcycle!;
    const lateral = track.lateralOffsetM;
    const heading = track.headingRad;
    const lateralPeakToPeak = Math.max(...lateral) - Math.min(...lateral);
    const headingPeakToPeak = Math.max(...heading) - Math.min(...heading);
    expect(lateralPeakToPeak).toBeLessThan(0.01);
    expect(headingPeakToPeak).toBeLessThan(0.5 * Math.PI / 180);
  });

  it('does not amplify centimetre-scale lane polyline faceting into body hunting', () => {
    const topology = structuredClone(syntheticTopology());
    for (const rsl of ['1:0:-1', '2:0:-1']) {
      const lane = topology.lanes[rsl]!;
      lane.polyline = lane.polyline!.map((point, index) => ({
        ...point,
        y: index === 0 || index === lane.polyline!.length - 1 ? 0 : (index % 2 ? 0.015 : -0.015),
      }));
    }
    const graph = buildLaneGraph(topology);
    const built = buildFollowRoute(graph, LANE_LEFT, [], 2_000);
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    const route = built.route;
    for (const dt of [0.01, 0.02, 0.05]) for (const kind of ['motorcycle', 'car'] as const) {
      const base = vehicle(graph, { id: kind, rsl: LANE_LEFT, s: 20, speedMps: 8, cruiseSpeedMps: 10 });
      const actor = {
        ...base,
        kind,
        dims: kind === 'motorcycle' ? { l: 2.1, w: .75, h: 1.23 } : { l: 4.6, w: 1.9, h: 1.5 },
      };
      const track = runSimulation(scenario(graph, {
        actors: [actor], clipSeconds: 10, warmupSeconds: 0, dt, physics: { mode: 'dynamic-v1' },
      }), { graph, guards: 'collect' }).trace.ticks.actors[kind]!;
      expect(Math.max(...track.lateralOffsetM.map(Math.abs))).toBeLessThan(0.08);
      let maxHeadingError = 0;
      for (let i = 0; i < track.s.length; i++) {
        const delta = track.headingRad[i]! - route.poseAt(track.s[i]!).headingRad;
        maxHeadingError = Math.max(maxHeadingError, Math.abs(Math.atan2(Math.sin(delta), Math.cos(delta))));
      }
      expect(maxHeadingError).toBeLessThan(3 * Math.PI / 180);
    }
  });
});

describe.skipIf(!HAVE_YALE)('motorcycle stability on real map geometry', () => {
  it('holds a visually straight Yale corridor', () => {
    const raw = JSON.parse(gunzipSync(readFileSync(YALE_INDEX)).toString('utf8')) as TopologyIndex;
    const graph: LaneGraph = buildLaneGraph(raw);
    let route: import('../map/route.js').Route | null = null;
    for (const rsl of graph.laneRsls()) {
      const built = buildFollowRoute(graph, rsl, [], 500);
      if (!built.ok || built.route.lengthM < 160) continue;
      const origin = built.route.poseAt(20).headingRad;
      let maxDelta = 0;
      for (let s = 20; s <= 140; s += 2) {
        const d = built.route.poseAt(s).headingRad - origin;
        maxDelta = Math.max(maxDelta, Math.abs(Math.atan2(Math.sin(d), Math.cos(d))));
      }
      if (maxDelta < 1 * Math.PI / 180) { route = built.route; break; }
    }
    expect(route).not.toBeNull();
    if (!route) return;
    const metrics = [];
    for (const kind of ['motorcycle', 'car'] as const) {
      const pose = route.poseAt(20);
      const scene = toSceneXZ(pose.point);
      const input = parseSimScenarioInput({ mapId: 'yale-street', clipSeconds: 10, warmupSeconds: 0, actors: [{
        id: kind, kind, dims: kind === 'motorcycle' ? { l: 2.1, w: .75, h: 1.23 } : { l: 4.6, w: 1.9, h: 1.5 },
        initial: { laneRef: { rsl: pose.rsl!, s: pose.storageS, tFrac: 0 }, pose: { x: scene.x, z: scene.z, headingRad: pose.headingRad }, speedMps: 8 },
        behavior: { route: { kind: 'lanePath', lanes: route.legs.map((leg) => leg.rsl) }, cruiseSpeedMps: 10 },
      }] });
      const track = runSimulation(input, { graph, guards: 'collect' }).trace.ticks.actors[kind]!;
      let signChanges = 0, priorSign = 0, maxHeadingError = 0;
      for (let i = 0; i < track.s.length; i++) {
        const sign = Math.abs(track.lateralOffsetM[i]!) < .002 ? 0 : Math.sign(track.lateralOffsetM[i]!);
        if (sign && priorSign && sign !== priorSign) signChanges++;
        if (sign) priorSign = sign;
        const rawDelta = track.headingRad[i]! - route.poseAt(track.s[i]!).headingRad;
        maxHeadingError = Math.max(maxHeadingError, Math.abs(Math.atan2(Math.sin(rawDelta), Math.cos(rawDelta))));
      }
      metrics.push({ kind, maxOffset: Math.max(...track.lateralOffsetM.map(Math.abs)), signChanges, maxHeadingErrorDeg: maxHeadingError * 180 / Math.PI });
    }
    expect(metrics[0]!.maxOffset).toBeLessThan(.1);
    expect(metrics[0]!.maxHeadingErrorDeg).toBeLessThan(3);
  });
});
