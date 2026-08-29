/**
 * Collision-planner projection of the runtime-bound map topology index.
 *
 * Each node is one `(road_id, section_id, lane_id)` lane section. Forward
 * edges come directly from the index's XODR successors/predecessors, while
 * adjacent edges project its same-direction lane-change links. Geometry is
 * the index polyline ordered by CARLA's travel direction resolved at bind
 * time. The planner-facing `LaneNode` / `LaneEdge` API stays deliberately
 * small: downstream planners treat increasing polyline index as forward
 * travel without reconstructing topology or guessing direction.
 */
import "server-only";
import {
  laneTravelIncreasesSByConvention,
  travelOrderedPolyline,
  type RuntimeBoundMapTopologyIndex,
} from "@simforge-oss/maps/topology";

const EXACT_JOIN_YAW_TOLERANCE_RAD = (60 * Math.PI) / 180;

export interface LanePolylineVertex {
  x: number;
  y: number;
  yaw: number;
  s: number;
}

export interface LaneNode {
  id: string;
  road_id: number;
  section_id: number;
  lane_id: number;
  lane_type: string;
  is_junction: boolean;
  left_lane_id: number | null;
  right_lane_id: number | null;
  /** Polyline in forward-travel order; index 0 is the spawn-side end. */
  forwardPolyline: readonly LanePolylineVertex[];
  /** Cumulative arc length per vertex, parallel to `forwardPolyline`.
   *  `cumulativeArc[i]` is the arc length from index 0 to index i.
   *  `cumulativeArc[length-1]` equals `length_m`. */
  cumulativeArc: readonly number[];
  /** Total arc length end-to-end. */
  length_m: number;
}

export interface LaneEdge {
  to: string;
  kind: "forward" | "adjacent";
  /** Edge weight in meters (forward edges) or 0 (adjacent lane-change). */
  weightM: number;
}

export interface LaneGraph {
  readonly nodes: ReadonlyMap<string, LaneNode>;
  /** Outgoing edges (forward continuations + adjacent lane-changes). */
  outgoing(id: string): readonly LaneEdge[];
  /** Incoming edges (reverse continuations + adjacent lane-changes). */
  incoming(id: string): readonly LaneEdge[];
}

export interface LaneSegmentInput {
  road_id: number;
  section_id: number;
  lane_id: number;
  lane_type?: string | null;
  is_junction: boolean;
  left_lane_id?: number | null;
  right_lane_id?: number | null;
  centerline: ReadonlyArray<{ x: number; y: number; z?: number; yaw: number; s: number }>;
}

export function laneNodeId(road_id: number, section_id: number, lane_id: number): string {
  return `${road_id}:${section_id}:${lane_id}`;
}

// ── Polyline helpers ────────────────────────────────────────────────────────

/** Smallest absolute angle (radians) between two headings, in [0, π]. */
export function angleDifference(a: number, b: number): number {
  let d = (a - b) % (Math.PI * 2);
  if (d > Math.PI) d -= Math.PI * 2;
  if (d < -Math.PI) d += Math.PI * 2;
  return Math.abs(d);
}

function buildCumulativeArc(polyline: readonly { x: number; y: number }[]): number[] {
  const arc: number[] = [0];
  for (let i = 1; i < polyline.length; i++) {
    const dx = polyline[i]!.x - polyline[i - 1]!.x;
    const dy = polyline[i]!.y - polyline[i - 1]!.y;
    arc.push(arc[arc.length - 1]! + Math.hypot(dx, dy));
  }
  return arc;
}

