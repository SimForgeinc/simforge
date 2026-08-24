/**
 * Segments: maximal same-direction driving corridors with piecewise profiles.
 *
 * Why chains at all: xodr roads on these maps average ~13 m (Yale's median lane
 * is 18.6 m long), so "a road" is not a useful unit for anything — a 20-second
 * clip at 40 kph covers ~220 m, i.e. a dozen roads. The chain is the unit a
 * corridor clause (`runwayUpstreamM`, `throughLanesSameDir`) can actually be
 * evaluated over.
 *
 * A link is admitted only when it is **geometrically contiguous and mutually
 * unambiguous**: the successor's polyline starts where the predecessor's ends,
 * the heading is continuous, the predecessor has exactly one such successor and
 * the successor exactly one such predecessor. The raw `successors` lists cannot
 * be trusted for this — on the dev maps a lane routinely lists the same lane as
 * both predecessor and successor, and lists junction-internal lanes that are
 * not physically adjacent to it.
 *
 * **Junction traversal.** See {@link Segment} — restricting chains to
 * non-junction lanes is degenerate on this data, so chains continue through the
 * unambiguous straight-through movement and record where they did so.
 */

import { asSegmentId, type JunctionId, type LaneRef, type SegmentId } from '../types/ids.js';
import type {
  JunctionInterval,
  LaneChangeInterval,
  Segment,
  SegmentProfileSample,
} from '../types/topology.js';
import type { LaneNode } from '../geometry/lane-graph.js';
import { poseAtS } from '../geometry/vec.js';
import { round } from './anchor-lift.js';
import { type BuildContext, roadNameFor } from './context.js';
import { makeSegmentIdString } from './hash.js';
import { compareStrings } from './compare.js';

/** Profile sampling stride along a chain, metres. */
export const PROFILE_STRIDE_M = 10;

/** Endpoint tolerance for admitting a chain link, metres. */
export const CHAIN_GAP_TOLERANCE_M = 1.5;

/** Maximum heading discontinuity across a chain link, radians (≈35°). */
export const CHAIN_HEADING_TOLERANCE_RAD = 0.61;

/** A junction movement counts as "straight through" below this heading change. */
export const STRAIGHT_THROUGH_MAX_RAD = (25 * Math.PI) / 180;

/** Build every driving corridor on the map. */
export function buildSegments(ctx: BuildContext): Segment[] {
  const graph = ctx.graph;

  // Junction-internal lanes are chainable only when they realise the
  // straight-through movement; a left turn is a different corridor.
  const straightInternal = new Set<string>();
  for (const gate of ctx.sources.topology.gates) {
    if (gate.turnRelation !== 'Straight') continue;
    if (Math.abs(gate.headingChangeRad) > STRAIGHT_THROUGH_MAX_RAD) continue;
    straightInternal.add(gate.connectingLaneRsl);
  }

  const eligible = graph
    .allLanes()
    .filter(
      (l) =>
        l.laneType === 'driving' &&
        l.lengthM > 0.05 &&
        (!l.isJunction || straightInternal.has(l.rsl as string)),
    );
  const eligibleSet = new Set(eligible.map((l) => l.rsl as string));

  const nextOf = new Map<string, string>();
  const prevCount = new Map<string, number>();

  for (const lane of eligible) {
    const succs = graph
      .geometricSuccessors(lane.rsl as string, CHAIN_GAP_TOLERANCE_M, CHAIN_HEADING_TOLERANCE_RAD)
      .filter((n) => eligibleSet.has(n.rsl as string) && n.rsl !== lane.rsl);
    if (succs.length !== 1) continue;
    const target = succs[0] as LaneNode;
    const preds = graph
      .geometricPredecessors(
        target.rsl as string,
        CHAIN_GAP_TOLERANCE_M,
        CHAIN_HEADING_TOLERANCE_RAD,
      )
      .filter((n) => eligibleSet.has(n.rsl as string) && n.rsl !== target.rsl);
    if (preds.length !== 1 || preds[0]?.rsl !== lane.rsl) continue;
    nextOf.set(lane.rsl as string, target.rsl as string);
    prevCount.set(target.rsl as string, (prevCount.get(target.rsl as string) ?? 0) + 1);
  }

  const visited = new Set<string>();
  const segments: Segment[] = [];
  // Heads first (so chains are emitted whole), then leftovers to break cycles.
  const heads = eligible
    .map((l) => l.rsl as string)
    .filter((r) => (prevCount.get(r) ?? 0) === 0)
    .sort();
  const leftovers = eligible.map((l) => l.rsl as string).sort();

  for (const start of [...heads, ...leftovers]) {
    if (visited.has(start)) continue;
    const chain: string[] = [];
    let cursor: string | undefined = start;
    while (cursor && !visited.has(cursor)) {
      visited.add(cursor);
      chain.push(cursor);
      cursor = nextOf.get(cursor);
    }
    const seg = materialise(ctx, chain);
    if (seg) segments.push(seg);
  }

  segments.sort((a, b) => compareStrings(a.id as string, b.id as string));
  return segments;
}

