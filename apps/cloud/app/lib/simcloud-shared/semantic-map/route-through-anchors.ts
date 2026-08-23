/**
 * Route between authored lane anchors, changing lanes where it is legal to.
 *
 * ## Why this is written rather than derived
 *
 * `deriveRunway` answers "where does this car go" for a car nobody routed: a
 * forward walk, keep-lane, straightest through each junction. It is not a router
 * and cannot be made into one — it has no destination to aim at.
 *
 * An authored route is the other question. The author dropped anchors on specific
 * lanes and the corridor has to CONNECT them, which means shortest-path search,
 * and it means being willing to change lanes to get there: two anchors on adjacent
 * lanes of the same road are a lane change, not an unresolvable leg.
 * The retired runtime route graph did this over the runtime crawl; this replacement uses the
 * semantic graph — the same question, on the graph that has the whole lane rather
 * than the ~89% of it the crawl reaches.
 *
 * ## What the semantic graph makes possible that the crawl did not
 *
 * The old graph paid a flat 25 m penalty for any lane change its runtime segment
 * declared legal, from a single per-lane `lane_change` enum. `LaneCorridor.
 * lateralAdjacencies` carries `sameDirection` and `permissionIntervals`
 * (`startM`/`endM`/`allowed`/`marking`), so a change across a solid line can be
 * REFUSED rather than merely discouraged. The cost stays equivalent so routes do
 * not start weaving to save a metre.
 *
 * ## The one modelling approximation, stated
 *
 * A legal lane change is drawn at the established 35%-along-lane station but
 * enters the target corridor at station zero. That apparently odd split is the
 * contract of the graph this replaces: its lateral edge geometry ended at 35%,
 * while its node identity pointed at the target lane's start. Preserving it
 * avoids silently changing authored corridors; the semantic graph still makes
 * the important improvement of refusing changes where permission intervals say
 * the marking is solid.
 */

import { pointAndYawAtStation, parseRsl, travelFractionToRoadFraction } from "./corridor-station";
import { polylineLength } from "./geometry";
import type {
  JunctionMovementVariant,
  LaneCorridor,
  SemanticMapGraph,
  SemanticMapPoint,
} from "./types";

/** A lane reference the author placed: which lane, and how far along its `+s`. */
export type RouteAnchorRef = {
  rsl: string;
  /** Fraction along the road's `+s` axis, NOT along travel. */
  sFraction: number;
  /** Authored runtime-frame position, when the anchor carries one. */
  point?: SemanticMapPoint;
  /**
   * Which authored field determines the longitudinal station.
   *
   * A point always disambiguates duplicate corridors. Runtime preview routes,
   * however, historically slice the selected lane by `s_fraction`; callers
   * migrating that contract can retain it without giving up geometric corridor
   * selection.
   */
  stationAuthority?: "point" | "fraction" | "compatible";
};

export type AnchorRouteResult = {
  /**
   * The resolved corridor, split wherever a leg could not be connected.
   *
   * Split rather than bridged: a straight line through whatever lies between two
   * unconnectable anchors is a road that does not exist, and the caller can tell
   * the author which leg failed instead of driving them through a building.
   */
  lines: SemanticMapPoint[][];
  /** Indexes into the anchor list of legs that could not be connected. */
  unresolvedLegIndexes: number[];
};

export type RouteThroughAnchorsOptions = {
  /**
   * Match a node-edge router whose search begins after the authored source edge.
   * The source lane is still traversed; a legal lateral hop can occur once the
   * search reaches a subsequent corridor.
   */
  deferInitialLaneChange?: boolean;
  /**
   * Preserve a displaced intermediate stamp's node-edge source traversal:
   * stamped point back to the corridor head, then forward through the graph.
   */
  replayDisplacedIntermediateSource?: boolean;
};

/**
 * What a lane change costs, in metres of equivalent travel.
 *
 * Carried over from the retired runtime router's lane-change penalty unchanged.
 * Its job is to keep the router in lane when staying in lane is nearly as short —
 * a router that changed lanes to save a metre would produce a corridor that weaves
 * for no reason the author could see. 25 m is long enough to dominate the noise
 * between parallel lanes and short enough that a genuinely shorter route through
 * an adjacent lane still wins.
 */
export const LANE_CHANGE_COST_M = 25;
/** CARLA GlobalRoutePlanner's established lateral-link station. */
const LANE_CHANGE_PREFERRED_FRACTION = 0.35;

