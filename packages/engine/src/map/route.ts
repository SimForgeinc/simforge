/**
 * Routes: a single arc-length parameterisation an actor drives along.
 *
 * A route is either a **lane chain** (ordered directed lanes, connected within
 * `ENDPOINT_TOL_M`) or a **freeform polyline** (pedestrian crossings, jaywalk
 * diagonals). Both expose the same `poseAt(s)` so the controllers never branch
 * on actor kind for geometry.
 *
 * Lateral position is *not* part of the route: actors carry a signed offset in
 * metres (positive = left of the centreline) that the lateral controller
 * animates. Completing a lane change re-bases the route onto the neighbour lane
 * and subtracts the lane separation from the offset, so the offset stays small
 * and a following actor's "same lane?" test stays meaningful.
 */

import { clamp, dist, normalizeAngle, pointSegment, type Vec2 } from '../core/math.js';
import { localFromScene } from '../frames.js';
import type { RouteSpec, TurnRelation } from '../schema/input.js';
import { ENDPOINT_TOL_M, type DirectedLane, type LaneGraph } from './lane-graph.js';
import type { LaneRsl } from './topology.js';

export interface RouteLeg extends DirectedLane {
  /** Route arc length at the leg's entry. */
  readonly sStart: number;
  readonly lengthM: number;
  /** Turn taken to enter this leg, when it is a junction connecting lane. */
  readonly turnRelation: TurnRelation | null;
}

export interface RoutePose {
  readonly point: Vec2;
  readonly headingRad: number;
  readonly rsl: LaneRsl | null;
  /** Arc length within the lane, in traversal direction. */
  readonly laneS: number;
  /**
   * Arc length within the lane in the index's **storage** direction. This is
   * the `s` that `laneRef`, `widthSamples` and signal stop lines speak, so it
   * is the only lane-local `s` that crosses the package boundary.
   */
  readonly storageS: number;
  readonly reversed: boolean;
  readonly legIndex: number;
}

export interface RouteBuildError {
  code:
    | 'route_lane_missing'
    | 'route_disconnected'
    | 'route_empty'
    | 'route_orientation_ambiguous'
    | 'route_turn_unavailable';
  reason: string;
  detail?: Record<string, unknown>;
}

export interface PlacementRouteOptions {
  readonly startRsl: LaneRsl;
  /** Lane-local s in topology storage direction. */
  readonly startStorageS: number;
  readonly requiredDownstreamM: number;
  readonly maxLegs?: number;
}

/** @deprecated Seeds no longer alter default routing; retained for API compatibility. */
export interface SeededPlacementRouteOptions extends PlacementRouteOptions {
  readonly seed?: string;
  readonly actorId?: string;
}

export type SeededPlacementRouteResult =
  | { ok: true; route: Route; lanes: readonly LaneRsl[]; downstreamM: number }
  | { ok: false; error: RouteBuildError };

function routeDirectedKey(lane: DirectedLane): string {
  return `${lane.rsl}${lane.reversed ? '#r' : '#f'}`;
}

export class Route {
  readonly legs: readonly RouteLeg[];
  readonly lengthM: number;
  private readonly freePoints: readonly Vec2[] | null;
  private readonly freeCum: readonly number[] | null;
  private readonly freeHeadings: readonly number[] | null;
  private laneIndex: Map<LaneRsl, number> | null = null;

  private constructor(
    private readonly graph: LaneGraph | null,
    legs: readonly RouteLeg[],
    free: { points: Vec2[]; cum: number[]; headings: number[] } | null,
  ) {
    this.legs = legs;
    this.freePoints = free?.points ?? null;
    this.freeCum = free?.cum ?? null;
    this.freeHeadings = free?.headings ?? null;
    this.lengthM = free
      ? free.cum[free.cum.length - 1]!
      : legs.length === 0
        ? 0
        : legs[legs.length - 1]!.sStart + legs[legs.length - 1]!.lengthM;
  }