/** Interpolate the world point at a given s-fraction along a node's polyline. */
export function pointOnLane(
  node: LaneNode,
  sFraction: number,
): { x: number; y: number; yaw: number } {
  const poly = node.forwardPolyline;
  if (poly.length === 1) return { x: poly[0]!.x, y: poly[0]!.y, yaw: poly[0]!.yaw };
  const targetArc = Math.max(0, Math.min(1, sFraction)) * node.length_m;
  // Binary-search the cumulative arc array.
  const arc = node.cumulativeArc;
  let lo = 0;
  let hi = arc.length - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >>> 1;
    if (arc[mid]! <= targetArc) lo = mid;
    else hi = mid;
  }
  const segLen = arc[hi]! - arc[lo]!;
  const t = segLen === 0 ? 0 : (targetArc - arc[lo]!) / segLen;
  const a = poly[lo]!;
  const b = poly[hi]!;
  return {
    x: a.x + (b.x - a.x) * t,
    y: a.y + (b.y - a.y) * t,
    yaw: a.yaw + (b.yaw - a.yaw) * t,
  };
}

/**
 * Sample a polyline between two arc-length positions on the same node,
 * spaced ~ every `samplingM` meters (always includes both endpoints).
 * Used to build per-actor waypoint polylines from a plan.
 */
export function sampleLaneSegment(
  node: LaneNode,
  fromSFraction: number,
  toSFraction: number,
  samplingM = 5,
): Array<{ x: number; y: number }> {
  const from = Math.max(0, Math.min(1, fromSFraction));
  const to = Math.max(0, Math.min(1, toSFraction));
  const forward = to >= from;
  const startArc = from * node.length_m;
  const endArc = to * node.length_m;
  const span = Math.abs(endArc - startArc);
  if (span === 0) {
    const p = pointOnLane(node, from);
    return [{ x: p.x, y: p.y }];
  }
  const steps = Math.max(1, Math.ceil(span / samplingM));
  const out: Array<{ x: number; y: number }> = [];
  for (let i = 0; i <= steps; i++) {
    const arc = startArc + ((endArc - startArc) * i) / steps;
    const sFraction = arc / node.length_m;
    const p = pointOnLane(node, sFraction);
    out.push({ x: p.x, y: p.y });
  }
  void forward;
  return out;
}

// ── Graph construction ──────────────────────────────────────────────────────

type DirectedLink = readonly [from: string, to: string];

function assembleLaneGraph(
  nodes: Map<string, LaneNode>,
  forwardLinks: readonly DirectedLink[],
  adjacentLinks: readonly DirectedLink[],
): LaneGraph {
  const outgoing = new Map<string, LaneEdge[]>();
  const incoming = new Map<string, LaneEdge[]>();
  const pushEdge = (
    map: Map<string, LaneEdge[]>,
    from: string,
    edge: LaneEdge,
  ): void => {
    const list = map.get(from);
    if (list) {
      if (!list.some((existing) => existing.to === edge.to && existing.kind === edge.kind)) {
        list.push(edge);
      }
    } else {
      map.set(from, [edge]);
    }
  };

  for (const [from, to] of forwardLinks) {
    const fromNode = nodes.get(from);
    const toNode = nodes.get(to);
    if (!fromNode || !toNode || from === to) continue;
    const weightM = (fromNode.length_m + toNode.length_m) / 2;
    pushEdge(outgoing, from, { to, kind: "forward", weightM });
    pushEdge(incoming, to, { to: from, kind: "forward", weightM });
  }

  for (const [from, to] of adjacentLinks) {
    if (!nodes.has(from) || !nodes.has(to) || from === to) continue;
    pushEdge(outgoing, from, { to, kind: "adjacent", weightM: 0 });
    pushEdge(incoming, to, { to: from, kind: "adjacent", weightM: 0 });
  }

  return {
    nodes,
    outgoing(id) {
      return outgoing.get(id) ?? [];
    },
    incoming(id) {
      return incoming.get(id) ?? [];
    },
  };
}

/**
 * Build a graph from explicit, travel-ordered lane segments.
 *
 * Production uses {@link buildLaneGraphFromTopology}. This constructor is
 * retained for synthetic planner fixtures, whose authored centerlines already
 * run in travel order. Exact shared endpoints provide their explicit joins;
 * there is no distance-based connectivity tolerance.
 */
