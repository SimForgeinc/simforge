import type { ScenarioEditorRoadAnchor } from "@simforge-oss/studio-shared";
import type { RuntimeRoadSegment } from "@/app/lib/runtime/runtime-types";
import type { ForbiddenFractionZones } from "./types";
import {
  isDrivableSegment,
  isRoutableSegment,
  rslFromWaypointRef,
  segmentLengthMeters,
  segmentRsl,
} from "./graph";
import {
  centerlineArcLengthMeters,
  centerlineYawAtFraction,
  forwardIsIncreasingS,
  headingDeltaDegrees,
  withWorldAnchor,
} from "./routing-geometry";
import { forwardSuccessorSegments, routeSuccessorIsAdjacent } from "./routing-successors";

// Lane-geometry sampling, travel-direction resolution, the successor adjacency
// guard, and the geometry-successor recovery live in the split modules below;
// re-exported here so every existing `./routing` importer keeps working.
export * from "./routing-geometry";
export * from "./routing-successors";

// ---------------------------------------------------------------------------
// Deterministic RNG + numeric helpers.
// ---------------------------------------------------------------------------

export function hashSeed(parts: Array<number | string>): number {
  let hash = 2166136261;
  for (const part of parts.join(":")) {
    hash ^= part.charCodeAt(0);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

export function seededRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(1664525, state) + 1013904223) >>> 0;
    return state / 0x100000000;
  };
}

export function roundTo(value: number, places: number): number {
  const scale = 10 ** places;
  return Math.round(value * scale) / scale;
}

export function randomInRange(random: () => number, min: number, max: number): number {
  return min + (max - min) * random();
}

/** True if a lane's speed limit falls in [min,max] (km/h). Unknown speed limit
 * (undefined) is kept — the filter only excludes lanes it can positively place
 * outside the band. */
export function speedLimitInBand(
  speedLimitKph: number | undefined,
  minKph: number | undefined,
  maxKph: number | undefined,
): boolean {
  if (speedLimitKph == null || !Number.isFinite(speedLimitKph)) return true;
  if (minKph != null && speedLimitKph < minKph) return false;
  if (maxKph != null && speedLimitKph > maxKph) return false;
  return true;
}

// ---------------------------------------------------------------------------
// Survival runway + upstream walks.
// ---------------------------------------------------------------------------

/**
 * Meters of GUARANTEED survivable continuation from `startFraction` along
 * the lane. Generated maps end roads at tile boundaries: a vehicle reaching
 * a dead end drives off the mesh and is destroyed, so the guarantee is the
 * worst-case distance to a dead end. Junction-internal lanes COUNT as
 * continuation (these suburban grids put a junction every ~30-100m —
 * junction-free windows don't exist), and at forks the MINIMUM across
 * branches is taken since an unsupervised TM-driven vehicle may take any of
 * them. Behavioral correctness at junctions (e.g. a lane_keep subject turning)
 * is the 2D behavior gate's job, not the generator's.
 */
