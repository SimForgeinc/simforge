/**
 * JunctionDescriptors, including the precomputed `conflictPairs`.
 *
 * `conflictPairs` is the highest-value derived fact in the index (Scenic's
 * `conflictingManeuvers`): for every pair of movements through a junction whose
 * connecting-lane centrelines actually cross, we store the crossing point, the
 * arc length along each path, the crossing angle, and the relation from A's
 * point of view. That is what lets "an oncoming car turns left across you"
 * survive being retargeted onto a differently-shaped junction on another map —
 * the solver backs each actor up from the *precomputed* conflict point instead
 * of re-deriving junction geometry it does not have.
 *
 * Two kinds of conflict are emitted:
 *
 * 1. **Crossings** — proper segment intersections between the two connecting
 *    lanes, at a tangent angle of at least {@link MIN_CROSSING_ANGLE_RAD}.
 *    Endpoint touches are excluded on purpose.
 * 2. **Merges** — movements that converge instead of crossing: a shared exit
 *    lane, or a near-tangent overlap. Recorded at the point of **closest
 *    approach** between the two paths, with `sOnA`/`sOnB` at that point — the
 *    midpoint of the two lane *ends* would sit up to a lane-width off both
 *    paths, and a solver backing an actor up from it would aim at empty asphalt.
 *
 *    The angle floor matters: a right turn and an opposing left turn feeding
 *    the same exit have coincident tails (measured separation 0.00 m), which
 *    produces a perfectly valid tangent "intersection". Calling that a crossing
 *    would promise a T-bone where the real interaction is a squeeze.
 *
 * **Everything here depends on travel-ordered polylines** (see
 * {@link LaneGraph}). Read straight from the s-ordered source, a positive-id
 * approach lane's heading is 180° out and its connecting lane's arc length runs
 * backwards. Measured on Yale before that fix: junction 134 reported *zero*
 * `opposing` pairs against a geometric truth of 18, which silently makes every
 * left-turn-across-oncoming template unbindable there.
 *
 * Control is derived from the signal layer rather than trusted from the search
 * index (whose `control_type` disagrees with the signals on these maps — see
 * `controlEvidence`, which records both).
 */

import { asGateId, asJunctionId, asLaneRef, asLocationId, type GateId, type JunctionId } from '../types/ids.js';
import type { LocationId } from '../types/ids.js';
import type {
  ConflictPair,
  ConflictRelation,
  JunctionApproach,
  JunctionArm,
  JunctionControl,
  JunctionDescriptor,
  TurnOption,
} from '../types/topology.js';
import type { LocationDraft } from './draft.js';
import type { LaneNode } from '../geometry/lane-graph.js';
import {
  angleBetween,
  bearingDegBetween,
  bounds,
  centroid,
  headingToBearingDeg,
  poseAtS,
  projectOnSegment,
  segmentIntersection,
  wrapPi,
  type Point2,
} from '../geometry/vec.js';
import { round } from './anchor-lift.js';
import { type BuildContext, roadNameFor } from './context.js';
import { makeLocationIdString } from './hash.js';
import { compareStrings } from './compare.js';

/** Bearing tolerance for grouping lanes into the same physical arm, degrees. */
const ARM_CLUSTER_DEG = 40;

/** How far from the junction footprint a signal still counts as controlling it. */
const SIGNAL_RADIUS_PAD_M = 22;

/** Above this, two approaches are treated as opposing. */
const OPPOSING_MIN_RAD = (135 * Math.PI) / 180;

/** Below this, two approaches are treated as the same direction. */
const SAME_DIR_MAX_RAD = (25 * Math.PI) / 180;

/** Build a descriptor for every junction in the topology index. */
export function buildJunctionDescriptors(
  ctx: BuildContext,
  crossingDrafts: readonly LocationDraft[],
): JunctionDescriptor[] {
  const out: JunctionDescriptor[] = [];
  const signals = collectSignals(ctx);
  for (const jid of Object.keys(ctx.sources.topology.junctions).sort()) {
    const descriptor = buildOne(ctx, jid, signals, crossingDrafts);
    if (descriptor) out.push(descriptor);
  }
  return out;
}

/** The catalog id a junction location has (derivable without the catalog). */
export function junctionLocationId(mapId: string, junctionId: string): LocationId {
  return asLocationId(makeLocationIdString(mapId, 'junction', `junction:${junctionId}`));
}