export function buildLaneGraph(segments: readonly LaneSegmentInput[]): LaneGraph {
  const nodes = new Map<string, LaneNode>();

  for (const seg of segments) {
    if (seg.centerline.length < 2) continue;
    const id = laneNodeId(seg.road_id, seg.section_id, seg.lane_id);
    if (nodes.has(id)) continue;

    const forwardPolyline: LanePolylineVertex[] = seg.centerline.map((p) => ({
      x: p.x,
      y: p.y,
      yaw: p.yaw,
      s: p.s,
    }));
    const cumulativeArc = buildCumulativeArc(forwardPolyline);
    const length_m = cumulativeArc[cumulativeArc.length - 1]!;
    if (length_m === 0) continue;

    nodes.set(id, {
      id,
      road_id: seg.road_id,
      section_id: seg.section_id,
      lane_id: seg.lane_id,
      lane_type: (seg.lane_type ?? "").toLowerCase() || "unknown",
      is_junction: seg.is_junction,
      left_lane_id: seg.left_lane_id ?? null,
      right_lane_id: seg.right_lane_id ?? null,
      forwardPolyline,
      cumulativeArc,
      length_m,
    });
  }

  const adjacentLinks: DirectedLink[] = [];
  for (const node of nodes.values()) {
    const sign = Math.sign(node.lane_id);
    for (const neighborLane of [node.left_lane_id, node.right_lane_id]) {
      if (neighborLane == null || neighborLane === node.lane_id) continue;
      if (Math.sign(neighborLane) !== sign) continue;
      const neighborId = laneNodeId(node.road_id, node.section_id, neighborLane);
      if (!nodes.has(neighborId)) continue;
      adjacentLinks.push([node.id, neighborId]);
    }
  }

  const forwardLinks: DirectedLink[] = [];
  const starts = new Map<string, LaneNode[]>();
  const endpointKey = (x: number, y: number): string => `${x},${y}`;
  for (const node of nodes.values()) {
    const first = node.forwardPolyline[0]!;
    const key = endpointKey(first.x, first.y);
    const list = starts.get(key);
    if (list) list.push(node);
    else starts.set(key, [node]);
  }
  for (const node of nodes.values()) {
    const last = node.forwardPolyline[node.forwardPolyline.length - 1]!;
    for (const candidate of starts.get(endpointKey(last.x, last.y)) ?? []) {
      if (candidate.id === node.id) continue;
      const first = candidate.forwardPolyline[0]!;
      if (angleDifference(last.yaw, first.yaw) > EXACT_JOIN_YAW_TOLERANCE_RAD) continue;
      forwardLinks.push([node.id, candidate.id]);
    }
  }

  return assembleLaneGraph(nodes, forwardLinks, adjacentLinks);
}

function polylineYaw(
  points: readonly { x: number; y: number }[],
  index: number,
): number {
  const current = points[index]!;
  for (let nextIndex = index + 1; nextIndex < points.length; nextIndex += 1) {
    const next = points[nextIndex]!;
    if (next.x !== current.x || next.y !== current.y) {
      return Math.atan2(next.y - current.y, next.x - current.x);
    }
  }
  for (let priorIndex = index - 1; priorIndex >= 0; priorIndex -= 1) {
    const prior = points[priorIndex]!;
    if (prior.x !== current.x || prior.y !== current.y) {
      return Math.atan2(current.y - prior.y, current.x - prior.x);
    }
  }
  return 0;
}

function topologyAdjacentLaneId(
  topology: RuntimeBoundMapTopologyIndex,
  lane: RuntimeBoundMapTopologyIndex["lanes"][string],
  side: "left" | "right",
): number | null {
  const adjacent = lane.adjacentLanes?.[side];
  if (!adjacent?.sameDirection || !adjacent.laneRsl) return null;
  const target = topology.lanes[adjacent.laneRsl];
  if (
    !target ||
    target.roadId !== lane.roadId ||
    target.section !== lane.section
  ) {
    return null;
  }
  return target.laneId;
}

