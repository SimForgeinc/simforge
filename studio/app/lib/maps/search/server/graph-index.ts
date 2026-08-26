import "server-only";

import type {
  MapSearchIndex,
  MapSearchIndexGraphEdge,
  MapSearchIndexGraphRelation,
  MapSearchIndexObject,
} from "@simforge-oss/studio-shared";

/**
 * In-memory topology graph over the `search_index.json` canonical objects.
 *
 * Built once per corpus-cache entry alongside the spatial index. Backs the
 * Phase C relation operators (`leads_to`, `connected_to`, `upstream_of`,
 * `downstream_of`) with bounded Dijkstra traversal — every walk is capped by
 * an explicit `maxDistanceM` so a misparsed query can never fan out across
 * the whole map.
 *
 * Edge weights, in meters:
 *   - Edges with `distance_m` set (POI → anchor) use that value.
 *   - `approaches` edges between a junction and a street use half the
 *     street's `length_m` so a full traverse junction → street → junction
 *     accumulates the true street length.
 *   - Missing data falls back to 0 (free hop) so a graph with unknown
 *     lengths still connects, at the cost of distance fidelity.
 *
 * For the MVP every edge is undirected (`direction: "both"`). The API
 * exposes directional variants so callers can opt-in once the builder
 * produces edge direction for future lane-aware flow data.
 */

export interface GraphNeighbor {
  id: string;
  weightM: number;
  relation: MapSearchIndexGraphRelation;
  /**
   * Traversal direction of the outgoing edge as the BFS saw it.
   * `forward`  — followed the edge in its stored `from → to` orientation.
   * `reverse`  — walked against the stored orientation.
   * `both`     — edge was stored as `direction: "both"`.
   */
  edgeDirection: "forward" | "reverse" | "both";
}

export type TraversalDirection = "any" | "forward" | "reverse";

/**
 * Result of a path-tracking BFS.
 *   - `distances` matches `bfs()`'s return: reachable-id → cumulative weight.
 *   - `prev` maps each reachable-id (except `start`) to its predecessor on the
 *     shortest path; reconstruct a route by walking `prev` backwards from a
 *     target until you hit `start`.
 */
export interface GraphBfsResult {
  distances: Map<string, number>;
  prev: Map<string, string>;
}

export interface GraphIndex {
  readonly size: number;
  /** List of all object ids known to the graph (includes isolated nodes). */
  readonly ids: readonly string[];
  /**
   * Outgoing neighbors of `objectId`, respecting `direction`:
   *   - `any`      — follow edges both ways (undirected).
   *   - `forward`  — stored from→to plus any `both`.
   *   - `reverse`  — stored to→from plus any `both`.
   */
  neighbors(
    objectId: string,
    direction?: TraversalDirection,
  ): ReadonlyArray<GraphNeighbor>;
  /**
   * Bounded Dijkstra from `start`. Returns a map of reachable-object-id to
   * minimum accumulated edge weight. `start` is always included at distance
   * 0. Stops expanding any path whose accumulated weight would exceed
   * `maxDistanceM`.
   */
  bfs(
    start: string,
    maxDistanceM: number,
    direction?: TraversalDirection,
  ): Map<string, number>;
  /**
   * Same traversal as `bfs`, but also exposes a predecessor map so callers
   * can reconstruct the actual route to a reachable node. Used by topology
   * relations (`leads_to`, etc.) to attach the path of intermediate hops.
   */
  bfsWithPaths(
    start: string,
    maxDistanceM: number,
    direction?: TraversalDirection,
  ): GraphBfsResult;
  /**
   * Min accumulated weight from `a` to `b`, or `Number.POSITIVE_INFINITY`
   * when they are not reachable within `maxDistanceM`.
   */
  pairDistance(
    a: string,
    b: string,
    maxDistanceM: number,
    direction?: TraversalDirection,
  ): number;
}

function edgeWeight(
  edge: MapSearchIndexGraphEdge,
  objects: Record<string, MapSearchIndexObject>,
): number {
  if (typeof edge.distance_m === "number" && edge.distance_m >= 0) {
    return edge.distance_m;
  }
  if (typeof edge.length_m === "number" && edge.length_m >= 0) {
    return edge.length_m;
  }
  if (edge.relation === "approaches") {
    // `length_m` on street / street_segment objects is the centerline
    // length in meters — the XODR-sourced builder path writes `entity.lengthM`
    // directly, and the GeoJSON-only fallback divides summed lane length by
    // lane count before storing. Half of that keeps the "junction → street
    // → junction hop equals the full centerline length" convention.
    const candidateIds = [edge.from, edge.to];
    for (const id of candidateIds) {
      const obj = objects[id];
      if (!obj) continue;
      if (obj.kind !== "street" && obj.kind !== "street_segment") continue;
      const facts = obj.facts as { length_m?: unknown } | undefined;
      const raw = facts?.length_m;
      if (typeof raw !== "number" || !Number.isFinite(raw) || raw <= 0) continue;
      return raw / 2;
    }
  }
  return 0;
}

interface AdjacencyRecord {
  id: string;
  weightM: number;
  relation: MapSearchIndexGraphRelation;
  edgeDirection: "forward" | "reverse" | "both";
}

/**
 * Build a traversal graph from the sidecar.
 *
 * Always returns a valid GraphIndex — missing or malformed edges are skipped.
 * A sidecar with no edges yields an empty graph whose BFS returns only the
 * starting node.
 */