interface SignalPoint {
  point: Point2;
  category: string;
  mutcd: string;
  name: string;
}

function collectSignals(ctx: BuildContext): SignalPoint[] {
  const out: SignalPoint[] = [];
  for (const f of ctx.sources.signals?.features ?? []) {
    const coords = f.geometry.coordinates;
    if (!Array.isArray(coords) || coords.length < 2) continue;
    const [lng, lat] = coords as number[];
    if (typeof lng !== 'number' || typeof lat !== 'number') continue;
    out.push({
      point: ctx.toLocal(lng, lat),
      category: f.properties.signal_category ?? 'undefined',
      mutcd: f.properties.mutcd_code ?? '',
      name: f.properties.name ?? '',
    });
  }
  return out;
}

function buildOne(
  ctx: BuildContext,
  junctionId: string,
  signals: readonly SignalPoint[],
  crossingDrafts: readonly LocationDraft[],
): JunctionDescriptor | null {
  const graph = ctx.graph;
  const raw = ctx.sources.topology.junctions[junctionId];
  if (!raw) return null;

  const internalLanes = raw.internalLaneRsls
    .map((r) => graph.get(r))
    .filter((l): l is LaneNode => l !== undefined);
  const allPoints = internalLanes.flatMap((l) => l.points);
  if (allPoints.length === 0) return null;
  const center = centroid(allPoints);
  const bb = bounds(allPoints);
  const sizeM = round(Math.hypot(bb.maxX - bb.minX, bb.maxY - bb.minY), 2);

  const gates = ctx.sources.topology.gates
    .filter((g) => g.junctionId === junctionId)
    .sort((a, b) => compareStrings(a.id, b.id));

  // --- arms ---------------------------------------------------------------
  // Arms are clustered by **outward leg direction**, not by bearing from the
  // junction centroid. On a 70 m junction the inbound and outbound centrelines
  // of a single leg sit ~15 m apart, and centroid bearings split that one leg
  // into two — Yale's big El Camino junctions came out as 6-7 "arms" where both
  // the outward-leg clustering and the search index's `approach_count` say 4.
  //
  // The outward direction of an inbound lane is its travel heading reversed;
  // of an outbound lane, its travel heading as it leaves. Both require
  // travel-ordered polylines to mean anything.
  const approachRsls = [
    ...new Set([...raw.approachLaneRsls, ...gates.map((g) => g.approachLaneRsl)]),
  ].sort();
  const exitRsls = [...new Set(gates.flatMap((g) => g.exitLaneRsls))].sort();

  interface Leg {
    /** Outward bearing, degrees (0 = north, clockwise). */
    bearingDeg: number;
    rsl: string;
    kind: 'approach' | 'exit';
  }
  const legs: Leg[] = [];
  for (const rsl of approachRsls) {
    const lane = graph.get(rsl);
    if (!lane || lane.laneType !== 'driving') continue;
    legs.push({
      bearingDeg: headingToBearingDeg(graph.endHeading(lane) + Math.PI),
      rsl,
      kind: 'approach',
    });
  }
  for (const rsl of exitRsls) {
    const lane = graph.get(rsl);
    if (!lane || lane.laneType !== 'driving') continue;
    legs.push({ bearingDeg: headingToBearingDeg(graph.startHeading(lane)), rsl, kind: 'exit' });
  }

  const clusters = clusterByBearing(legs);
  const arms: JunctionArm[] = clusters.map((cluster, index) => {
    const approach = cluster.filter((l) => l.kind === 'approach').map((l) => l.rsl).sort();
    const exit = cluster.filter((l) => l.kind === 'exit').map((l) => l.rsl).sort();
    const roadNames = cluster.map((l) => roadNameFor(ctx, l.rsl)).filter(Boolean);
    return {
      index,
      bearingDeg: round(meanBearingDeg(cluster.map((l) => l.bearingDeg)), 1),
      roadName: mostCommon(roadNames) ?? '',
      approachLaneRefs: approach.map((r) => asLaneRef(r)),
      exitLaneRefs: exit.map((r) => asLaneRef(r)),
      inboundLaneCount: approach.length,
      outboundLaneCount: exit.length,
    };
  });

  const armIndexByApproach = new Map<string, number>();
  for (const arm of arms) {
    for (const rsl of arm.approachLaneRefs) armIndexByApproach.set(rsl as string, arm.index);
  }

  // --- approaches ---------------------------------------------------------
  const approaches: JunctionApproach[] = [];
  for (const rsl of approachRsls) {
    const lane = graph.get(rsl);
    if (!lane) continue;
    const turnOptions: TurnOption[] = gates
      .filter((g) => g.approachLaneRsl === rsl)
      .map((g) => ({
        gateId: asGateId(g.id),
        turn: g.turnRelation,
        connectingLaneRsl: asLaneRef(g.connectingLaneRsl),
        exitLaneRsls: g.exitLaneRsls.map((e) => asLaneRef(e)),
        headingChangeRad: round(g.headingChangeRad, 6),
      }));
    approaches.push({
      laneRsl: asLaneRef(rsl),
      bearingDeg: round(headingToBearingDeg(graph.endHeading(lane)), 1),
      armIndex: armIndexByApproach.get(rsl) ?? 0,
      roadName: roadNameFor(ctx, rsl),
      speedLimitKph: lane.speedLimitKph ?? 0,
      turnOptions,
    });
  }
  approaches.sort((a, b) => compareStrings(a.laneRsl as string, b.laneRsl as string));

  // --- control ------------------------------------------------------------
  const { control, evidence } = deriveControl(ctx, junctionId, center, sizeM, signals, arms.length);

  // --- conflict pairs -----------------------------------------------------
  const conflictPairs = computeConflictPairs(ctx, gates, center);

  // --- crossings ----------------------------------------------------------
  const radius = sizeM / 2 + 15;
  const crossingLocationIds = crossingDrafts
    .filter((d) => {
      const p = d.anchor.road ? null : null;
      void p;
      const local = ctx.toLocal(d.anchor.geo.lng, d.anchor.geo.lat);
      return Math.hypot(local.x - center.x, local.y - center.y) <= radius;
    })
    .map((d) => d.id)
    .sort();

  return {
    junctionId: asJunctionId(junctionId),
    locationId: junctionLocationId(ctx.sources.mapId as string, junctionId),
    centerXY: [round(center.x, 3), round(center.y, 3)],
    sizeM,
    arms,
    armCount: arms.length,
    approaches,
    control,
    controlEvidence: evidence,
    internalLaneRefs: raw.internalLaneRsls.slice().sort().map((r) => asLaneRef(r)),
    crossingLocationIds,
    conflictPairs,
  };
}