  static fromLegs(graph: LaneGraph, legs: readonly RouteLeg[]): Route {
    return new Route(graph, legs, null);
  }

  static fromPolyline(points: readonly Vec2[]): Route {
    const pts: Vec2[] = [];
    for (const p of points) {
      const prev = pts[pts.length - 1];
      if (prev && dist(prev, p) < 1e-9) continue;
      pts.push({ x: p.x, y: p.y });
    }
    const cum = [0];
    const headings: number[] = [];
    for (let i = 1; i < pts.length; i++) {
      cum.push(cum[i - 1]! + dist(pts[i - 1]!, pts[i]!));
      headings.push(Math.atan2(pts[i]!.y - pts[i - 1]!.y, pts[i]!.x - pts[i - 1]!.x));
    }
    headings.push(headings[headings.length - 1] ?? 0);
    return new Route(null, [], { points: pts, cum, headings });
  }

  get isFreeform(): boolean {
    return this.freePoints !== null;
  }

  /** Index of the leg containing route arc length `s`. */
  legIndexAt(s: number): number {
    if (this.legs.length === 0) return -1;
    const q = clamp(s, 0, this.lengthM);
    let lo = 0;
    let hi = this.legs.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (this.legs[mid]!.sStart <= q) lo = mid;
      else hi = mid - 1;
    }
    return lo;
  }

  poseAt(s: number): RoutePose {
    const q = clamp(s, 0, this.lengthM);
    if (this.freePoints && this.freeCum && this.freeHeadings) {
      let lo = 0;
      let hi = this.freeCum.length - 1;
      while (hi - lo > 1) {
        const mid = (lo + hi) >> 1;
        if (this.freeCum[mid]! <= q) lo = mid;
        else hi = mid;
      }
      const a = this.freePoints[lo]!;
      const b = this.freePoints[hi]!;
      const span = this.freeCum[hi]! - this.freeCum[lo]!;
      const t = span > 1e-9 ? (q - this.freeCum[lo]!) / span : 0;
      return {
        point: { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t },
        headingRad: this.freeHeadings[lo]!,
        rsl: null,
        laneS: q,
        storageS: q,
        reversed: false,
        legIndex: -1,
      };
    }
    const i = this.legIndexAt(q);
    const leg = this.legs[i]!;
    const laneS = clamp(q - leg.sStart, 0, leg.lengthM);
    const sample = this.graph!.sampleDirected(leg, laneS);
    return {
      point: sample.point,
      headingRad: normalizeAngle(sample.headingRad),
      rsl: leg.rsl,
      laneS,
      storageS: leg.reversed ? leg.lengthM - laneS : laneS,
      reversed: leg.reversed,
      legIndex: i,
    };
  }

  /** Lane width at route arc length `s` (default 3.5 m off the lane graph). */
  widthAt(s: number): number {
    if (this.legs.length === 0 || !this.graph) return 3.5;
    const i = this.legIndexAt(s);
    const leg = this.legs[i]!;
    const laneS = clamp(s - leg.sStart, 0, leg.lengthM);
    const storageS = leg.reversed ? leg.lengthM - laneS : laneS;
    return this.graph.widthAt(leg.rsl, storageS);
  }

  /** Point offset laterally from the centreline; `+` is left of travel. */
  pointWithOffset(s: number, lateralM: number): Vec2 {
    const pose = this.poseAt(s);
    if (lateralM === 0) return pose.point;
    const nx = -Math.sin(pose.headingRad);
    const ny = Math.cos(pose.headingRad);
    return { x: pose.point.x + nx * lateralM, y: pose.point.y + ny * lateralM };
  }

  /**
   * Route arc length of a lane-local **storage** `s`, or `null` when the route
   * never traverses that lane. Ties (a lane visited twice) resolve to the first
   * visit, which keeps the reading monotone for a follower.
   *
   * Backed by a lazily built `rsl → legIndex` map: this is called once per
   * actor pair per tick by the leader search, so a linear scan over a 40-leg
   * route was measurable.
   */
  sOfLaneStorage(rsl: LaneRsl, storageS: number): number | null {
    if (!this.laneIndex) {
      this.laneIndex = new Map();
      for (let i = 0; i < this.legs.length; i++) {
        if (!this.laneIndex.has(this.legs[i]!.rsl)) this.laneIndex.set(this.legs[i]!.rsl, i);
      }
    }
    const i = this.laneIndex.get(rsl);
    if (i === undefined) return null;
    const leg = this.legs[i]!;
    const travel = leg.reversed ? leg.lengthM - storageS : storageS;
    return leg.sStart + clamp(travel, 0, leg.lengthM);
  }

  /** Whether the route ever traverses `rsl`. */
  includesLane(rsl: LaneRsl): boolean {
    return this.sOfLaneStorage(rsl, 0) !== null;
  }

  /** Nearest route arc length to a point, scanning coarsely then refining. */
  projectPoint(p: Vec2, stepM = 2): { s: number; d: number } {
    let best = { s: 0, d: Infinity };
    const n = Math.max(2, Math.ceil(this.lengthM / stepM) + 1);
    for (let i = 0; i < n; i++) {
      const s = (this.lengthM * i) / (n - 1);
      const d = dist(this.poseAt(s).point, p);
      if (d < best.d) best = { s, d };
    }
    // Golden-section-free local refine: two bisection passes over ±step.
    let lo = Math.max(0, best.s - stepM);
    let hi = Math.min(this.lengthM, best.s + stepM);
    for (let iter = 0; iter < 24; iter++) {
      const m1 = lo + (hi - lo) / 3;
      const m2 = hi - (hi - lo) / 3;
      const d1 = dist(this.poseAt(m1).point, p);
      const d2 = dist(this.poseAt(m2).point, p);
      if (d1 < d2) hi = m2;
      else lo = m1;
    }
    const s = (lo + hi) / 2;
    return { s, d: dist(this.poseAt(s).point, p) };
  }

  /**
   * The same path traversed the other way, from the far end back to the start.
   *
   * This is what selecting reverse gear means geometrically. A shift does *not*
   * rotate the body — a car backing down the lane it just came up keeps its
   * heading exactly, and every oriented bounding box and render depends on that
   * being true. What inverts is the direction of travel. Flipping the route and
   * re-basing `routeS` to `lengthM - s` expresses that with no discontinuity:
   * the reversing body's heading is `newTangent + PI`, which is the old tangent.
   *
   * Flipping the **lane chain** rather than degrading to a polyline is the whole
   * point — `laneRsl`, lane width, the leader search and the corridor guard all
   * keep working while the actor reverses.
   */
  reversedRoute(): Route {
    if (this.freePoints) return Route.fromPolyline([...this.freePoints].reverse());
    if (!this.graph || this.legs.length === 0) return this;
    const legs: RouteLeg[] = [];
    let sStart = 0;
    for (let i = this.legs.length - 1; i >= 0; i--) {
      const leg = this.legs[i]!;
      legs.push({
        rsl: leg.rsl,
        reversed: !leg.reversed,
        sStart,
        lengthM: leg.lengthM,
        // A junction connector traversed backwards is not the authored turn.
        turnRelation: null,
      });
      sStart += leg.lengthM;
    }
    return Route.fromLegs(this.graph, legs);
  }

  /** Signed lateral offset of `p` from the centreline at `s` (`+` = left). */
  lateralOffsetAt(s: number, p: Vec2): number {
    const pose = this.poseAt(s);
    const dx = p.x - pose.point.x;
    const dy = p.y - pose.point.y;
    return -Math.sin(pose.headingRad) * dx + Math.cos(pose.headingRad) * dy;
  }
}

