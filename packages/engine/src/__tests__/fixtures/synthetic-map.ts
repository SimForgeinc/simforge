/**
 * A tiny synthetic topology index, built in code rather than committed as data.
 *
 * Layout (xodr-local metres, `x` east / `y` north):
 *
 * ```
 *   y=0.0    ├── 1:0:-1 ──────┼── 2:0:-1 ──────┤   left lane,  0 → 800 m
 *   y=-3.5   ├── 1:0:-2 ──────┼── 2:0:-2 ──────┤   right lane, 0 → 800 m
 *
 *   y=50     ├── 9:0:-1 ─┤                         60 m dead end
 * ```
 *
 * Both carriageway lanes travel `+x` (heading 0) and are mutually
 * lane-changeable. `9:0:-1` exists so the runway guard has something to catch.
 *
 * Keeping this in TypeScript means the fixture is diffable, has no binary blob
 * in the repo, and the geometry that a test asserts on is visible next to the
 * assertion.
 */

import type { TopologyIndex, TopologyLane } from '../../map/topology.js';

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
  predecessors?: string[];
  successors?: string[];
  left?: string | null;
  right?: string | null;
  speedLimitKph?: number;
  laneType?: string;
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
    laneType: o.laneType ?? 'driving',
    isJunction: false,
    junctionId: null,
    predecessors: o.predecessors ?? [],
    successors: o.successors ?? [],
    speedLimitKph: o.speedLimitKph ?? 50,
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

/** The left (inner) through lane, `y = 0`. */
export const LANE_LEFT = '1:0:-1';
/** The right (outer) through lane, `y = -3.5`. */
export const LANE_RIGHT = '1:0:-2';
export const LANE_LEFT_2 = '2:0:-1';
export const LANE_RIGHT_2 = '2:0:-2';
/** A 60 m stub with no successors. */
export const LANE_DEAD_END = '9:0:-1';

export function syntheticTopology(): TopologyIndex {
  const lanes: Record<string, TopologyLane> = {};
  for (const l of [
    lane({
      rsl: LANE_LEFT,
      roadId: 1,
      laneId: -1,
      y: 0,
      x0: 0,
      x1: 400,
      successors: [LANE_LEFT_2],
      right: LANE_RIGHT,
    }),
    lane({
      rsl: LANE_RIGHT,
      roadId: 1,
      laneId: -2,
      y: -3.5,
      x0: 0,
      x1: 400,
      successors: [LANE_RIGHT_2],
      left: LANE_LEFT,
    }),
    lane({
      rsl: LANE_LEFT_2,
      roadId: 2,
      laneId: -1,
      y: 0,
      x0: 400,
      x1: 800,
      predecessors: [LANE_LEFT],
      right: LANE_RIGHT_2,
    }),
    lane({
      rsl: LANE_RIGHT_2,
      roadId: 2,
      laneId: -2,
      y: -3.5,
      x0: 400,
      x1: 800,
      predecessors: [LANE_RIGHT],
      left: LANE_LEFT_2,
    }),
    lane({ rsl: LANE_DEAD_END, roadId: 9, laneId: -1, y: 50, x0: 0, x1: 60 }),
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