/**
 * Derive control from the signal layer.
 *
 * The search index's own `control_type` is recorded as evidence but not used:
 * on Yale it labels a junction "uncontrolled" that has traffic lights standing
 * in it, because its detector keys off approach count rather than signals.
 */
function deriveControl(
  ctx: BuildContext,
  junctionId: string,
  center: Point2,
  sizeM: number,
  signals: readonly SignalPoint[],
  armCount: number,
): { control: JunctionControl; evidence: string[] } {
  const radius = sizeM / 2 + SIGNAL_RADIUS_PAD_M;
  let lights = 0;
  let stops = 0;
  let yields = 0;
  for (const sig of signals) {
    if (Math.hypot(sig.point.x - center.x, sig.point.y - center.y) > radius) continue;
    if (sig.category === 'traffic_light') lights += 1;
    else if (sig.category === 'stop_sign' || sig.mutcd === 'R1-1') stops += 1;
    else if (sig.category === 'yield_sign' || sig.mutcd === 'R1-2') yields += 1;
  }
  const evidence = [`radius_m=${round(radius, 1)}`, `traffic_light=${lights}`, `stop_sign=${stops}`, `yield_sign=${yields}`];
  const searchObj = ctx.sources.searchIndex?.objects[`junction:${junctionId}`];
  const searchControl = searchObj?.facts?.['control_type'];
  if (typeof searchControl === 'string') evidence.push(`search_index_control_type=${searchControl}`);

  let control: JunctionControl;
  if (lights > 0) control = 'signalized';
  else if (stops > 0 && armCount > 0 && stops >= armCount) control = 'all_way_stop';
  else if (stops > 0) control = 'minor_stop';
  else if (yields > 0) control = 'yield';
  else control = 'uncontrolled';
  return { control, evidence };
}