export function survivalRunwayMeters(
  segments: ReadonlyMap<string, RuntimeRoadSegment>,
  start: RuntimeRoadSegment,
  startFraction: number,
  maxNeededMeters: number,
  visited: ReadonlySet<string> = new Set(),
  depth = 0,
): number {
  const startRemaining = segmentLengthMeters(start) * Math.max(0, 1 - startFraction);
  if (depth > 24 || startRemaining >= maxNeededMeters) {
    return Math.min(startRemaining, maxNeededMeters);
  }
  const nextVisited = new Set(visited);
  nextVisited.add(segmentRsl(start));
  // Forward continuations = the UNION of the DECLARED adjacent successors and the
  // GEOMETRY-reconstructed ones. A declared successor not physically contiguous
  // with this lane's travel end is dropped (routeSuccessorIsAdjacent): SR-P1 road
  // 41 lane -3's bundle successor sits ~380 m away — the graph says "continue",
  // the MESH ends at s=344.5, the subject falls into the void (2026-07-17). Munich's
  // bundle has the OPPOSITE defect — a lane's true forward connector is MISSING
  // from `successors` — so forwardSuccessorSegments adds it back from geometry;
  // without it real roads read as dead ends and placement funnels onto road 77.
  const forward = forwardSuccessorSegments(segments, start);
  const branches = forward
    .filter((seg) => !nextVisited.has(segmentRsl(seg)))
    .slice(0, 4);
  if (branches.length === 0) {
    // Revisiting a segment (loop) means indefinite continuation; a true dead
    // end means the runway stops here. Adjacency is already enforced by
    // forwardSuccessorSegments, so a forward continuation back onto a VISITED
    // lane is a real loop (a teleporting revisit was never in the set).
    const loops = forward.some((seg) => visited.has(segmentRsl(seg)));
    return loops ? maxNeededMeters : Math.min(startRemaining, maxNeededMeters);
  }
  const worstBranch = Math.min(
    ...branches.map((branch) =>
      survivalRunwayMeters(
        segments,
        branch,
        0,
        maxNeededMeters - startRemaining,
        nextVisited,
        depth + 1,
      ),
    ),
  );
  return Math.min(startRemaining + worstBranch, maxNeededMeters);
}

/**
 * Best-case (any-branch) survivable continuation from `startFraction`: like
 * survivalRunwayMeters but takes the MAX across branches — there EXISTS a path
 * of this length, rather than every path guaranteeing it. Used for
 * post-maneuver continuation (post-turn, route-follower lane_keep) where the
 * follow-through may legitimately involve further turns/loops and a single
 * good branch suffices; an subject that ends up on a bad branch is the 2D behavior
 * gate's job to reject (dib 2026-07-13: keep the seed pool wide, keep the
 * promotion bar at the CARLA-log gates).
 */
export function survivalRunwayBestBranchMeters(
  segments: ReadonlyMap<string, RuntimeRoadSegment>,
  start: RuntimeRoadSegment,
  startFraction: number,
  maxNeededMeters: number,
  visited: ReadonlySet<string> = new Set(),
  depth = 0,
): number {
  const startRemaining = segmentLengthMeters(start) * Math.max(0, 1 - startFraction);
  if (depth > 24 || startRemaining >= maxNeededMeters) {
    return Math.min(startRemaining, maxNeededMeters);
  }
  const nextVisited = new Set(visited);
  nextVisited.add(segmentRsl(start));
  // Union of DECLARED adjacent successors + GEOMETRY-reconstructed ones (see
  // survivalRunwayMeters): drops SR-P1's ~380 m teleport, adds back Munich's
  // dropped forward connectors.
  const forward = forwardSuccessorSegments(segments, start);
  const branches = forward
    .filter((seg) => !nextVisited.has(segmentRsl(seg)))
    .slice(0, 4);
  if (branches.length === 0) {
    // A forward continuation back onto a VISITED lane is a real loop; adjacency
    // is already enforced by forwardSuccessorSegments.
    const loops = forward.some((seg) => visited.has(segmentRsl(seg)));
    return loops ? maxNeededMeters : Math.min(startRemaining, maxNeededMeters);
  }
  const bestBranch = Math.max(
    ...branches.map((branch) =>
      survivalRunwayBestBranchMeters(
        segments,
        branch,
        0,
        maxNeededMeters - startRemaining,
        nextVisited,
        depth + 1,
      ),
    ),
  );
  return Math.min(startRemaining + bestBranch, maxNeededMeters);
}