const EPSILON_M = 1e-6;
/** Collapse sub-centimetre sampling noise at corridor/variant seams. */
const POINT_JOIN_EPSILON_M = 0.01;
/**
 * Published maps can omit a junction connector while retaining the aligned
 * road lanes on both sides. Infer only an explicit dead end, across one
 * intersection-sized gap, and only when lane identity and headings agree.
 */
const INFERRED_DEAD_END_JOIN_MAX_M = 60;
const INFERRED_DEAD_END_HEADING_MAX_DEG = 45;

/** Where an anchor sits on the semantic graph. */
export type AnchorStation = {
  corridor: LaneCorridor;
  stationM: number;
  /** Authored point used to choose and project onto the graph. */
  point?: SemanticMapPoint;
  /** Present when the RSL is a junction lane carried by a movement variant. */
  junction?: {
    variant: JunctionMovementVariant;
    stationM: number;
  };
};

/**
 * An anchor's `(rsl, sFraction)` as a corridor and a station along it.
 *
 * The inverse of `runtimeBindingAtCorridorStation`, and it makes the same
 * assumption that function makes in the forward direction: a corridor's runtime
 * fragment covers the WHOLE of the lane it names. Where two corridors both claim
 * one lane the authorable one wins, then the lower id — a stable answer matters
 * more than a clever one, because an unstable choice hands the same draft two
 * different corridors on two reads.
 */
export function anchorStation(
  graph: SemanticMapGraph,
  anchor: RouteAnchorRef,
): AnchorStation | null {
  const parsed = parseRsl(anchor.rsl);
  if (!parsed) return null;
  if (!Number.isFinite(anchor.sFraction)) return null;
  const roadFraction = Math.min(1, Math.max(0, anchor.sFraction));
  // `travelFractionToRoadFraction` is its own inverse — it either flips the
  // fraction or does not, by lane-id sign — so the same call converts back.
  const travelFraction = travelFractionToRoadFraction(parsed.laneId, roadFraction);

  let best: AnchorStation | null = null;
  let bestAuthorable = false;
  let bestDistanceM = Infinity;
  for (const corridor of graph.corridors) {
    for (const fragment of corridor.runtimeFragments) {
      if (fragment.rsl !== anchor.rsl) continue;
      const span = fragment.endArcM - fragment.startArcM;
      if (span <= EPSILON_M) continue;
      const authorable = corridor.authoringStatus === "authorable";
      const projection = anchor.point
        ? nearestProjection(corridor.polyline, anchor.point)
        : null;
      const fractionStationM = fragment.startArcM + travelFraction * span;
      const fractionPose =
        projection && anchor.stationAuthority === "compatible"
          ? pointAndYawAtStation(corridor.polyline, fractionStationM)
          : null;
      const pointCorroboratesFraction =
        anchor.point &&
        fractionPose &&
        Math.hypot(
          anchor.point.x - fractionPose.point.x,
          anchor.point.y - fractionPose.point.y,
        ) <= (corridor.representativeWidthM ?? corridor.minWidthM ?? 3.5) / 2;
      const stationM =
        projection &&
        (anchor.stationAuthority !== "fraction" &&
          (anchor.stationAuthority !== "compatible" ||
            pointCorroboratesFraction))
          ? Math.max(
              fragment.startArcM,
              Math.min(fragment.endArcM, projection.stationM),
            )
          : fractionStationM;
      const distanceM = projection?.distanceM ?? Infinity;
      const better =
        best === null ||
        (authorable && !bestAuthorable) ||
        (authorable === bestAuthorable &&
          (distanceM < bestDistanceM - EPSILON_M ||
            (Math.abs(distanceM - bestDistanceM) <= EPSILON_M &&
              corridor.id.localeCompare(best.corridor.id) < 0)));
      if (!better) continue;
      best = {
        corridor,
        stationM,
        ...(anchor.point ? { point: anchor.point } : {}),
      };
      bestAuthorable = authorable;
      bestDistanceM = distanceM;
    }
  }
  // Junction lanes are deliberately not corridors; they live inside movement
  // variants. Retain that station so a source can finish the movement into its
  // outgoing corridor and a target can enter it from its incoming corridor.
  if (!best) {
    let bestVariant:
      | {
          variant: JunctionMovementVariant;
          stationM: number;
          distanceM: number;
        }
      | null = null;
    for (const variant of graph.movementVariants) {
      if (!isAuthorable(variant) || !variant.runtimeLaneRsls.includes(anchor.rsl)) {
        continue;
      }
      const connectorRsls = variant.runtimeLaneRsls.slice(1, -1);
      const connectorIndex = connectorRsls.indexOf(anchor.rsl);
      if (connectorIndex < 0) continue;
      const projection = anchor.point
        ? nearestProjection(variant.polyline, anchor.point)
        : {
            stationM:
              variant.entryStationM +
              ((connectorIndex + travelFraction) /
                Math.max(1, connectorRsls.length)) *
                Math.max(
                  0,
                  variant.exitStationM - variant.entryStationM,
                ),
            distanceM: 0,
          };
      if (
        projection.stationM < variant.entryStationM - EPSILON_M ||
        projection.stationM > variant.exitStationM + EPSILON_M
      ) continue;
      if (
        !bestVariant ||
        projection.distanceM < bestVariant.distanceM - EPSILON_M ||
        (Math.abs(projection.distanceM - bestVariant.distanceM) <= EPSILON_M &&
          variant.id.localeCompare(bestVariant.variant.id) < 0)
      ) {
        bestVariant = {
          variant,
          stationM: projection.stationM,
          distanceM: projection.distanceM,
        };
      }
    }
    if (bestVariant) {
      const outgoing = graph.corridors.find(
        (corridor) =>
          corridor.id === bestVariant.variant.outgoingCorridorId &&
          isAuthorable(corridor),
      );
      if (outgoing) {
        best = {
          corridor: outgoing,
          stationM: 0,
          ...(anchor.point ? { point: anchor.point } : {}),
          junction: {
            variant: bestVariant.variant,
            stationM: bestVariant.stationM,
          },
        };
      }
    }
  }

  // Last-resort geometric attachment for a stamped road anchor whose exact RSL
  // is absent from both corridors and movements. This preserves the previous
  // fail-soft behaviour for incomplete publications without guessing from an
  // unstamped lane id.
  if (!best && anchor.point) {
    for (const corridor of graph.corridors) {
      if (!isAuthorable(corridor)) continue;
      const projection = nearestProjection(corridor.polyline, anchor.point);
      if (
        projection.distanceM < bestDistanceM - EPSILON_M ||
        (Math.abs(projection.distanceM - bestDistanceM) <= EPSILON_M &&
          (!best || corridor.id.localeCompare(best.corridor.id) < 0))
      ) {
        best = {
          corridor,
          stationM: projection.stationM,
          point: anchor.point,
        };
        bestDistanceM = projection.distanceM;
      }
    }
  }
  return best;
}