/* -------------------------------------------------------------- building */

function legFrom(graph: LaneGraph, d: DirectedLane, sStart: number, turnOverride?: TurnRelation | null): RouteLeg {
  const g = graph.requireGeometry(d.rsl);
  const turn = g.lane.isJunction ? graph.turnRelationOf(d.rsl) : null;
  return {
    rsl: d.rsl,
    reversed: d.reversed,
    sStart,
    lengthM: g.lengthM,
    turnRelation: turnOverride === undefined ? ((turn as TurnRelation | null) ?? null) : turnOverride,
  };
}

/** Build a route from an explicit ordered lane chain. */
export function buildLanePathRoute(
  graph: LaneGraph,
  lanes: readonly LaneRsl[],
): { ok: true; route: Route } | { ok: false; error: RouteBuildError } {
  if (lanes.length === 0) return { ok: false, error: { code: 'route_empty', reason: 'no lanes' } };
  for (const rsl of lanes) {
    if (!graph.geometry(rsl)) {
      return {
        ok: false,
        error: { code: 'route_lane_missing', reason: `lane ${rsl} not in topology`, detail: { rsl } },
      };
    }
  }
  // Orient the first lane: prefer its nominal direction, but if a second lane
  // exists take whichever orientation actually connects to it.
  const first = lanes[0]!;
  let firstReversed = graph.nominalReversed(first) ?? false;
  if (lanes.length > 1) {
    const next = lanes[1]!;
    let matched = false;
    for (const reversed of [firstReversed, !firstReversed]) {
      const exit = graph.endpoints({ rsl: first, reversed }).exit;
      if (graph.orientToward(next, exit)) {
        firstReversed = reversed;
        matched = true;
        break;
      }
    }
    if (!matched) {
      return {
        ok: false,
        error: {
          code: 'route_disconnected',
          reason: `lane ${first} does not connect to ${next} within ${ENDPOINT_TOL_M} m`,
          detail: { from: first, to: next },
        },
      };
    }
  }

  const legs: RouteLeg[] = [legFrom(graph, { rsl: first, reversed: firstReversed }, 0)];
  for (let i = 1; i < lanes.length; i++) {
    const prev = legs[legs.length - 1]!;
    const exit = graph.endpoints(prev).exit;
    const oriented = graph.orientToward(lanes[i]!, exit);
    if (!oriented) {
      const gap = Math.min(
        dist(exit, graph.endpoints({ rsl: lanes[i]!, reversed: false }).entry),
        dist(exit, graph.endpoints({ rsl: lanes[i]!, reversed: true }).entry),
      );
      return {
        ok: false,
        error: {
          code: 'route_disconnected',
          reason: `lane ${prev.rsl} does not connect to ${lanes[i]} (gap ${gap.toFixed(2)} m > ${ENDPOINT_TOL_M} m)`,
          detail: { from: prev.rsl, to: lanes[i], gapM: gap },
        },
      };
    }
    legs.push(legFrom(graph, oriented, prev.sStart + prev.lengthM));
  }
  return { ok: true, route: Route.fromLegs(graph, legs) };
}

