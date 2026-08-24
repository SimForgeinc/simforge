/**
 * The lane graph: an indexed, query-ready view over the topology index.
 *
 * Three things live here that everything else in the package leans on:
 *
 * 1. **Travel-ordered polylines.** The topology index stores every polyline in
 *    OpenDRIVE `s` order, and a positive-id lane travels *against* `s`. Stored
 *    order is therefore the direction of travel for negative-id lanes and the
 *    reverse of it for positive-id ones — measured on Yale, 225 of 234
 *    positive-id approach lanes have the junction at their polyline *start*,
 *    and 198 of 239 positive-id connecting lanes run exit-to-approach.
 *
 *    Consuming that raw is catastrophic and silent: the "heading into the
 *    junction" of a positive-id approach comes out 180° wrong, so head-on
 *    conflicts get labelled same-direction merges; arc length along a
 *    connecting lane is measured from the wrong end, so a precomputed conflict
 *    point lands at the far side of the intersection; and "successor" tests
 *    compare the wrong endpoints. {@link LaneGraph} therefore reverses
 *    positive-id polylines at construction, and **every `s` in this package is
 *    travel-ordered arc length from the lane's entry**, not OpenDRIVE `s`.
 *    {@link LaneNode.reversed} records which lanes were flipped, and
 *    {@link LaneGraph.toXodrS} converts back for export.
 *
 * 2. **`nearestLane`** — the anchor-lift primitive. A uniform grid over every
 *    polyline *segment* (not vertex — polylines sample at ~1–4 m and a vertex
 *    index would miss the middle of long straights). No raycasting is needed:
 *    the polylines are already in the same metric frame as everything else.
 *
 * 3. **Lane rows** — the topology index's `adjacentLanes` only reports
 *    *drivable* neighbours (lane `-2`'s left is `null` even when shoulder `-1`
 *    exists), so parking/bike/sidewalk adjacency has to be reconstructed from
 *    the `road:section` lane row by lane-id ordering. That reconstruction is
 *    what makes `hasParkingAdjacent` and friends true facts rather than
 *    plausible-looking guesses.
 */

import { asJunctionId, asLaneRef, type JunctionId, type LaneRef } from '../types/ids.js';
import type { TopologyIndex, TopologyLane } from '../types/sources.js';
import {
  cumulativeLengths,
  dist2,
  headingOf,
  poseAtS,
  projectOnSegment,
  type Point2,
} from './vec.js';

/** Grid cell size for the nearest-lane index, metres. */
const GRID_CELL_M = 20;

/** Precomputed per-lane geometry. All arc lengths are travel-ordered. */
export interface LaneNode {
  rsl: LaneRef;
  raw: TopologyLane;
  /** Polyline **in travel order** — reversed from the source when `reversed`. */
  points: Point2[];
  /**
   * True when the source polyline ran against the direction of travel and was
   * flipped. Starts from the OpenDRIVE sign rule (`laneId > 0`) and is then
   * settled against the gate for junction connecting lanes.
   */
  reversed: boolean;
  /** Cumulative arc length; `cum[cum.length - 1]` is the lane length. */
  cum: number[];
  lengthM: number;
  laneType: string;
  isJunction: boolean;
  junctionId: JunctionId | null;
  speedLimitKph: number | null;
  widthM: number;
  /** `road:section`. */
  rowKey: string;
  laneId: number;
}

/** A nearest-lane hit. */
export interface LaneHit {
  rsl: LaneRef;
  lane: LaneNode;
  /** Arc length along the lane polyline, metres. */
  s: number;
  /** Distance from the query point to the lane centreline, metres. */
  distanceM: number;
  /** Signed lateral offset from the centreline (left positive), metres. */
  offsetM: number;
  headingRad: number;
  point: Point2;
}

/** Options for {@link LaneGraph.nearestLane}. */
export interface NearestLaneOptions {
  /** Give up beyond this distance. Default 150 m. */
  maxDistanceM?: number;
  /** Restrict to these lane types. */
  laneTypes?: readonly string[];
  /** Exclude junction-internal lanes. */
  excludeJunctionInternal?: boolean;
  /** Only consider these lanes. */
  onlyRsls?: ReadonlySet<string>;
}

