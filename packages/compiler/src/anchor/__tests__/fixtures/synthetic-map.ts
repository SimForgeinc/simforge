/**
 * A hand-built four-way junction, in the **raw topology-index shape**.
 *
 * Committed as code rather than as a JSON blob because it is ~200 lines of
 * geometry that has to stay readable: every lane below is placed on purpose so
 * the matcher tests can assert on structure that a reader can verify by eye.
 *
 * ```
 *                     N (road 3)
 *              exit x=+1.75 ↑   ↓ approach x=-1.75
 *                        ┌───────┐
 *   W (road 1)  →→→→ -1  │       │  -1 →→→→   E (road 2)
 *   approach  y=-1.75    │  jx   │
 *             y=-5.25 -2 │  100  │  westbound approach y=+1.75
 *             y=-8.75 -3 │       │
 *                        └───────┘
 *                     S (road 4)
 * ```
 *
 * Lane ids follow the OpenDRIVE convention the real data uses: negative ids run
 * with `s`, positive ids run against it (so their polylines are stored
 * backwards, exactly like Yale's).
 */

import type { RawSearchIndex, RawTopologyIndex, RawTopologyLane } from '../../derive.js';
import type { Point2 } from '../../types/map-index.js';

const SPEED_KPH = 56;
const LANE_WIDTH_M = 3.5;

function line(from: Point2, to: Point2, step = 1): Point2[] {
  const length = Math.hypot(to.x - from.x, to.y - from.y);
  const n = Math.max(2, Math.round(length / step));
  const out: Point2[] = [];
  for (let i = 0; i <= n; i += 1) {
    const t = i / n;
    out.push({ x: from.x + (to.x - from.x) * t, y: from.y + (to.y - from.y) * t });
  }
  return out;
}

function bezier(from: Point2, control: Point2, to: Point2, n = 24): Point2[] {
  const out: Point2[] = [];
  for (let i = 0; i <= n; i += 1) {
    const t = i / n;
    const u = 1 - t;
    out.push({
      x: u * u * from.x + 2 * u * t * control.x + t * t * to.x,
      y: u * u * from.y + 2 * u * t * control.y + t * t * to.y,
    });
  }
  return out;
}

interface LaneSpec {
  rsl: string;
  laneType?: string;
  junctionId?: string | null;
  polyline: Point2[];
  adjacentLeft?: string | null;
  adjacentRight?: string | null;
  laneChange?: boolean;
}

function lane(spec: LaneSpec): RawTopologyLane {
  const [roadId, section, laneId] = spec.rsl.split(':').map(Number) as [number, number, number];
  const length = spec.polyline.reduce(
    (acc, p, i) => (i === 0 ? 0 : acc + Math.hypot(p.x - spec.polyline[i - 1]!.x, p.y - spec.polyline[i - 1]!.y)),
    0,
  );
  return {
    rsl: spec.rsl,
    roadId,
    section,
    laneId,
    laneType: spec.laneType ?? 'driving',
    isJunction: spec.junctionId != null,
    junctionId: spec.junctionId ?? null,
    predecessors: [],
    successors: [],
    speedLimitKph: SPEED_KPH,
    representativeWidthM: LANE_WIDTH_M,
    widthSamples: [
      { s: 0, widthM: LANE_WIDTH_M },
      { s: length / 2, widthM: LANE_WIDTH_M },
      { s: length, widthM: LANE_WIDTH_M },
    ],
    adjacentLanes: {
      left: { laneRsl: spec.adjacentLeft ?? null, sameDirection: !!spec.adjacentLeft },
      right: { laneRsl: spec.adjacentRight ?? null, sameDirection: !!spec.adjacentRight },
    },
    laneChangePermissions: spec.laneChange
      ? [
          { side: 'left', startS: 0, endS: length, allowed: true },
          { side: 'right', startS: 0, endS: length, allowed: true },
        ]
      : [],
    polyline: spec.polyline,
  };
}

interface GateSpec {
  id: string;
  turn: 'Left' | 'Right' | 'Straight';
  approach: string;
  connecting: string;
  exit: string;
}

const JUNCTION_ID = '100';

/** The three-lane arterial approach the worked example is written against. */
export const EGO_APPROACH_LANE = '1:0:-1';
export const OPPOSING_APPROACH_LANE = '2:0:1';
export const SYNTHETIC_JUNCTION_ID = JUNCTION_ID;