// ---------------------------------------------------------------------------
// Geometry
// ---------------------------------------------------------------------------

/**
 * The stretch of a polyline between two stations, endpoints interpolated.
 *
 * Both ends are interpolated rather than snapped to the nearest vertex: an anchor
 * sits where the author put it, and rounding it to a vertex moves the corridor's
 * start by up to a sample interval — which on a 10 m-sampled lane is enough to
 * put a car through a stop line it was placed behind.
 */
export function slicePolylineByStation(
  points: readonly SemanticMapPoint[],
  fromM: number,
  toM: number,
): SemanticMapPoint[] {
  if (points.length < 2 || toM <= fromM + EPSILON_M) return [];
  const head = pointAndYawAtStation(points, Math.max(0, fromM));
  const tail = pointAndYawAtStation(points, toM);
  if (!head || !tail) return [];
  const out: SemanticMapPoint[] = [head.point];
  let consumed = 0;
  for (let index = 1; index < points.length; index += 1) {
    const previous = points[index - 1]!;
    const current = points[index]!;
    consumed += Math.hypot(
      current.x - previous.x,
      current.y - previous.y,
      (current.z ?? 0) - (previous.z ?? 0),
    );
    if (consumed <= fromM + EPSILON_M) continue;
    if (consumed >= toM - EPSILON_M) break;
    out.push(current);
  }
  out.push(tail.point);
  return out;
}

/** Append, skipping a vertex that repeats the one before it. */
function appendPoints(target: SemanticMapPoint[], source: readonly SemanticMapPoint[]): void {
  for (const point of source) {
    const previous = target[target.length - 1];
    if (
      previous &&
      Math.hypot(point.x - previous.x, point.y - previous.y) <=
        POINT_JOIN_EPSILON_M
    ) {
      continue;
    }
    target.push(point);
  }
}