/**
 * Project the runtime-bound topology index into the collision planner's graph.
 *
 * Prefer CARLA's crawl-resolved direction whenever the binding has one. The
 * crawl does not cover every published lane, though, and Munich's accepted
 * topology predates the direction stamps entirely. For those lanes we retain
 * the lane-id convention: it agreed with the crawl on 7099/7099 measured gate
 * lanes across every published map. Keeping that measured fallback preserves
 * complete graphs instead of dropping valid live-corpus lanes.
 */
export function buildLaneGraphFromTopology(
  topology: RuntimeBoundMapTopologyIndex,
  center: { x: number; y: number },
  radiusM: number,
  resolvedTravelIncreasesS: ReadonlyMap<string, boolean>,
): LaneGraph {
  const nodes = new Map<string, LaneNode>();

  for (const lane of Object.values(topology.lanes)) {
    if (lane.polyline.length < 2) continue;
    const travelIncreasesS =
      resolvedTravelIncreasesS.get(lane.rsl) ??
      laneTravelIncreasesSByConvention(lane.laneId);
    const midpoint = lane.polyline[Math.floor(lane.polyline.length / 2)]!;
    if (Math.hypot(midpoint.x - center.x, midpoint.y - center.y) > radiusM) continue;

    const ordered = travelOrderedPolyline(lane.polyline, travelIncreasesS);
    const cumulativeArc = buildCumulativeArc(ordered);
    const length_m = cumulativeArc[cumulativeArc.length - 1]!;
    if (length_m === 0) continue;
    const forwardPolyline: LanePolylineVertex[] = ordered.map((point, index) => ({
      x: point.x,
      y: point.y,
      yaw: polylineYaw(ordered, index),
      s: cumulativeArc[index]!,
    }));

    nodes.set(lane.rsl, {
      id: lane.rsl,
      road_id: lane.roadId,
      section_id: lane.section,
      lane_id: lane.laneId,
      lane_type: lane.laneType.toLowerCase() || "unknown",
      is_junction: lane.isJunction,
      left_lane_id: topologyAdjacentLaneId(topology, lane, "left"),
      right_lane_id: topologyAdjacentLaneId(topology, lane, "right"),
      forwardPolyline,
      cumulativeArc,
      length_m,
    });
  }

  const forwardLinks: DirectedLink[] = [];
  const adjacentLinks: DirectedLink[] = [];
  for (const lane of Object.values(topology.lanes)) {
    if (!nodes.has(lane.rsl)) continue;
    for (const successor of lane.successors) {
      forwardLinks.push([lane.rsl, successor]);
    }
    for (const predecessor of lane.predecessors) {
      forwardLinks.push([predecessor, lane.rsl]);
    }
    for (const side of ["left", "right"] as const) {
      const adjacent = lane.adjacentLanes?.[side];
      if (adjacent?.sameDirection && adjacent.laneRsl) {
        adjacentLinks.push([lane.rsl, adjacent.laneRsl]);
      }
    }
  }

  return assembleLaneGraph(nodes, forwardLinks, adjacentLinks);
}

// ── Backward walk ───────────────────────────────────────────────────────────

export interface LanePosition {
  laneId: string;
  /** Arc-length fraction along the node's forward polyline. */
  sFraction: number;
}

export interface BackwardWalkResult {
  /** Where the actor must spawn. */
  spawn: LanePosition;
  /** World point at the spawn. */
  spawnPoint: { x: number; y: number };
  /** Yaw (forward-travel direction) at the spawn. */
  spawnYaw: number;
  /** Forward-direction polyline from spawn to the original start position,
   *  sampled ~ every `samplingM` meters. Always includes both endpoints. */
  forwardPolyline: ReadonlyArray<{ x: number; y: number }>;
  /** Total arc length actually traversed. */
  arcLengthM: number;
  /** Ordered list of lane nodes the walk passed through, from spawn lane
   *  to the start lane. Useful for diagnostics + tests. */
  laneSequence: readonly LaneNode[];
}

