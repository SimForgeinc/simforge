/**
 * Derive the route a placed vehicle drives when nobody drew one.
 *
 * ## Why this replaces `autopilot`
 *
 * The authoring model is: place a car on a lane and it drives — straight, along
 * the lane, at a speed — and the timeline steers it. Nothing about "where does
 * it go" is authored or stored for the common case
 * (`plans/2026-07-29-one-motion-model.md`). Something still has to answer the
 * question, and there were only ever two candidates:
 *
 * - **CARLA's Traffic Manager.** Reproducible today, but a function of the CARLA
 *   build, the map revision and the TM's own implementation, with no
 *   OpenSCENARIO equivalent. `compile-autopilot-route.ts`'s header documents why
 *   that is a bad thing to depend on.
 * - **The lane graph, walked deterministically.** Pure, offline, exportable, and
 *   identical in the browser and the worker because both derive it from the same
 *   published graph.
 *
 * This is the second one. It is `compileAutopilotRoute`'s walk with two changes,
 * and it deliberately reuses that walk rather than forking it: junction choice
 * becomes **straightest-first** instead of seeded, and an ordered list of
 * authored turn intents can override the choice at successive junctions.
 *
 * ## Straightest, not seeded
 *
 * A seeded pick is right for ambient traffic — you want a spread of behaviour
 * across a population, and each car stable run to run. It is wrong for an
 * authored actor: "I placed a car here" means "it carries on", not "it takes a
 * hash-determined turn at the next intersection". Straightest-first makes the
 * default legible, which is the property an author needs from a route they did
 * not draw.
 *
 * ## Turn intents
 *
 * `turnAtJunctions` is consumed in order, one per junction the walk reaches. It
 * is how a `turn` interaction clip ("turn left at the next junction") becomes
 * geometry without the author placing a single point. An intent that no movement
 * at that junction can satisfy is reported in `unmetTurns` and the walk falls
 * back to straightest — reporting rather than guessing, because a turn the map
 * cannot make is an authoring error the editor must surface, not a silent
 * straight-on.
 */

import { distance3dOr2d, orientToJoin, polylineLength } from "./geometry";
import { runtimeBindingAtCorridorStation } from "./corridor-station";
import { junctionInterior } from "./junction-interior";
import { cropPolylineToAnchors } from "./polyline-interval";
import {
  joinsWalk,
  maintainsUnauthoredProgress,
  trimTerminalDetour,
} from "./route-walk-guards";
import { corridorWalkIndices } from "./walk-orientation";
import type {
  JunctionMovement,
  JunctionMovementVariant,
  LaneCorridor,
  SemanticMapGraph,
  SemanticMapPoint,
} from "./types";
import type { TurnRelation } from "../map-topology/types";
import { JUNCTION_TURN_WEIGHTS } from "../junction-direction";
import { junctionTurnForRelation } from "../map-topology/build-topology-index";

/**
 * What an authored `turn` clip asks for at one junction.
 *
 * `"straight"` is spellable so an author can override a default that would
 * otherwise turn (a junction whose only movements bend, e.g. a fork) and so a
 * caller can pad the list positionally.
 */
export type RunwayTurnIntent = "left" | "right" | "straight" | "u_turn";

export type DerivedRunwayAnchor = {
  x: number;
  y: number;
  z: number;
  /** Degrees, runtime frame — heading of travel AT this anchor. */
  yaw: number;
  /** The lane's POSTED limit arriving here. Reported, never commanded. */
  speed_limit_kph: number | null;
  /** `road:section:lane`, for the runtime's anchor authentication. Null in junctions. */
  rsl: string | null;
  /** Fraction along `rsl`'s road `+s` axis. Null exactly when `rsl` is. */
  s_fraction: number | null;
};

export type DerivedRunwayLeg = {
  kind: "corridor" | "junction";
  id: string;
  lengthM: number;
  turn?: TurnRelation;
  /** True when an authored intent chose this junction rather than the default. */
  authored?: boolean;
};

export type DerivedRunwayTermination = "budget" | "dead_end" | "cycle_guard";

/**
 * WHY the walk stopped, when it stopped early.
 *
 * `dead_end` alone is not actionable, and for a long time it was usually not
 * even true: it meant the junction ahead had been dropped by the compiler, not
 * that the road ended. Two causes, both since fixed, and the history is worth
 * keeping because both were invisible from inside this file:
 *
 * - Junction seams failed on geometry the CARLA crawl had truncated
 *   (`GATE_GEOMETRY_DISCONTINUITY`, fixed by `runtime-lane-geometry.ts`'s
 *   splice). On San Ramon Part 1, 2026-07-29, 684 of 941 variants were
 *   `diagnostic_only` and the median walk covered one ~20 m corridor.
 * - Gates naming a lane shorter than the crawl's sampling step could not bind at
 *   all, because that lane appears in no crawled segment (fixed by link-attested
 *   binding in `build-runtime-parity.ts`).
 *
 * After both, 2026-07-30 over the nine dev maps: 98.1 % of gates a car can
 * arrive on bind, and an early stop is now usually honest. Of the corridors with
 * no authorable way out, CARLA's own successors agree there is nowhere to go for
 * the large majority; only 9 across all nine maps are a connection the runtime
 * has and this graph does not.
 *
 * So `stopReason` is still worth surfacing verbatim in the editor — "route ends
 * here" with no reason sends an author hunting a bug in their scenario — but
 * `no_continuation` should now be read as probably real. Re-measure with
 * `scripts/agent/connectivity-scorecard.mjs` before believing otherwise.
 */