/** Projection on `points` nearest to `target`, for anchors and lane changes. */
function nearestProjection(
  points: readonly SemanticMapPoint[],
  target: SemanticMapPoint,
): { stationM: number; distanceM: number } {
  let consumed = 0;
  let bestStation = 0;
  let bestDistance = Infinity;
  for (let index = 1; index < points.length; index += 1) {
    const left = points[index - 1]!;
    const right = points[index]!;
    const dx = right.x - left.x;
    const dy = right.y - left.y;
    const lengthSq = dx * dx + dy * dy;
    const local =
      lengthSq <= EPSILON_M * EPSILON_M
        ? 0
        : Math.max(
            0,
            Math.min(
              1,
              ((target.x - left.x) * dx + (target.y - left.y) * dy) /
                lengthSq,
            ),
          );
    const projected = {
      x: left.x + dx * local,
      y: left.y + dy * local,
    };
    const distance = Math.hypot(projected.x - target.x, projected.y - target.y);
    const segmentM = Math.hypot(
      dx,
      dy,
      (right.z ?? 0) - (left.z ?? 0),
    );
    if (distance < bestDistance) {
      bestDistance = distance;
      bestStation = consumed + segmentM * local;
    }
    consumed += segmentM;
  }
  return { stationM: bestStation, distanceM: bestDistance };
}

// ---------------------------------------------------------------------------
// The search
// ---------------------------------------------------------------------------

type Transition =
  | { kind: "successor"; toCorridorId: string; exitStationM: number; entryStationM: number }
  | {
      kind: "inferred_successor";
      toCorridorId: string;
      exitStationM: number;
      entryStationM: number;
      gapM: number;
    }
  | {
      kind: "junction";
      toCorridorId: string;
      exitStationM: number;
      entryStationM: number;
      variant: JunctionMovementVariant;
    }
  | {
      kind: "lane_change";
      toCorridorId: string;
      exitStationM: number;
      entryStationM: number;
      landingStationM: number;
      lateralM: number;
    };

type InferredSuccessorTransition = Extract<
  Transition,
  { kind: "inferred_successor" }
>;

/**
 * Where on this adjacency a lane change may happen, at or after `fromStationM`.
 *
 * Prefer the 35%-along-lane station used by the graph this replaces, clamped
 * forward to the current station and then to legal permission intervals. This
 * retains established route geometry without crossing a solid line. `null`
 * means the change is illegal from here on.
 */
function laneChangeStation(
  intervals: readonly { startM: number; endM: number; allowed: boolean }[],
  fromStationM: number,
  corridorLengthM: number,
): number | null {
  const preferredM = Math.max(
    fromStationM,
    corridorLengthM * LANE_CHANGE_PREFERRED_FRACTION,
  );
  let preferredBest: number | null = null;
  let fallbackBest: number | null = null;
  for (const interval of intervals) {
    if (!interval.allowed) continue;
    if (interval.endM < fromStationM - EPSILON_M) continue;
    const containsPreferred =
      preferredM >= interval.startM - EPSILON_M &&
      preferredM <= interval.endM + EPSILON_M;
    const station = Math.max(
      interval.startM,
      containsPreferred ? preferredM : fromStationM,
    );
    if (station > interval.endM + EPSILON_M) continue;
    if (containsPreferred) {
      if (preferredBest === null || station < preferredBest) {
        preferredBest = station;
      }
    } else if (fallbackBest === null || station < fallbackBest) {
      fallbackBest = station;
    }
  }
  return preferredBest ?? fallbackBest;
}

function isAuthorable(entity: { authoringStatus: string }): boolean {
  return entity.authoringStatus === "authorable";
}

type SearchState = {
  costM: number;
  entryStationM: number;
  from: { corridorId: string; transition: Transition } | null;
};

function headingDeg(left: SemanticMapPoint, right: SemanticMapPoint): number {
  return (Math.atan2(right.y - left.y, right.x - left.x) * 180) / Math.PI;
}

function headingDeltaDeg(left: number, right: number): number {
  let delta = Math.abs(left - right) % 360;
  if (delta > 180) delta = 360 - delta;
  return delta;
}

function boundaryLaneId(
  corridor: LaneCorridor,
  boundary: "head" | "tail",
): number | null {
  const fragment =
    boundary === "head"
      ? corridor.runtimeFragments[0]
      : corridor.runtimeFragments.at(-1);
  return fragment ? parseRsl(fragment.rsl)?.laneId ?? null : null;
}