/**
 * Walk backward from `start` along the lane graph, consuming up to
 * `distanceM` meters of arc length. Returns the spawn position + forward
 * polyline from spawn to start.
 *
 * Predecessor selection. At each lane boundary we follow a single backward
 * forward-edge (lane-change edges are ignored — the planner places spawns
 * on the same lane stream that reaches the conflict point). When multiple
 * predecessors exist (e.g. several connecting lanes feed a single exit
 * lane through a junction), we pick the one whose endpoint yaw best
 * matches the current lane's start yaw. Non-junction predecessors are
 * preferred so the spawn lands on an approach road, not inside a junction.
 */
export function walkBack(
  graph: LaneGraph,
  start: LanePosition,
  distanceM: number,
  samplingM = 5,
): BackwardWalkResult | null {
  const startNode = graph.nodes.get(start.laneId);
  if (!startNode) return null;

  const visited = new Set<string>([startNode.id]);
  const laneSequence: LaneNode[] = [startNode];
  let currentNode = startNode;
  let currentSFraction = Math.max(0, Math.min(1, start.sFraction));
  let remaining = distanceM;

  while (remaining > 0) {
    const availableOnCurrent = currentSFraction * currentNode.length_m;
    if (availableOnCurrent >= remaining) {
      // We can spawn within this lane.
      const newSFraction = currentSFraction - remaining / currentNode.length_m;
      currentSFraction = newSFraction;
      remaining = 0;
      break;
    }
    // Consume the entire upstream portion of this lane.
    remaining -= availableOnCurrent;
    // Step to a predecessor.
    const predecessors = graph
      .incoming(currentNode.id)
      .filter((e) => e.kind === "forward")
      .map((e) => graph.nodes.get(e.to))
      .filter((n): n is LaneNode => n != null && !visited.has(n.id));
    if (predecessors.length === 0) {
      // No more predecessors — spawn at the lane's start.
      currentSFraction = 0;
      remaining = 0;
      break;
    }
    // Pick the best predecessor: prefer non-junction, then yaw alignment.
    const currentStartYaw = currentNode.forwardPolyline[0]!.yaw;
    predecessors.sort((a, b) => {
      const junctionA = a.is_junction ? 1 : 0;
      const junctionB = b.is_junction ? 1 : 0;
      if (junctionA !== junctionB) return junctionA - junctionB;
      const yawA = a.forwardPolyline[a.forwardPolyline.length - 1]!.yaw;
      const yawB = b.forwardPolyline[b.forwardPolyline.length - 1]!.yaw;
      return angleDifference(yawA, currentStartYaw) - angleDifference(yawB, currentStartYaw);
    });
    currentNode = predecessors[0]!;
    currentSFraction = 1;
    visited.add(currentNode.id);
    laneSequence.unshift(currentNode);
  }

  const spawnPoint = pointOnLane(currentNode, currentSFraction);
  const spawn: LanePosition = { laneId: currentNode.id, sFraction: currentSFraction };

  // Build forward-direction polyline from spawn to start.
  const polyline: Array<{ x: number; y: number }> = [];
  let totalArc = 0;
  for (let i = 0; i < laneSequence.length; i++) {
    const node = laneSequence[i]!;
    const fromS = i === 0 ? currentSFraction : 0;
    const toS = i === laneSequence.length - 1 ? start.sFraction : 1;
    const samples = sampleLaneSegment(node, fromS, toS, samplingM);
    for (const p of samples) {
      const last = polyline[polyline.length - 1];
      if (!last || last.x !== p.x || last.y !== p.y) polyline.push(p);
    }
    totalArc += Math.abs(toS - fromS) * node.length_m;
  }

  return {
    spawn,
    spawnPoint: { x: spawnPoint.x, y: spawnPoint.y },
    spawnYaw: spawnPoint.yaw,
    forwardPolyline: polyline,
    arcLengthM: totalArc,
    laneSequence,
  };
}