export type DerivedRunwayStopReason =
  /** Covered the requested distance. Healthy. */
  | "budget_reached"
  /** The junction ahead offers variants, but none is authorable. */
  | "junction_unbound"
  /** Genuinely nowhere to go: map boundary or a real dead end. */
  | "no_continuation"
  /** Re-entered one corridor too many times. */
  | "cycle_guard"
  /** The start point matched no authorable corridor. */
  | "unplaced";

export type DerivedRunway = {
  anchors: DerivedRunwayAnchor[];
  legs: DerivedRunwayLeg[];
  travelledM: number;
  terminated: DerivedRunwayTermination;
  /** Why the walk stopped. See {@link DerivedRunwayStopReason}. */
  stopReason: DerivedRunwayStopReason;
  /**
   * Turn intents no junction could satisfy, by their index in the input.
   *
   * The editor turns these into a blocker on the clip ("no left turn at that
   * junction"). Empty on a healthy derivation.
   */
  unmetTurns: number[];
  /**
   * How far the actor stands from the corridor the walk started on, in metres.
   *
   * A lane-placed car is centimetres from its centerline. Metres means the actor
   * is not on a road at all — a parking bay, a driveway, a lot aisle with no
   * OpenDRIVE lane — and its motion belongs to an `off_road` tail rather than a
   * derived route. The editor reads this to say "this car isn't on a road"
   * instead of silently driving it down the nearest one.
   */
  startDistanceM: number;
};

export type DeriveRunwayArgs = {
  graph: SemanticMapGraph;
  /** Where the actor sits, in world metres. The authority — never a road id. */
  start: { x: number; y: number };
  /**
   * Which way the actor FACES, in degrees, runtime frame. Optional but strongly
   * advised: without it the start corridor is chosen by proximity alone, and
   * proximity cannot tell apart the two directions of a two-way road or the
   * paired lanes of a parking aisle.
   *
   * Measured 2026-07-29 against the eval corpus: omitting it put six actors on
   * the correct road travelling backwards — 0.0 m from the authored route with a
   * 180 degree heading error (B2, B4, B6, F10, S12 and B2-nodist). Distance
   * alone cannot catch that, which is exactly why the equivalence harness checks
   * heading too.
   */
  startHeadingDeg?: number;
  /** Distance to cover. See {@link runwayBudgetM}. */
  travelBudgetM: number;
  /** Authored turn intents, consumed one per junction in order. */
  turnAtJunctions?: readonly RunwayTurnIntent[];
  /**
   * How an UNAUTHORED junction is decided. Defaults to straightest.
   *
   * Straightest is the right default and the wrong universal: it is what "I
   * placed a car and it carries on" means, but applied to a whole lane of
   * generated ambient traffic it sends every car through the intersection
   * together, which is the one thing ambient traffic exists not to do. So the
   * weighted draw stays available, seeded per actor — stable for one car across
   * runs, different between cars. An authored intent still wins over either.
   */
  pick?: RunwayBranchPick;
  /** `FollowRouteActionSchema` caps anchors at 32. Overridable for tests. */
  anchorCap?: number;
  /** How far a simplified runway may deviate from the centerline, in metres. */
  toleranceM?: number;
};

/**
 * How a junction with no authored intent is decided.
 *
 * `seed` is a string rather than a number so callers pass something meaningful
 * (an actor id) and two actors cannot collide by both hashing to zero.
 */
export type RunwayBranchPick =
  | { kind: "straightest" }
  | { kind: "weighted"; seed: string };

/**
 * xmur3 + mulberry32: a string seed to a stable stream.
 *
 * Deterministic across processes and platforms, which is the only property that
 * matters here — the browser preview, the server corridor build and the worker
 * must all draw the same branch for the same car or the three disagree about
 * where a car went.
 */