function inferredDeadEndSuccessors(
  corridor: LaneCorridor,
  candidates: readonly LaneCorridor[],
): InferredSuccessorTransition[] {
  if (corridor.polyline.length < 2) return [];
  const laneId = boundaryLaneId(corridor, "tail");
  if (laneId === null) return [];
  const tail = corridor.polyline.at(-1)!;
  const tailHeading = headingDeg(corridor.polyline.at(-2)!, tail);
  const transitions: InferredSuccessorTransition[] = [];
  for (const candidate of candidates) {
    if (
      candidate.id === corridor.id ||
      !isAuthorable(candidate) ||
      candidate.polyline.length < 2 ||
      Math.sign(boundaryLaneId(candidate, "head") ?? 0) !== Math.sign(laneId)
    ) {
      continue;
    }
    const head = candidate.polyline[0]!;
    const gapM = Math.hypot(head.x - tail.x, head.y - tail.y);
    if (
      gapM <= EPSILON_M ||
      gapM > INFERRED_DEAD_END_JOIN_MAX_M
    ) {
      continue;
    }
    const gapHeading = headingDeg(tail, head);
    const candidateHeading = headingDeg(head, candidate.polyline[1]!);
    if (
      headingDeltaDeg(tailHeading, gapHeading) >
        INFERRED_DEAD_END_HEADING_MAX_DEG ||
      headingDeltaDeg(gapHeading, candidateHeading) >
        INFERRED_DEAD_END_HEADING_MAX_DEG
    ) {
      continue;
    }
    transitions.push({
      kind: "inferred_successor",
      toCorridorId: candidate.id,
      exitStationM: corridor.lengthM,
      entryStationM: 0,
      gapM,
    });
  }
  // Lane numbers are local to a road and commonly shift across a junction.
  // The continuation is the closest aligned carriageway, not necessarily the
  // numerically identical lane on the next road. Return one deterministic seam
  // so parallel candidates cannot become destination-dependent shortcuts.
  return transitions
    .sort(
      (left, right) =>
        left.gapM - right.gapM ||
        left.toCorridorId.localeCompare(right.toCorridorId),
    )
    .slice(0, 1);
}

/**
 * Shortest drivable path from a station on one corridor to a station on another.
 *
 * Plain Dijkstra over corridors. The wrinkle is that `entryStationM` is part of a
 * node's state and is fixed the first time the node is settled — see the module
 * header for why that is an approximation and why it is a safe one.
 */