// ── Forward walk ────────────────────────────────────────────────────────────

export interface ForwardWalkResult {
  /** End position after walking `distanceM` forward from `start`. */
  end: LanePosition;
  endPoint: { x: number; y: number };
  endYaw: number;
  forwardPolyline: ReadonlyArray<{ x: number; y: number }>;
  arcLengthM: number;
  laneSequence: readonly LaneNode[];
}

/**
 * Walk forward from `start` for up to `distanceM` meters, optionally
 * biasing predecessor choice with `pickSuccessor`. Default successor pick:
 * the forward edge whose yaw best continues the current lane's direction.
 * Caller passes a custom picker to encode "turn left at the next
 * junction" semantics.
 */
export function walkForward(
  graph: LaneGraph,
  start: LanePosition,
  distanceM: number,
  options: {
    samplingM?: number;
    pickSuccessor?: (current: LaneNode, candidates: readonly LaneNode[]) => LaneNode | null;
  } = {},
): ForwardWalkResult | null {
  const samplingM = options.samplingM ?? 5;
  const startNode = graph.nodes.get(start.laneId);
  if (!startNode) return null;

  const visited = new Set<string>([startNode.id]);
  const laneSequence: LaneNode[] = [startNode];
  let currentNode = startNode;
  let currentSFraction = Math.max(0, Math.min(1, start.sFraction));
  let remaining = distanceM;

  while (remaining > 0) {
    const availableOnCurrent = (1 - currentSFraction) * currentNode.length_m;
    if (availableOnCurrent >= remaining) {
      currentSFraction += remaining / currentNode.length_m;
      remaining = 0;
      break;
    }
    remaining -= availableOnCurrent;
    const successors = graph
      .outgoing(currentNode.id)
      .filter((e) => e.kind === "forward")
      .map((e) => graph.nodes.get(e.to))
      .filter((n): n is LaneNode => n != null && !visited.has(n.id));
    if (successors.length === 0) {
      currentSFraction = 1;
      remaining = 0;
      break;
    }
    const picker = options.pickSuccessor ?? defaultForwardSuccessor;
    const next = picker(currentNode, successors);
    if (!next) {
      currentSFraction = 1;
      remaining = 0;
      break;
    }
    currentNode = next;
    currentSFraction = 0;
    visited.add(currentNode.id);
    laneSequence.push(currentNode);
  }

  const endPoint = pointOnLane(currentNode, currentSFraction);
  const end: LanePosition = { laneId: currentNode.id, sFraction: currentSFraction };

  const polyline: Array<{ x: number; y: number }> = [];
  let totalArc = 0;
  for (let i = 0; i < laneSequence.length; i++) {
    const node = laneSequence[i]!;
    const fromS = i === 0 ? start.sFraction : 0;
    const toS = i === laneSequence.length - 1 ? currentSFraction : 1;
    const samples = sampleLaneSegment(node, fromS, toS, samplingM);
    for (const p of samples) {
      const last = polyline[polyline.length - 1];
      if (!last || last.x !== p.x || last.y !== p.y) polyline.push(p);
    }
    totalArc += Math.abs(toS - fromS) * node.length_m;
  }

  return {
    end,
    endPoint: { x: endPoint.x, y: endPoint.y },
    endYaw: endPoint.yaw,
    forwardPolyline: polyline,
    arcLengthM: totalArc,
    laneSequence,
  };
}

/** Default successor picker: minimise yaw deviation at the boundary. */
function defaultForwardSuccessor(
  current: LaneNode,
  candidates: readonly LaneNode[],
): LaneNode | null {
  if (candidates.length === 0) return null;
  const currentEndYaw = current.forwardPolyline[current.forwardPolyline.length - 1]!.yaw;
  let best = candidates[0]!;
  let bestDelta = angleDifference(
    best.forwardPolyline[0]!.yaw,
    currentEndYaw,
  );
  for (let i = 1; i < candidates.length; i++) {
    const c = candidates[i]!;
    const delta = angleDifference(c.forwardPolyline[0]!.yaw, currentEndYaw);
    if (delta < bestDelta) {
      best = c;
      bestDelta = delta;
    }
  }
  return best;
}