/** Compute every crossing and merge conflict inside one junction. */
export function computeConflictPairs(
  ctx: BuildContext,
  gates: readonly { id: string; approachLaneRsl: string; connectingLaneRsl: string; exitLaneRsls: string[]; turnRelation: string }[],
  center: Point2,
): ConflictPair[] {
  const graph = ctx.graph;
  const byKey = new Map<string, ConflictPair>();

  // Canonical gate order, so the function depends on the *set* of gates and not
  // on the order they arrive in. Without this, `gateA`/`gateB` — and therefore
  // `relation`, which is stated from A's point of view — would silently flip
  // with the caller's sort.
  const ordered = [...gates].sort((a, b) => compareStrings(a.id, b.id));

  for (let i = 0; i < ordered.length; i++) {
    for (let j = i + 1; j < ordered.length; j++) {
      const ga = ordered[i] as (typeof gates)[number];
      const gb = ordered[j] as (typeof gates)[number];
      // Movements from the same approach lane share an origin: a driver picks
      // one of them, so they never conflict with each other.
      if (ga.approachLaneRsl === gb.approachLaneRsl) continue;
      const la = graph.get(ga.connectingLaneRsl);
      const lb = graph.get(gb.connectingLaneRsl);
      if (!la || !lb) continue;

      const approachA = graph.get(ga.approachLaneRsl);
      const approachB = graph.get(gb.approachLaneRsl);
      if (!approachA || !approachB) continue;
      const hA = graph.endHeading(approachA);
      const hB = graph.endHeading(approachB);
      const relation = classifyRelation(hA, hB);

      const key = `${ga.id}|${gb.id}`;
      const sharedExit = ga.exitLaneRsls.some((e) => gb.exitLaneRsls.includes(e));
      // A near-tangent "intersection" is two paths merging into a shared exit
      // lane, not a crossing: their centrelines become coincident (measured
      // separation 0.00 m) and the intersection lands at the very end of both.
      // Calling that a crossing would tell a solver to expect a T-bone where
      // the real interaction is a squeeze.
      const crossing = firstCrossing(la, lb, MIN_CROSSING_ANGLE_RAD);
      if (crossing) {
        byKey.set(key, {
          gateA: asGateId(ga.id),
          gateB: asGateId(gb.id),
          kind: 'crossing',
          pointXY: [round(crossing.point.x, 3), round(crossing.point.y, 3)],
          sOnA: round(crossing.sA, 3),
          sOnB: round(crossing.sB, 3),
          crossingAngleRad: clampAngle(crossing.angleRad),
          relation,
          turnA: ga.turnRelation,
          turnB: gb.turnRelation,
        });
        continue;
      }
      // Merge: converging centrelines — either declared by a shared exit lane,
      // or evidenced by a near-tangent overlap that failed the crossing test.
      const tangentOverlap = firstCrossing(la, lb, 0) !== null;
      if (!sharedExit && !tangentOverlap) continue;
      const merge = closestApproach(la, lb);
      if (!merge || merge.distanceM > MERGE_MAX_SEPARATION_M) continue;
      byKey.set(key, {
        gateA: asGateId(ga.id),
        gateB: asGateId(gb.id),
        kind: 'merge',
        pointXY: [round(merge.point.x, 3), round(merge.point.y, 3)],
        sOnA: round(merge.sA, 3),
        sOnB: round(merge.sB, 3),
        crossingAngleRad: clampAngle(merge.angleRad),
        relation,
        turnA: ga.turnRelation,
        turnB: gb.turnRelation,
      });
    }
  }

  return [...byKey.values()].sort(
    (a, b) =>
      compareStrings(a.gateA as string, b.gateA as string) ||
      compareStrings(a.gateB as string, b.gateB as string),
  );
}

/**
 * Cluster legs by outward bearing on the circle.
 *
 * Sorted-sweep with wrap-around merging, so a leg pointing at 358° and one at
 * 3° land in the same arm. Deterministic: the input is already sorted by rsl,
 * the sweep is by bearing, and clusters come out ordered by mean bearing.
 */