function straightThroughSuccessor(
  segments: ReadonlyMap<string, RuntimeRoadSegment>,
  current: RuntimeRoadSegment,
  visited: ReadonlySet<string>,
): RuntimeRoadSegment | null {
  const currentEndHeading = centerlineYawAtFraction(current, 1);
  // Union of declared + geometry successors (routeSuccessorIsAdjacent already
  // enforced by forwardSuccessorSegments); keep this function's own routable +
  // visited filters and heading-delta selection unchanged.
  const candidates = forwardSuccessorSegments(segments, current)
    .filter((seg) => !visited.has(segmentRsl(seg)) && isRoutableSegment(seg))
    .map((segment) => ({
      segment,
      delta: headingDeltaDegrees(currentEndHeading, centerlineYawAtFraction(segment, 0)),
    }))
    .sort((a, b) => a.delta - b.delta || segmentRsl(a.segment).localeCompare(segmentRsl(b.segment)));
  const best = candidates[0];
  if (!best || best.delta > 45) return null;
  const second = candidates[1];
  if (second && second.delta <= 45) return null;
  return best.segment;
}

/**
 * Lane-keep runway along an unambiguous straight-through corridor. Unlike the
 * generic survival runway, this does not take the worst branch at a junction:
 * a lane_keep site is viable when the lane has one clear straight continuation
 * (<=45 deg heading delta), and the corridor ends at a turn/fork/loop.
 */
export function laneKeepRunwayMeters(
  segments: ReadonlyMap<string, RuntimeRoadSegment>,
  start: RuntimeRoadSegment,
  startFraction: number,
  maxNeededMeters: number,
): number {
  let covered = centerlineArcLengthMeters(start) * Math.max(0, 1 - startFraction);
  if (covered >= maxNeededMeters) return maxNeededMeters;
  let current = start;
  const visited = new Set([segmentRsl(start)]);
  const maxDepth = Math.min(64, Math.max(8, Math.ceil(maxNeededMeters / 5)));
  for (let depth = 0; depth < maxDepth && covered < maxNeededMeters; depth += 1) {
    const next = straightThroughSuccessor(segments, current, visited);
    if (!next) break;
    visited.add(segmentRsl(next));
    covered += centerlineArcLengthMeters(next);
    current = next;
  }
  return Math.min(covered, maxNeededMeters);
}

/**
 * The successor a route-following subject would take: the ROUTABLE (junction lanes
 * included) successor with the smallest heading change — the natural "keep
 * following the lane" continuation. Unlike straightThroughSuccessor this never
 * bails on ambiguity or a >45° best branch: a route-follower subject drives a
 * DETERMINISTIC route, so the builder just needs a consistent choice, and the
 * corridor may legitimately bend through turns (dib 2026-07-13: the whole map
 * should be lane_keep candidates; follow-through need not be straight).
 */
export function preferredRouteSuccessor(
  segments: ReadonlyMap<string, RuntimeRoadSegment>,
  current: RuntimeRoadSegment,
  visited: ReadonlySet<string>,
): RuntimeRoadSegment | null {
  const currentEndHeading = centerlineYawAtFraction(current, 1);
  // Union of declared + geometry successors (routeSuccessorIsAdjacent already
  // enforced by forwardSuccessorSegments); keep this function's own routable +
  // visited filters and straightest-successor selection unchanged.
  const candidates = forwardSuccessorSegments(segments, current)
    .filter((seg) => !visited.has(segmentRsl(seg)) && isRoutableSegment(seg))
    .map((segment) => ({
      segment,
      delta: headingDeltaDegrees(currentEndHeading, centerlineYawAtFraction(segment, 0)),
    }))
    .sort((a, b) => a.delta - b.delta || segmentRsl(a.segment).localeCompare(segmentRsl(b.segment)));
  return candidates[0]?.segment ?? null;
}

/**
 * Runway a route-following lane_keep subject actually gets: walks the SAME
 * straightest-routable-successor chain buildForwardRouteThroughSuccessors
 * (preferStraight) builds, so "gate passes" implies "the emitted route
 * delivers this length". Junction connectors count; ambiguous forks resolve
 * to the straightest branch instead of ending the corridor.
 */