/**
 * Successor picker that prefers a LEFT turn at the next junction. Used by
 * the unprotected-left-turn planner to coerce subject through the conflicting
 * left-turn lane. When the next-section choice includes a junction-internal
 * lane that turns left relative to the current heading, pick it; otherwise
 * fall back to the straight-ahead lane.
 */
export function leftTurnSuccessorPicker(
  current: LaneNode,
  candidates: readonly LaneNode[],
): LaneNode | null {
  if (candidates.length === 0) return null;
  const currentEndYaw = current.forwardPolyline[current.forwardPolyline.length - 1]!.yaw;
  let best: LaneNode | null = null;
  let bestScore = -Infinity;
  for (const c of candidates) {
    const startYaw = c.forwardPolyline[0]!.yaw;
    const endYaw = c.forwardPolyline[c.forwardPolyline.length - 1]!.yaw;
    // Signed turn angle from current's end heading to candidate's end
    // heading. Positive = left (CCW), negative = right (CW).
    let turn = endYaw - currentEndYaw;
    while (turn > Math.PI) turn -= Math.PI * 2;
    while (turn < -Math.PI) turn += Math.PI * 2;
    // Junction-internal lanes are preferred at the first junction crossing,
    // and we want a left-ish turn (~ +π/2). Score = closeness to +π/2.
    const turnScore = -Math.abs(turn - Math.PI / 2);
    // Penalize if start yaw doesn't continue the current heading.
    const continuationPenalty = -angleDifference(startYaw, currentEndYaw);
    const junctionBonus = c.is_junction ? 0.5 : 0;
    const score = turnScore + continuationPenalty + junctionBonus;
    if (score > bestScore) {
      bestScore = score;
      best = c;
    }
  }
  return best;
}

// ── Misc helpers ────────────────────────────────────────────────────────────

/**
 * Project a world point onto the lane's centerline polyline. Returns the
 * arc-length s-fraction of the foot of the perpendicular and the projected
 * point itself. Operates on the FORWARD polyline; the result is robust to
 * stored-centerline reversal.
 */
export function projectPointOntoLanePolyline(
  node: LaneNode,
  point: { x: number; y: number },
): { sFraction: number; point: { x: number; y: number }; distance: number } {
  const poly = node.forwardPolyline;
  if (poly.length < 2) {
    const dx = point.x - poly[0]!.x;
    const dy = point.y - poly[0]!.y;
    return {
      sFraction: 0,
      point: { x: poly[0]!.x, y: poly[0]!.y },
      distance: Math.hypot(dx, dy),
    };
  }
  let bestArc = 0;
  let bestPoint = { x: poly[0]!.x, y: poly[0]!.y };
  let bestDistance = Infinity;
  for (let i = 1; i < poly.length; i++) {
    const a = poly[i - 1]!;
    const b = poly[i]!;
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const segLenSq = dx * dx + dy * dy;
    if (segLenSq === 0) continue;
    const t = Math.max(
      0,
      Math.min(1, ((point.x - a.x) * dx + (point.y - a.y) * dy) / segLenSq),
    );
    const px = a.x + t * dx;
    const py = a.y + t * dy;
    const distance = Math.hypot(point.x - px, point.y - py);
    if (distance < bestDistance) {
      bestDistance = distance;
      bestPoint = { x: px, y: py };
      const segArc = Math.sqrt(segLenSq);
      bestArc = node.cumulativeArc[i - 1]! + t * segArc;
    }
  }
  return {
    sFraction: node.length_m > 0 ? bestArc / node.length_m : 0,
    point: bestPoint,
    distance: bestDistance,
  };
}