/** Immediate lane-row neighbour. */
export interface RowNeighbour {
  rsl: LaneRef;
  lane: LaneNode;
  /** True when the neighbour travels the same direction (same sign of lane id). */
  sameDirection: boolean;
}

/**
 * Indexed lane graph.
 *
 * Construction is O(total polyline vertices); Yale's 1,141 lanes build in a
 * few milliseconds.
 */
export class LaneGraph {
  readonly lanes: Map<string, LaneNode> = new Map();
  readonly rows: Map<string, LaneNode[]> = new Map();
  readonly index: TopologyIndex;

  /** cellKey → [laneRsl, segmentIndex] pairs, flattened. */
  readonly #grid: Map<string, { rsl: string; i: number }[]> = new Map();


  constructor(index: TopologyIndex) {
    this.index = index;
    const rsls = Object.keys(index.lanes).sort();
    for (const rsl of rsls) {
      const raw = index.lanes[rsl];
      if (!raw || !Array.isArray(raw.polyline) || raw.polyline.length < 2) continue;
      // Positive lane ids run against OpenDRIVE `s`; flip so index 0 is where a
      // vehicle enters the lane.
      const reversed = raw.laneId > 0;
      const source = raw.polyline.map((p) => ({ x: p.x, y: p.y }));
      const points = reversed ? source.reverse() : source;
      const cum = cumulativeLengths(points);
      const node: LaneNode = {
        rsl: asLaneRef(rsl),
        raw,
        points,
        reversed,
        cum,
        lengthM: cum[cum.length - 1] as number,
        laneType: raw.laneType,
        isJunction: raw.isJunction === true,
        junctionId: raw.junctionId == null ? null : asJunctionId(String(raw.junctionId)),
        speedLimitKph: raw.speedLimitKph ?? null,
        widthM: raw.representativeWidthM ?? 0,
        rowKey: `${raw.roadId}:${raw.section}`,
        laneId: raw.laneId,
      };
      this.lanes.set(rsl, node);
      const row = this.rows.get(node.rowKey);
      if (row) row.push(node);
      else this.rows.set(node.rowKey, [node]);
    }
    this.#orientConnectingLanes();
    for (const node of this.lanes.values()) this.#indexLane(node);
    // Lane rows are ordered by lane id: ... -3, -2, -1, 1, 2, 3 ...
    for (const row of this.rows.values()) row.sort((a, b) => a.laneId - b.laneId);
  }

