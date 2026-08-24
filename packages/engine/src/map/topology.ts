/**
 * The subset of `dev-assets/<map>/topology-index.json.gz` the engine consumes.
 *
 * The engine reads the topology index **directly** — it does not depend on
 * `map-intel`'s derived indexes. That keeps the simulation lane independent of
 * the catalog build; anything richer (conflict pairs, segments) is passed in as
 * pre-resolved numbers on `SimScenarioInput`.
 *
 * Coordinates in the index are xodr-local metres, which is also the engine's
 * working frame — no transform on load.
 */

/** `road:section:lane`, e.g. `"27:0:-1"`. */
export type LaneRsl = string;

export type PolylinePoint = { x: number; y: number } | [number, number];

export interface TopologyAdjacentLane {
  side: 'left' | 'right';
  laneRsl: LaneRsl | null;
  sameDirection: boolean;
  permissionIds: string[];
}

export interface TopologyLaneChangePermission {
  id: string;
  side: 'left' | 'right';
  startS: number;
  endS: number;
  allowed: boolean;
  marking?: string;
  source?: string;
}

export interface TopologyLane {
  rsl: LaneRsl;
  roadId: number;
  section: number;
  laneId: number;
  laneType: string;
  isJunction: boolean;
  junctionId: string | null;
  predecessors: LaneRsl[];
  successors: LaneRsl[];
  speedLimitKph: number | null;
  representativeWidthM?: number;
  widthSamples?: Array<{ s: number; widthM: number }>;
  adjacentLanes?: { left?: TopologyAdjacentLane | null; right?: TopologyAdjacentLane | null };
  laneChangePermissions?: TopologyLaneChangePermission[];
  polyline: PolylinePoint[];
}

export type TurnRelationName = 'Straight' | 'Left' | 'Right' | 'UTurnLeft' | 'UTurnRight';

export interface TopologyGate {
  id: string;
  junctionId: string;
  turnRelation: TurnRelationName;
  headingChangeRad: number;
  connectingLaneRsl: LaneRsl;
  approachLaneRsl: LaneRsl;
  exitLaneRsls: LaneRsl[];
}

export interface TopologyJunction {
  junctionId: string;
  gateIds: string[];
  internalLaneRsls: LaneRsl[];
  approachLaneRsls: LaneRsl[];
}

export interface TopologyIndex {
  schemaVersion?: number;
  mapName?: string;
  source?: { xodrSha256?: string };
  lanes: Record<LaneRsl, TopologyLane>;
  gates: TopologyGate[];
  junctions: Record<string, TopologyJunction>;
}

/** Normalise a polyline point to `{x, y}` regardless of encoding. */
export function pointOf(p: PolylinePoint): { x: number; y: number } {
  return Array.isArray(p) ? { x: p[0], y: p[1] } : p;
}
