import type { MapTopologyIndex, TopologyLane } from './topology/types.js';

export type MapPairCorrespondence = {
  readonly lanes: Readonly<Record<string, string>>;
  readonly unresolved: Readonly<Record<string, readonly string[]>>;
};

/** Conservative, directed whole-lane matching. IDs are never geometry evidence.
 * A 2D overlap (including stacked roads) remains ambiguous, not a nearest snap.
 * Callers must independently prove coordinate/elevation and road-station compatibility.
 */
export function buildMapPairCorrespondence(source: MapTopologyIndex, target: MapTopologyIndex): MapPairCorrespondence {
  const lanes: Record<string, string> = {};
  const unresolved: Record<string, string[]> = {};
  const buckets = new Map<string, TopologyLane[]>();
  const bucket = (x: number, y: number) => `${Math.floor(x)},${Math.floor(y)}`;
  for (const lane of Object.values(target.lanes)) {
    const point = lane.polyline[0];
    if (!point) continue;
    const key = bucket(point.x, point.y);
    const list = buckets.get(key) ?? [];
    list.push(lane); buckets.set(key, list);
  }
  for (const lane of Object.values(source.lanes)) {
    const point = lane.polyline[0];
    const candidates: string[] = [];
    if (point) for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) {
      for (const other of buckets.get(bucket(point.x + dx, point.y + dy)) ?? []) {
        if (compatible(lane, other)) candidates.push(other.rsl);
      }
    }
    if (candidates.length === 1) lanes[lane.rsl] = candidates[0]!;
    else unresolved[lane.rsl] = candidates;
  }
  // Enforce injectivity and connections within the proven local subgraph.
  // Unknown neighbors do not invalidate an entire connected city; consumers
  // must prove every lane and directed edge in the scenario's dependency route.
  const reverse = new Map<string, string[]>();
  for (const [from, to] of Object.entries(lanes)) {
    const list = reverse.get(to) ?? []; list.push(from); reverse.set(to, list);
  }
  for (const [to, froms] of reverse) if (froms.length > 1) for (const from of froms) {
    unresolved[from] = [to]; delete lanes[from];
  }
  for (const [from, to] of Object.entries(lanes)) {
    const a = source.lanes[from]!, b = target.lanes[to]!;
    if (!(['predecessors', 'successors'] as const).every((key) =>
      a[key].every((id) => lanes[id] === undefined || b[key].includes(lanes[id]!)))) {
      unresolved[from] = [to]; delete lanes[from];
    }
  }
  return { lanes, unresolved };
}

function compatible(a: TopologyLane, b: TopologyLane): boolean {
  if (a.laneType !== b.laneType || a.isJunction !== b.isJunction || Math.sign(a.laneId) !== Math.sign(b.laneId)
    || a.polyline.length < 2 || b.polyline.length < 2 || a.speedLimitKph !== b.speedLimitKph
    || Math.abs((a.representativeWidthM ?? 0) - (b.representativeWidthM ?? 0)) > .1) return false;
  // Sampling counts differ across exports: compare normalized arc-length stations.
  const sample = (lane: TopologyLane) => {
    const cumulative = [0];
    for (let i = 1; i < lane.polyline.length; i++) {
      const p = lane.polyline[i - 1]!, q = lane.polyline[i]!;
      cumulative.push(cumulative[i - 1]! + Math.hypot(q.x - p.x, q.y - p.y));
    }
    return { cumulative, length: cumulative[cumulative.length - 1]! };
  };
  const aa = sample(a), bb = sample(b);
  if (aa.length === 0 || bb.length === 0 || Math.abs(aa.length - bb.length) > .1) return false;
  const at = (lane: TopologyLane, distances: number[], s: number) => {
    let i = 1; while (i < distances.length - 1 && distances[i]! < s) i++;
    const p = lane.polyline[i - 1]!, q = lane.polyline[i]!;
    const t = (s - distances[i - 1]!) / (distances[i]! - distances[i - 1]! || 1);
    return { x: p.x + t * (q.x - p.x), y: p.y + t * (q.y - p.y) };
  };
  const n = Math.max(2, Math.ceil(aa.length));
  for (let i = 0; i <= n; i++) {
    const p = at(a, aa.cumulative, aa.length * i / n), q = at(b, bb.cumulative, bb.length * i / n);
    if (Math.hypot(p.x - q.x, p.y - q.y) > .1) return false;
  }
  const ap = a.polyline[0]!, aq = a.polyline[1]!, bp = b.polyline[0]!, bq = b.polyline[1]!;
  const delta = Math.atan2(aq.y - ap.y, aq.x - ap.x) - Math.atan2(bq.y - bp.y, bq.x - bp.x);
  return Math.abs(Math.atan2(Math.sin(delta), Math.cos(delta))) < .02;
}