const laneSpecs: LaneSpec[] = [
  // --- West leg (road 1): eastbound approach, westbound exit ---------------
  { rsl: '1:0:-1', polyline: line({ x: -150, y: -1.75 }, { x: -10, y: -1.75 }), adjacentRight: '1:0:-2', laneChange: true },
  { rsl: '1:0:-2', polyline: line({ x: -150, y: -5.25 }, { x: -10, y: -5.25 }), adjacentLeft: '1:0:-1', adjacentRight: '1:0:-3', laneChange: true },
  { rsl: '1:0:-3', polyline: line({ x: -150, y: -8.75 }, { x: -10, y: -8.75 }), adjacentLeft: '1:0:-2', laneChange: true },
  { rsl: '1:0:1', polyline: line({ x: -150, y: 1.75 }, { x: -10, y: 1.75 }) },
  { rsl: '1:0:2', polyline: line({ x: -150, y: 5.25 }, { x: -10, y: 5.25 }) },
  { rsl: '1:0:3', polyline: line({ x: -150, y: 8.75 }, { x: -10, y: 8.75 }) },
  { rsl: '1:0:-4', laneType: 'sidewalk', polyline: line({ x: -150, y: -12.5 }, { x: -10, y: -12.5 }) },

  // --- East leg (road 2): eastbound exit, westbound approach ---------------
  { rsl: '2:0:-1', polyline: line({ x: 10, y: -1.75 }, { x: 150, y: -1.75 }) },
  { rsl: '2:0:-2', polyline: line({ x: 10, y: -5.25 }, { x: 150, y: -5.25 }) },
  { rsl: '2:0:-3', polyline: line({ x: 10, y: -8.75 }, { x: 150, y: -8.75 }) },
  { rsl: '2:0:1', polyline: line({ x: 10, y: 1.75 }, { x: 150, y: 1.75 }), adjacentLeft: '2:0:2' },
  { rsl: '2:0:2', polyline: line({ x: 10, y: 5.25 }, { x: 150, y: 5.25 }), adjacentLeft: '2:0:3', adjacentRight: '2:0:1' },
  // Deliberately *not* a third through lane: the east approach is two lanes
  // wide, so a "3-lane arterial" clause discriminates between the two
  // otherwise-symmetric left turns at this junction.
  { rsl: '2:0:3', laneType: 'parking', polyline: line({ x: 10, y: 8.75 }, { x: 150, y: 8.75 }), adjacentRight: '2:0:2' },

  // --- North leg (road 3): northbound exit, southbound approach ------------
  { rsl: '3:0:-1', polyline: line({ x: 1.75, y: 10 }, { x: 1.75, y: 150 }) },
  { rsl: '3:0:1', polyline: line({ x: -1.75, y: 10 }, { x: -1.75, y: 150 }) },

  // --- South leg (road 4): northbound approach, southbound exit ------------
  { rsl: '4:0:-1', polyline: line({ x: 1.75, y: -150 }, { x: 1.75, y: -10 }) },
  { rsl: '4:0:1', polyline: line({ x: -1.75, y: -150 }, { x: -1.75, y: -10 }) },

  // --- Junction-internal connecting lanes ----------------------------------
  { rsl: '10:0:-1', junctionId: JUNCTION_ID, polyline: bezier({ x: -10, y: -1.75 }, { x: 1.75, y: -1.75 }, { x: 1.75, y: 10 }) },
  { rsl: '11:0:-1', junctionId: JUNCTION_ID, polyline: line({ x: -10, y: -1.75 }, { x: 10, y: -1.75 }) },
  { rsl: '12:0:-1', junctionId: JUNCTION_ID, polyline: line({ x: -10, y: -5.25 }, { x: 10, y: -5.25 }) },
  { rsl: '13:0:-1', junctionId: JUNCTION_ID, polyline: bezier({ x: -10, y: -8.75 }, { x: -1.75, y: -8.75 }, { x: -1.75, y: -10 }) },
  { rsl: '14:0:-1', junctionId: JUNCTION_ID, polyline: line({ x: 10, y: 1.75 }, { x: -10, y: 1.75 }) },
  { rsl: '15:0:-1', junctionId: JUNCTION_ID, polyline: bezier({ x: 10, y: 1.75 }, { x: -1.75, y: 1.75 }, { x: -1.75, y: -10 }) },
  { rsl: '16:0:-1', junctionId: JUNCTION_ID, polyline: line({ x: -1.75, y: 10 }, { x: -1.75, y: -10 }) },
  { rsl: '17:0:-1', junctionId: JUNCTION_ID, polyline: bezier({ x: -1.75, y: 10 }, { x: -1.75, y: -1.75 }, { x: 10, y: -1.75 }) },
  { rsl: '18:0:-1', junctionId: JUNCTION_ID, polyline: line({ x: 1.75, y: -10 }, { x: 1.75, y: 10 }) },
  { rsl: '19:0:-1', junctionId: JUNCTION_ID, polyline: bezier({ x: 1.75, y: -10 }, { x: 1.75, y: 1.75 }, { x: -10, y: 1.75 }) },
];