/**
 * Choose a connected, legal-direction lane path for a newly placed road actor.
 * The exact chosen lane chain is intended to be persisted. At every branch we
 * prefer a topology-labelled Straight movement, then the geometrically
 * straightest continuation. Turns are therefore a fallback rather than an
 * implicit random behaviour; an authored route interaction remains the only
 * way to request a different movement.
 */
export function buildDefaultPlacementRoute(
  graph: LaneGraph,
  options: PlacementRouteOptions,
): SeededPlacementRouteResult {
  const geometry = graph.geometry(options.startRsl);
  if (!geometry || geometry.lane.laneType !== 'driving') {
    return { ok: false, error: { code: 'route_lane_missing', reason: `no driving lane ${options.startRsl} in topology`, detail: { rsl: options.startRsl } } };
  }
  const required = Math.max(1, options.requiredDownstreamM);
  const maxLegs = Math.max(1, Math.min(128, options.maxLegs ?? 64));
  const nominal = graph.nominalReversed(options.startRsl);
  const orientations = nominal === null ? [false, true] : [nominal];

  for (const reversed of orientations) {
    const start: DirectedLane = { rsl: options.startRsl, reversed };
    const startAhead = reversed
      ? Math.max(0, Math.min(geometry.lengthM, options.startStorageS))
      : Math.max(0, geometry.lengthM - Math.max(0, Math.min(geometry.lengthM, options.startStorageS)));
    const lanes: LaneRsl[] = [options.startRsl];
    const visited = new Set([routeDirectedKey(start)]);
    let current = start;
    let downstreamM = startAhead;

    while (lanes.length < maxLegs) {
      const candidates = graph.successors(current)
        .filter((candidate) => graph.geometry(candidate.rsl)?.lane.laneType === 'driving')
        .filter((candidate) => !visited.has(routeDirectedKey(candidate)))
        .sort((a, b) => compareContinuation(graph, current, a, b));
      // Persist one meaningful continuation even if the starting lane alone is
      // long enough. After that, the requested distance is only a preview
      // length; it never justifies replacing an available straight movement
      // with a turn that happens to have more runway.
      if (downstreamM >= required && (lanes.length > 1 || candidates.length === 0)) break;
      const next = candidates[0];
      if (!next) break;
      lanes.push(next.rsl);
      visited.add(routeDirectedKey(next));
      downstreamM += graph.lengthOf(next.rsl);
      current = next;
    }

    const built = buildLanePathRoute(graph, lanes);
    if (!built.ok) continue;
    const spawnS = built.route.sOfLaneStorage(options.startRsl, options.startStorageS);
    if (spawnS === null) continue;
    return {
      ok: true,
      route: built.route,
      lanes,
      downstreamM: Math.max(0, built.route.lengthM - spawnS),
    };
  }
  return {
    ok: false,
    error: {
      code: 'route_disconnected',
      reason: `no connected driving route from ${options.startRsl} provides ${required.toFixed(1)} m downstream`,
      detail: { startRsl: options.startRsl, requiredDownstreamM: required, maxLegs },
    },
  };
}