function clusterByBearing<T extends { bearingDeg: number }>(legs: readonly T[]): T[][] {
  if (legs.length === 0) return [];
  const sorted = [...legs].sort((a, b) => a.bearingDeg - b.bearingDeg);
  const clusters: T[][] = [];
  for (const leg of sorted) {
    const last = clusters[clusters.length - 1];
    const lastBearing = last ? meanBearingDeg(last.map((l) => l.bearingDeg)) : null;
    if (last && lastBearing !== null && bearingDelta(leg.bearingDeg, lastBearing) < ARM_CLUSTER_DEG) {
      last.push(leg);
    } else {
      clusters.push([leg]);
    }
  }
  // Wrap-around: the last cluster may belong with the first.
  if (clusters.length > 1) {
    const first = clusters[0] as T[];
    const last = clusters[clusters.length - 1] as T[];
    const a = meanBearingDeg(first.map((l) => l.bearingDeg));
    const b = meanBearingDeg(last.map((l) => l.bearingDeg));
    if (bearingDelta(a, b) < ARM_CLUSTER_DEG) {
      first.push(...last);
      clusters.pop();
    }
  }
  return clusters.sort(
    (a, b) =>
      meanBearingDeg(a.map((l) => l.bearingDeg)) - meanBearingDeg(b.map((l) => l.bearingDeg)),
  );
}

/** Smallest absolute difference between two compass bearings, degrees. */
function bearingDelta(a: number, b: number): number {
  return Math.abs((wrapPi(((a - b) * Math.PI) / 180) * 180) / Math.PI);
}

/** Circular mean of a set of bearings, degrees in `[0, 360)`. */
function meanBearingDeg(bearings: readonly number[]): number {
  if (bearings.length === 0) return 0;
  let sx = 0;
  let sy = 0;
  for (const b of bearings) {
    const rad = (b * Math.PI) / 180;
    sx += Math.cos(rad);
    sy += Math.sin(rad);
  }
  const deg = (Math.atan2(sy, sx) * 180) / Math.PI;
  return ((deg % 360) + 360) % 360;
}

/** Two merging paths further apart than this are not really interacting. */
const MERGE_MAX_SEPARATION_M = 8;

/** Rounded for byte-stable JSON, floored at PI so the value never over-claims. */
function clampAngle(rad: number): number {
  return Math.min(round(rad, 6), Math.PI);
}

/**
 * Closest approach between two connecting-lane centrelines.
 *
 * Every vertex of each path is projected onto every segment of the other, so
 * the result is exact to the polyline sampling (~1 m) rather than to the
 * vertices alone.
 */
function closestApproach(
  la: LaneNode,
  lb: LaneNode,
): { point: Point2; sA: number; sB: number; angleRad: number; distanceM: number } | null {
  let best: { point: Point2; sA: number; sB: number; angleRad: number; distanceM: number } | null = null;

  const consider = (
    sA: number,
    sB: number,
    pa: Point2,
    pb: Point2,
  ): void => {
    const distanceM = Math.hypot(pa.x - pb.x, pa.y - pb.y);
    if (best && distanceM >= best.distanceM) return;
    best = {
      point: { x: (pa.x + pb.x) / 2, y: (pa.y + pb.y) / 2 },
      sA,
      sB,
      angleRad: angleBetween(headingAt(la, sA), headingAt(lb, sB)),
      distanceM,
    };
  };

  for (let i = 0; i < la.points.length; i++) {
    const pa = la.points[i] as Point2;
    for (let j = 0; j + 1 < lb.points.length; j++) {
      const b1 = lb.points[j] as Point2;
      const b2 = lb.points[j + 1] as Point2;
      const proj = projectOnSegment(pa, b1, b2);
      const segB = (lb.cum[j + 1] as number) - (lb.cum[j] as number);
      consider(la.cum[i] as number, (lb.cum[j] as number) + proj.t * segB, pa, proj.point);
    }
  }
  for (let j = 0; j < lb.points.length; j++) {
    const pb = lb.points[j] as Point2;
    for (let i = 0; i + 1 < la.points.length; i++) {
      const a1 = la.points[i] as Point2;
      const a2 = la.points[i + 1] as Point2;
      const proj = projectOnSegment(pb, a1, a2);
      const segA = (la.cum[i + 1] as number) - (la.cum[i] as number);
      consider((la.cum[i] as number) + proj.t * segA, lb.cum[j] as number, proj.point, pb);
    }
  }
  return best;
}

function headingAt(lane: LaneNode, s: number): number {
  return poseAtS(lane.points, lane.cum, s).headingRad;
}

