/**
 * The engine's arc-length model over the topology index.
 *
 * ## Why orientation has to be derived
 *
 * `topology-index.json.gz` stores lane polylines in **geometric `s` order** and
 * its `predecessors` / `successors` lists are effectively *undirected* — on
 * yale-street 658 of 1534 links fail a naive "my last point is your first
 * point" test, and many lanes list the same neighbour in both arrays (e.g.
 * `0:0:-2` has `141:0:1` as both). OpenDRIVE's own rule is that a lane with a
 * negative id travels along `+s` and a positive id against it, but junction
 * connecting roads are emitted in whichever direction their connecting road ran.
 *
 * So `LaneGraph` works with **directed lanes** (`rsl` + `reversed`) and derives
 * successors *geometrically*: a neighbour is a successor only if one of its two
 * orientations has an entry endpoint within `ENDPOINT_TOL_M` of our exit
 * endpoint. Non-junction lanes are additionally pinned to their sign-implied
 * direction so the walker can't drive the wrong way down a one-way lane;
 * junction connecting lanes are free (their storage order is unreliable).
 *
 * Everything fans out in sorted order so route walks are reproducible.
 */

import { clamp, dist, pointSegment, type Vec2 } from '../core/math.js';
import {
  pointOf,
  type LaneRsl,
  type TopologyGate,
  type TopologyIndex,
  type TopologyLane,
  type TurnRelationName,
} from './topology.js';

/** Endpoints closer than this are the same node. Also the guard tolerance in
 * `route_disconnected` (research doc: "geometrically-verified adjacency"). */
export const ENDPOINT_TOL_M = 0.5;

/** A lane traversed in a definite direction. */
export interface DirectedLane {
  readonly rsl: LaneRsl;
  /** `true` = travel from the last polyline point to the first. */
  readonly reversed: boolean;
}

export interface LaneGeometry {
  readonly rsl: LaneRsl;
  readonly lane: TopologyLane;
  /** Polyline in storage order, xodr-local metres. */
  readonly points: readonly Vec2[];
  /** Cumulative arc length at each point; `cum[0] === 0`. */
  readonly cum: readonly number[];
  readonly lengthM: number;
  /** Per-point heading in storage direction (last repeats the previous). */
  readonly headings: readonly number[];
  readonly speedLimitMps: number;
  readonly widthM: number;
}

export interface PathSample {
  readonly point: Vec2;
  readonly headingRad: number;
}

const DEFAULT_SPEED_LIMIT_MPS = 13.4; // 30 mph — used when the index has none.
const DEFAULT_LANE_WIDTH_M = 3.5;

function directedKey(d: DirectedLane): string {
  return `${d.rsl}${d.reversed ? '#r' : '#f'}`;
}

/**
 * Read-only, immutable view of one map's drivable geometry. Building it is
 * O(lanes) and takes a few ms on yale-street (1141 lanes); callers should build
 * once and share across runs.
 */
export class LaneGraph {
  readonly mapName: string;
  readonly topologyDigest: string;
  private readonly geom = new Map<LaneRsl, LaneGeometry>();
  private readonly gatesByApproach = new Map<LaneRsl, TopologyGate[]>();
  private readonly gatesByConnecting = new Map<LaneRsl, TopologyGate[]>();
  private readonly successorCache = new Map<string, DirectedLane[]>();

