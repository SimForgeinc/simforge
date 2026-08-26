import type { ScenarioEditorRoadAnchor } from "@simforge-oss/studio-shared";
import type { RuntimeRoadSegment } from "@/app/lib/runtime/runtime-types";
import { isRoutableSegment, rslFromWaypointRef, segmentRsl } from "./graph";
import {
  centerlineArcLengthMeters,
  centerlinePointAtFraction,
  centerlineYawAtFraction,
  forwardIsIncreasingS,
  headingDeltaDegrees,
} from "./routing-geometry";

// ---------------------------------------------------------------------------
// Successor resolution: the adjacency guard, the geometry-reconstructed
// forward-successor recovery (Munich missing-connector repair), and the
// emitted-corridor measurement built on them. Split from routing.ts (wave-2a);
// routing.ts re-exports this module, so external `./routing` importers are
// unchanged.
// ---------------------------------------------------------------------------

/**
 * Reject a bundle "successor" whose geometry is NOT physically contiguous with
 * the current segment's travel-end. Munich's map bundle links some successors
 * that sit 80-110 m away (a lane-connectivity defect — the OpenDRIVE successor
 * record disagrees with the connecting-lane geometry). Chaining one teleports the
 * route to a point behind the subject, and the pure-pursuit follower U-turns into
 * oncoming traffic to chase the far waypoint (dib 2026-07-16, munich highway_entry
 * -026: route jumped road55→road265 80 m backward → 214° U-turn). A real lane
 * connection shares a boundary, so the successor's travel-START must lie within a
 * few metres of the current segment's travel-END. Map-agnostic: well-connected
 * maps (US) always pass, so their long routes are unchanged; on Munich a defective
 * junction just ENDS the route there (a shorter but CONTINUOUS route the subject can
 * actually drive — far better than a U-turn). We also accept when next's OTHER end
 * is the near one, so a yaw-less segment whose direction we mis-assess still counts
 * as adjacent — the guard is about spatial contiguity, not orientation.
 */
const ROUTE_SUCCESSOR_ADJ_METERS = 12;
export function routeSuccessorIsAdjacent(
  segments: ReadonlyMap<string, RuntimeRoadSegment>,
  current: RuntimeRoadSegment,
  next: RuntimeRoadSegment,
): boolean {
  // A valid forward continuation: the successor's yaw-ENTRY must abut the current
  // segment's yaw-EXIT (both taken in each lane's own travel direction). This is
  // STRICT on purpose — accepting a successor that merely touches at some other end
  // pairing chains it backward and the subject U-turns (dib 2026-07-16: the lenient
  // any-end match produced MORE reversals, not fewer). Munich's defective
  // successors sit 80-110 m from the exit, so they're rejected and the route simply
  // ENDS there — a shorter but continuous, correctly-directed route.
  const curFwd = forwardIsIncreasingS(segments, current);
  const nextFwd = forwardIsIncreasingS(segments, next);
  const exit = centerlinePointAtFraction(current, curFwd ? 1 : 0);
  const entry = centerlinePointAtFraction(next, nextFwd ? 0 : 1);
  if (!exit || !entry) return true; // no geometry to judge — don't over-reject
  return Math.hypot(exit.x - entry.x, exit.y - entry.y) <= ROUTE_SUCCESSOR_ADJ_METERS;
}

/**
 * Max PERPENDICULAR offset (metres) a geometry-reconstructed successor's
 * travel-entry may sit from the ray extending the current lane's travel-exit
 * heading. This is the "ahead, not beside" discriminator that separates a real
 * forward continuation (its centerline extends the current lane — near-zero
 * lateral offset) from a same-direction SIBLING lane a lane-change would reach
 * (offset ≈ one lane width). It is deliberately smaller than a lane width
 * (~3-3.5 m on these maps) so a parallel neighbour is rejected while the slop of
 * a genuine end-to-start join is tolerated. It only gates the GEOMETRY search
 * (whole-segment-set); DECLARED successors keep the looser 12 m
 * routeSuccessorIsAdjacent gate unchanged, because that set is already the
 * bundle's own forward edges (never siblings). Without it, multi-lane roads (US)
 * would spuriously gain their parallel lanes as "successors" — the exact
 * regression the guardrails forbid (a lane's exit is within 12 m of the next
 * road's every same-direction lane entry, only ~4-8 m apart).
 */
const FORWARD_SUCCESSOR_LATERAL_METERS = 2.5;