function materialise(ctx: BuildContext, chain: string[]): Segment | null {
  const graph = ctx.graph;
  const lanes = chain.map((r) => graph.get(r)).filter((l): l is LaneNode => l !== undefined);
  if (lanes.length === 0) return null;
  // A chain made only of junction lanes is a movement, not a corridor.
  if (lanes.every((l) => l.isJunction)) return null;

  const laneStartS: number[] = [];
  let acc = 0;
  for (const lane of lanes) {
    laneStartS.push(round(acc, 3));
    acc += lane.lengthM;
  }
  const lengthM = acc;

  // Merge consecutive junction lanes belonging to the same junction.
  const junctionIntervals: JunctionInterval[] = [];
  for (let i = 0; i < lanes.length; i++) {
    const lane = lanes[i] as LaneNode;
    if (!lane.isJunction || !lane.junctionId) continue;
    const startS = laneStartS[i] as number;
    const endS = startS + lane.lengthM;
    const last = junctionIntervals[junctionIntervals.length - 1];
    if (last && last.junctionId === lane.junctionId && Math.abs(last.endS - startS) < 0.5) {
      last.endS = round(endS, 2);
    } else {
      junctionIntervals.push({
        junctionId: lane.junctionId,
        startS: round(startS, 2),
        endS: round(endS, 2),
      });
    }
  }

  const profile = sampleProfile(ctx, lanes, laneStartS, lengthM);
  const openLanes = lanes.filter((l) => !l.isJunction);
  const rowStats = crossSection(ctx, openLanes);

  const first = lanes[0] as LaneNode;
  const last = lanes[lanes.length - 1] as LaneNode;
  const entryJunctionId = junctionTouching(ctx, first, 'in');
  const exitJunctionId = junctionTouching(ctx, last, 'out');

  const laneChangeIntervals: LaneChangeInterval[] = [];
  for (let i = 0; i < lanes.length; i++) {
    const lane = lanes[i] as LaneNode;
    const base = laneStartS[i] as number;
    for (const perm of lane.raw.laneChangePermissions ?? []) {
      // Source `s` and `side` are stated looking along OpenDRIVE `+s`. On a
      // lane travelling against `s` both have to be flipped, or a permission
      // that reads "left, 0-13 m" would send a vehicle into oncoming traffic
      // at the wrong end of the block.
      const a = ctx.graph.fromXodrS(lane, perm.startS);
      const b = ctx.graph.fromXodrS(lane, perm.endS);
      const side = ctx.graph.driverSide(lane, perm.side);
      laneChangeIntervals.push({
        side,
        startS: round(base + Math.min(a, b), 2),
        endS: round(base + Math.max(a, b), 2),
        allowed: perm.allowed,
        targetRsl: targetOfPermission(lane, perm.side),
      });
    }
  }
  laneChangeIntervals.sort((a, b) => a.startS - b.startS || compareStrings(a.side, b.side));

  const speeds = profile.map((p) => p.speedLimitKph).filter((v) => v > 0);
  const sameDir = profile.map((p) => p.lanesSameDir);
  const roadNames = openLanes.map((l) => roadNameFor(ctx, l.rsl as string)).filter(Boolean);

  const id: SegmentId = asSegmentId(makeSegmentIdString(ctx.sources.mapId as string, chain));

  return {
    id,
    laneRefs: lanes.map((l) => l.rsl),
    junctionLaneRefs: lanes.filter((l) => l.isJunction).map((l) => l.rsl),
    junctionIntervals,
    laneStartS,
    lengthM: round(lengthM, 2),
    roadName: mostCommon(roadNames) ?? '',
    laneType: first.laneType,
    profile,
    minLanesSameDir: sameDir.length ? Math.min(...sameDir) : 0,
    maxLanesSameDir: sameDir.length ? Math.max(...sameDir) : 0,
    minSpeedLimitKph: speeds.length ? Math.min(...speeds) : 0,
    maxSpeedLimitKph: speeds.length ? Math.max(...speeds) : 0,
    maxCurvatureDegPer10m: profile.length
      ? round(Math.max(...profile.map((p) => p.curvatureDegPer10m)), 2)
      : 0,
    hasParkingAdjacent: rowStats.parking,
    hasBikeAdjacent: rowStats.biking,
    hasSidewalkAdjacent: rowStats.sidewalk,
    hasShoulderAdjacent: rowStats.shoulder,
    hasMedianAdjacent: rowStats.median,
    isOneWay: rowStats.maxOpposing === 0,
    laneChangeIntervals,
    entryJunctionId,
    exitJunctionId,
  };
}

