/**
 * Synthetic two-lane fixture for the rl-env suite, expressed through the
 * public sim-engine surface (mirrors the engine's own test fixture so the
 * numbers in the tests stay diffable against it).
 */

import {
  buildLaneGraph,
  parseSimScenarioInput,
  type LaneGraph,
  type SimScenarioInput,
  type TopologyIndex,
  type TopologyLane,
} from '@uniscenarios/sim-engine';

const STEP_M = 5;

function straight(x0: number, x1: number, y: number): Array<{ x: number; y: number }> {
  const pts: Array<{ x: number; y: number }> = [];
  const n = Math.round((x1 - x0) / STEP_M);
  for (let i = 0; i <= n; i++) pts.push({ x: x0 + i * STEP_M, y });
  return pts;
}

interface LaneOpts {
  rsl: string;
  roadId: number;
  laneId: number;
  y: number;
  x0: number;
  x1: number;
  left?: string | null;
  right?: string | null;
}

function lane(o: LaneOpts): TopologyLane {
  const permissions = [];
  if (o.left) {
    permissions.push({
      id: `${o.rsl}:left:${o.left}`,
      side: 'left' as const,
      startS: 0,
      endS: o.x1 - o.x0,
      allowed: true,
      marking: 'broken',
      source: 'fixture',
    });
  }
  if (o.right) {
    permissions.push({
      id: `${o.rsl}:right:${o.right}`,
      side: 'right' as const,
      startS: 0,
      endS: o.x1 - o.x0,
      allowed: true,
      marking: 'broken',
      source: 'fixture',
    });
  }
  return {
    rsl: o.rsl,
    roadId: o.roadId,
    section: 0,
    laneId: o.laneId,
    laneType: 'driving',
    isJunction: false,
    junctionId: null,
    predecessors: [],
    successors: [],
    speedLimitKph: 50,
    representativeWidthM: 3.5,
    widthSamples: [
      { s: 0, widthM: 3.5 },
      { s: o.x1 - o.x0, widthM: 3.5 },
    ],
    adjacentLanes: {
      left: {
        side: 'left',
        laneRsl: o.left ?? null,
        sameDirection: o.left !== undefined && o.left !== null,
        permissionIds: o.left ? [`${o.rsl}:left:${o.left}`] : [],
      },
      right: {
        side: 'right',
        laneRsl: o.right ?? null,
        sameDirection: o.right !== undefined && o.right !== null,
        permissionIds: o.right ? [`${o.rsl}:right:${o.right}`] : [],
      },
    },
    laneChangePermissions: permissions,
    polyline: straight(o.x0, o.x1, o.y),
  };
}

export const LANE_LEFT = '1:0:-1';
export const LANE_RIGHT = '1:0:-2';

export function syntheticTopology(): TopologyIndex {
  const lanes: Record<string, TopologyLane> = {};
  for (const l of [
    lane({ rsl: LANE_LEFT, roadId: 1, laneId: -1, y: 0, x0: 0, x1: 400, right: LANE_RIGHT }),
    lane({ rsl: LANE_RIGHT, roadId: 1, laneId: -2, y: -3.5, x0: 0, x1: 400, left: LANE_LEFT }),
  ]) {
    lanes[l.rsl] = l;
  }
  return {
    schemaVersion: 1,
    mapName: 'synthetic-straight',
    source: { xodrSha256: 'synthetic' },
    lanes,
    gates: [],
    junctions: {},
  };
}

export function syntheticGraph(): LaneGraph {
  return buildLaneGraph(syntheticTopology());
}

/** Scene-frame pose for a point on the straight, east-bound fixture lane. */
export function poseOnLane(graph: LaneGraph, rsl: string, s: number): { x: number; z: number; headingRad: number } {
  const sample = graph.sampleDirected({ rsl, reversed: false }, s);
  return { x: sample.point.x, z: -sample.point.y, headingRad: sample.headingRad };
}

export interface VehicleOpts {
  id: string;
  rsl?: string;
  s: number;
  speedMps: number;
  cruiseSpeedMps?: number;
  presentAtStart?: boolean;
}

export interface VehicleSpec {
  readonly id: string;
  readonly kind: 'vehicle';
  readonly dims: { l: number; w: number; h: number };
  readonly initial: {
    readonly laneRef: { rsl: string; s: number; tFrac: number };
    readonly pose: { x: number; z: number; headingRad: number };
    readonly speedMps: number;
  };
  readonly behavior: {
    readonly route: { kind: 'follow'; startRsl: string; turns: unknown[]; maxLengthM: number };
    readonly cruiseSpeedMps?: number;
  };
  readonly presentAtStart: boolean;
}

export function vehicle(graph: LaneGraph, o: VehicleOpts): VehicleSpec {
  const rsl = o.rsl ?? LANE_LEFT;
  return {
    id: o.id,
    kind: 'vehicle',
    dims: { l: 4.5, w: 1.9, h: 1.5 },
    initial: {
      laneRef: { rsl, s: o.s, tFrac: 0 },
      pose: poseOnLane(graph, rsl, o.s),
      speedMps: o.speedMps,
    },
    behavior: {
      route: { kind: 'follow', startRsl: rsl, turns: [], maxLengthM: 2000 },
      cruiseSpeedMps: o.cruiseSpeedMps,
    },
    presentAtStart: o.presentAtStart ?? true,
  };
}

interface ScenarioSpec {
  readonly mapId: string;
  readonly clipSeconds: number;
  readonly warmupSeconds: number;
  readonly dt: number;
  readonly seed: string | number;
  readonly physics: { mode: 'kinematic-v1' | 'dynamic-v1' };
  readonly actors: readonly VehicleSpec[];
  readonly interactions?: readonly Record<string, unknown>[];
  readonly metricSubject?: string | null;
}

export function scenario(
  graph: LaneGraph,
  partial: Partial<ScenarioSpec> & Pick<ScenarioSpec, 'actors'>,
): SimScenarioInput {
  void graph;
  return parseSimScenarioInput({
    mapId: 'synthetic-straight',
    clipSeconds: 20,
    warmupSeconds: 5,
    dt: 0.02,
    seed: 'fixture',
    physics: { mode: 'kinematic-v1' },
    ...partial,
  } as unknown as SimScenarioInput);
}