/**
 * Max heading difference (degrees) between the current lane's travel direction
 * at its exit and a geometry-reconstructed successor's travel direction at its
 * entry. A forward continuation flows the SAME way (gentle bends and junction
 * connectors start tangent to the approach); an ONCOMING lane whose geometry
 * happens to abut the exit (undivided-road opposite lane, U-turn stub) points
 * ~180° away and must be rejected — the runtime's Waypoint.next() never returns
 * it. Only gates the GEOMETRY search; declared successors are trusted as-is.
 */
const FORWARD_SUCCESSOR_HEADING_DELTA_DEG = 60;

/**
 * Spatial hash of every routable segment's TRAVEL-ENTRY point, so
 * geometryForwardSuccessors can find the lanes whose entry abuts a given
 * segment's travel-exit in O(1) rather than scanning all N segments (naive is
 * O(N) per lane → O(N²) per placement pass). Cells are
 * ROUTE_SUCCESSOR_ADJ_METERS wide, so a candidate can only abut within that
 * radius if its entry falls in one of the 9 cells around the exit's cell.
 */
type ForwardSuccessorIndex = {
  cells: Map<string, RuntimeRoadSegment[]>;
};

// Built once per map and memoised on the segments-map identity (the generator
// keeps one stable Map<rsl, segment> per map for the whole placement pass —
// index.ts segmentsByMap), so no call site needs a new parameter.
const forwardSuccessorIndexCache = new WeakMap<
  ReadonlyMap<string, RuntimeRoadSegment>,
  ForwardSuccessorIndex
>();

function forwardSuccessorCellKey(x: number, y: number): string {
  return `${Math.floor(x / ROUTE_SUCCESSOR_ADJ_METERS)},${Math.floor(
    y / ROUTE_SUCCESSOR_ADJ_METERS,
  )}`;
}

function buildForwardSuccessorIndex(
  segments: ReadonlyMap<string, RuntimeRoadSegment>,
): ForwardSuccessorIndex {
  const cells = new Map<string, RuntimeRoadSegment[]>();
  for (const seg of segments.values()) {
    // Only lanes a route-follower could continue onto are candidate successors
    // (Driving/Bidirectional, junction connectors INCLUDED). Sidewalk/parking/
    // shoulder lanes are never a forward continuation.
    if (!isRoutableSegment(seg)) continue;
    const fwd = forwardIsIncreasingS(segments, seg);
    const entry = centerlinePointAtFraction(seg, fwd ? 0 : 1);
    if (!entry || !Number.isFinite(entry.x) || !Number.isFinite(entry.y)) continue;
    const key = forwardSuccessorCellKey(entry.x, entry.y);
    const bucket = cells.get(key);
    if (bucket) bucket.push(seg);
    else cells.set(key, [seg]);
  }
  return { cells };
}

function forwardSuccessorIndexFor(
  segments: ReadonlyMap<string, RuntimeRoadSegment>,
): ForwardSuccessorIndex {
  const cached = forwardSuccessorIndexCache.get(segments);
  if (cached) return cached;
  const built = buildForwardSuccessorIndex(segments);
  forwardSuccessorIndexCache.set(segments, built);
  return built;
}

/**
 * Forward successors reconstructed from GEOMETRY the way the runtime's
 * GlobalRoutePlanner does (Waypoint.next()), instead of trusting the bundle's
 * `successors` array. Munich_Phase_1A's bundle frequently OMITS a lane's true
 * forward connector (the successor record points to a sibling lane or is
 * absent), so lanes read as dead ends, survival-runway comes up short, and ~83%
 * of placeable scenes funnelled onto the few roads (like road 77) whose
 * `successors` happen to be complete. This finds every routable segment whose
 * TRAVEL-ENTRY abuts `current`'s TRAVEL-EXIT within ROUTE_SUCCESSOR_ADJ_METERS
 * — the SAME 12 m gate routeSuccessorIsAdjacent applies to declared successors,
 * searched over the whole segment set — AND that lies AHEAD of the exit rather
 * than beside it (FORWARD_SUCCESSOR_LATERAL_METERS), so a parallel sibling lane
 * (a lane-change target, not a continuation) is excluded.
 *
 * Map-agnostic and purely additive: on well-connected maps (US) every real
 * forward edge is ALREADY a declared, geometrically-adjacent, straight-ahead
 * successor, so this set is a SUBSET of the declared-adjacent set and the union
 * (forwardSuccessorSegments) is unchanged. It only ADDS the near, ahead edges
 * the bundle dropped; the far (80-110 m) defective successors stay rejected by
 * the 12 m threshold and lateral siblings by the lateral threshold.
 */