/**
 * Below this tangent angle, an intersection between two connecting lanes is a
 * convergence, not a crossing.
 */
const MIN_CROSSING_ANGLE_RAD = (10 * Math.PI) / 180;

function firstCrossing(
  la: LaneNode,
  lb: LaneNode,
  minAngleRad: number,
): { point: Point2; sA: number; sB: number; angleRad: number } | null {
  let best: { point: Point2; sA: number; sB: number; angleRad: number } | null = null;
  for (let i = 0; i + 1 < la.points.length; i++) {
    const a1 = la.points[i] as Point2;
    const a2 = la.points[i + 1] as Point2;
    for (let j = 0; j + 1 < lb.points.length; j++) {
      const b1 = lb.points[j] as Point2;
      const b2 = lb.points[j + 1] as Point2;
      const hit = segmentIntersection(a1, a2, b1, b2);
      if (!hit) continue;
      const segA = (la.cum[i + 1] as number) - (la.cum[i] as number);
      const segB = (lb.cum[j + 1] as number) - (lb.cum[j] as number);
      const sA = (la.cum[i] as number) + hit.tA * segA;
      const sB = (lb.cum[j] as number) + hit.tB * segB;
      const angleRad = angleBetween(
        Math.atan2(a2.y - a1.y, a2.x - a1.x),
        Math.atan2(b2.y - b1.y, b2.x - b1.x),
      );
      if (angleRad < minAngleRad) continue;
      if (!best || sA < best.sA) best = { point: hit.point, sA, sB, angleRad };
    }
  }
  return best;
}

/**
 * Classify how B relates to A, from the two **travel** headings into the junction.
 *
 * Both headings must be travel-ordered — see {@link LaneGraph}. That is the
 * whole ball game: read straight from the s-ordered polylines, a positive-id
 * approach lane's heading is 180° wrong, and every head-on conflict at that
 * junction is labelled a same-direction merge. Measured on Yale before the fix:
 * junction 134 reported zero `opposing` pairs where the geometry has 18, which
 * makes every left-turn-across-oncoming template unbindable there.
 *
 * The signed difference is used directly rather than a side test against the
 * junction centroid: with travel-ordered headings the two agree, and the signed
 * difference has no dependency on where the centroid happens to fall on a
 * lopsided 70 m junction.
 *
 * ```
 *              delta = wrapPi(headingB - headingA)
 *   |delta| >= 135°  → opposing        (head-on: the left-turn-across case)
 *   |delta| <=  25°  → same_dir_merge  (converging, same direction)
 *   delta < 0        → from_left       (B crosses right-to-left in front of A)
 *   delta > 0        → from_right
 * ```
 */
export function classifyRelation(headingA: number, headingB: number): ConflictRelation {
  const delta = wrapPi(headingB - headingA);
  const abs = Math.abs(delta);
  if (abs >= OPPOSING_MIN_RAD) return 'opposing';
  if (abs <= SAME_DIR_MAX_RAD) return 'same_dir_merge';
  return delta < 0 ? 'from_left' : 'from_right';
}

/** Which gates conflict with a given gate, from a descriptor. */
export function conflictingGates(descriptor: JunctionDescriptor, gateId: GateId): GateId[] {
  const out = new Set<string>();
  for (const pair of descriptor.conflictPairs) {
    if (pair.gateA === gateId) out.add(pair.gateB as string);
    else if (pair.gateB === gateId) out.add(pair.gateA as string);
  }
  return [...out].sort().map((g) => asGateId(g));
}

/** Descriptor lookup keyed by junction id. */
export function indexDescriptors(
  descriptors: readonly JunctionDescriptor[],
): Map<string, JunctionDescriptor> {
  const out = new Map<string, JunctionDescriptor>();
  for (const d of descriptors) out.set(d.junctionId as string, d);
  return out;
}

function mostCommon(values: readonly string[]): string | undefined {
  if (values.length === 0) return undefined;
  const counts = new Map<string, number>();
  for (const v of values) counts.set(v, (counts.get(v) ?? 0) + 1);
  return [...counts.entries()].sort((a, b) => b[1] - a[1] || compareStrings(a[0], b[0]))[0]?.[0];
}

/** Re-export for tests that need the raw junction id brand. */
export type { JunctionId };