/**
 * Profile samples.
 *
 * Samples that land inside a junction are skipped: a junction-internal lane
 * lives on its own single-lane "road", so counting its cross-section would
 * report a four-lane arterial as one lane wide for the 20 m it spends crossing
 * an intersection, and every `throughLanesSameDir` clause would then fail on
 * exactly the corridors that matter.
 */
function sampleProfile(
  ctx: BuildContext,
  lanes: LaneNode[],
  laneStartS: number[],
  lengthM: number,
): SegmentProfileSample[] {
  const out: SegmentProfileSample[] = [];
  const count = Math.max(2, Math.ceil(lengthM / PROFILE_STRIDE_M) + 1);
  for (let i = 0; i < count; i++) {
    const s = Math.min(lengthM, (i * lengthM) / (count - 1));
    const laneIdx = laneIndexAt(laneStartS, s);
    const lane = lanes[laneIdx] as LaneNode;
    if (lane.isJunction) continue;
    const localS = s - (laneStartS[laneIdx] as number);
    const cross = crossSectionAt(ctx, lane);
    out.push({
      s: round(s, 2),
      lanesSameDir: cross.sameDir,
      lanesOpposing: cross.opposing,
      speedLimitKph: lane.speedLimitKph ?? 0,
      laneWidthM: round(ctx.graph.widthAt(lane, localS), 3),
      curvatureDegPer10m: round(ctx.graph.curvatureDegPer10mAt(lane, localS), 2),
    });
  }
  return out;
}

function laneIndexAt(laneStartS: readonly number[], s: number): number {
  let idx = 0;
  for (let i = 0; i < laneStartS.length; i++) {
    if ((laneStartS[i] as number) <= s) idx = i;
    else break;
  }
  return idx;
}

/** Cross-section counts for a single lane's row. */
export function crossSectionAt(
  ctx: BuildContext,
  lane: LaneNode,
): {
  sameDir: number;
  opposing: number;
  parking: boolean;
  biking: boolean;
  sidewalk: boolean;
  shoulder: boolean;
  median: boolean;
} {
  const row = ctx.graph.row(lane.rsl as string);
  const sign = Math.sign(lane.laneId) || 1;
  let sameDir = 0;
  let opposing = 0;
  let parking = false;
  let biking = false;
  let sidewalk = false;
  let shoulder = false;
  let median = false;
  for (const other of row) {
    const otherSign = Math.sign(other.laneId) || 1;
    if (other.laneType === 'driving') {
      if (otherSign === sign) sameDir += 1;
      else opposing += 1;
      continue;
    }
    if (other.laneType === 'parking') parking = true;
    else if (other.laneType === 'biking') biking = true;
    else if (other.laneType === 'sidewalk') sidewalk = true;
    else if (other.laneType === 'shoulder') shoulder = true;
    else if (other.laneType === 'median' || other.laneType === 'restricted') median = true;
  }
  return { sameDir: Math.max(1, sameDir), opposing, parking, biking, sidewalk, shoulder, median };
}

