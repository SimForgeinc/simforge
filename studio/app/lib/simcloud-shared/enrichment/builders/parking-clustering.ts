/**
 * Clustering and parking-lane connectivity helpers for the parking-builder.
 *
 * Extracted from parking-builder.ts to keep that file under 1,000 lines.
 */

import type { LngLat } from "./parking-geometry-helpers";

// ── Internal types (re-exported for use by parking-builder) ───────────────

export type ParkingSpace = {
  index: number;
  centroid: { lat: number; lng: number };
  polygon: LngLat[];
};

export type ParkingLane = {
  id: string;
  coordinates: LngLat[];
  center: { lat: number; lng: number };
  lengthM: number;
  /**
   * Normalized (brace-stripped) ids of this lane's predecessor and successor
   * lanes, from the RoadRunner `Predecessors`/`Successors` link arrays. Used
   * to group connected parking lanes into one street-parking location. Only
   * matched against other *parking* lanes; links to driving lanes/junctions
   * resolve to nothing and are ignored.
   */
  linkIds: string[];
};

// ── Lane ID normalization & link parsing ──────────────────────────────────

/** Strip a single wrapping `{ }` from a RoadRunner id, if present. */
export function normalizeLaneId(id: string): string {
  let s = id.trim();
  if (s.startsWith("{")) s = s.slice(1);
  if (s.endsWith("}")) s = s.slice(0, -1);
  return s;
}

/**
 * Parse a RoadRunner link property (`Predecessors` / `Successors`) into the
 * normalized (brace-stripped) ids of the linked lanes. The value is an array
 * of `{Dir, Id}` objects, which RoadRunner emits in one of two forms:
 *   • a native JSON array (the Di Rosa export, and the common case), or
 *   • a *stringified* JSON array (some re-serializing tooling).
 * Both are accepted. A malformed string is tolerated — we push a warning and
 * return no links rather than failing the whole build.
 */
export function parseLaneLinkIds(
  raw: unknown,
  laneId: string,
  field: string,
  warnings: string[],
): string[] {
  let arr: unknown = raw;
  if (typeof raw === "string") {
    const trimmed = raw.trim();
    if (trimmed === "" || trimmed === "[]") return [];
    try {
      arr = JSON.parse(trimmed);
    } catch {
      warnings.push(
        `parking-builder: malformed ${field} on lane ${laneId}, ignoring its links`,
      );
      return [];
    }
  }
  if (!Array.isArray(arr)) return [];
  const ids: string[] = [];
  for (const el of arr) {
    const linkId = (el as { Id?: unknown } | null)?.Id;
    if (typeof linkId === "string" && linkId.length > 0) {
      ids.push(normalizeLaneId(linkId));
    }
  }
  return ids;
}

// ── Parking-lane connectivity ──────────────────────────────────────────────

/** Squared planar distance (in degrees²) — fine for nearest-endpoint ranking. */
export function sqDistDeg(a: LngLat, b: LngLat): number {
  const dx = a[0] - b[0];
  const dy = a[1] - b[1];
  return dx * dx + dy * dy;
}

/**
 * Group parking lanes into connected components via their predecessor/successor
 * links. Edges are undirected (A↔B if either lists the other) and only connect
 * two *parking* lanes — a link whose target isn't a parking lane in the set
 * (driving lane, junction connector, or a dangling/stale id) resolves to
 * nothing and is dropped. Returns each component as a sorted array of lane
 * indices; components are ordered by their smallest member index so output is
 * deterministic.
 */
export function connectedLaneComponents(lanes: ParkingLane[]): number[][] {
  const n = lanes.length;
  const idToIndex = new Map<string, number>();
  for (let i = 0; i < n; i++) idToIndex.set(normalizeLaneId(lanes[i]!.id), i);

  const parent = new Int32Array(n);
  for (let i = 0; i < n; i++) parent[i] = i;
  const find = (x: number): number => {
    let r = x;
    while (parent[r] !== r) r = parent[r]!;
    while (parent[x] !== r) {
      const next = parent[x]!;
      parent[x] = r;
      x = next;
    }
    return r;
  };
  const union = (a: number, b: number) => {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent[ra] = rb;
  };

  for (let i = 0; i < n; i++) {
    for (const linkId of lanes[i]!.linkIds) {
      const j = idToIndex.get(linkId);
      if (j !== undefined && j !== i) union(i, j);
    }
  }

  const groups = new Map<number, number[]>();
  for (let i = 0; i < n; i++) {
    const root = find(i);
    let bucket = groups.get(root);
    if (!bucket) groups.set(root, (bucket = []));
    bucket.push(i);
  }
  const components = [...groups.values()].map((g) => g.sort((a, b) => a - b));
  components.sort((a, b) => a[0]! - b[0]!);
  return components;
}

/**
 * Stitch the centerlines of a connected component's lanes into one continuous
 * polyline. Membership comes from the link graph; ordering and orientation come
 * from geometry — greedy endpoint-chaining attaches, at each step, the
 * remaining lane whose nearest endpoint is closest to either free end of the
 * growing chain, reversing that lane's points if needed to connect head-to-tail
 * (the duplicated joint vertex is dropped). The `Dir` flag in the links is not
 * relied on because its orientation semantics are ambiguous and endpoint
 * matching is robust. For the common straight chain this reproduces the curb
 * polyline; for a rare branch component it still yields one reasonable strip.
 */