export function routeFollowRunwayMeters(
  segments: ReadonlyMap<string, RuntimeRoadSegment>,
  start: RuntimeRoadSegment,
  startFraction: number,
  maxNeededMeters: number,
): number {
  let covered = centerlineArcLengthMeters(start) * Math.max(0, 1 - startFraction);
  if (covered >= maxNeededMeters) return maxNeededMeters;
  let current = start;
  const visited = new Set([segmentRsl(start)]);
  const maxDepth = Math.min(64, Math.max(8, Math.ceil(maxNeededMeters / 5)));
  for (let depth = 0; depth < maxDepth && covered < maxNeededMeters; depth += 1) {
    const next = preferredRouteSuccessor(segments, current, visited);
    if (!next) break;
    visited.add(segmentRsl(next));
    covered += centerlineArcLengthMeters(next);
    current = next;
  }
  return Math.min(covered, maxNeededMeters);
}

/**
 * Forward distance (meters) from a spawn point to the FIRST junction entry along
 * the subject's path, capped at `cap`. Unlike survivalRunwayMeters (which walks
 * THROUGH junctions to gauge total runway), this stops AT the first junction —
 * the point where the Traffic Manager makes the subject yield/stop. Used to keep a
 * lane change off a junction approach: the subject must have room to finish merging
 * before it reaches (and halts at) the junction, otherwise it just sits there.
 * A dead end / loop with no junction in range returns `cap` (treated as clear).
 */
export function metersToNextJunction(
  segments: ReadonlyMap<string, RuntimeRoadSegment>,
  start: RuntimeRoadSegment,
  startFraction: number,
  cap: number,
): number {
  let dist = segmentLengthMeters(start) * Math.max(0, 1 - startFraction);
  let current = start;
  const visited = new Set([segmentRsl(start)]);
  for (let depth = 0; depth < 24 && dist < cap; depth += 1) {
    // Union of declared + geometry-reconstructed successors (the lanes the subject
    // can actually continue onto), so a Munich lane whose real forward connector
    // the bundle dropped no longer reads as junction-free runway.
    const successorSegments = forwardSuccessorSegments(segments, current);
    // A junction successor = the subject reaches the junction at the current dist.
    if (successorSegments.some((seg) => seg.is_junction)) return dist;
    const next = successorSegments.find(
      (seg) => isDrivableSegment(seg) && !visited.has(segmentRsl(seg)),
    );
    if (!next) return cap; // dead end / loop: no junction within reach
    visited.add(segmentRsl(next));
    dist += segmentLengthMeters(next);
    current = next;
  }
  return Math.min(dist, cap);
}

/**
 * Straightest drivable PREDECESSOR of `current` — the through-road at a merge.
 * The upstream spawn walk used to demand a UNIQUE predecessor and reject every
 * merge point (67% of all turn-candidate rejects, no_upstream_approach). A
 * merge is fine to spawn behind: the subject flows forward from the chosen
 * predecessor into the approach regardless of what the OTHER merging lanes do
 * (dib 2026-07-13). Heading continuity picks the mainline over a side branch;
 * >60° of bend means we'd be spawning on a cross-street, so bail there.
 */
function straightestUpstreamPredecessor(
  segments: ReadonlyMap<string, RuntimeRoadSegment>,
  current: RuntimeRoadSegment,
  visited: ReadonlySet<string>,
): RuntimeRoadSegment | null {
  const currentStartHeading = centerlineYawAtFraction(current, 0);
  const candidates = (current.predecessors ?? [])
    .map((ref) => rslFromWaypointRef(ref))
    .filter((rsl): rsl is string => Boolean(rsl) && !visited.has(rsl!))
    .map((rsl) => segments.get(rsl))
    .filter((seg): seg is RuntimeRoadSegment => isDrivableSegment(seg))
    .map((segment) => ({
      segment,
      delta: headingDeltaDegrees(centerlineYawAtFraction(segment, 1), currentStartHeading),
    }))
    .sort((a, b) => a.delta - b.delta || segmentRsl(a.segment).localeCompare(segmentRsl(b.segment)));
  const best = candidates[0];
  if (!best) return null;
  if (candidates.length > 1 && best.delta > 60) return null;
  return best.segment;
}