/** @deprecated Use `buildDefaultPlacementRoute`; default routes are no longer random. */
export function buildSeededPlacementRoute(
  graph: LaneGraph,
  options: SeededPlacementRouteOptions,
): SeededPlacementRouteResult {
  return buildDefaultPlacementRoute(graph, options);
}

function compareContinuation(graph: LaneGraph, current: DirectedLane, a: DirectedLane, b: DirectedLane): number {
  const gates = graph.gatesFrom(current.rsl);
  const relation = (candidate: DirectedLane): TurnRelation | null =>
    (gates.find((gate) => gate.connectingLaneRsl === candidate.rsl)?.turnRelation as TurnRelation | undefined) ?? null;
  const score = (candidate: DirectedLane): number => {
    if (relation(candidate) === 'Straight') return -1;
    const from = graph.sampleDirected(current, graph.lengthOf(current.rsl)).headingRad;
    const to = graph.sampleDirected(candidate, 0).headingRad;
    return Math.abs(normalizeAngle(to - from));
  };
  return score(a) - score(b) || routeDirectedKey(a).localeCompare(routeDirectedKey(b));
}

const TURN_FALLBACK_ORDER: TurnRelation[] = ['Straight', 'Right', 'Left', 'UTurnRight', 'UTurnLeft'];

/**
 * Walk successors from `startRsl`, consuming `turns` at each junction.
 *
 * Choice rule (deterministic): the requested turn if a complete, connected
 * gate movement offers it, else the first available relation in `Straight,
 * Right, Left, UTurnRight, UTurnLeft`, else the straightest successor. Ties
 * within a relation prefer the smallest heading deflection, closest exit-lane
 * lineage and then stable topology ids. A chosen gate is completed atomically
 * through its exit lane even when the preview bound falls inside the junction.
 */