  /**
   * Re-orient junction connecting lanes from their gate.
   *
   * The lane-sign rule is the OpenDRIVE semantic and is right for the open
   * road, but it is only right for ~92% of connecting lanes: on Yale, 41 of 239
   * positive-id connecting lanes are already stored approach-to-exit. The gate
   * is ground truth — a connecting lane *begins* where its approach lane ends —
   * so it is used to settle the direction rather than the sign.
   *
   * Getting this wrong is invisible until it is expensive: `sOnA` for a
   * precomputed conflict would be measured from the far side of the
   * intersection, so an actor backed up from it would start on the wrong side
   * of the junction it was supposed to be entering.
   */
  #orientConnectingLanes(): void {
    const gates = [...(this.index.gates ?? [])].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    const settled = new Set<string>();
    for (const gate of gates) {
      if (settled.has(gate.connectingLaneRsl)) continue;
      const approach = this.lanes.get(gate.approachLaneRsl);
      const connecting = this.lanes.get(gate.connectingLaneRsl);
      if (!approach || !connecting) continue;
      settled.add(gate.connectingLaneRsl);
      const entry = approach.points[approach.points.length - 1] as Point2;
      const toStart = dist2(entry, connecting.points[0] as Point2);
      const toEnd = dist2(entry, connecting.points[connecting.points.length - 1] as Point2);
      if (toEnd < toStart) this.#flip(connecting);
    }
  }

  #flip(node: LaneNode): void {
    node.points.reverse();
    const cum = cumulativeLengths(node.points);
    node.cum.length = 0;
    node.cum.push(...cum);
    node.reversed = !node.reversed;
  }

  #indexLane(node: LaneNode): void {
    for (let i = 0; i + 1 < node.points.length; i++) {
      const a = node.points[i] as Point2;
      const b = node.points[i + 1] as Point2;
      const x0 = Math.floor(Math.min(a.x, b.x) / GRID_CELL_M);
      const x1 = Math.floor(Math.max(a.x, b.x) / GRID_CELL_M);
      const y0 = Math.floor(Math.min(a.y, b.y) / GRID_CELL_M);
      const y1 = Math.floor(Math.max(a.y, b.y) / GRID_CELL_M);
      for (let cx = x0; cx <= x1; cx++) {
        for (let cy = y0; cy <= y1; cy++) {
          const key = `${cx},${cy}`;
          const bucket = this.#grid.get(key);
          if (bucket) bucket.push({ rsl: node.rsl as string, i });
          else this.#grid.set(key, [{ rsl: node.rsl as string, i }]);
        }
      }
    }
  }

  /** Lane by reference, or `undefined`. */
  get(rsl: string): LaneNode | undefined {
    return this.lanes.get(rsl);
  }

  /** All lanes, in stable (sorted-key) order. */
  allLanes(): LaneNode[] {
    return [...this.lanes.values()];
  }

  /**
   * Nearest lane centreline to a point.
   *
   * Searches outward ring by ring over the grid and stops as soon as the best
   * hit so far is closer than the next ring's guaranteed minimum distance —
   * exact, not approximate.
   */
  nearestLane(p: Point2, opts: NearestLaneOptions = {}): LaneHit | null {
    const maxDistance = opts.maxDistanceM ?? 150;
    const types = opts.laneTypes ? new Set(opts.laneTypes) : null;
    const cx = Math.floor(p.x / GRID_CELL_M);
    const cy = Math.floor(p.y / GRID_CELL_M);
    const maxRing = Math.ceil(maxDistance / GRID_CELL_M) + 1;

    let best: LaneHit | null = null;
    let bestDist = Infinity;

    for (let ring = 0; ring <= maxRing; ring++) {
      // Everything in rings < `ring` has been examined; anything in this ring
      // or beyond is at least (ring - 1) * cell away.
      if (best && bestDist <= (ring - 1) * GRID_CELL_M) break;
      for (let dx = -ring; dx <= ring; dx++) {
        for (let dy = -ring; dy <= ring; dy++) {
          if (Math.max(Math.abs(dx), Math.abs(dy)) !== ring) continue;
          const bucket = this.#grid.get(`${cx + dx},${cy + dy}`);
          if (!bucket) continue;
          for (const entry of bucket) {
            const lane = this.lanes.get(entry.rsl);
            if (!lane) continue;
            if (types && !types.has(lane.laneType)) continue;
            if (opts.excludeJunctionInternal && lane.isJunction) continue;
            if (opts.onlyRsls && !opts.onlyRsls.has(entry.rsl)) continue;
            const a = lane.points[entry.i] as Point2;
            const b = lane.points[entry.i + 1] as Point2;
            const proj = projectOnSegment(p, a, b);
            if (proj.distance >= bestDist) continue;
            const segStart = lane.cum[entry.i] as number;
            const segLen = (lane.cum[entry.i + 1] as number) - segStart;
            bestDist = proj.distance;
            best = {
              rsl: lane.rsl,
              lane,
              s: segStart + proj.t * segLen,
              distanceM: proj.distance,
              offsetM: proj.side,
              headingRad: headingOf(a, b),
              point: proj.point,
            };
          }
        }
      }
    }
    if (!best || bestDist > maxDistance) return null;
    return best;
  }

  /** Pose at arc length `s` along a lane. */
  poseAt(rsl: string, s: number): { point: Point2; headingRad: number } | null {
    const lane = this.lanes.get(rsl);
    if (!lane) return null;
    const pose = poseAtS(lane.points, lane.cum, s);
    return { point: pose.point, headingRad: pose.headingRad };
  }

  /** Start point of a lane. */
  startOf(lane: LaneNode): Point2 {
    return lane.points[0] as Point2;
  }

  /** End point of a lane. */
  endOf(lane: LaneNode): Point2 {
    return lane.points[lane.points.length - 1] as Point2;
  }

  /** Heading at the very start of a lane. */
  startHeading(lane: LaneNode): number {
    return headingOf(lane.points[0] as Point2, lane.points[1] as Point2);
  }

  /** Heading at the very end of a lane. */
  endHeading(lane: LaneNode): number {
    const n = lane.points.length;
    return headingOf(lane.points[n - 2] as Point2, lane.points[n - 1] as Point2);
  }

  /**
   * Immediate neighbours in the physical lane row.
   *
   * `left`/`right` are relative to the lane's own direction of travel. In
   * OpenDRIVE, negative lane ids run with the road's s-direction and positive
   * against it, so for a negative lane the next-lower id (`-3` beside `-2`) is
   * to its *right*, and for a positive lane it is to its *left*.
   */
  rowNeighbours(rsl: string): { left: RowNeighbour | null; right: RowNeighbour | null } {
    const lane = this.lanes.get(rsl);
    if (!lane) return { left: null, right: null };
    const row = this.rows.get(lane.rowKey);
    if (!row) return { left: null, right: null };
    const idx = row.findIndex((l) => l.rsl === lane.rsl);
    if (idx < 0) return { left: null, right: null };
    const lower = idx > 0 ? (row[idx - 1] as LaneNode) : null;
    const higher = idx + 1 < row.length ? (row[idx + 1] as LaneNode) : null;
    const wrap = (n: LaneNode | null): RowNeighbour | null =>
      n ? { rsl: n.rsl, lane: n, sameDirection: Math.sign(n.laneId) === Math.sign(lane.laneId) } : null;
    return lane.laneId < 0
      ? { left: wrap(higher), right: wrap(lower) }
      : { left: wrap(lower), right: wrap(higher) };
  }

  /**
   * Walk the lane row outward from `rsl` and return every neighbour reachable
   * without crossing the road centreline, in order.
   */
  rowSideLanes(rsl: string, side: 'left' | 'right'): LaneNode[] {
    const out: LaneNode[] = [];
    let cursor = rsl;
    const seen = new Set<string>([rsl]);
    for (let guard = 0; guard < 32; guard++) {
      const n = this.rowNeighbours(cursor)[side];
      if (!n || seen.has(n.rsl as string)) break;
      seen.add(n.rsl as string);
      out.push(n.lane);
      cursor = n.rsl as string;
    }
    return out;
  }

  /** Every lane in the same `road:section` row, ordered by lane id. */
  row(rsl: string): LaneNode[] {
    const lane = this.lanes.get(rsl);
    if (!lane) return [];
    return this.rows.get(lane.rowKey) ?? [];
  }

  /**
   * Geometric successors: successors declared by the topology index whose
   * polyline actually starts where this lane ends.
   *
   * The raw `successors`/`predecessors` lists on the dev maps are *not* clean
   * directed edges — lane `0:0:-2` lists `141:0:1` in both — so continuity has
   * to be verified rather than trusted.
   *
   * @param gapToleranceM How far apart the endpoints may be. Default 1.5 m.
   * @param maxHeadingChangeRad Reject hairpin "continuations". Default 100°.
   */
  geometricSuccessors(rsl: string, gapToleranceM = 1.5, maxHeadingChangeRad = 1.75): LaneNode[] {
    const lane = this.lanes.get(rsl);
    if (!lane) return [];
    const end = this.endOf(lane);
    const endHdg = this.endHeading(lane);
    const tol2 = gapToleranceM * gapToleranceM;
    const out: LaneNode[] = [];
    const candidates = new Set<string>([...lane.raw.successors, ...lane.raw.predecessors]);
    for (const cand of [...candidates].sort()) {
      const next = this.lanes.get(cand);
      if (!next) continue;
      if (dist2(end, this.startOf(next)) > tol2) continue;
      const d = Math.abs(normalise(this.startHeading(next) - endHdg));
      if (d > maxHeadingChangeRad) continue;
      out.push(next);
    }
    return out;
  }

  /** Geometric predecessors — the mirror of {@link geometricSuccessors}. */
  geometricPredecessors(rsl: string, gapToleranceM = 1.5, maxHeadingChangeRad = 1.75): LaneNode[] {
    const lane = this.lanes.get(rsl);
    if (!lane) return [];
    const start = this.startOf(lane);
    const startHdg = this.startHeading(lane);
    const tol2 = gapToleranceM * gapToleranceM;
    const out: LaneNode[] = [];
    const candidates = new Set<string>([...lane.raw.successors, ...lane.raw.predecessors]);
    for (const cand of [...candidates].sort()) {
      const prev = this.lanes.get(cand);
      if (!prev) continue;
      if (dist2(start, this.endOf(prev)) > tol2) continue;
      const d = Math.abs(normalise(startHdg - this.endHeading(prev)));
      if (d > maxHeadingChangeRad) continue;
      out.push(prev);
    }
    return out;
  }

  /**
   * Width of a lane at arc length `s`, linearly interpolated between its width
   * samples (clamped at both ends).
   *
   * Zero is a legitimate result: OpenDRIVE lanes taper to nothing at drops and
   * merges, and the width samples say so. Callers that need a usable lane must
   * check the value rather than assume it is positive.
   */
  widthAt(lane: LaneNode, s: number): number {
    const samples = lane.raw.widthSamples;
    if (!samples || samples.length === 0) return lane.widthM;
    // `widthSamples[].s` is OpenDRIVE `s`; the argument is travel-ordered.
    const query = this.toXodrS(lane, s);
    const sorted = [...samples].sort((a, b) => a.s - b.s);
    const first = sorted[0] as { s: number; widthM: number };
    const last = sorted[sorted.length - 1] as { s: number; widthM: number };
    if (query <= first.s) return first.widthM;
    if (query >= last.s) return last.widthM;
    for (let i = 0; i + 1 < sorted.length; i++) {
      const a = sorted[i] as { s: number; widthM: number };
      const b = sorted[i + 1] as { s: number; widthM: number };
      if (query < a.s || query > b.s) continue;
      const span = b.s - a.s;
      const t = span === 0 ? 0 : (query - a.s) / span;
      return a.widthM + t * (b.widthM - a.widthM);
    }
    return lane.widthM;
  }

  /**
   * Convert travel-ordered arc length back to OpenDRIVE `s`.
   *
   * Needed wherever source data keyed on `s` is consulted (width samples,
   * lane-change permissions) and by any exporter that has to emit an
   * OpenSCENARIO `LanePosition`.
   */
  toXodrS(lane: LaneNode, travelS: number): number {
    return lane.reversed ? lane.lengthM - travelS : travelS;
  }

  /** Convert OpenDRIVE `s` to travel-ordered arc length. */
  fromXodrS(lane: LaneNode, xodrS: number): number {
    return lane.reversed ? lane.lengthM - xodrS : xodrS;
  }

  /**
   * Convert a source-declared side (`left`/`right` looking along `+s`) into the
   * driver's frame. For a lane travelling against `s` the two are swapped, and
   * a lane-change permission that says "left" would otherwise send a vehicle
   * into oncoming traffic.
   */
  driverSide(lane: LaneNode, sourceSide: 'left' | 'right'): 'left' | 'right' {
    if (!lane.reversed) return sourceSide;
    return sourceSide === 'left' ? 'right' : 'left';
  }

  /** Absolute heading change per 10 m around arc length `s`, in degrees. */
  curvatureDegPer10mAt(lane: LaneNode, s: number, window = 10): number {
    const total = lane.lengthM;
    if (total < 1) return 0;
    const a = Math.max(0, s - window / 2);
    const b = Math.min(total, s + window / 2);
    if (b - a < 0.5) return 0;
    const pa = poseAtS(lane.points, lane.cum, a);
    const pb = poseAtS(lane.points, lane.cum, b);
    const delta = Math.abs(normalise(pb.headingRad - pa.headingRad));
    return ((delta * 180) / Math.PI) * (10 / (b - a));
  }
}

function normalise(a: number): number {
  let x = a;
  while (x <= -Math.PI) x += 2 * Math.PI;
  while (x > Math.PI) x -= 2 * Math.PI;
  return x;
}