/**
 * Walk PREDECESSORS from the junction-approach segment to find an upstream
 * spawn point `approachMeters` before the junction entry. Turn-approach
 * segments on generated maps are short stubs (p50 ~15m), so the subject usually
 * has to spawn several segments upstream and flow into the approach. Stops
 * at junctions; at a MERGE it follows the straightest (mainline) predecessor
 * instead of rejecting — the 2D behavior gate rejects the rare subject that gets
 * diverted before the labeled turn.
 */
export function upstreamSpawnForApproach(
  segments: ReadonlyMap<string, RuntimeRoadSegment>,
  approach: RuntimeRoadSegment,
  approachMeters: number,
): { segment: RuntimeRoadSegment; fraction: number } | null {
  let needed = approachMeters;
  let current = approach;
  const visited = new Set([segmentRsl(approach)]);
  for (;;) {
    const length = segmentLengthMeters(current);
    if (length >= needed + 2) {
      return { segment: current, fraction: Math.max(0.02, 1 - needed / length) };
    }
    needed -= length;
    const upstream = straightestUpstreamPredecessor(segments, current, visited);
    if (!upstream) return null;
    current = upstream;
    visited.add(segmentRsl(current));
  }
}

/**
 * Like upstreamSpawnForApproach, but also returns the FORWARD path from the
 * spawn segment (exclusive) to `approach` (inclusive) — the mainline segments a
 * route-follower must traverse to flow from the upstream spawn down to the
 * approach's end. Used by highway_exit so the subject can spawn several short
 * highway stubs upstream of the gore (Page Mill's "highway" lanes are ≤85 m,
 * too short to hold a full in-window approach on one segment) and still carry a
 * complete, gap-free route to the gore. `path` is [] when the spawn lands on
 * `approach` itself (the single-segment case — identical to
 * upstreamSpawnForApproach).
 */
export function upstreamApproachPath(
  segments: ReadonlyMap<string, RuntimeRoadSegment>,
  approach: RuntimeRoadSegment,
  approachMeters: number,
): { segment: RuntimeRoadSegment; fraction: number; path: RuntimeRoadSegment[] } | null {
  let needed = approachMeters;
  let current = approach;
  const visited = new Set([segmentRsl(approach)]);
  // Predecessor-order walk (approach first, spawn last); the forward prefix is
  // this minus the spawn, reversed.
  const walk: RuntimeRoadSegment[] = [approach];
  for (;;) {
    const length = segmentLengthMeters(current);
    if (length >= needed + 2) {
      return {
        segment: current,
        fraction: Math.max(0.02, 1 - needed / length),
        path: walk.slice(0, -1).reverse(),
      };
    }
    needed -= length;
    const upstream = straightestUpstreamPredecessor(segments, current, visited);
    if (!upstream) return null;
    current = upstream;
    visited.add(segmentRsl(current));
    walk.push(current);
  }
}

/**
 * Maximum approach distance upstreamSpawnForApproach can satisfy from this
 * junction-approach segment: total single-predecessor chain length minus the
 * 2m spawn headroom. Walk rules mirror upstreamSpawnForApproach exactly
 * (drivable, straightest-predecessor at merges, loop guard) so
 * "capacity >= approach" implies the spawn walk succeeds. Used by the caused-stop variants to ADAPT the
 * brake delay to short chains instead of rejecting them outright.
 */