export function buildFollowRoute(
  graph: LaneGraph,
  startRsl: LaneRsl,
  turns: readonly TurnRelation[],
  maxLengthM: number,
  startReversed?: boolean,
  options: { strictTurns?: boolean } = {},
): { ok: true; route: Route } | { ok: false; error: RouteBuildError } {
  if (!graph.geometry(startRsl)) {
    return {
      ok: false,
      error: { code: 'route_lane_missing', reason: `lane ${startRsl} not in topology`, detail: { rsl: startRsl } },
    };
  }
  const reversed = startReversed ?? graph.nominalReversed(startRsl) ?? false;
  const legs: RouteLeg[] = [legFrom(graph, { rsl: startRsl, reversed }, 0)];
  const visited = new Set<string>([`${startRsl}#${reversed ? 'r' : 'f'}`]);
  let turnIdx = 0;

  while (true) {
    const current = legs[legs.length - 1]!;
    const routeEndM = current.sStart + current.lengthM;
    const gates = graph.gatesFrom(current.rsl);
    const want = turns[turnIdx];
    // `maxLengthM` limits ordinary route preview runway. It must not suppress
    // an explicit movement merely because the approach lane itself is longer
    // than the preview. In that case include the requested connector, then let
    // the next iteration apply the normal length bound.
    const requestedMovementIsHere = want !== undefined && gates.some((gate) => gate.turnRelation === want);
    if (routeEndM >= maxLengthM && !requestedMovementIsHere) break;
    const succ = graph.successors(current)
      .filter((d) => !visited.has(`${d.rsl}#${d.reversed ? 'r' : 'f'}`))
      .sort((a, b) => compareContinuation(graph, current, a, b));
    if (succ.length === 0) break;

    let chosen = succ[0]!;
    let chosenGate: (typeof gates)[number] | undefined;
    if (gates.length > 0) {
      const byRelation = new Map<TurnRelation, Array<{ lane: DirectedLane; gate: (typeof gates)[number] }>>();
      for (const g of gates) {
        const match = succ.find((d) => d.rsl === g.connectingLaneRsl);
        if (!match) continue;
        // A gate is only addressable when its complete movement chain is
        // geometrically traversable. This prevents a stale/disconnected gate
        // alternative from shadowing a valid movement with the same relation.
        if (connectedGateExits(graph, g, match).length === 0) continue;
        const relation = g.turnRelation as TurnRelation;
        const candidates = byRelation.get(relation) ?? [];
        // Keep duplicate connector alternatives until after ranking: their
        // exit lineage or heading metadata can differ even when the connector
        // RSL is the same.
        candidates.push({ lane: match, gate: g });
        byRelation.set(relation, candidates);
      }
      for (const candidates of byRelation.values()) {
        candidates.sort((a, b) =>
          Math.abs(a.gate.headingChangeRad) - Math.abs(b.gate.headingChangeRad) ||
          gateLineageDelta(graph, a.gate) - gateLineageDelta(graph, b.gate) ||
          routeDirectedKey(a.lane).localeCompare(routeDirectedKey(b.lane)) ||
          a.gate.id.localeCompare(b.gate.id));
      }
      if (want !== undefined && options.strictTurns && !byRelation.get(want)?.[0]) {
        return {
          ok: false,
          error: {
            code: 'route_turn_unavailable',
            reason: `${want} is not a legal movement at the next junction from lane ${current.rsl}`,
            detail: {
              rsl: current.rsl,
              requestedTurn: want,
              availableTurns: [...byRelation.keys()].sort(),
            },
          },
        };
      }
      const pick = (want !== undefined ? byRelation.get(want)?.[0] : undefined) ??
        TURN_FALLBACK_ORDER.map((r) => byRelation.get(r)?.[0]).find((candidate) => candidate !== undefined);
      if (pick) {
        chosen = pick.lane;
        chosenGate = pick.gate;
        if (want !== undefined && pick.gate.turnRelation === want) turnIdx++;
      }
    }
    visited.add(`${chosen.rsl}#${chosen.reversed ? 'r' : 'f'}`);
    const connectorLeg = legFrom(
      graph,
      chosen,
      current.sStart + current.lengthM,
      chosenGate ? chosenGate.turnRelation as TurnRelation : undefined,
    );
    legs.push(connectorLeg);
    if (chosenGate) {
      // A selected gate is an atomic approach -> connector -> exit movement.
      // Finish it even when the preview length ends inside the junction; this
      // leaves a stable road-lane lineage for retargeting and replay.
      const gateExit = connectedGateExits(graph, chosenGate, chosen)
        .filter((candidate) => !visited.has(routeDirectedKey(candidate)))
        .sort((a, b) => compareGateExit(graph, chosenGate!, a, b))[0];
      if (gateExit) {
        visited.add(routeDirectedKey(gateExit));
        legs.push(legFrom(graph, gateExit, connectorLeg.sStart + connectorLeg.lengthM));
      }
    }
  }
  if (options.strictTurns && turnIdx < turns.length) {
    const want = turns[turnIdx]!;
    return {
      ok: false,
      error: {
        code: 'route_turn_unavailable',
        reason: `no junction offering ${want} is reachable from lane ${startRsl} within the route horizon`,
        detail: { rsl: startRsl, requestedTurn: want, availableTurns: [] },
      },
    };
  }
  return { ok: true, route: Route.fromLegs(graph, legs) };
}