function crossSection(
  ctx: BuildContext,
  lanes: LaneNode[],
): {
  parking: boolean;
  biking: boolean;
  sidewalk: boolean;
  shoulder: boolean;
  median: boolean;
  maxOpposing: number;
} {
  let parking = false;
  let biking = false;
  let sidewalk = false;
  let shoulder = false;
  let median = false;
  let maxOpposing = 0;
  for (const lane of lanes) {
    const c = crossSectionAt(ctx, lane);
    parking ||= c.parking;
    biking ||= c.biking;
    sidewalk ||= c.sidewalk;
    shoulder ||= c.shoulder;
    median ||= c.median;
    maxOpposing = Math.max(maxOpposing, c.opposing);
  }
  return { parking, biking, sidewalk, shoulder, median, maxOpposing };
}

function targetOfPermission(lane: LaneNode, side: 'left' | 'right'): LaneRef | null {
  const adj = lane.raw.adjacentLanes?.[side];
  return adj?.laneRsl ? (adj.laneRsl as LaneRef) : null;
}

function junctionTouching(
  ctx: BuildContext,
  lane: LaneNode,
  direction: 'in' | 'out',
): JunctionId | null {
  if (lane.isJunction && lane.junctionId) return lane.junctionId;
  const neighbours =
    direction === 'in'
      ? ctx.graph.geometricPredecessors(lane.rsl as string, CHAIN_GAP_TOLERANCE_M, Math.PI)
      : ctx.graph.geometricSuccessors(lane.rsl as string, CHAIN_GAP_TOLERANCE_M, Math.PI);
  for (const n of neighbours) if (n.junctionId) return n.junctionId;
  return null;
}

function mostCommon(values: readonly string[]): string | undefined {
  if (values.length === 0) return undefined;
  const counts = new Map<string, number>();
  for (const v of values) counts.set(v, (counts.get(v) ?? 0) + 1);
  return [...counts.entries()].sort((a, b) => b[1] - a[1] || compareStrings(a[0], b[0]))[0]?.[0];
}

/** Sample a pose along a chain by chain arc length. Used by densifiers. */
export function poseAlongSegment(
  ctx: BuildContext,
  segment: Segment,
  s: number,
): { rsl: LaneRef; localS: number; x: number; y: number; headingRad: number; isJunction: boolean } | null {
  const idx = laneIndexAt(segment.laneStartS, s);
  const rsl = segment.laneRefs[idx];
  if (!rsl) return null;
  const lane = ctx.graph.get(rsl as string);
  if (!lane) return null;
  const localS = Math.max(0, Math.min(lane.lengthM, s - (segment.laneStartS[idx] as number)));
  const pose = poseAtS(lane.points, lane.cum, localS);
  return {
    rsl,
    localS,
    x: pose.point.x,
    y: pose.point.y,
    headingRad: pose.headingRad,
    isJunction: lane.isJunction,
  };
}

/**
 * Distance from a point on a chain to the nearest junction, along the chain.
 *
 * Counts junctions the chain passes *through* as well as the ones at its ends;
 * returns 0 when the point is inside a junction. `Infinity` when the chain
 * neither starts, ends, nor passes through one.
 */
export function distanceToJunctionM(segment: Segment, s: number): number {
  let best = Infinity;
  for (const interval of segment.junctionIntervals) {
    if (s >= interval.startS && s <= interval.endS) return 0;
    best = Math.min(best, Math.abs(s - interval.startS), Math.abs(s - interval.endS));
  }
  if (segment.entryJunctionId) best = Math.min(best, s);
  if (segment.exitJunctionId) best = Math.min(best, segment.lengthM - s);
  return best;
}
