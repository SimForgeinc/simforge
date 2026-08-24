/**
 * Integration against a real map artefact.
 *
 * `dev-assets/` is not committed, so this whole file is `describe.skipIf`-ed
 * when the topology index is absent — CI on a fresh clone still runs the
 * synthetic suite. When it *is* present these are the tests that catch the
 * things a hand-built fixture cannot: undirected `predecessors`/`successors`,
 * junction connecting lanes stored in an unpredictable direction, real lane
 * widths, and 1141 lanes of scale.
 */

import { existsSync, readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { buildLaneGraph, ENDPOINT_TOL_M, type LaneGraph } from '../map/lane-graph.js';
import { buildFollowRoute } from '../map/route.js';
import { runSimulation } from '../sim/engine.js';
import { parseSimScenarioInput } from '../schema/input.js';
import { toSceneXZ } from '../frames.js';
import { traceDigest } from '../trace/gzip.js';
import type { TopologyIndex } from '../map/topology.js';

const INDEX_PATH = fileURLToPath(
  new URL('../../../../dev-assets/yale-street/topology-index.json.gz', import.meta.url),
);
const HAVE_MAP = existsSync(INDEX_PATH);

function loadGraph(): LaneGraph {
  const raw = JSON.parse(gunzipSync(readFileSync(INDEX_PATH)).toString('utf8')) as TopologyIndex;
  return buildLaneGraph(raw);
}

describe.skipIf(!HAVE_MAP)('yale-street topology', () => {
  const graph = HAVE_MAP ? loadGraph() : (null as unknown as LaneGraph);

  it('builds an arc-length model for every drivable lane', () => {
    const driving = graph
      .laneRsls()
      .filter((rsl) => graph.geometry(rsl)!.lane.laneType === 'driving');
    expect(driving.length).toBeGreaterThan(400);
    for (const rsl of driving.slice(0, 50)) {
      const g = graph.geometry(rsl)!;
      expect(g.lengthM).toBeGreaterThan(0);
      expect(g.cum.length).toBe(g.points.length);
      expect(graph.widthAt(rsl, g.lengthM / 2)).toBeGreaterThan(0.1);
    }
  });

  it('derives directed successors for the great majority of driving lanes', () => {
    const driving = graph
      .laneRsls()
      .filter((rsl) => graph.geometry(rsl)!.lane.laneType === 'driving');
    let withSuccessor = 0;
    for (const rsl of driving) {
      // Non-junction lanes have a single legal direction; a junction connecting
      // lane's storage order is unreliable, so the walker resolves it from the
      // approach it was entered by — mirror that here.
      const nominal = graph.nominalReversed(rsl);
      const orientations = nominal === null ? [false, true] : [nominal];
      if (orientations.some((reversed) => graph.successors({ rsl, reversed }).length > 0)) {
        withSuccessor++;
      }
    }
    // The remainder are genuine map-boundary dead ends.
    expect(withSuccessor / driving.length).toBeGreaterThan(0.9);
  });

  it('every route it builds is geometrically continuous', () => {
    const driving = graph
      .laneRsls()
      .filter((rsl) => graph.geometry(rsl)!.lane.laneType === 'driving');
    let checked = 0;
    for (const rsl of driving) {
      const built = buildFollowRoute(graph, rsl, [], 600);
      if (!built.ok || built.route.legs.length < 3) continue;
      checked++;
      for (let i = 1; i < built.route.legs.length; i++) {
        const exit = graph.endpoints(built.route.legs[i - 1]!).exit;
        const entry = graph.endpoints(built.route.legs[i]!).entry;
        expect(Math.hypot(exit.x - entry.x, exit.y - entry.y)).toBeLessThanOrEqual(ENDPOINT_TOL_M);
      }
      if (checked >= 40) break;
    }
    expect(checked).toBeGreaterThan(10);
  });

  /** The longest single follow-route on the map, used as the test corridor. */
  function longestCorridor(): { rsl: string; lengthM: number } {
    let best = { rsl: '', lengthM: 0 };
    for (const rsl of graph.laneRsls()) {
      const g = graph.geometry(rsl)!;
      if (g.lane.laneType !== 'driving' || g.lane.isJunction) continue;
      const built = buildFollowRoute(graph, rsl, [], 1200);
      if (built.ok && built.route.lengthM > best.lengthM) {
        best = { rsl, lengthM: built.route.lengthM };
      }
    }
    return best;
  }

  it('runs a two-actor scenario on real geometry, deterministically', () => {
    const corridor = longestCorridor();
    expect(corridor.lengthM).toBeGreaterThan(300);
    const built = buildFollowRoute(graph, corridor.rsl, [], 1200);
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    const route = built.route;

    const at = (s: number) => {
      const pose = route.poseAt(s);
      const scene = toSceneXZ(pose.point);
      return {
        laneRef: { rsl: pose.rsl!, s: pose.storageS, tFrac: 0 },
        pose: { x: scene.x, z: scene.z, headingRad: pose.headingRad },
      };
    };

    const input = parseSimScenarioInput({
      mapId: 'yale-street',
      clipSeconds: 20,
      seed: 'yale',
      metricSubject: 'ego',
      actors: [
        {
          id: 'ego',
          kind: 'vehicle',
          dims: { l: 4.6, w: 1.9, h: 1.5 },
          initial: { ...at(20), speedMps: 8 },
          behavior: {
            route: { kind: 'lanePath', lanes: route.legs.map((l) => l.rsl) },
            cruiseSpeedMps: 8,
          },
        },
        {
          id: 'lead',
          kind: 'vehicle',
          dims: { l: 4.6, w: 1.9, h: 1.5 },
          initial: { ...at(60), speedMps: 6 },
          behavior: {
            route: { kind: 'lanePath', lanes: route.legs.map((l) => l.rsl) },
            cruiseSpeedMps: 6,
          },
        },
      ],
      interactions: [
        {
          id: 'follow',
          actorId: 'ego',
          trigger: { kind: 'at', t: 0 },
          verb: 'gap',
          target: { actorId: 'lead' },
          value: 1.8,
          mode: 'time',
          dynamics: { shape: 'cubic', constraint: 'time', value: 4 },
        },
      ],
    });

    const a = runSimulation(input, { graph, guards: 'collect' });
    const b = runSimulation(input, { graph, guards: 'collect' });
    expect(traceDigest(a.trace)).toBe(traceDigest(b.trace));
    expect(a.trace.ticks.t.length).toBe(1001);
    expect(a.trace.header.topologyDigest).toMatch(/^[0-9a-f]{64}$/);
    // The ego actually moved along real lane geometry.
    const egoS = a.trace.ticks.actors['ego']!.s;
    expect(egoS.at(-1)!).toBeGreaterThan(egoS[0]! + 50);
    expect(a.trace.ticks.actors['ego']!.laneRsl[0]).toBe(route.poseAt(20).rsl);
    expect(a.trace.events.filter((event) => event.kind === 'road_departure_prevented')).toEqual([]);
    expect(a.trace.events.filter((event) => event.kind.startsWith('collision'))).toEqual([]);
    let maxCrossTrackM = 0;
    const ego = a.trace.ticks.actors.ego!;
    for (let index = 0; index < ego.x.length; index += 1) {
      const point = { x: ego.x[index]!, y: ego.y[index]! };
      const projected = route.projectPoint(point);
      maxCrossTrackM = Math.max(maxCrossTrackM, Math.abs(route.lateralOffsetAt(projected.s, point)));
    }
    expect(maxCrossTrackM).toBeLessThan(1.1);
  });
});

describe.skipIf(!HAVE_MAP)('performance', () => {
  const graph = HAVE_MAP ? loadGraph() : (null as unknown as LaneGraph);

  it('simulates a 10-actor 20 s scenario well inside an interactive budget', () => {
    let corridor: { rsl: string; lanes: string[] } | null = null;
    for (const rsl of graph.laneRsls()) {
      const g = graph.geometry(rsl)!;
      if (g.lane.laneType !== 'driving' || g.lane.isJunction) continue;
      const built = buildFollowRoute(graph, rsl, [], 1200);
      if (built.ok && built.route.lengthM > 400) {
        corridor = { rsl, lanes: built.route.legs.map((l) => l.rsl) };
        break;
      }
    }
    expect(corridor).not.toBeNull();
    const built = buildFollowRoute(graph, corridor!.rsl, [], 1200);
    if (!built.ok) return;
    const route = built.route;

    const actors = [];
    for (let i = 0; i < 10; i++) {
      const s = 10 + i * 18;
      const pose = route.poseAt(s);
      const scene = toSceneXZ(pose.point);
      actors.push({
        id: `car-${String(i).padStart(2, '0')}`,
        kind: 'vehicle' as const,
        dims: { l: 4.5, w: 1.9, h: 1.5 },
        initial: {
          laneRef: { rsl: pose.rsl!, s: pose.storageS, tFrac: 0 },
          pose: { x: scene.x, z: scene.z, headingRad: pose.headingRad },
          speedMps: 7,
        },
        behavior: {
          route: { kind: 'lanePath' as const, lanes: corridor!.lanes },
          cruiseSpeedMps: 7,
        },
      });
    }

    const input = parseSimScenarioInput({
      mapId: 'yale-street',
      clipSeconds: 20,
      seed: 'perf',
      actors,
    });

    // Warm the JIT, then measure. `process.hrtime` is measurement only — it
    // never enters the simulation, which is why the determinism tripwire
    // tolerates it here (this file lives under `__tests__`).
    runSimulation(input, { graph, guards: 'collect' });
    const start = process.hrtime.bigint();
    const runs = 5;
    let ticks = 0;
    for (let i = 0; i < runs; i++) {
      ticks += runSimulation(input, { graph, guards: 'collect' }).trace.metrics.ticksSimulated;
    }
    const seconds = Number(process.hrtime.bigint() - start) / 1e9;
    const ticksPerSecond = ticks / seconds;
    const realTimeFactor = ticksPerSecond * 0.02;

    console.log(
      `[sim-engine] 10 actors × 20 s: ${(seconds / runs) * 1000} ms/run, ` +
        `${Math.round(ticksPerSecond)} ticks/s, ${Math.round(realTimeFactor)}× real time`,
    );
    // Class-native force integration is intentionally more expensive than the
    // removed kinematic sampler. It must still leave ample headroom for the
    // editor and batch pipeline on the reference CPU.
    expect(realTimeFactor).toBeGreaterThan(7);
  }, 20_000);
});