function searchPath(
  graph: SemanticMapGraph,
  corridorsById: Map<string, LaneCorridor>,
  variantsByIncoming: Map<string, JunctionMovementVariant[]>,
  source: AnchorStation,
  target: AnchorStation,
  options: RouteThroughAnchorsOptions = {},
): { corridorId: string; transition: Transition }[] | null {
  const states = new Map<string, SearchState>([
    [source.corridor.id, { costM: 0, entryStationM: source.stationM, from: null }],
  ]);
  const settled = new Set<string>();
  const pending = new Set<string>([source.corridor.id]);

  // The goal is tracked SEPARATELY from the settled distances, because arriving
  // at the target corridor is not the same as arriving at the anchor on it.
  //
  // Entering the target past the anchor is not an answer — the car would have to
  // drive backwards — so a settled state on that corridor can be a perfectly good
  // shortest path and still not be a route. That is exactly what happens when the
  // route loops back to the lane it started on: the source is settled at step one
  // with the anchor behind it, and folding the goal into `states` would let that
  // settled entry block the loop from ever completing.
  let goalCostM = Infinity;
  let goalFrom: { corridorId: string; transition: Transition } | null = null;

  const arrivesAtAnchor = (corridorId: string, entryStationM: number): boolean =>
    corridorId === target.corridor.id && entryStationM <= target.stationM + EPSILON_M;

  while (pending.size > 0) {
    // Sorted scan rather than a heap. Corridor counts are in the thousands and
    // this runs once per authored leg, so the constant factor is irrelevant next
    // to the cost of being wrong about tie-breaking: the id tie-break is what
    // makes the same draft resolve to the same corridor on every read.
    const currentId = [...pending].sort((left, right) => {
      const delta = (states.get(left)?.costM ?? Infinity) - (states.get(right)?.costM ?? Infinity);
      return delta || left.localeCompare(right);
    })[0]!;
    pending.delete(currentId);
    if (settled.has(currentId)) continue;
    settled.add(currentId);

    const state = states.get(currentId)!;
    // Nothing beyond the goal can be cheaper: Dijkstra settles in cost order.
    if (state.costM >= goalCostM) break;
    const corridor = corridorsById.get(currentId);
    if (!corridor) continue;

    const runToEndM = Math.max(0, corridor.lengthM - state.entryStationM);
    const transitions: Transition[] = [];

    // A junction is the corridor's own end, so its variants and the plain
    // successor links are alternatives rather than a sequence — the same reading
    // `deriveRunway` takes.
    for (const variant of variantsByIncoming.get(currentId) ?? []) {
      if (!isAuthorable(variant)) continue;
      transitions.push({
        kind: "junction",
        toCorridorId: variant.outgoingCorridorId,
        exitStationM: corridor.lengthM,
        entryStationM: 0,
        variant,
      });
    }
    for (const successorId of corridor.successorCorridorIds) {
      transitions.push({
        kind: "successor",
        toCorridorId: successorId,
        exitStationM: corridor.lengthM,
        entryStationM: 0,
      });
    }
    // Some accepted publications retain both road lanes but omit the connector
    // corridor between them. An inferred seam normally never competes with
    // authored connectivity. The source is the one exception: the retired router
    // began its shortest-path search at the source lane's tail, so a published
    // turn-only movement could not force a lateral hop back to another lane's
    // head when the runtime crawl continued straight across the same junction.
    let inferredDeadEnd = false;
    const authoredMovementReachesTarget = transitions.some(
      (transition) =>
        transition.kind === "junction" &&
        transition.toCorridorId === target.corridor.id,
    );
    if (
      corridor.successorCorridorIds.length === 0 &&
      (transitions.length === 0 ||
        (currentId === source.corridor.id &&
          !authoredMovementReachesTarget))
    ) {
      const inferred = inferredDeadEndSuccessors(corridor, graph.corridors);
      transitions.push(...inferred);
      inferredDeadEnd = inferred.length > 0;
    }
    for (const adjacency of inferredDeadEnd ||
      (options.deferInitialLaneChange && currentId === source.corridor.id)
      ? []
      : corridor.lateralAdjacencies) {
      // Oncoming traffic is not a lane change. The old graph checked this with a
      // lane-id sign comparison; the graph states it.
      if (!adjacency.sameDirection) continue;
      const changeStationM = laneChangeStation(
        adjacency.permissionIntervals,
        state.entryStationM,
        corridor.lengthM,
      );
      if (changeStationM === null) continue;
      const neighbour = corridorsById.get(adjacency.targetCorridorId);
      if (!neighbour) continue;
      const at = pointAndYawAtStation(corridor.polyline, changeStationM);
      if (!at) continue;
      const landing = nearestProjection(neighbour.polyline, at.point);
      transitions.push({
        kind: "lane_change",
        toCorridorId: adjacency.targetCorridorId,
        exitStationM: changeStationM,
        // Compatibility with the retired router: the lateral edge lands on its
        // target point geometrically, but its graph node is the lane head.
        entryStationM: 0,
        landingStationM: landing.stationM,
        lateralM: landing.distanceM,
      });
    }

    for (const transition of transitions) {
      const next = corridorsById.get(transition.toCorridorId);
      if (!next || !isAuthorable(next)) continue;
      // A settled node cannot be improved — except as the GOAL, which is a
      // different question from the shortest distance to its corridor.
      if (
        settled.has(transition.toCorridorId) &&
        !arrivesAtAnchor(transition.toCorridorId, transition.entryStationM)
      ) {
        continue;
      }
      const stepM =
        transition.kind === "lane_change"
          ? LANE_CHANGE_COST_M + transition.lateralM
          : runToEndM +
            (transition.kind === "junction"
              ? Math.max(
                  0,
                  transition.variant.exitStationM - transition.variant.entryStationM,
                )
              : transition.kind === "inferred_successor"
                ? transition.gapM
                : 0);
      const costM = state.costM + Math.max(0, stepM);
      if (
        arrivesAtAnchor(transition.toCorridorId, transition.entryStationM) &&
        costM < goalCostM
      ) {
        goalCostM = costM;
        goalFrom = { corridorId: currentId, transition };
      }
      const existing = states.get(transition.toCorridorId);
      if (existing && existing.costM <= costM) continue;
      states.set(transition.toCorridorId, {
        costM,
        entryStationM: transition.entryStationM,
        from: { corridorId: currentId, transition },
      });
      pending.add(transition.toCorridorId);
    }
  }

  if (!goalFrom) return null;

  const chain: { corridorId: string; transition: Transition }[] = [goalFrom];
  let cursor = goalFrom.corridorId;
  const guard = new Set<string>();
  while (cursor !== source.corridor.id) {
    const state = states.get(cursor);
    if (!state?.from || guard.has(cursor)) return null;
    guard.add(cursor);
    chain.unshift(state.from);
    cursor = state.from.corridorId;
  }
  return chain;
}