export function upstreamChainCapacityMeters(
  segments: ReadonlyMap<string, RuntimeRoadSegment>,
  approach: RuntimeRoadSegment,
  capMeters: number,
): number {
  let total = 0;
  let current = approach;
  const visited = new Set([segmentRsl(approach)]);
  for (;;) {
    total += segmentLengthMeters(current);
    if (total - 2 >= capMeters) return capMeters;
    const upstream = straightestUpstreamPredecessor(segments, current, visited);
    if (!upstream) return Math.max(0, Math.min(capMeters, total - 2));
    current = upstream;
    visited.add(segmentRsl(current));
  }
}


function buildEgoForwardRoute(
  segment: RuntimeRoadSegment,
  fromFraction: number,
  speedKph: number,
  forwardIncreasingS: boolean,
): ScenarioEditorRoadAnchor[] {
  const road_id = String(segment.road_id);
  const lane_id = segment.lane_id ?? null;
  const section_id = segment.section_id ?? null;
  const end = forwardIncreasingS ? 0.96 : 0.04;
  const steps = 4;
  const anchors: ScenarioEditorRoadAnchor[] = [];
  for (let i = 1; i <= steps; i += 1) {
    const f = fromFraction + (end - fromFraction) * (i / steps);
    if (Math.abs(f - fromFraction) < 1e-3) continue;
    const sFraction = roundTo(forwardIncreasingS ? Math.min(end, f) : Math.max(end, f), 3);
    anchors.push(
      withWorldAnchor(
        {
          road_id,
          lane_id,
          section_id,
          s_fraction: sFraction,
          speed_kph: speedKph,
        },
        segment,
        sFraction,
      ),
    );
  }
  return anchors;
}

/** Forward route starting on `segment` and continuing THROUGH drivable successor
 * segments until at least `minForwardMeters` of road past `fromFraction` is
 * covered — so a route-follower placed far down its lane still has runway to
 * drive away after it resumes. Deterministic (first drivable, non-revisited
 * successor each hop); stops at a dead end / loop / junction-only continuation. */
export function buildForwardRouteThroughSuccessors(
  segments: ReadonlyMap<string, RuntimeRoadSegment>,
  segment: RuntimeRoadSegment,
  fromFraction: number,
  speedKph: number,
  minForwardMeters: number,
  // Route-follower lane_keep: choose the STRAIGHTEST routable successor at every
  // hop (the natural "keep following the lane" continuation, matching
  // routeFollowRunwayMeters so the gate's measured runway is the route's actual
  // length). Default false keeps stop-subject routes byte-identical.
  preferStraight = false,
): ScenarioEditorRoadAnchor[] {
  const fwd0 = forwardIsIncreasingS(segments, segment);
  const anchors = buildEgoForwardRoute(segment, fromFraction, speedKph, fwd0);
  let covered =
    segmentLengthMeters(segment) *
    Math.max(0, fwd0 ? 0.96 - fromFraction : fromFraction - 0.04);
  let current = segment;
  const visited = new Set([segmentRsl(segment)]);
  let depth = 0;
  // Walk far enough to actually DELIVER minForwardMeters. The old fixed `depth < 8` cap
  // truncated the route to ~8 short junction segments (~60 m), so on segment-dense maps
  // the subject ran out of road ~8 s into a 20 s clip and stalled at the route end. `visited`
  // already prevents cycles, so depth is only a runaway guard — size it to the runway
  // (≈ one short ~5 m segment per metre of target) with a hard ceiling. When the road
  // genuinely ends before the target, the loop still breaks on `!next` and the worker
  // holds cleanly at the end (route-end handbrake hold).
  const maxDepth = Math.min(64, Math.max(8, Math.ceil(minForwardMeters / 5)));
  while (covered < minForwardMeters && depth < maxDepth) {
    // Routable successors = Driving/Bidirectional lanes INCLUDING junction connecting
    // lanes. The old filter (`isDrivableSegment`, which is `!is_junction`) made the route
    // DEAD-END at the first junction, so the subject drove to the junction approach, exhausted
    // its route, and stalled there — reading as a mid-road stall OR a "won't go on green"
    // light stop. A junction has precise predecessor/successor links, so walking them
    // follows the defined movement (fwdN below anchors each lane in its own travel
    // direction → no wrong-way), and it matches survivalRunwayMeters, which already counts
    // junctions as runway when the placement gate approves the spot. Prefer staying on a
    // through-road; only step onto a junction connecting lane when the road actually ends.
    const candidates = (current.successors ?? [])
      .map((ref) => rslFromWaypointRef(ref))
      .filter((rsl): rsl is string => Boolean(rsl) && !visited.has(rsl!))
      .map((rsl) => segments.get(rsl!))
      .filter((seg): seg is RuntimeRoadSegment => seg != null && isRoutableSegment(seg)
        && routeSuccessorIsAdjacent(segments, current, seg));
    const next = preferStraight
      ? preferredRouteSuccessor(segments, current, visited)
      : (candidates.find((seg) => !seg.is_junction) ?? candidates[0]);
    if (!next) break;
    visited.add(segmentRsl(next));
    appendSegmentRouteAnchors(anchors, segments, next, speedKph);
    covered += segmentLengthMeters(next);
    current = next;
    depth += 1;
  }
  return anchors;
}