export function buildGraphIndex(sidecar: MapSearchIndex): GraphIndex {
  const objects = sidecar.objects;
  const forward = new Map<string, AdjacencyRecord[]>();
  const reverse = new Map<string, AdjacencyRecord[]>();

  const pushUnique = (
    map: Map<string, AdjacencyRecord[]>,
    key: string,
    rec: AdjacencyRecord,
  ): void => {
    const list = map.get(key);
    if (!list) {
      map.set(key, [rec]);
      return;
    }
    if (list.some((r) => r.id === rec.id && r.relation === rec.relation)) {
      return;
    }
    list.push(rec);
  };

  for (const edge of sidecar.graph.edges ?? []) {
    if (!edge.from || !edge.to || edge.from === edge.to) continue;
    if (!(edge.from in objects) || !(edge.to in objects)) continue;
    const weight = edgeWeight(edge, objects);
    const dir = edge.direction ?? "both";

    // Traversal semantics:
    //   `out` edge J→S : J can reach S forward;  S can reach J reverse.
    //   `in`  edge J→S : S can reach J forward;  J can reach S reverse.
    //                    (stored orientation is J→S but flow is S→J.)
    //   `both` edge    : all four directions are valid — a two-way road.
    //
    // The forward map answers "where can I go downstream from node X?" and
    // the reverse map answers "where can I come from upstream of X?". For
    // `both` edges we seed both ends into both maps so the undirected MVP
    // works without the caller caring about stored orientation.
    if (dir === "out") {
      pushUnique(forward, edge.from, {
        id: edge.to,
        weightM: weight,
        relation: edge.relation,
        edgeDirection: "forward",
      });
      pushUnique(reverse, edge.to, {
        id: edge.from,
        weightM: weight,
        relation: edge.relation,
        edgeDirection: "reverse",
      });
    } else if (dir === "in") {
      pushUnique(forward, edge.to, {
        id: edge.from,
        weightM: weight,
        relation: edge.relation,
        edgeDirection: "forward",
      });
      pushUnique(reverse, edge.from, {
        id: edge.to,
        weightM: weight,
        relation: edge.relation,
        edgeDirection: "reverse",
      });
    } else {
      // `both` — undirected. Both endpoints can reach each other in either
      // mode. Tag the stored edgeDirection as `both` so callers that care
      // about flow direction can tell bidirectional edges apart.
      pushUnique(forward, edge.from, {
        id: edge.to,
        weightM: weight,
        relation: edge.relation,
        edgeDirection: "both",
      });
      pushUnique(forward, edge.to, {
        id: edge.from,
        weightM: weight,
        relation: edge.relation,
        edgeDirection: "both",
      });
      pushUnique(reverse, edge.from, {
        id: edge.to,
        weightM: weight,
        relation: edge.relation,
        edgeDirection: "both",
      });
      pushUnique(reverse, edge.to, {
        id: edge.from,
        weightM: weight,
        relation: edge.relation,
        edgeDirection: "both",
      });
    }
  }

  function neighborsFor(
    id: string,
    direction: TraversalDirection,
  ): AdjacencyRecord[] {
    if (direction === "forward") return forward.get(id) ?? [];
    if (direction === "reverse") return reverse.get(id) ?? [];
    // any — union of forward + reverse, deduping on (id, relation).
    const out: AdjacencyRecord[] = [];
    const seen = new Set<string>();
    for (const list of [forward.get(id), reverse.get(id)]) {
      for (const rec of list ?? []) {
        const key = `${rec.id}::${rec.relation}`;
        if (seen.has(key)) continue;
        seen.add(key);
        out.push(rec);
      }
    }
    return out;
  }

  // Plain Dijkstra with a linear-scan extract-min. Graphs are small
  // (< ~2000 objects) so the O(V²) scan is cheap and keeps the code
  // compact — no heap dependency needed. Tracks predecessors so callers
  // that want the actual path (not just the distance) get it without a
  // second traversal.
  function runBfs(
    start: string,
    maxDistanceM: number,
    direction: TraversalDirection,
  ): GraphBfsResult {
    const dist = new Map<string, number>();
    const prev = new Map<string, string>();
    if (!(start in objects)) return { distances: dist, prev };
    dist.set(start, 0);
    const visited = new Set<string>();

    while (true) {
      let u: string | undefined;
      let bestD = Number.POSITIVE_INFINITY;
      for (const [id, d] of dist) {
        if (!visited.has(id) && d < bestD) {
          bestD = d;
          u = id;
        }
      }
      if (u === undefined) break;
      if (bestD > maxDistanceM) break;
      visited.add(u);
      for (const e of neighborsFor(u, direction)) {
        const nd = bestD + e.weightM;
        if (nd > maxDistanceM) continue;
        const cur = dist.get(e.id);
        if (cur === undefined || nd < cur) {
          dist.set(e.id, nd);
          prev.set(e.id, u);
        }
      }
    }
    return { distances: dist, prev };
  }

  return {
    size: Object.keys(objects).length,
    ids: Object.keys(objects),
    neighbors(id, direction = "any") {
      return neighborsFor(id, direction);
    },
    bfs(start, maxDistanceM, direction = "any") {
      return runBfs(start, maxDistanceM, direction).distances;
    },
    bfsWithPaths(start, maxDistanceM, direction = "any") {
      return runBfs(start, maxDistanceM, direction);
    },
    pairDistance(a, b, maxDistanceM, direction = "any") {
      if (a === b) return 0;
      const reachable = runBfs(a, maxDistanceM, direction).distances;
      return reachable.get(b) ?? Number.POSITIVE_INFINITY;
    },
  };
}