/** Walk a settled chain back into one polyline. */
function geometryForChain(
  corridorsById: Map<string, LaneCorridor>,
  source: AnchorStation,
  target: AnchorStation,
  chain: { corridorId: string; transition: Transition }[],
): SemanticMapPoint[] {
  const points: SemanticMapPoint[] = [];
  // Seeded with the anchor itself, so a leg that leaves immediately still starts
  // where the author put the car. A lane change at the anchor's own station makes
  // the first slice zero-length, and without this the corridor began on the lane
  // the car changed INTO — a car teleporting sideways before it moves.
  const head = pointAndYawAtStation(source.corridor.polyline, source.stationM);
  if (head) points.push(head.point);
  let station = source.stationM;
  for (const step of chain) {
    const corridor = corridorsById.get(step.corridorId);
    if (!corridor) return [];
    appendPoints(
      points,
      slicePolylineByStation(corridor.polyline, station, step.transition.exitStationM),
    );
    if (step.transition.kind === "junction") {
      // A movement variant is the COMPOSED incoming lane + junction lanes +
      // outgoing lane. Only the span between its recorded entry and exit
      // stations is junction geometry; appending the whole polyline here drove
      // back to the start of the incoming corridor, then repeated the outgoing
      // corridor before `geometryForChain` appended it again.
      appendPoints(
        points,
        slicePolylineByStation(
          step.transition.variant.polyline,
          step.transition.variant.entryStationM,
          step.transition.variant.exitStationM,
        ),
      );
    } else if (step.transition.kind === "lane_change") {
      const targetCorridor = corridorsById.get(
        step.transition.toCorridorId,
      );
      const landing = targetCorridor
        ? pointAndYawAtStation(
            targetCorridor.polyline,
            step.transition.landingStationM,
          )
        : null;
      if (landing) appendPoints(points, [landing.point]);
    }
    station = step.transition.entryStationM;
  }
  appendPoints(
    points,
    slicePolylineByStation(target.corridor.polyline, station, target.stationM),
  );
  return points;
}

/**
 * Connect one leg: the corridor from `source` to `target`, or null.
 *
 * The same-corridor case is answered directly and only when the target lies
 * AHEAD. Behind, it falls through to the search — which will loop the block if
 * the map has a way round and report the leg unresolved if it does not. Slicing
 * backwards, as the graph this replaces did, produced a polyline that runs
 * against the lane: a corridor no car can drive, handed to the engine as if it
 * could.
 */
export function routeLeg(
  graph: SemanticMapGraph,
  source: AnchorStation,
  target: AnchorStation,
  options: RouteThroughAnchorsOptions = {},
): SemanticMapPoint[] | null {
  const corridorsById = new Map(graph.corridors.map((corridor) => [corridor.id, corridor]));
  const variantsByIncoming = new Map<string, JunctionMovementVariant[]>();
  for (const variant of graph.movementVariants) {
    const bucket = variantsByIncoming.get(variant.incomingCorridorId);
    if (bucket) bucket.push(variant);
    else variantsByIncoming.set(variant.incomingCorridorId, [variant]);
  }
  return routeLegWithIndex(
    graph,
    corridorsById,
    variantsByIncoming,
    source,
    target,
    options,
  );
}