function connectedGateExits(
  graph: LaneGraph,
  gate: ReturnType<LaneGraph['gatesFrom']>[number],
  connector: DirectedLane,
): DirectedLane[] {
  const exitPoint = graph.endpoints(connector).exit;
  const connectorType = graph.geometry(connector.rsl)?.lane.laneType;
  return gate.exitLaneRsls
    .map((rsl) => graph.orientToward(rsl, exitPoint))
    .filter((candidate): candidate is DirectedLane => candidate !== null)
    .filter((candidate) => graph.geometry(candidate.rsl)?.lane.laneType === connectorType);
}

function gateLineageDelta(graph: LaneGraph, gate: ReturnType<LaneGraph['gatesFrom']>[number]): number {
  const approachLaneId = graph.geometry(gate.approachLaneRsl)?.lane.laneId;
  if (approachLaneId === undefined) return Number.POSITIVE_INFINITY;
  const exitLaneIds = gate.exitLaneRsls
    .map((rsl) => graph.geometry(rsl)?.lane.laneId)
    .filter((laneId): laneId is number => laneId !== undefined);
  return exitLaneIds.length === 0
    ? Number.POSITIVE_INFINITY
    : Math.min(...exitLaneIds.map((laneId) => Math.abs(laneId - approachLaneId)));
}

function compareGateExit(
  graph: LaneGraph,
  gate: ReturnType<LaneGraph['gatesFrom']>[number],
  a: DirectedLane,
  b: DirectedLane,
): number {
  const approachLaneId = graph.geometry(gate.approachLaneRsl)?.lane.laneId ?? 0;
  const laneDelta = (candidate: DirectedLane): number =>
    Math.abs((graph.geometry(candidate.rsl)?.lane.laneId ?? approachLaneId) - approachLaneId);
  return laneDelta(a) - laneDelta(b) || routeDirectedKey(a).localeCompare(routeDirectedKey(b));
}

/** Resolve a `RouteSpec` from the input document. */
export function buildRoute(
  graph: LaneGraph,
  spec: RouteSpec,
): { ok: true; route: Route } | { ok: false; error: RouteBuildError } {
  switch (spec.kind) {
    case 'lanePath':
      return buildLanePathRoute(graph, spec.lanes);
    case 'follow':
      return buildFollowRoute(graph, spec.startRsl, spec.turns, spec.maxLengthM);
    case 'polyline':
      return { ok: true, route: Route.fromPolyline(spec.points.map(localFromScene)) };
    case 'timedPolyline':
      return { ok: true, route: Route.fromPolyline(spec.points.map(localFromScene)) };
  }
}