/** Append the standard 3 route anchors along `next` in its own travel
 * direction (its lane may be numbered the other way through a junction) —
 * anchored from its travel-START toward its end. */
function appendSegmentRouteAnchors(
  anchors: ScenarioEditorRoadAnchor[],
  segments: ReadonlyMap<string, RuntimeRoadSegment>,
  next: RuntimeRoadSegment,
  speedKph: number,
) {
  // Direction is the lane's YAW (which way traffic flows) — NOT which end is
  // spatially nearer (entering a lane at its geometric-near end can be its EXIT =
  // wrong-way). The routeSuccessorIsAdjacent guard already ensures we only chain a
  // successor whose yaw-ENTRY connects to the current segment's yaw-EXIT, so this
  // stays continuous AND correctly-directed.
  const fwdN = forwardIsIncreasingS(segments, next);
  const road_id = String(next.road_id);
  const lane_id = next.lane_id ?? null;
  const section_id = next.section_id ?? null;
  for (let i = 1; i <= 3; i += 1) {
    const f = fwdN ? 0.96 * (i / 3) : 0.96 - 0.92 * (i / 3);
    const sFraction = roundTo(f, 3);
    anchors.push(
      withWorldAnchor(
        { road_id, lane_id, section_id, s_fraction: sFraction, speed_kph: speedKph },
        next,
        sFraction,
      ),
    );
  }
}

/**
 * Route for a ramp scenario (highway_exit / highway_entry): anchors along the
 * spawn segment at `preSpeedKph`, then THROUGH the resolved gore/merge `chain`
 * (each hop at pre- or post-speed per `switchAtChainIndex`), then onward via
 * the straightest routable successor at `postSpeedKph` until
 * `minForwardMeters` is covered. The explicit chain pins the branch choice at
 * the gore — the whole reason these egos are route-followers, not TM.
 */