const gateSpecs: GateSpec[] = [
  { id: 'g_ego_left', turn: 'Left', approach: '1:0:-1', connecting: '10:0:-1', exit: '3:0:-1' },
  { id: 'g_ego_straight_1', turn: 'Straight', approach: '1:0:-1', connecting: '11:0:-1', exit: '2:0:-1' },
  { id: 'g_ego_straight_2', turn: 'Straight', approach: '1:0:-2', connecting: '12:0:-1', exit: '2:0:-2' },
  { id: 'g_ego_right', turn: 'Right', approach: '1:0:-3', connecting: '13:0:-1', exit: '4:0:1' },
  { id: 'g_opp_straight', turn: 'Straight', approach: '2:0:1', connecting: '14:0:-1', exit: '1:0:1' },
  { id: 'g_opp_left', turn: 'Left', approach: '2:0:1', connecting: '15:0:-1', exit: '4:0:1' },
  { id: 'g_north_straight', turn: 'Straight', approach: '3:0:1', connecting: '16:0:-1', exit: '4:0:1' },
  { id: 'g_north_left', turn: 'Left', approach: '3:0:1', connecting: '17:0:-1', exit: '2:0:-1' },
  { id: 'g_south_straight', turn: 'Straight', approach: '4:0:-1', connecting: '18:0:-1', exit: '3:0:-1' },
  { id: 'g_south_left', turn: 'Left', approach: '4:0:-1', connecting: '19:0:-1', exit: '1:0:1' },
];

const HEADING_CHANGE: Record<GateSpec['turn'], number> = {
  Left: Math.PI / 2,
  Right: -Math.PI / 2,
  Straight: 0,
};

/** The raw topology index for the synthetic map. */
export function syntheticTopology(): RawTopologyIndex {
  const lanes: Record<string, RawTopologyLane> = {};
  for (const spec of laneSpecs) lanes[spec.rsl] = lane(spec);
  const gates = gateSpecs.map((g) => ({
    id: g.id,
    junctionId: JUNCTION_ID,
    turnRelation: g.turn,
    headingChangeRad: HEADING_CHANGE[g.turn],
    connectingLaneRsl: g.connecting,
    approachLaneRsl: g.approach,
    exitLaneRsls: [g.exit],
  }));
  return {
    schemaVersion: 3,
    mapName: 'synthetic-4way',
    source: { xodrSha256: 'synthetic-4way-v1' },
    lanes,
    gates,
    junctions: {
      [JUNCTION_ID]: {
        junctionId: JUNCTION_ID,
        gateIds: gates.map((g) => g.id),
        internalLaneRsls: gates.map((g) => g.connectingLaneRsl),
        approachLaneRsls: [...new Set(gates.map((g) => g.approachLaneRsl))],
      },
    },
  };
}

/** Search-index-shaped junction facts, so control can be varied per test. */
export function syntheticSearchIndex(
  control: 'traffic_light' | 'stop' | 'uncontrolled' = 'traffic_light',
  allWayStop = false,
): RawSearchIndex {
  return {
    objects: {
      [`junction:${JUNCTION_ID}`]: {
        kind: 'junction',
        id: `junction:${JUNCTION_ID}`,
        name: 'Synthetic four-way',
        facts: {
          approach_count: 4,
          control_type: control,
          has_signal: control === 'traffic_light',
          is_all_way_stop: allWayStop,
        },
      },
    },
  };
}