export function stitchLaneCenterlines(members: ParkingLane[]): LngLat[] {
  if (members.length === 1) return members[0]!.coordinates;

  const remaining = members.slice();
  let chain: LngLat[] = [...remaining.shift()!.coordinates];

  while (remaining.length > 0) {
    const tail = chain[chain.length - 1]!;
    const head = chain[0]!;
    let best = { idx: -1, dist: Infinity, atTail: true, reverse: false };
    for (let k = 0; k < remaining.length; k++) {
      const coords = remaining[k]!.coordinates;
      const first = coords[0]!;
      const last = coords[coords.length - 1]!;
      // Four ways to attach lane k: to the chain's tail or head, with the lane
      // forward or reversed so its joining endpoint meets that free end.
      const candidates: { dist: number; atTail: boolean; reverse: boolean }[] = [
        { dist: sqDistDeg(tail, first), atTail: true, reverse: false },
        { dist: sqDistDeg(tail, last), atTail: true, reverse: true },
        { dist: sqDistDeg(head, last), atTail: false, reverse: false },
        { dist: sqDistDeg(head, first), atTail: false, reverse: true },
      ];
      for (const c of candidates) {
        if (c.dist < best.dist) best = { idx: k, ...c };
      }
    }
    const [lane] = remaining.splice(best.idx, 1);
    const coords = best.reverse
      ? [...lane!.coordinates].reverse()
      : lane!.coordinates;
    chain = best.atTail
      ? [...chain, ...coords.slice(1)]
      : [...coords.slice(0, -1), ...chain];
  }
  return chain;
}

// ── Space-to-lane perpendicular test ──────────────────────────────────────

/** How far (meters) a stall's projection may fall past a parking lane's first or
 * last vertex and still count as "alongside" the lane. */
const LANE_END_OVERHANG_M = 3;

/**
 * Perpendicular distance (meters) from a point to a parking-lane polyline,
 * plus whether the point's projection lands within the lane's span (so a stall
 * past the lane's end is rejected rather than snapped to the endpoint). Used to
 * decide which ParkingSpaces sit *on* a given parking lane.
 */
export function spacePerpToLane(
  pt: LngLat,
  coords: LngLat[],
  mPerDegLat: number,
  mPerDegLng: number,
): { distM: number; alongside: boolean } {
  let best = Infinity;
  let alongside = false;
  for (let j = 1; j < coords.length; j++) {
    const a = coords[j - 1]!;
    const b = coords[j]!;
    const ax = (pt[0] - a[0]) * mPerDegLng;
    const ay = (pt[1] - a[1]) * mPerDegLat;
    const bx = (b[0] - a[0]) * mPerDegLng;
    const by = (b[1] - a[1]) * mPerDegLat;
    const len2 = bx * bx + by * by;
    if (len2 < 1e-9) continue;
    const tRaw = (ax * bx + ay * by) / len2;
    const t = Math.max(0, Math.min(1, tRaw));
    const d = Math.hypot(ax - bx * t, ay - by * t);
    if (d < best) {
      best = d;
      // Overhang past this segment's nearest end, in meters (0 when the
      // projection lands within the segment). Absolute, so the allowance
      // doesn't scale with segment length.
      const overhangM = Math.abs(tRaw - t) * Math.sqrt(len2);
      alongside = overhangM <= LANE_END_OVERHANG_M;
    }
  }
  return { distM: best, alongside };
}

// ── Single-linkage centroid clustering ────────────────────────────────────

/**
 * Single-linkage centroid clustering via a grid hash + union-find.
 *
 * Two spaces are merged iff their centroids are within `thresholdDeg`. The
 * grid cell size equals the threshold, so every qualifying pair must lie in
 * the same cell or one of the 8 neighbors — that's the only region we scan.
 * Complexity is near-linear in N for realistic point densities (was O(N^3)
 * for the older quadratic pair-scan + splice approach, which crossed two
 * minutes on 5k inputs).
 */
export function clusterParkingSpaces(
  spaces: ParkingSpace[],
  thresholdDeg: number,
): ParkingSpace[][] {
  const n = spaces.length;
  if (n === 0) return [];

  const t2 = thresholdDeg * thresholdDeg;
  const cell = thresholdDeg;
  const grid = new Map<string, number[]>();
  const cellIndex = (s: ParkingSpace) =>
    `${Math.floor(s.centroid.lng / cell)},${Math.floor(s.centroid.lat / cell)}`;

  for (let i = 0; i < n; i++) {
    const key = cellIndex(spaces[i]!);
    let bucket = grid.get(key);
    if (!bucket) grid.set(key, (bucket = []));
    bucket.push(i);
  }

  const parent = new Int32Array(n);
  for (let i = 0; i < n; i++) parent[i] = i;
  const find = (x: number): number => {
    let r = x;
    while (parent[r] !== r) r = parent[r]!;
    while (parent[x] !== r) {
      const next = parent[x]!;
      parent[x] = r;
      x = next;
    }
    return r;
  };
  const union = (a: number, b: number) => {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent[ra] = rb;
  };

  for (let i = 0; i < n; i++) {
    const si = spaces[i]!;
    const ix = Math.floor(si.centroid.lng / cell);
    const iy = Math.floor(si.centroid.lat / cell);
    for (let dx = -1; dx <= 1; dx++) {
      for (let dy = -1; dy <= 1; dy++) {
        const bucket = grid.get(`${ix + dx},${iy + dy}`);
        if (!bucket) continue;
        for (const j of bucket) {
          if (j <= i) continue;
          const sj = spaces[j]!;
          const dlat = si.centroid.lat - sj.centroid.lat;
          const dlng = si.centroid.lng - sj.centroid.lng;
          if (dlat * dlat + dlng * dlng < t2) union(i, j);
        }
      }
    }
  }

  const byRoot = new Map<number, ParkingSpace[]>();
  for (let i = 0; i < n; i++) {
    const root = find(i);
    let group = byRoot.get(root);
    if (!group) byRoot.set(root, (group = []));
    group.push(spaces[i]!);
  }
  return Array.from(byRoot.values());
}