export function geometryForwardSuccessors(
  segments: ReadonlyMap<string, RuntimeRoadSegment>,
  current: RuntimeRoadSegment,
  index?: ForwardSuccessorIndex,
): RuntimeRoadSegment[] {
  const idx = index ?? forwardSuccessorIndexFor(segments);
  const curFwd = forwardIsIncreasingS(segments, current);
  const exit = centerlinePointAtFraction(current, curFwd ? 1 : 0);
  if (!exit || !Number.isFinite(exit.x) || !Number.isFinite(exit.y)) return [];
  const exitHeadingDeg = centerlineYawAtFraction(current, curFwd ? 1 : 0);
  const headingRad = (exitHeadingDeg * Math.PI) / 180;
  // Unit vector along the exit travel heading (u) and its perpendicular (perp).
  // For a candidate entry offset v from the exit: v·u is the AHEAD/behind
  // (longitudinal) distance and |v·perp| is the sideways (lateral) offset.
  const ux = Math.cos(headingRad);
  const uy = Math.sin(headingRad);
  const perpX = -Math.sin(headingRad);
  const perpY = Math.cos(headingRad);
  const hasHeading = Number.isFinite(exitHeadingDeg);
  const currentRsl = segmentRsl(current);
  const predecessorRsls = new Set(
    (current.predecessors ?? [])
      .map((ref) => rslFromWaypointRef(ref))
      .filter((rsl): rsl is string => Boolean(rsl)),
  );
  const cx = Math.floor(exit.x / ROUTE_SUCCESSOR_ADJ_METERS);
  const cy = Math.floor(exit.y / ROUTE_SUCCESSOR_ADJ_METERS);
  const out: RuntimeRoadSegment[] = [];
  const seen = new Set<string>();
  for (let dx = -1; dx <= 1; dx += 1) {
    for (let dy = -1; dy <= 1; dy += 1) {
      const bucket = idx.cells.get(`${cx + dx},${cy + dy}`);
      if (!bucket) continue;
      for (const cand of bucket) {
        const candRsl = segmentRsl(cand);
        // Never continue onto ourselves, a lane that FEEDS us (a declared
        // predecessor whose geometry happens to abut = a backward/U-turn edge),
        // or a duplicate.
        if (candRsl === currentRsl || predecessorRsls.has(candRsl) || seen.has(candRsl)) {
          continue;
        }
        // Reuse the exact adjacency contract (does NOT weaken the 12 m gate).
        if (!routeSuccessorIsAdjacent(segments, current, cand)) continue;
        // A real forward continuation is AHEAD, aligned, and travels the same
        // way — three refinements on top of the 12 m gate so the whole-map
        // search can't mistake a NON-successor for one (the reason the declared
        // set is trusted with the 12 m gate alone: it never contains these):
        //   - lateral: reject a same-direction SIBLING lane (a lane-change
        //     target ≈ one lane-width to the side);
        //   - longitudinal: reject a lane that abuts but sits BEHIND the exit
        //     (an overlapping/opposing stub the subject would have to back onto);
        //   - heading: reject an ONCOMING lane pointing ~180° away.
        if (hasHeading) {
          const candFwd = forwardIsIncreasingS(segments, cand);
          const entry = centerlinePointAtFraction(cand, candFwd ? 0 : 1);
          if (!entry) continue;
          const vx = entry.x - exit.x;
          const vy = entry.y - exit.y;
          if (Math.abs(vx * perpX + vy * perpY) > FORWARD_SUCCESSOR_LATERAL_METERS) continue;
          if (vx * ux + vy * uy < -FORWARD_SUCCESSOR_LATERAL_METERS) continue;
          const candHeadingDeg = centerlineYawAtFraction(cand, candFwd ? 0 : 1);
          if (
            headingDeltaDegrees(exitHeadingDeg, candHeadingDeg) >
            FORWARD_SUCCESSOR_HEADING_DELTA_DEG
          ) {
            continue;
          }
        }
        seen.add(candRsl);
        out.push(cand);
      }
    }
  }
  return out;
}