/**
 * Re-base a route onto the lateral neighbour at the actor's current position.
 *
 * Returns the new route plus the arc length that corresponds to the actor's
 * position on it, and the lane separation to subtract from the lateral offset.
 */
export function retargetToNeighbour(
  graph: LaneGraph,
  route: Route,
  sNow: number,
  side: 'left' | 'right',
  opts: { legalOnly: boolean; remainingTurns?: readonly TurnRelation[]; maxLengthM?: number },
): { route: Route; s: number; separationM: number; legal: boolean; targetRsl: LaneRsl } | null {
  const pose = route.poseAt(sNow);
  if (!pose.rsl) return null;
  const leg = route.legs[pose.legIndex]!;
  const storageS = leg.reversed ? leg.lengthM - pose.laneS : pose.laneS;
  // `adjacentLanes.left/right` is expressed in storage orientation; a reversed
  // leg swaps the driver's left and right.
  const storageSide: 'left' | 'right' = leg.reversed ? (side === 'left' ? 'right' : 'left') : side;
  const neighbour = graph.lateralNeighbour(pose.rsl, storageSide, storageS, opts.legalOnly);
  if (!neighbour) return null;
  const built = buildFollowRoute(
    graph,
    neighbour.rsl,
    retainedTurns(route, sNow, opts.remainingTurns),
    opts.maxLengthM ?? 2000,
    leg.reversed,
  );
  if (!built.ok) return null;
  const proj = built.route.projectPoint(pose.point);
  const separation = (route.widthAt(sNow) + built.route.widthAt(proj.s)) / 2;
  return {
    route: built.route,
    s: proj.s,
    separationM: side === 'left' ? separation : -separation,
    legal: neighbour.legal,
    targetRsl: neighbour.rsl,
  };
}

/** Build a route that starts on `targetRsl` near `point` (used by `changeLane`
 * with an explicit lane target). */
export function retargetToLane(
  graph: LaneGraph,
  route: Route,
  sNow: number,
  targetRsl: LaneRsl,
  opts: { remainingTurns?: readonly TurnRelation[]; maxLengthM?: number } = {},
): { route: Route; s: number; separationM: number } | null {
  if (!graph.geometry(targetRsl)) return null;
  const pose = route.poseAt(sNow);
  const leg = pose.legIndex >= 0 ? route.legs[pose.legIndex] : undefined;
  const built = buildFollowRoute(
    graph,
    targetRsl,
    retainedTurns(route, sNow, opts.remainingTurns),
    opts.maxLengthM ?? 2000,
    leg?.reversed,
  );
  if (!built.ok) return null;
  const proj = built.route.projectPoint(pose.point);
  const lateral = built.route.lateralOffsetAt(proj.s, pose.point);
  return { route: built.route, s: proj.s, separationM: -lateral };
}

/** Preserve the route's already-authored junction intent across a lateral lane
 * change. A lane change changes lateral position, not the next turn. */
function retainedTurns(
  route: Route,
  sNow: number,
  explicit: readonly TurnRelation[] | undefined,
): readonly TurnRelation[] {
  if (explicit && explicit.length > 0) return explicit;
  const currentLeg = route.legIndexAt(sNow);
  return route.legs
    .slice(Math.max(0, currentLeg + 1))
    .map((leg) => leg.turnRelation)
    .filter((turn): turn is TurnRelation => turn !== null);
}

/** Distance along a shared route between two arc lengths, or `null`. */
export function alongRouteGap(leaderS: number, followerS: number): number {
  return leaderS - followerS;
}

/** Closest approach between a point and a polyline, used by region tests. */
export function pointToPolyline(p: Vec2, poly: readonly Vec2[]): number {
  let best = Infinity;
  for (let i = 1; i < poly.length; i++) {
    const r = pointSegment(p, poly[i - 1]!, poly[i]!);
    if (r.d2 < best) best = r.d2;
  }
  return Math.sqrt(best);
}