  constructor(private readonly index: TopologyIndex) {
    this.mapName = index.mapName ?? 'unknown';
    this.topologyDigest = index.source?.xodrSha256 ?? '';

    for (const rsl of Object.keys(index.lanes).sort()) {
      const lane = index.lanes[rsl]!;
      const raw = lane.polyline ?? [];
      const points: Vec2[] = [];
      for (const p of raw) {
        const v = pointOf(p);
        const prev = points[points.length - 1];
        // Drop duplicate vertices: they make headings NaN.
        if (prev && Math.abs(prev.x - v.x) < 1e-9 && Math.abs(prev.y - v.y) < 1e-9) continue;
        points.push({ x: v.x, y: v.y });
      }
      if (points.length < 2) continue;
      const cum: number[] = [0];
      const headings: number[] = [];
      for (let i = 1; i < points.length; i++) {
        const a = points[i - 1]!;
        const b = points[i]!;
        cum.push(cum[i - 1]! + dist(a, b));
        headings.push(Math.atan2(b.y - a.y, b.x - a.x));
      }
      headings.push(headings[headings.length - 1]!);
      this.geom.set(rsl, {
        rsl,
        lane,
        points,
        cum,
        lengthM: cum[cum.length - 1]!,
        headings,
        speedLimitMps:
          lane.speedLimitKph && lane.speedLimitKph > 0
            ? lane.speedLimitKph / 3.6
            : DEFAULT_SPEED_LIMIT_MPS,
        widthM: lane.representativeWidthM && lane.representativeWidthM > 0
          ? lane.representativeWidthM
          : DEFAULT_LANE_WIDTH_M,
      });
    }

    for (const gate of [...index.gates].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))) {
      push(this.gatesByApproach, gate.approachLaneRsl, gate);
      push(this.gatesByConnecting, gate.connectingLaneRsl, gate);
    }
  }

  /** Every lane rsl with usable geometry, sorted. */
  laneRsls(): LaneRsl[] {
    return [...this.geom.keys()].sort();
  }

  geometry(rsl: LaneRsl): LaneGeometry | undefined {
    return this.geom.get(rsl);
  }

  requireGeometry(rsl: LaneRsl): LaneGeometry {
    const g = this.geom.get(rsl);
    if (!g) throw new Error(`lane ${rsl} is not in the topology index (or has no polyline)`);
    return g;
  }

  lengthOf(rsl: LaneRsl): number {
    return this.requireGeometry(rsl).lengthM;
  }

  /** Lane width at arc length `s`, interpolated from `widthSamples`. */
  widthAt(rsl: LaneRsl, s: number): number {
    const g = this.requireGeometry(rsl);
    const samples = g.lane.widthSamples;
    if (!samples || samples.length === 0) return g.widthM;
    if (samples.length === 1) return samples[0]!.widthM;
    const q = clamp(s, 0, g.lengthM);
    if (q <= samples[0]!.s) return samples[0]!.widthM;
    for (let i = 1; i < samples.length; i++) {
      const a = samples[i - 1]!;
      const b = samples[i]!;
      if (q <= b.s) {
        const span = b.s - a.s;
        const t = span > 1e-9 ? (q - a.s) / span : 0;
        return a.widthM + (b.widthM - a.widthM) * t;
      }
    }
    return samples[samples.length - 1]!.widthM;
  }

  /**
   * Pose at arc length `s` measured **in the traversal direction** of `d`.
   * `s` is clamped to the lane.
   */
  sampleDirected(d: DirectedLane, s: number): PathSample {
    const g = this.requireGeometry(d.rsl);
    const storageS = d.reversed ? g.lengthM - s : s;
    const sample = this.sampleStorage(g, storageS);
    return d.reversed
      ? { point: sample.point, headingRad: sample.headingRad + Math.PI }
      : sample;
  }

  /** Pose at arc length `s` in **storage** order. */
  sampleStorage(g: LaneGeometry, s: number): PathSample {
    const q = clamp(s, 0, g.lengthM);
    // Binary search, not a scan: yale-street lanes run to ~90 vertices and this
    // is the engine's hottest function (every leader lookup and every conflict
    // sample lands here), so an O(n) probe showed up directly in ticks/sec.
    let lo = 0;
    let hi = g.cum.length - 1;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (g.cum[mid]! <= q) lo = mid;
      else hi = mid;
    }
    const a = g.points[lo]!;
    const b = g.points[hi]!;
    const span = g.cum[hi]! - g.cum[lo]!;
    const t = span > 1e-9 ? (q - g.cum[lo]!) / span : 0;
    return {
      point: { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t },
      headingRad: g.headings[lo]!,
    };
  }

  /** Entry / exit endpoints of a directed lane. */
  endpoints(d: DirectedLane): { entry: Vec2; exit: Vec2 } {
    const g = this.requireGeometry(d.rsl);
    const first = g.points[0]!;
    const last = g.points[g.points.length - 1]!;
    return d.reversed ? { entry: last, exit: first } : { entry: first, exit: last };
  }

  /**
   * The orientation OpenDRIVE implies for a lane travelled legally: negative
   * lane ids run along `+s`, positive ids against it. Junction connecting lanes
   * return `null` — their storage direction is not reliable, so the caller
   * resolves them geometrically.
   */
  nominalReversed(rsl: LaneRsl): boolean | null {
    const g = this.geometry(rsl);
    if (!g) return null;
    if (g.lane.isJunction) return null;
    return g.lane.laneId > 0;
  }

  /** Orientation to use when a lane is entered from `fromPoint`. */
  orientToward(rsl: LaneRsl, fromPoint: Vec2, tol = ENDPOINT_TOL_M): DirectedLane | null {
    const g = this.geometry(rsl);
    if (!g) return null;
    const nominal = this.nominalReversed(rsl);
    const options: boolean[] = nominal === null ? [false, true] : [nominal];
    let best: { reversed: boolean; d: number } | null = null;
    for (const reversed of options) {
      const d = dist(this.endpoints({ rsl, reversed }).entry, fromPoint);
      if (d <= tol && (best === null || d < best.d)) best = { reversed, d };
    }
    return best ? { rsl, reversed: best.reversed } : null;
  }

  /**
   * Directed successors, sorted by `rsl` then orientation. A neighbour counts
   * when one of its admissible orientations starts within `ENDPOINT_TOL_M` of
   * our exit point.
   */
  successors(d: DirectedLane): DirectedLane[] {
    const key = directedKey(d);
    const cached = this.successorCache.get(key);
    if (cached) return cached;
    const g = this.geometry(d.rsl);
    if (!g) return [];
    const exit = this.endpoints(d).exit;
    const candidates = new Set<LaneRsl>();
    for (const n of g.lane.successors ?? []) candidates.add(n);
    for (const n of g.lane.predecessors ?? []) candidates.add(n);
    candidates.delete(d.rsl);
    const out: DirectedLane[] = [];
    for (const rsl of [...candidates].sort()) {
      const oriented = this.orientToward(rsl, exit);
      if (oriented) out.push(oriented);
    }
    this.successorCache.set(key, out);
    return out;
  }

  /** Gates leaving an approach lane, sorted by gate id. */
  gatesFrom(approachRsl: LaneRsl): TopologyGate[] {
    return this.gatesByApproach.get(approachRsl) ?? [];
  }

  /** Gates whose connecting lane is `rsl` (used to name a turn in progress). */
  gatesVia(connectingRsl: LaneRsl): TopologyGate[] {
    return this.gatesByConnecting.get(connectingRsl) ?? [];
  }

  /**
   * Same-direction lateral neighbour, if a lane change to `side` is possible at
   * arc length `s`. `legalOnly` consults `laneChangePermissions`.
   */
  lateralNeighbour(
    rsl: LaneRsl,
    side: 'left' | 'right',
    s: number,
    legalOnly: boolean,
  ): { rsl: LaneRsl; legal: boolean } | null {
    const g = this.geometry(rsl);
    if (!g) return null;
    const adj = g.lane.adjacentLanes?.[side];
    if (!adj || !adj.laneRsl || !adj.sameDirection) return null;
    if (!this.geometry(adj.laneRsl)) return null;
    const perms = g.lane.laneChangePermissions ?? [];
    let legal = perms.length === 0; // no data ⇒ permissive, matching the index's own default
    for (const id of adj.permissionIds ?? []) {
      const p = perms.find((q) => q.id === id);
      if (!p) continue;
      if (s >= p.startS - 1e-6 && s <= p.endS + 1e-6) legal = p.allowed;
    }
    if (legalOnly && !legal) return null;
    return { rsl: adj.laneRsl, legal };
  }

  /** Nearest point on a lane to `p`, in storage arc length. */
  projectOnto(rsl: LaneRsl, p: Vec2): { s: number; d: number } | null {
    const g = this.geometry(rsl);
    if (!g) return null;
    let best = { s: 0, d2: Infinity };
    for (let i = 1; i < g.points.length; i++) {
      const a = g.points[i - 1]!;
      const b = g.points[i]!;
      const r = pointSegment(p, a, b);
      if (r.d2 < best.d2) best = { s: g.cum[i - 1]! + r.t * (g.cum[i]! - g.cum[i - 1]!), d2: r.d2 };
    }
    return { s: best.s, d: Math.sqrt(best.d2) };
  }

  /**
   * Nearest drivable lane to a point, searched over a sorted candidate list so
   * ties break deterministically.
   */
  nearestLane(
    p: Vec2,
    opts: { laneTypes?: readonly string[]; maxDistM?: number } = {},
  ): { rsl: LaneRsl; s: number; d: number } | null {
    const types = opts.laneTypes ?? ['driving'];
    const maxD = opts.maxDistM ?? 25;
    let best: { rsl: LaneRsl; s: number; d: number } | null = null;
    for (const rsl of this.laneRsls()) {
      const g = this.geom.get(rsl)!;
      if (!types.includes(g.lane.laneType)) continue;
      const proj = this.projectOnto(rsl, p);
      if (!proj || proj.d > maxD) continue;
      if (best === null || proj.d < best.d - 1e-9) best = { rsl, s: proj.s, d: proj.d };
    }
    return best;
  }

  /** Turn relation of the gate that uses `connectingRsl`, if any. */
  turnRelationOf(connectingRsl: LaneRsl): TurnRelationName | null {
    const gates = this.gatesVia(connectingRsl);
    return gates.length > 0 ? gates[0]!.turnRelation : null;
  }

  /** The raw index, for callers that need a field the graph does not expose. */
  raw(): TopologyIndex {
    return this.index;
  }
}

function push<K, V>(m: Map<K, V[]>, k: K, v: V): void {
  const arr = m.get(k);
  if (arr) arr.push(v);
  else m.set(k, [v]);
}

/** Build a graph from a parsed topology index. */
export function buildLaneGraph(index: TopologyIndex): LaneGraph {
  return new LaneGraph(index);
}