/**
 * The set of segments a route-following subject could actually continue onto from
 * `current`: the UNION (deduped by rsl key) of the DECLARED forward path
 * (`current.successors` that resolve to a segment and pass
 * routeSuccessorIsAdjacent) and the GEOMETRY-reconstructed forward successors
 * (geometryForwardSuccessors). This is the single source of forward candidates
 * for every runway / junction walk, so Munich lanes whose true connector the
 * bundle dropped are no longer read as dead ends, while well-connected maps see
 * the identical declared set (geometry ⊆ declared-adjacent there).
 *
 * Downstream drivability / routability filters (isRoutableSegment,
 * isDrivableSegment), visited / loop guards, and heading-delta selection stay in
 * the CALLERS — this only broadens the candidate SOURCE from declared-only to
 * the union. Declared successors are NOT filtered by drivability here (the
 * least-restrictive consumer, survivalRunwayMeters, counts any adjacent
 * successor as runway); each caller keeps its own filter.
 */
export function forwardSuccessorSegments(
  segments: ReadonlyMap<string, RuntimeRoadSegment>,
  current: RuntimeRoadSegment,
  index?: ForwardSuccessorIndex,
): RuntimeRoadSegment[] {
  const currentRsl = segmentRsl(current);
  const byRsl = new Map<string, RuntimeRoadSegment>();
  for (const ref of current.successors ?? []) {
    const rsl = rslFromWaypointRef(ref);
    if (!rsl || rsl === currentRsl || byRsl.has(rsl)) continue;
    const seg = segments.get(rsl);
    if (!seg || !routeSuccessorIsAdjacent(segments, current, seg)) continue;
    byRsl.set(rsl, seg);
  }
  for (const seg of geometryForwardSuccessors(segments, current, index)) {
    const rsl = segmentRsl(seg);
    if (!byRsl.has(rsl)) byRsl.set(rsl, seg);
  }
  return [...byRsl.values()];
}

/**
 * Measure an EMITTED subject route (the anchors the worker's route-follower will
 * chase): the physically CONTIGUOUS centerline meters it delivers from the
 * spawn point, and whether that corridor terminates at a physical DEAD END
 * (no adjacent routable successor past the terminal segment — the mesh ends
 * there, so an overrun leaves the subject in the void).
 *
 * Two properties matter for the dead-end overrun guard (2026-07-17 — ~100 of
 * 175 render failures were egos driving off the physical end of successor-less
 * roads, actor_below_road_surface):
 *  - The corridor is TRUNCATED at the first NON-ADJACENT segment transition.
 *    A defective bundle chain (e.g. SR-P1 highway_entry road 220 → 1067, a
 *    45 m teleport) measures as its short drivable prefix ending at a dead
 *    end — the subject runs out of mesh chasing the far waypoint — instead of a
 *    long-but-undrivable polyline.
 *  - Length is the segment centerline ARC length (spawn segment: the remainder
 *    from the spawn fraction to its travel end), not anchor chord distance, so
 *    curved corridors are not under-measured.
 */
export function measureEmittedRouteCorridor(
  segments: ReadonlyMap<string, RuntimeRoadSegment>,
  spawnSegment: RuntimeRoadSegment,
  spawnFraction: number,
  route: ReadonlyArray<ScenarioEditorRoadAnchor>,
): { meters: number; endsAtDeadEnd: boolean } {
  const fwd = forwardIsIncreasingS(segments, spawnSegment);
  let meters =
    centerlineArcLengthMeters(spawnSegment) *
    Math.max(0, Math.min(1, fwd ? 1 - spawnFraction : spawnFraction));
  let current = spawnSegment;
  for (const anchor of route) {
    const anchorRsl = `${anchor.road_id}:${anchor.section_id}:${anchor.lane_id}`;
    if (anchorRsl === segmentRsl(current)) continue;
    const next = segments.get(anchorRsl);
    if (!next) continue;
    if (!routeSuccessorIsAdjacent(segments, current, next)) {
      // Discontiguous transition: the drivable corridor ends HERE, at the
      // current segment's physical end — and that end is a dead end from the
      // follower's perspective (it will chase the far waypoint off the mesh).
      return { meters, endsAtDeadEnd: true };
    }
    meters += centerlineArcLengthMeters(next);
    current = next;
  }
  // Terminal continuation from the SAME union the runway walks use
  // (forwardSuccessorSegments = declared-adjacent ∪ geometry-reconstructed).
  // Declared-only here re-created the exact Munich failure this measurement
  // exists to guard: a lane whose bundle omits its true connector — but whose
  // geometryForwardSuccessors finds the physical continuation — read as
  // endsAtDeadEnd, and assessEgoRouteOverrun rejected the placement whenever
  // the emitted corridor came up shorter than the demand (PR #445 review).
  const hasContinuation = forwardSuccessorSegments(segments, current).some((next) =>
    isRoutableSegment(next),
  );
  return { meters, endsAtDeadEnd: !hasContinuation };
}