function seededRng(seed: string): () => number {
  let h = 1779033703 ^ seed.length;
  for (let index = 0; index < seed.length; index += 1) {
    h = Math.imul(h ^ seed.charCodeAt(index), 3432918353);
    h = (h << 13) | (h >>> 19);
  }
  let state = (h ^= h >>> 16) >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Draw one variant, weighted by which movement it is.
 *
 * Candidates are sorted by id first: the graph's array order is a build
 * artifact, and drawing from an unsorted list would hand the same car a
 * different branch after a graph rebuild that changed nothing about the map.
 * Falls back to straightest when nothing classifies, rather than inventing a
 * direction for degenerate geometry.
 */
function weightedVariant(
  variants: readonly JunctionMovementVariant[],
  movementsById: Map<string, JunctionMovement>,
  approachHeading: number | null,
  rng: () => number,
): JunctionMovementVariant | null {
  if (variants.length === 0) return null;
  const ordered = [...variants].sort((left, right) => left.id.localeCompare(right.id));
  const weights = ordered.map((variant) => {
    const relation = movementsById.get(variant.movementId)?.turnRelation;
    return relation === undefined ? 0 : JUNCTION_TURN_WEIGHTS[junctionTurnForRelation(relation)];
  });
  const total = weights.reduce((sum, weight) => sum + weight, 0);
  if (total <= 0) return straightestVariant(ordered, movementsById, approachHeading);
  let target = rng() * total;
  for (let index = 0; index < ordered.length; index += 1) {
    target -= weights[index]!;
    if (target <= 0) return ordered[index]!;
  }
  return ordered[ordered.length - 1]!;
}

const DEFAULT_ANCHOR_CAP = 32;
const DEFAULT_TOLERANCE_M = 1.5;
const MAX_CORRIDOR_VISITS = 1;

/**
 * How far the walk should go, given how long the scenario runs.
 *
 * The margin is not decoration. A runway that ends mid-run leaves the car
 * braking to a stop under the hand brake (`reached_path_end` in
 * `actor_control.py:1313`), which reads as a frozen ego and has cost the
 * generator real debugging time. Overshooting costs nothing — surplus anchors
 * past the end of the run are never reached.
 */
export function runwayBudgetM(durationSeconds: number, speedKph: number): number {
  const metresPerSecond = Math.max(0, speedKph) / 3.6;
  const nominal = metresPerSecond * Math.max(0, durationSeconds);
  return Math.max(50, nominal * 1.5);
}

const TURN_RELATIONS: Record<RunwayTurnIntent, readonly TurnRelation[]> = {
  left: ["Left"],
  right: ["Right"],
  straight: ["Straight"],
  u_turn: ["UTurnLeft", "UTurnRight"],
};

/**
 * How far a JUNCTION movement may turn away from the approach before the walk
 * treats it as a broken edge rather than a turn.
 *
 * The seam limit (`maximumSeamHeadingDeltaRad`, 30 degrees on every published
 * graph) is the wrong instrument here and applying it was a category error: it
 * measures whether two lanes are CONTINUOUS, and a junction movement is not
 * meant to be — turning is the entire point. What the walk actually has to
 * refuse at a junction is a variant it would have to drive BACKWARDS to reach,
 * which is what the guard was added for (corridor successors joining at 166-180
 * degrees). A right angle separates those two cases cleanly.
 *
 * On the nine dev maps this changes nothing measurable — 0 of Di Rosa's 278
 * variants enter at more than 30 degrees, because a variant's interior is
 * sampled about every metre and develops its turn gradually. It matters where
 * the geometry is COARSE: a connector represented by a handful of points swings
 * its first segment through the whole turn at once, and at 30 degrees the walk
 * discarded it, leaving a car that was authored to turn left driving straight
 * through with no diagnostic. Silent is what made it worth fixing.
 *
 * A declared U-turn is exempt: reversing is what it is for, so only the gap
 * check applies to it.
 */
const JUNCTION_ENTRY_HEADING_LIMIT_RAD = Math.PI / 2;

const U_TURN_RELATIONS: ReadonlySet<TurnRelation> = new Set<TurnRelation>([
  "UTurnLeft",
  "UTurnRight",
]);

function isAuthorable(entity: { authoringStatus: string }): boolean {
  return entity.authoringStatus === "authorable";
}

function isUTurn(movement: JunctionMovement | undefined): boolean {
  return movement?.turnRelation === "UTurnLeft" || movement?.turnRelation === "UTurnRight";
}

/** Heading of a polyline's first meaningful segment, in radians. */
function entryHeading(points: readonly SemanticMapPoint[]): number | null {
  for (let index = 1; index < points.length; index += 1) {
    const dx = points[index]!.x - points[0]!.x;
    const dy = points[index]!.y - points[0]!.y;
    if (Math.hypot(dx, dy) > 1e-6) return Math.atan2(dy, dx);
  }
  return null;
}

/** Heading of a polyline's last meaningful segment, in radians. */
function exitHeading(points: readonly SemanticMapPoint[]): number | null {
  const last = points.length - 1;
  for (let index = last - 1; index >= 0; index -= 1) {
    const dx = points[last]!.x - points[index]!.x;
    const dy = points[last]!.y - points[index]!.y;
    if (Math.hypot(dx, dy) > 1e-6) return Math.atan2(dy, dx);
  }
  return null;
}

/**
 * Absolute heading change across a variant, in radians. Infinity when unmeasurable.
 *
 * Measured over the junction interior, because that is the turn. Over the whole
 * polyline the entry heading is taken ~66 m upstream of the junction and the
 * exit heading well past it, so a bend in the approach or exit lane reads as
 * part of the turn and `straightestVariant` ranks on the wrong geometry.
 */
function headingChange(
  variant: JunctionMovementVariant,
  approachHeading: number | null,
): number {
  const interior = junctionInterior(variant).points;
  const exit = exitHeading(interior);
  const entry = entryHeading(interior) ?? approachHeading;
  if (exit === null || entry === null) return Number.POSITIVE_INFINITY;
  let delta = exit - entry;
  while (delta > Math.PI) delta -= 2 * Math.PI;
  while (delta < -Math.PI) delta += 2 * Math.PI;
  return Math.abs(delta);
}

/**
 * The default junction choice: straightest wins.
 *
 * `turnRelation === "Straight"` is trusted first because it is the map index's
 * own classification and is stable across graph rebuilds; geometry breaks ties
 * and covers junctions where nothing is classified straight (a fork, a bend).
 * Ids break the final tie so the choice cannot depend on the graph's array
 * order, which is a build artifact rather than a fact about the map — the same
 * reason `seededPick` sorts.
 */
function straightestVariant(
  variants: readonly JunctionMovementVariant[],
  movementsById: Map<string, JunctionMovement>,
  approachHeading: number | null,
): JunctionMovementVariant | null {
  if (variants.length === 0) return null;
  const ranked = [...variants].sort((left, right) => {
    const leftStraight = movementsById.get(left.movementId)?.turnRelation === "Straight";
    const rightStraight = movementsById.get(right.movementId)?.turnRelation === "Straight";
    if (leftStraight !== rightStraight) return leftStraight ? -1 : 1;
    const delta = headingChange(left, approachHeading) - headingChange(right, approachHeading);
    if (Math.abs(delta) > 1e-9) return delta;
    return left.id.localeCompare(right.id);
  });
  return ranked[0] ?? null;
}

/** Variants satisfying an authored intent, in the same straightest-first order. */
function variantsForIntent(
  variants: readonly JunctionMovementVariant[],
  movementsById: Map<string, JunctionMovement>,
  intent: RunwayTurnIntent,
): JunctionMovementVariant[] {
  const wanted = new Set<TurnRelation>(TURN_RELATIONS[intent]);
  return variants.filter((variant) => {
    const relation = movementsById.get(variant.movementId)?.turnRelation;
    return relation !== undefined && wanted.has(relation);
  });
}

const distance = distance3dOr2d;

function cumulativeStations(points: readonly SemanticMapPoint[]): number[] {
  const stations = new Array<number>(points.length);
  let total = 0;
  stations[0] = 0;
  for (let index = 1; index < points.length; index += 1) {
    total += distance(points[index - 1]!, points[index]!);
    stations[index] = total;
  }
  return stations;
}

function nearestVertexIndex(
  points: readonly SemanticMapPoint[],
  target: { x: number; y: number },
): number {
  let best = 0;
  let bestDistance = Infinity;
  for (let index = 0; index < points.length; index += 1) {
    const point = points[index]!;
    const candidate = Math.hypot(point.x - target.x, point.y - target.y);
    if (candidate < bestDistance) {
      bestDistance = candidate;
      best = index;
    }
  }
  return best;
}

function perpendicularDistance(
  point: SemanticMapPoint,
  start: SemanticMapPoint,
  end: SemanticMapPoint,
): number {
  const dx = end.x - start.x;
  const dy = end.y - start.y;
  const lengthSq = dx * dx + dy * dy;
  if (lengthSq === 0) return distance(point, start);
  const t = ((point.x - start.x) * dx + (point.y - start.y) * dy) / lengthSq;
  const clamped = Math.max(0, Math.min(1, t));
  return Math.hypot(
    point.x - (start.x + clamped * dx),
    point.y - (start.y + clamped * dy),
  );
}

/** Ramer-Douglas-Peucker over indices, so per-point metadata survives. */
function simplifyIndices(
  points: readonly SemanticMapPoint[],
  toleranceM: number,
): number[] {
  // Negative means "do not simplify" for conformance tooling. Zero is not
  // enough: RDP still drops exactly-collinear crawl samples at zero tolerance,
  // hiding the true gap distribution the continuity check needs to measure.
  if (toleranceM < 0) return points.map((_, index) => index);
  if (points.length <= 2) return points.map((_, index) => index);
  const keep = new Set<number>([0, points.length - 1]);
  const walk = (first: number, last: number): void => {
    if (last <= first + 1) return;
    let worst = -1;
    let worstDistance = 0;
    for (let index = first + 1; index < last; index += 1) {
      const candidate = perpendicularDistance(points[index]!, points[first]!, points[last]!);
      if (candidate > worstDistance) {
        worstDistance = candidate;
        worst = index;
      }
    }
    if (worst === -1 || worstDistance <= toleranceM) return;
    keep.add(worst);
    walk(first, worst);
    walk(worst, last);
  };
  walk(0, points.length - 1);
  return [...keep].sort((left, right) => left - right);
}

function thinToCap(
  points: readonly SemanticMapPoint[],
  indices: readonly number[],
  cap: number,
): number[] {
  const kept = [...indices];
  while (kept.length > cap) {
    let victim = -1;
    let victimCost = Infinity;
    for (let position = 1; position < kept.length - 1; position += 1) {
      const cost = perpendicularDistance(
        points[kept[position]!]!,
        points[kept[position - 1]!]!,
        points[kept[position + 1]!]!,
      );
      if (cost < victimCost) {
        victimCost = cost;
        victim = position;
      }
    }
    if (victim === -1) break;
    kept.splice(victim, 1);
  }
  return kept;
}

function yawDegreesAt(points: readonly SemanticMapPoint[], index: number): number {
  const ahead = points[Math.min(index + 1, points.length - 1)]!;
  const behind = points[Math.max(index - 1, 0)]!;
  return (Math.atan2(ahead.y - behind.y, ahead.x - behind.x) * 180) / Math.PI;
}

type WalkPoint = {
  point: SemanticMapPoint;
  speedKph: number | null;
  rsl: string | null;
  sFraction: number | null;
};

/**
 * Walk the lane graph from where the actor stands and return the route it drives.
 *
 * Pure and offline: it never talks to CARLA, and it never reads a road id as a
 * position. Returns an empty anchor list rather than throwing when the start
 * matches no corridor — a car placed on a driveway is a legitimate scenario and
 * the caller reports it instead of failing the edit.
 */
export function deriveRunway(args: DeriveRunwayArgs): DerivedRunway {
  const {
    graph,
    start,
    startHeadingDeg,
    travelBudgetM,
    turnAtJunctions = [],
    pick = { kind: "straightest" } as RunwayBranchPick,
    anchorCap = DEFAULT_ANCHOR_CAP,
    toleranceM = DEFAULT_TOLERANCE_M,
  } = args;

  const corridorsById = new Map<string, LaneCorridor>(
    graph.corridors.map((corridor) => [corridor.id, corridor]),
  );
  const maximumJoinGapM = graph.buildConfig?.maximumSeamGapM ?? 3;
  const maximumJoinHeadingDeltaRad =
    graph.buildConfig?.maximumSeamHeadingDeltaRad ?? Math.PI / 6;
  const walkPolylineById = new Map<string, SemanticMapPoint[]>();
  const walkPolyline = (corridor: LaneCorridor): SemanticMapPoint[] => {
    const cached = walkPolylineById.get(corridor.id);
    if (cached) return cached;
    const successors = corridor.successorCorridorIds
      .map((id) => corridorsById.get(id))
      .filter((next): next is LaneCorridor => next !== undefined && isAuthorable(next))
      .map((next) => next.polyline);
    const points = trimTerminalDetour(
      corridor.polyline,
      successors,
      maximumJoinGapM,
      maximumJoinHeadingDeltaRad,
    );
    walkPolylineById.set(corridor.id, points);
    return points;
  };
  const movementsById = new Map<string, JunctionMovement>(
    graph.movements.map((movement) => [movement.id, movement]),
  );
  const variantsByIncoming = new Map<string, JunctionMovementVariant[]>();
  // Every variant, authorable or not, indexed separately and used ONLY to
  // explain a stop. Without it the walk cannot tell "this road ends" from "this
  // junction's movements were rejected by the semantic compiler", because the
  // authorable filter has already removed the evidence. Rejections are rare now
  // (see `DerivedRunwayStopReason`) but the distinction is exactly the one an
  // author cannot make from the outside, so it stays measured rather than
  // assumed.
  const allVariantsByIncoming = new Map<string, JunctionMovementVariant[]>();
  for (const variant of graph.movementVariants) {
    const allBucket = allVariantsByIncoming.get(variant.incomingCorridorId);
    if (allBucket) allBucket.push(variant);
    else allVariantsByIncoming.set(variant.incomingCorridorId, [variant]);
    if (!isAuthorable(variant)) continue;
    const bucket = variantsByIncoming.get(variant.incomingCorridorId);
    if (bucket) bucket.push(variant);
    else variantsByIncoming.set(variant.incomingCorridorId, [variant]);
  }

  // Which corridor is the actor ON? Proximity picks the road; the actor's own
  // heading picks the DIRECTION, and only if it was supplied.
  //
  // A two-way road carries two corridors whose polylines are metres apart and
  // whose travel headings are 180 degrees opposed, so nearest-vertex alone is a
  // coin flip between "drives away down its lane" and "drives head-on into
  // oncoming traffic". Corridors travelling the wrong way are therefore ranked
  // behind every corridor travelling the right way, rather than excluded — an
  // actor genuinely placed against the lane (an against-lane recovery scenario)
  // still resolves, it just loses to any agreeing corridor nearby.
  const AGREEMENT_LIMIT_DEG = 90;
  let startCorridor: LaneCorridor | null = null;
  let startIndex = 0;
  let startDistance = Infinity;
  let startAgrees = false;
  for (const corridor of graph.corridors) {
    if (!isAuthorable(corridor)) continue;
    const corridorPolyline = walkPolyline(corridor);
    const index = nearestVertexIndex(corridorPolyline, start);
    const vertex = corridorPolyline[index]!;
    const candidate = Math.hypot(vertex.x - start.x, vertex.y - start.y);

    let agrees = true;
    if (startHeadingDeg !== undefined) {
      // The corridor's travel heading AT the nearest vertex, not overall: a long
      // corridor round a bend has no single direction.
      const ahead = corridorPolyline[Math.min(index + 1, corridorPolyline.length - 1)]!;
      const behind = corridorPolyline[Math.max(index - 1, 0)]!;
      const localHeadingDeg =
        (Math.atan2(ahead.y - behind.y, ahead.x - behind.x) * 180) / Math.PI;
      let delta = Math.abs(localHeadingDeg - startHeadingDeg) % 360;
      if (delta > 180) delta = 360 - delta;
      agrees = delta <= AGREEMENT_LIMIT_DEG;
    }

    const better =
      startCorridor === null ||
      (agrees && !startAgrees) ||
      (agrees === startAgrees && candidate < startDistance);
    if (better) {
      startDistance = candidate;
      startCorridor = corridor;
      startIndex = index;
      startAgrees = agrees;
    }
  }
  if (!startCorridor) {
    return {
      anchors: [],
      legs: [],
      travelledM: 0,
      terminated: "dead_end",
      stopReason: "unplaced",
      unmetTurns: [],
      startDistanceM: Number.POSITIVE_INFINITY,
    };
  }

  const walked: WalkPoint[] = [];
  const legs: DerivedRunwayLeg[] = [];
  const unmetTurns: number[] = [];
  // Which authored intent is still outstanding. Deliberately NOT a count of
  // junctions crossed — see the junction choice below.
  let intentCursor = 0;
  const visits = new Map<string, number>();
  let travelled = 0;
  let terminated: DerivedRunwayTermination = "budget";
  let stopReason: DerivedRunwayStopReason = "budget_reached";
  let current: LaneCorridor | null = startCorridor;
  let sliceFrom = startIndex;

  // One stream for the whole walk, not one per junction: a car's first and second
  // intersection have to be independent draws, and re-seeding from the actor id at
  // each would make every junction the same draw.
  const branchRng = pick.kind === "weighted" ? seededRng(pick.seed) : null;

  while (current && travelled < travelBudgetM) {
    const visitCount = (visits.get(current.id) ?? 0) + 1;
    visits.set(current.id, visitCount);
    if (visitCount > MAX_CORRIDOR_VISITS) {
      terminated = "cycle_guard";
      stopReason = "cycle_guard";
      break;
    }

    const currentPolyline = walkPolyline(current);
    const slice = currentPolyline.slice(sliceFrom);
    if (slice.length >= 2) {
      const legLength = polylineLength(slice);
      travelled += legLength;
      legs.push({ kind: "corridor", id: current.id, lengthM: legLength });
      const stations = cumulativeStations(currentPolyline);
      const corridorAtStation = current;
      for (const index of corridorWalkIndices(
        walked[walked.length - 1]?.point ?? null,
        currentPolyline,
        sliceFrom,
      )) {
        const binding = runtimeBindingAtCorridorStation(corridorAtStation, stations[index]!);
        walked.push({
          point: currentPolyline[index]!,
          speedKph: current.speedLimitKph,
          rsl: binding ? `${binding.roadId}:${binding.sectionId}:${binding.laneId}` : null,
          sFraction: binding ? binding.sFraction : null,
        });
      }
    }
    sliceFrom = 0;
    if (travelled >= travelBudgetM) break;

    const approachHeading = exitHeading(currentPolyline);
    const availableVariants = variantsByIncoming.get(current.id) ?? [];
    /**
     * Variants this junction can actually be driven through.
     *
     * `authored` relaxes the HEADING checks to the point where they only still
     * refuse driving backwards. The gap check is never relaxed: a variant the
     * car would have to teleport to is broken however explicitly it was asked
     * for, and that is the failure this guard was built for (successors named
     * 19.7-128.9 m away).
     *
     * The heading checks exist to keep an UNASKED continuation smooth. An
     * authored turn is not a continuation — it is an instruction, against a
     * movement the compiler already marked `authorable`. Refusing it because
     * the connector's last segment sits 45 degrees off the exit lane means a
     * car told to turn left drives straight through with no diagnostic, and
     * silence is the part that makes it dangerous. `maintainsUnauthoredProgress`
     * already draws this same line ("Authored turns bypass this guard; their
     * geometry is an explicit request").
     */
    const eligibleVariants = (authored: boolean): JunctionMovementVariant[] =>
      availableVariants.filter((variant) => {
        if (visits.has(variant.outgoingCorridorId)) return false;
        const interior = junctionInterior(variant).points;
        // Entering the junction is a TURN, not a seam: bound it by
        // `JUNCTION_ENTRY_HEADING_LIMIT_RAD` so a legitimate turn survives and a
        // backwards edge still does not. Leaving it rejoins ordinary corridor
        // geometry, so that half keeps the seam limit.
        const isUTurn = U_TURN_RELATIONS.has(
          movementsById.get(variant.movementId)?.turnRelation as TurnRelation,
        );
        const entryHeadingLimitRad =
          authored || isUTurn ? Math.PI : JUNCTION_ENTRY_HEADING_LIMIT_RAD;
        const exitHeadingLimitRad = authored
          ? JUNCTION_ENTRY_HEADING_LIMIT_RAD
          : maximumJoinHeadingDeltaRad;
        if (
          !joinsWalk(walked, interior, maximumJoinGapM, entryHeadingLimitRad, false)
        ) {
          return false;
        }
        const outgoing = corridorsById.get(variant.outgoingCorridorId);
        if (!outgoing) return false;
        const throughInterior: WalkPoint[] = [
          ...walked,
          ...interior.map((point) => ({
            point,
            speedKph: current!.speedLimitKph,
            rsl: null,
            sFraction: null,
          })),
        ];
        return joinsWalk(
          throughInterior,
          outgoing.polyline,
          maximumJoinGapM,
          exitHeadingLimitRad,
          true,
        );
      });
    const variants: JunctionMovementVariant[] = eligibleVariants(false);

    // Authored intent first; otherwise straightest, with U-turns excluded from
    // the default unless they are the only way out. A U-turn nobody asked for is
    // never the straightest continuation anyway — this makes it explicit, and
    // keeps parity with the compiler's own rule at a genuine dead end.
    // A junction that CANNOT serve the intent does not consume it.
    //
    // The cursor advances only when a turn is actually taken. Advancing it on
    // every junction meant a car told to turn left burned the instruction at the
    // first junction that had no left to give — on Belmont, a carriageway end
    // whose only movements are `uturn` and `right` — and drove straight through
    // the one offering left a few seconds later. The corridor came back
    // byte-identical for left, right and straight, which is how the bug hid.
    //
    // Still reported: an intent no junction on the whole runway could serve is an
    // authoring error the editor has to surface, so it lands in `unmetTurns` once,
    // by INTENT index, rather than once per junction it failed at.
    const intent = turnAtJunctions[intentCursor];
    let chosen: JunctionMovementVariant | null = null;
    let authored = false;
    if (intent !== undefined) {
      const candidates = variantsForIntent(variants, movementsById, intent);
      chosen = straightestVariant(candidates, movementsById, approachHeading);
      if (!chosen) {
        // Retry against the relaxed set before declaring the turn unmet, so a
        // coarsely-sampled connector cannot quietly downgrade the instruction.
        chosen = straightestVariant(
          variantsForIntent(eligibleVariants(true), movementsById, intent),
          movementsById,
          approachHeading,
        );
      }
      if (chosen) {
        authored = true;
        intentCursor += 1;
      } else if (variants.length > 0 && !unmetTurns.includes(intentCursor)) {
        unmetTurns.push(intentCursor);
      }
    }
    if (!chosen) {
      const through = variants.filter((variant) => {
        if (isUTurn(movementsById.get(variant.movementId))) return false;
        const interior = junctionInterior(variant).points;
        const outgoing = corridorsById.get(variant.outgoingCorridorId);
        if (!outgoing) return false;
        const orientedOutgoing = orientToJoin(
          interior[interior.length - 1]!,
          outgoing.polyline,
        );
        return maintainsUnauthoredProgress(walked, travelled, [interior, orientedOutgoing]);
      });
      // Plain lane-following routes never reverse. A U-turn is an authored
      // action with its own semantics; taking one merely because it is the only
      // graph edge violates the actor's motion program.
      const unauthored = through;
      chosen =
        branchRng === null
          ? straightestVariant(unauthored, movementsById, approachHeading)
          : weightedVariant(unauthored, movementsById, approachHeading, branchRng);
    }

    if (chosen) {
      const movement = movementsById.get(chosen.movementId);
      // The INTERIOR only. The approach corridor was just driven to its end and
      // the outgoing corridor is driven from its start below, so the variant's
      // approach and exit context would be a second traversal. See
      // `junctionInterior`.
      const interior = junctionInterior(chosen);
      travelled += interior.lengthM;
      legs.push({
        kind: "junction",
        id: chosen.id,
        lengthM: interior.lengthM,
        ...(movement ? { turn: movement.turnRelation } : {}),
        ...(authored ? { authored: true } : {}),
      });
      for (const point of interior.points) {
        walked.push({ point, speedKph: current.speedLimitKph, rsl: null, sFraction: null });
      }
      current = corridorsById.get(chosen.outgoingCorridorId) ?? null;
      if (!current) {
        terminated = "dead_end";
        stopReason = "no_continuation";
      }
      continue;
    }

    // No junction: a plain lane-to-lane continuation. Straightest applies here
    // too — a corridor with several successors is a fork, and an authored car
    // carries on rather than picking one by hash.
    const successors = current.successorCorridorIds
      .map((id) => corridorsById.get(id))
      .filter(
        (corridor): corridor is LaneCorridor =>
          corridor != null &&
          isAuthorable(corridor) &&
          !visits.has(corridor.id) &&
          joinsWalk(
            walked,
            corridor.polyline,
            maximumJoinGapM,
            maximumJoinHeadingDeltaRad,
            true,
          ) &&
          maintainsUnauthoredProgress(walked, travelled, [
            walked.length === 0
              ? corridor.polyline
              : orientToJoin(walked[walked.length - 1]!.point, corridor.polyline),
          ]),
      );
    if (successors.length === 0) {
      const wouldRevisit =
        availableVariants.some((variant) => visits.has(variant.outgoingCorridorId)) ||
        current.successorCorridorIds.some((id) => visits.has(id));
      terminated = wouldRevisit ? "cycle_guard" : "dead_end";
      // Variants existed but none survived the authorable filter: the map's
      // junction is unbound, not absent. This distinction is the difference
      // between "your scenario ends here" and "this map cannot carry it".
      stopReason = wouldRevisit
        ? "cycle_guard"
        : variants.length > 0
          ? "no_continuation"
          : (allVariantsByIncoming.get(current.id) ?? []).length > 0
          ? "junction_unbound"
          : "no_continuation";
      break;
    }
    const approach = approachHeading;
    const next = [...successors].sort((left, right) => {
      const leftEntry = entryHeading(left.polyline);
      const rightEntry = entryHeading(right.polyline);
      const cost = (entry: number | null): number => {
        if (entry === null || approach === null) return Number.POSITIVE_INFINITY;
        let delta = entry - approach;
        while (delta > Math.PI) delta -= 2 * Math.PI;
        while (delta < -Math.PI) delta += 2 * Math.PI;
        return Math.abs(delta);
      };
      const delta = cost(leftEntry) - cost(rightEntry);
      if (Math.abs(delta) > 1e-9) return delta;
      return left.id.localeCompare(right.id);
    })[0]!;
    current = next;
  }

  if (walked.length < 2) {
    return {
      anchors: [],
      legs,
      travelledM: travelled,
      terminated,
      stopReason,
      unmetTurns,
      startDistanceM: startDistance,
    };
  }

  const points = walked.map((entry) => entry.point);
  const kept = thinToCap(points, simplifyIndices(points, toleranceM), anchorCap);
  const anchors = kept.map((index) => {
    const point = points[index]!;
    return {
      x: point.x,
      y: point.y,
      z: point.z ?? 0,
      yaw: yawDegreesAt(points, index),
      speed_limit_kph: walked[index]!.speedKph,
      rsl: walked[index]!.rsl,
      s_fraction: walked[index]!.sFraction,
    };
  });

  return {
    anchors,
    legs,
    travelledM: travelled,
    terminated,
    stopReason,
    unmetTurns,
    startDistanceM: startDistance,
  };
}

/**
 * The DENSE geometry a derived runway covers.
 *
 * `anchors` is deliberately sparse — `FollowRouteActionSchema` caps them at 32 and
 * a 200 m Yale Street walk comes back as four — so it is the wrong thing to
 * measure against. Nearest-point onto four points turns every junction into a
 * chord that cuts the corner, which puts an authored anchor metres off its own
 * route and, worse, makes the chord heading disagree with the anchor heading so a
 * direction-aware comparison rejects it outright. Measured on the corpus,
 * 2026-07-29: comparing against the anchors reported "no match" for 58 of 361
 * vehicles whose migration was correct, including egos that fit within a metre.
 *
 * The legs name corridors and movement variants by id and both carry their own
 * polyline, so the driven geometry is a lookup rather than an estimate. Falls back
 * to the anchors when a leg's id is not in the graph — a caller comparing against
 * a coarse polyline is better off than one comparing against nothing.
 */
export function runwayPolyline(
  graph: SemanticMapGraph,
  runway: Pick<DerivedRunway, "legs" | "anchors">,
): Array<{ x: number; y: number; z: number | null }> {
  const corridorById = new Map(graph.corridors.map((corridor) => [corridor.id, corridor]));
  const variantById = new Map(
    graph.movementVariants.map((variant) => [variant.id, variant]),
  );
  const points: Array<{ x: number; y: number; z: number | null }> = [];
  for (const leg of runway.legs) {
    // A junction leg draws its INTERIOR, matching what the walk charged for it.
    // The variant's stored polyline also spans the approach and exit corridors,
    // which this loop draws either side of it anyway — so using the whole thing
    // laid ~66 m of already-drawn road back down, starting from the approach's
    // far end. `orientToJoin` cannot rescue that: both endpoints of the full
    // polyline are far from the join, so it keeps the stored order and the line
    // jumps backwards. On screen that is a car U-turning and looping on a
    // straight road. See `junctionInterior`.
    let source: { polyline: readonly SemanticMapPoint[] } | undefined;
    if (leg.kind === "corridor") {
      const corridor = corridorById.get(leg.id);
      const successors = (corridor?.successorCorridorIds ?? [])
        .map((id) => corridorById.get(id))
        .filter((next): next is LaneCorridor => next !== undefined && isAuthorable(next))
        .map((next) => next.polyline);
      source = corridor
        ? {
            polyline: trimTerminalDetour(
              corridor.polyline,
              successors,
              graph.buildConfig?.maximumSeamGapM ?? 3,
              graph.buildConfig?.maximumSeamHeadingDeltaRad ?? Math.PI / 6,
            ),
          }
        : undefined;
    } else {
      const variant = variantById.get(leg.id);
      source = variant ? { polyline: junctionInterior(variant).points } : undefined;
    }
    if (!source || source.polyline.length === 0) continue;
    // Orient each leg to JOIN the one before it. A corridor's stored polyline is
    // travel-ordered against its OWN axis, and a walk can enter one from either
    // end — so blind concatenation can lay a leg down backwards, producing a
    // polyline that passes through exactly the right points in exactly the wrong
    // direction. Measured on E4's ego, 2026-07-29: all three authored anchors sat
    // 0.00 m from the concatenated line with tangents 180 degrees reversed, which
    // reads as a perfect fit to any direction-blind comparison and as a car
    // driving its route backwards to a correct one.
    const oriented =
      points.length === 0
        ? [...source.polyline]
        : orientToJoin(points[points.length - 1]!, source.polyline);
    for (const point of oriented) {
      const last = points[points.length - 1];
      if (last && Math.hypot(last.x - point.x, last.y - point.y) < 0.01) continue;
      points.push({ x: point.x, y: point.y, z: point.z ?? null });
    }
  }
  if (points.length < 2) {
    return runway.anchors.map((anchor) => ({
      x: anchor.x,
      y: anchor.y,
      z: anchor.z ?? null,
    }));
  }
  // Callers can supply named legs without anchors (for example while drawing a
  // graph selection). There is no driven interval to crop to in that case, so
  // preserve the long-standing dense-leg result.
  if (runway.anchors.length < 2) return points;

  // Legs identify WHICH corridor was used, not the station where the actor
  // started on its first leg. Reconstructing that leg wholesale therefore drew
  // road behind the actor: 3380 of 3469 midpoint starts on the 2026-07-31 corpus
  // had a different drawn start, commonly by tens of metres. Crop the dense
  // lookup geometry to the first and last driven anchors. The first occurrence
  // wins at the start and the last at the end so a legitimate loop retains its
  // full span rather than collapsing between two repeated positions.
  return cropPolylineToAnchors(
    points,
    runway.anchors[0]!,
    runway.anchors[runway.anchors.length - 1]!,
  );
}