export function buildRouteViaChain(
  segments: ReadonlyMap<string, RuntimeRoadSegment>,
  start: RuntimeRoadSegment,
  fromFraction: number,
  chain: ReadonlyArray<RuntimeRoadSegment>,
  preSpeedKph: number,
  postSpeedKph: number,
  switchAtChainIndex: number,
  minForwardMeters: number,
): ScenarioEditorRoadAnchor[] {
  const fwd0 = forwardIsIncreasingS(segments, start);
  const anchors = buildEgoForwardRoute(start, fromFraction, preSpeedKph, fwd0);
  let covered =
    segmentLengthMeters(start) *
    Math.max(0, fwd0 ? 0.96 - fromFraction : fromFraction - 0.04);
  const visited = new Set([segmentRsl(start)]);
  let current = start;
  chain.forEach((next, index) => {
    visited.add(segmentRsl(next));
    appendSegmentRouteAnchors(
      anchors,
      segments,
      next,
      index >= switchAtChainIndex ? postSpeedKph : preSpeedKph,
    );
    covered += segmentLengthMeters(next);
    current = next;
  });
  const maxDepth = Math.min(64, Math.max(8, Math.ceil(minForwardMeters / 5)));
  for (let depth = 0; depth < maxDepth && covered < minForwardMeters; depth += 1) {
    const next = preferredRouteSuccessor(segments, current, visited);
    if (!next) break;
    visited.add(segmentRsl(next));
    appendSegmentRouteAnchors(anchors, segments, next, postSpeedKph);
    covered += segmentLengthMeters(next);
    current = next;
  }
  return anchors;
}

// ---------------------------------------------------------------------------
// Forbidden-fraction zones (heavy-traffic clearance corridors).
// ---------------------------------------------------------------------------

export function addForbiddenWindow(
  zones: ForbiddenFractionZones,
  rsl: string,
  start: number,
  end: number,
) {
  const clampedStart = Math.max(0, Math.min(1, start));
  const clampedEnd = Math.max(0, Math.min(1, end));
  if (clampedEnd <= clampedStart) return;
  const list = zones.get(rsl) ?? [];
  list.push({ start: clampedStart, end: clampedEnd });
  zones.set(rsl, list);
}

export function fractionIsForbidden(
  zones: ForbiddenFractionZones,
  rsl: string,
  fraction: number,
): boolean {
  const list = zones.get(rsl);
  if (!list) return false;
  return list.some((zone) => fraction >= zone.start && fraction <= zone.end);
}

/**
 * Mark the subject's forward corridor — everything it may drive over during the
 * label window — as forbidden for static jam fill. Walks successors
 * breadth-first (through junction-internal connectors, mirroring
 * survivalRunwayMeters: a TM-driven subject may take ANY branch at a fork) until
 * `corridorMeters` of every reachable path is covered. The generator's
 * convention is that higher s_fractions sit AHEAD along the travel direction.
 */
export function markForwardCorridorForbidden(input: {
  segments: ReadonlyMap<string, RuntimeRoadSegment>;
  zones: ForbiddenFractionZones;
  start: RuntimeRoadSegment;
  startFraction: number;
  corridorMeters: number;
}) {
  const queue: Array<{
    segment: RuntimeRoadSegment;
    fromFraction: number;
    remaining: number;
  }> = [
    {
      segment: input.start,
      fromFraction: Math.max(0, Math.min(1, input.startFraction)),
      remaining: input.corridorMeters,
    },
  ];
  // rsl -> largest carry-in budget already expanded; smaller revisits add
  // nothing, so this both dedups work and terminates loops.
  const expanded = new Map<string, number>();
  let safety = 512;
  while (queue.length > 0 && safety > 0) {
    safety -= 1;
    const { segment, fromFraction, remaining } = queue.shift()!;
    const rsl = segmentRsl(segment);
    const length = Math.max(1, segmentLengthMeters(segment));
    const endFraction = Math.min(1, fromFraction + remaining / length);
    addForbiddenWindow(input.zones, rsl, fromFraction, endFraction);
    if (endFraction < 1) continue;
    const carry = remaining - (endFraction - fromFraction) * length;
    if (carry <= 0) continue;
    for (const ref of segment.successors ?? []) {
      const nextRsl = rslFromWaypointRef(ref);
      const next = nextRsl ? input.segments.get(nextRsl) : null;
      if (!next || !nextRsl) continue;
      if ((expanded.get(nextRsl) ?? -1) >= carry) continue;
      expanded.set(nextRsl, carry);
      queue.push({ segment: next, fromFraction: 0, remaining: carry });
    }
  }
}