function routeLegWithIndex(
  graph: SemanticMapGraph,
  corridorsById: Map<string, LaneCorridor>,
  variantsByIncoming: Map<string, JunctionMovementVariant[]>,
  source: AnchorStation,
  target: AnchorStation,
  options: RouteThroughAnchorsOptions = {},
): SemanticMapPoint[] | null {
  const sourceJunction = source.junction;
  const targetJunction = target.junction;
  if (
    sourceJunction &&
    targetJunction &&
    sourceJunction.variant.id === targetJunction.variant.id &&
    targetJunction.stationM > sourceJunction.stationM + EPSILON_M
  ) {
    const slice = slicePolylineByStation(
      sourceJunction.variant.polyline,
      sourceJunction.stationM,
      targetJunction.stationM,
    );
    if (slice.length >= 2) return slice;
  }

  const sourceBase: AnchorStation = sourceJunction
    ? {
        corridor:
          corridorsById.get(sourceJunction.variant.outgoingCorridorId) ??
          source.corridor,
        stationM: 0,
      }
    : source;
  const targetBase: AnchorStation = targetJunction
    ? {
        corridor:
          corridorsById.get(targetJunction.variant.incomingCorridorId) ??
          target.corridor,
        stationM:
          corridorsById.get(targetJunction.variant.incomingCorridorId)
            ?.lengthM ?? target.corridor.lengthM,
      }
    : target;
  const sourceProjection =
    options.replayDisplacedIntermediateSource &&
    !sourceJunction &&
    source.point
      ? nearestProjection(sourceBase.corridor.polyline, source.point)
      : null;
  const replaySourceToHead =
    sourceProjection &&
    sourceProjection.stationM - sourceBase.stationM >
      (sourceBase.corridor.representativeWidthM ??
        sourceBase.corridor.minWidthM ??
        3.5) /
        2;
  const searchSource = replaySourceToHead
    ? { ...sourceBase, stationM: 0 }
    : sourceBase;

  let core: SemanticMapPoint[] | null = null;
  if (
    searchSource.corridor.id === targetBase.corridor.id &&
    targetBase.stationM > searchSource.stationM + EPSILON_M
  ) {
    core = slicePolylineByStation(
      searchSource.corridor.polyline,
      searchSource.stationM,
      targetBase.stationM,
    );
  } else if (
    searchSource.corridor.id === targetBase.corridor.id &&
    targetBase.stationM < searchSource.stationM - EPSILON_M &&
    source.point &&
    target.point
  ) {
    // A stamped reverse manoeuvre is an authored exception to lane travel: the
    // car backs along its lane from the first world pose to the second. Keep the
    // unstamped case fail-closed—without poses, a descending fraction is just as
    // likely a bad anchor order—but preserve an explicit world-space retreat.
    core = slicePolylineByStation(
      searchSource.corridor.polyline,
      targetBase.stationM,
      searchSource.stationM,
    ).reverse();
  } else if (
    searchSource.corridor.id === targetBase.corridor.id &&
    Math.abs(targetBase.stationM - searchSource.stationM) <= EPSILON_M
  ) {
    core = [];
  } else {
    const chain = searchPath(
      graph,
      corridorsById,
      variantsByIncoming,
      searchSource,
      targetBase,
      options,
    );
    if (chain) {
      core = geometryForChain(
        corridorsById,
        searchSource,
        targetBase,
        chain,
      );
    }
  }
  if (!core) return null;

  const points: SemanticMapPoint[] = [];
  if (sourceJunction) {
    const prefix = slicePolylineByStation(
      sourceJunction.variant.polyline,
      sourceJunction.stationM,
      sourceJunction.variant.exitStationM,
    );
    appendPoints(points, prefix);
  }
  if (replaySourceToHead && sourceProjection) {
    appendPoints(
      points,
      slicePolylineByStation(
        sourceBase.corridor.polyline,
        0,
        sourceProjection.stationM,
      ).reverse(),
    );
  }
  appendPoints(points, core);
  if (targetJunction) {
    const suffix = slicePolylineByStation(
      targetJunction.variant.polyline,
      targetJunction.variant.entryStationM,
      targetJunction.stationM,
    );
    appendPoints(points, suffix);
  }
  return points.length >= 2 ? points : null;
}

/**
 * The corridor an authored anchor list describes.
 *
 * Legs are resolved pairwise and concatenated. A leg that cannot be connected
 * ends the run in progress and starts a new one, so the result is the drivable
 * pieces plus a list of which legs failed — the caller picks the longest run and
 * reports the gaps, rather than being handed a corridor that silently teleports.
 */
export function routeThroughAnchors(
  graph: SemanticMapGraph,
  anchors: readonly RouteAnchorRef[],
  options: RouteThroughAnchorsOptions = {},
): AnchorRouteResult {
  const corridorsById = new Map(graph.corridors.map((corridor) => [corridor.id, corridor]));
  const variantsByIncoming = new Map<string, JunctionMovementVariant[]>();
  for (const variant of graph.movementVariants) {
    const bucket = variantsByIncoming.get(variant.incomingCorridorId);
    if (bucket) bucket.push(variant);
    else variantsByIncoming.set(variant.incomingCorridorId, [variant]);
  }

  const lines: SemanticMapPoint[][] = [];
  const unresolvedLegIndexes: number[] = [];
  let active: SemanticMapPoint[] = [];
  for (let index = 1; index < anchors.length; index += 1) {
    const source = anchorStation(graph, anchors[index - 1]!);
    const target = anchorStation(graph, anchors[index]!);
    const leg =
      source && target
        ? routeLegWithIndex(
            graph,
            corridorsById,
            variantsByIncoming,
            source,
            target,
            {
              ...options,
              replayDisplacedIntermediateSource:
                options.replayDisplacedIntermediateSource && index > 1,
            },
          )
        : null;
    if (!leg) {
      if (active.length >= 2) lines.push(active);
      active = [];
      unresolvedLegIndexes.push(index - 1);
      continue;
    }
    appendPoints(active, leg);
  }
  if (active.length >= 2) lines.push(active);
  return { lines, unresolvedLegIndexes };
}

/** Total length of a resolved run, for picking the longest. */
export function routeLineLengthM(points: readonly SemanticMapPoint[]): number {
  return polylineLength(points);
}
