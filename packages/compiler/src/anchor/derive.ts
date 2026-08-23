/**
 * Self-derivation of a {@link DerivedMapIndex} straight from
 * `topology-index.json.gz` (+ the optional `search-index.json.gz` for junction
 * control).
 *
 * `packages/maps` owns this derivation in production. This module exists
 * so the matcher lane is **not blocked** on that sibling and so the algorithm
 * has a second, independent implementation of the derived facts to test
 * against. `normalize.ts` is the seam: when map-intel's
 * `derived/topology-derived.json` is present, it is adapted instead.
 *
 * Two facts about the raw topology index drive most of the code here:
 *
 * 1. **Polylines are in OpenDRIVE `s` order, not travel order.** For lanes with
 *    `laneId > 0` travel runs backwards along the polyline. Verified on Yale:
 *    with that flip, 498/537 gates have their approach's travel-end within
 *    1.5 m of their connecting lane's travel-start.
 * 2. **`predecessors`/`successors` are undirected.** The same neighbour often
 *    appears in both lists. Direction is therefore re-derived geometrically,
 *    which also gives us the physical-contiguity flag the research doc demands
 *    ("successors that aren't physically contiguous").
 */

import { sha256Hex } from './sha256.js';
import {
  angleDiff,
  cumulativeLengths,
  curvatureDegPer10mAt,
  dist,
  headingAtS,
  pointAtS,
  polylineIntersection,
  polylineLength,
  toDeg,
  bbox,
  bboxOverlaps,
} from './geometry.js';
import { adjacentKinds, crossSectionAt, laneWidthAt } from './cross-section.js';
import type { JunctionControl, Turn } from './types/anchor.js';
import { DERIVED_INDEX_CONTRACT_VERSION } from './version.js';
import type {
  ConflictPair,
  DerivedGate,
  DerivedLane,
  DerivedMapIndex,
  FactIndex,
  JunctionApproach,
  JunctionDescriptor,
  LaneRsl,
  Point2,
  Segment,
  SegmentProfileSample,
} from './types/map-index.js';

/** Metres within which two lane ends count as physically contiguous. */
export const LINK_TOLERANCE_M = 2.0;
/** Profile sampling stride along a segment. */
export const PROFILE_STRIDE_M = 10;

export interface RawTopologyLane {
  rsl: string;
  roadId: number;
  section: number;
  laneId: number;
  laneType: string;
  isJunction: boolean;
  junctionId: string | null;
  predecessors: string[];
  successors: string[];
  speedLimitKph: number;
  representativeWidthM: number;
  widthSamples: Array<{ s: number; widthM: number }>;
  adjacentLanes: {
    left: { laneRsl: string | null; sameDirection: boolean };
    right: { laneRsl: string | null; sameDirection: boolean };
  };
  laneChangePermissions: Array<{
    side: 'left' | 'right';
    startS: number;
    endS: number;
    allowed: boolean;
  }>;
  polyline: Point2[];
}

export interface RawTopologyIndex {
  schemaVersion: number;
  mapName?: string;
  source?: { xodrSha256?: string };
  lanes: Record<string, RawTopologyLane>;
  gates: Array<{
    id: string;
    junctionId: string;
    turnRelation: string;
    headingChangeRad: number;
    connectingLaneRsl: string;
    approachLaneRsl: string;
    exitLaneRsls: string[];
  }>;
  junctions: Record<
    string,
    { junctionId: string; gateIds: string[]; internalLaneRsls: string[]; approachLaneRsls: string[] }
  >;
}

/** The `search-index.json` object bag, narrowed to what we consume. */
export interface RawSearchIndex {
  objects: Record<
    string,
    { kind?: string; id?: string; name?: string; facts?: Record<string, unknown> }
  >;
}

export interface DeriveOptions {
  mapId: string;
  searchIndex?: RawSearchIndex;
  handedness?: 'right' | 'left';
  /** Override the computed digest (e.g. to match map-intel's). */
  topologyDigest?: string;
}

const TURN_MAP: Record<string, Turn> = {
  Right: 'right',
  Left: 'left',
  Straight: 'straight',
  UTurnLeft: 'uturn',
  UTurnRight: 'uturn',
  right: 'right',
  left: 'left',
  straight: 'straight',
  uturn: 'uturn',
};

export function normalizeTurn(raw: string): Turn {
  return TURN_MAP[raw] ?? 'straight';
}

/** Travel-ordered polyline: reversed when the lane runs against OpenDRIVE `s`. */
function travelPolyline(lane: RawTopologyLane): Point2[] {
  return lane.laneId > 0 ? [...lane.polyline].reverse() : lane.polyline.map((p) => ({ ...p }));
}

function travelEnd(poly: Point2[]): Point2 {
  return poly[poly.length - 1] ?? { x: 0, y: 0 };
}

function normalizeWidthSamples(
  lane: RawTopologyLane,
  lengthM: number,
): Array<{ s: number; widthM: number }> {
  const samples = lane.widthSamples ?? [];
  if (lane.laneId <= 0) return samples.map((w) => ({ ...w })).sort((a, b) => a.s - b.s);
  return samples
    .map((w) => ({ s: Math.max(0, lengthM - w.s), widthM: w.widthM }))
    .sort((a, b) => a.s - b.s);
}

function normalizePermissions(
  lane: RawTopologyLane,
  lengthM: number,
): DerivedLane['laneChangePermissions'] {
  const perms = lane.laneChangePermissions ?? [];
  if (lane.laneId <= 0) {
    return perms.map((p) => ({ side: p.side, startS: p.startS, endS: p.endS, allowed: p.allowed }));
  }
  // Travel runs against `s`: both the interval and the side flip.
  return perms.map((p) => ({
    side: p.side === 'left' ? 'right' : 'left',
    startS: Math.max(0, lengthM - p.endS),
    endS: Math.max(0, lengthM - p.startS),
    allowed: p.allowed,
  }));
}

/** Reverse a lane in place: polyline, width samples, permission intervals and sides. */
function reverseLaneInPlace(lane: DerivedLane): void {
  lane.polyline = [...lane.polyline].reverse();
  lane.widthSamples = lane.widthSamples
    .map((w) => ({ s: Math.max(0, lane.lengthM - w.s), widthM: w.widthM }))
    .sort((a, b) => a.s - b.s);
  lane.laneChangePermissions = lane.laneChangePermissions.map((p) => ({
    side: p.side === 'left' ? 'right' : 'left',
    startS: Math.max(0, lane.lengthM - p.endS),
    endS: Math.max(0, lane.lengthM - p.startS),
    allowed: p.allowed,
  }));
}

/**
 * Resolve junction-internal lane direction **from the approach**.
 *
 * The lane-id sign rule holds for road lanes but not reliably for connecting
 * lanes: on Yale it puts 39 of 537 gates' connecting lanes backwards, which
 * would silently drop those movements from every frame (and, worse, could put a
 * reference path into a lane travelled the wrong way). A gate declares which
 * approach feeds which connecting lane, so the approach's travel end decides
 * the orientation. Same policy the sim-engine lane arrived at independently.
 *
 * @returns how many connecting lanes were flipped.
 */
function alignJunctionLanesToGates(
  lanes: Record<LaneRsl, DerivedLane>,
  raw: RawTopologyIndex,
): number {
  let flipped = 0;
  const seen = new Set<LaneRsl>();
  for (const gate of [...raw.gates].sort((a, b) => (a.id < b.id ? -1 : 1))) {
    const approach = lanes[gate.approachLaneRsl];
    const connecting = lanes[gate.connectingLaneRsl];
    if (!approach || !connecting || connecting.polyline.length < 2) continue;
    if (!connecting.isJunction || seen.has(connecting.rsl)) continue;
    seen.add(connecting.rsl);
    const approachEnd = travelEnd(approach.polyline);
    const toStart = dist(approachEnd, connecting.polyline[0] as Point2);
    const toEnd = dist(approachEnd, travelEnd(connecting.polyline));
    if (toEnd < toStart && toEnd <= LINK_TOLERANCE_M) {
      reverseLaneInPlace(connecting);
      flipped += 1;
    }
  }
  return flipped;
}

/**
 * Directed, geometry-verified lane links.
 *
 * Candidate neighbours come from the raw (undirected) `predecessors` +
 * `successors` lists and from gate declarations; a link survives only when the
 * ends actually meet and the headings are continuous.
 */
function buildDirectedLinks(
  lanes: Record<LaneRsl, DerivedLane>,
  raw: RawTopologyIndex,
): void {
  const candidates = new Map<LaneRsl, Set<LaneRsl>>();
  const add = (a: LaneRsl, b: LaneRsl): void => {
    if (!lanes[a] || !lanes[b] || a === b) return;
    let set = candidates.get(a);
    if (!set) {
      set = new Set();
      candidates.set(a, set);
    }
    set.add(b);
  };
  for (const rsl of Object.keys(raw.lanes).sort()) {
    const lane = raw.lanes[rsl];
    if (!lane) continue;
    for (const other of [...lane.predecessors, ...lane.successors]) {
      add(rsl, other);
      add(other, rsl);
    }
  }
  for (const gate of raw.gates) {
    add(gate.approachLaneRsl, gate.connectingLaneRsl);
    add(gate.connectingLaneRsl, gate.approachLaneRsl);
    for (const exit of gate.exitLaneRsls) {
      add(gate.connectingLaneRsl, exit);
      add(exit, gate.connectingLaneRsl);
    }
  }

  for (const rsl of [...candidates.keys()].sort()) {
    const lane = lanes[rsl];
    if (!lane) continue;
    const succ = new Set<LaneRsl>();
    const pred = new Set<LaneRsl>();
    for (const otherRsl of [...(candidates.get(rsl) ?? [])].sort()) {
      const other = lanes[otherRsl];
      if (!other || other.polyline.length < 2 || lane.polyline.length < 2) continue;
      const aEnd = travelEnd(lane.polyline);
      const bStart = other.polyline[0] as Point2;
      const bEnd = travelEnd(other.polyline);
      const aStart = lane.polyline[0] as Point2;
      const headingOut = headingAtS(lane.polyline, lane.lengthM);
      const headingIn = headingAtS(other.polyline, 0);
      const continuous = Math.abs(angleDiff(headingIn, headingOut)) < (2 * Math.PI) / 3;
      if (dist(aEnd, bStart) <= LINK_TOLERANCE_M && continuous) succ.add(otherRsl);
      if (dist(bEnd, aStart) <= LINK_TOLERANCE_M) pred.add(otherRsl);
    }
    lane.successors = [...succ].sort();
    lane.predecessors = [...pred].sort();
  }
}

function controlFromSearchIndex(
  junctionId: string,
  search: RawSearchIndex | undefined,
): JunctionControl | 'unknown' {
  const obj = search?.objects?.[`junction:${junctionId}`];
  const facts = obj?.facts;
  if (!facts) return 'unknown';
  const control = String(facts['control_type'] ?? '');
  if (control === 'traffic_light' || facts['has_signal'] === true) return 'signalized';
  if (control === 'roundabout') return 'roundabout';
  if (control === 'stop') return facts['is_all_way_stop'] === true ? 'all_way_stop' : 'minor_stop';
  if (control === 'yield') return 'yield';
  if (control === 'uncontrolled') return 'uncontrolled';
  return 'unknown';
}

function approachIdOf(junctionId: string, lane: DerivedLane): string {
  return `${junctionId}#${lane.roadId}:${lane.section}`;
}

/** Where B comes from, seen from A's approach heading. */
export function relationFromHeadings(
  egoHeadingRad: number,
  otherHeadingRad: number,
): ConflictPair['relation'] {
  const d = toDeg(angleDiff(otherHeadingRad, egoHeadingRad));
  const abs = Math.abs(d);
  if (abs >= 135) return 'opposing';
  if (abs <= 25) return 'merge';
  return d < 0 ? 'from_left' : 'from_right';
}

function buildJunctionDescriptor(
  junctionId: string,
  raw: RawTopologyIndex,
  lanes: Record<LaneRsl, DerivedLane>,
  gatesById: Map<string, DerivedGate>,
  search: RawSearchIndex | undefined,
): JunctionDescriptor {
  const rawJunction = raw.junctions[junctionId];
  const gateIds = [...(rawJunction?.gateIds ?? [])].sort();
  const internalLaneRsls = [...(rawJunction?.internalLaneRsls ?? [])].sort();

  // Approaches, grouped by the approach lane's (road, section).
  const byApproach = new Map<string, { lanes: Set<LaneRsl>; gates: Set<string>; turns: Set<Turn> }>();
  for (const gateId of gateIds) {
    const gate = gatesById.get(gateId);
    if (!gate) continue;
    const lane = lanes[gate.approachLaneRsl];
    if (!lane) continue;
    const id = approachIdOf(junctionId, lane);
    let entry = byApproach.get(id);
    if (!entry) {
      entry = { lanes: new Set(), gates: new Set(), turns: new Set() };
      byApproach.set(id, entry);
    }
    entry.lanes.add(gate.approachLaneRsl);
    entry.gates.add(gateId);
    entry.turns.add(gate.turnRelation);
  }

  const approaches: JunctionApproach[] = [...byApproach.keys()].sort().map((id) => {
    const entry = byApproach.get(id)!;
    const laneRsls = [...entry.lanes].sort();
    const first = lanes[laneRsls[0] as LaneRsl];
    const bearingDeg = first ? toDeg(headingAtS(first.polyline, first.lengthM)) : 0;
    const cs = first ? crossSectionAt(lanes, first.rsl, Math.max(0, first.lengthM - 0.5)) : null;
    return {
      id,
      laneRsls,
      bearingDeg,
      turnOptions: [...entry.turns].sort(),
      gateIds: [...entry.gates].sort(),
      throughLanes: cs ? cs.sameDirDriving.size : laneRsls.length,
    };
  });

  // Arms: legs radiating from the junction centre, clustered by bearing.
  const internalPoints: Point2[] = [];
  for (const rsl of internalLaneRsls) {
    const lane = lanes[rsl];
    if (lane) internalPoints.push(...lane.polyline);
  }
  const centre =
    internalPoints.length > 0
      ? {
          x: internalPoints.reduce((acc, p) => acc + p.x, 0) / internalPoints.length,
          y: internalPoints.reduce((acc, p) => acc + p.y, 0) / internalPoints.length,
        }
      : { x: 0, y: 0 };
  // Arms are counted from **outward leg directions**, not from bearings around
  // the centroid: on a 70 m junction the approach and exit centrelines of one
  // leg sit 15 m apart, and a centroid-bearing clustering splits that single
  // leg in two (observed on Yale: 6-8 "arms" at junctions the catalog calls
  // 4-way). The outward direction of an inbound lane is its reversed travel
  // heading; of an outbound lane, its travel heading.
  const legDirections: number[] = [];
  for (const rsl of [...(rawJunction?.approachLaneRsls ?? [])].sort()) {
    const lane = lanes[rsl];
    if (!lane || lane.laneType !== 'driving') continue;
    legDirections.push(headingAtS(lane.polyline, lane.lengthM) + Math.PI);
  }
  for (const gateId of gateIds) {
    const gate = gatesById.get(gateId);
    if (!gate) continue;
    for (const exitRsl of gate.exitLaneRsls) {
      const lane = lanes[exitRsl];
      if (!lane || lane.laneType !== 'driving') continue;
      legDirections.push(headingAtS(lane.polyline, 0));
    }
  }
  const clusters: number[] = [];
  for (const b of legDirections.sort((a, z) => a - z)) {
    if (!clusters.some((c) => Math.abs(toDeg(angleDiff(b, c))) < 45)) clusters.push(b);
  }
  const arms = Math.max(clusters.length, approaches.length > 0 ? 2 : 0);

  // Size: diagonal of the junction-internal bounding box.
  let sizeM = 0;
  if (internalPoints.length > 1) {
    const box = bbox(internalPoints);
    sizeM = Math.hypot(box.maxX - box.minX, box.maxY - box.minY);
  }

  // conflictPairs: every pair of gates whose connecting-lane centrelines cross.
  const conflictPairs: ConflictPair[] = [];
  for (let i = 0; i < gateIds.length; i += 1) {
    const gateA = gatesById.get(gateIds[i] as string);
    if (!gateA) continue;
    const laneA = lanes[gateA.connectingLaneRsl];
    const approachA = lanes[gateA.approachLaneRsl];
    if (!laneA || !approachA || laneA.polyline.length < 2) continue;
    const boxA = bbox(laneA.polyline);
    for (let j = i + 1; j < gateIds.length; j += 1) {
      const gateB = gatesById.get(gateIds[j] as string);
      if (!gateB) continue;
      const laneB = lanes[gateB.connectingLaneRsl];
      const approachB = lanes[gateB.approachLaneRsl];
      if (!laneB || !approachB || laneB.polyline.length < 2) continue;
      if (gateA.approachLaneRsl === gateB.approachLaneRsl) continue;
      if (!bboxOverlaps(boxA, bbox(laneB.polyline), 1)) continue;
      const crossing = polylineIntersection(laneA.polyline, laneB.polyline);
      if (!crossing) continue;
      const headingA = headingAtS(approachA.polyline, approachA.lengthM);
      const headingB = headingAtS(approachB.polyline, approachB.lengthM);
      // Two movements that converge on a shared exit cross at a shallow angle:
      // that is a *merge*, whatever their approach bearings say. Classifying it
      // by approach bearing alone would sell a right-turn-into-the-same-exit as
      // a "from_left" T-bone.
      const relation =
        crossing.angleDeg <= 30
          ? ('merge' as const)
          : relationFromHeadings(headingA, headingB);
      conflictPairs.push({
        gateA: gateA.id,
        gateB: gateB.id,
        point: crossing.point,
        sOnA: crossing.sOnA,
        sOnB: crossing.sOnB,
        crossingAngleDeg: crossing.angleDeg,
        relation,
      });
    }
  }
  conflictPairs.sort((a, b) => (a.gateA === b.gateA ? (a.gateB < b.gateB ? -1 : 1) : a.gateA < b.gateA ? -1 : 1));

  return {
    junctionId,
    arms,
    approaches,
    control: controlFromSearchIndex(junctionId, search),
    sizeM,
    conflictPairs,
    crossingsByApproach: {},
    gateIds,
    internalLaneRsls,
  };
}

function buildSegments(lanes: Record<LaneRsl, DerivedLane>): Segment[] {
  const isCorridorLane = (lane: DerivedLane | undefined): lane is DerivedLane =>
    !!lane && lane.laneType === 'driving' && !lane.isJunction;

  const consumed = new Set<LaneRsl>();
  const segments: Segment[] = [];

  for (const rsl of Object.keys(lanes).sort()) {
    const lane = lanes[rsl];
    if (!isCorridorLane(lane) || consumed.has(rsl)) continue;
    // Only start a chain at a genuine head.
    const corridorPreds = lane.predecessors.filter((p) => isCorridorLane(lanes[p]));
    if (corridorPreds.length === 1) {
      const pred = lanes[corridorPreds[0] as LaneRsl];
      if (pred && pred.successors.filter((s) => isCorridorLane(lanes[s])).length === 1) continue;
    }

    const chain: LaneRsl[] = [];
    let cursor: DerivedLane | undefined = lane;
    while (cursor && isCorridorLane(cursor) && !consumed.has(cursor.rsl)) {
      chain.push(cursor.rsl);
      consumed.add(cursor.rsl);
      const succ: LaneRsl[] = cursor.successors.filter((s: LaneRsl) => isCorridorLane(lanes[s]));
      if (succ.length !== 1) break;
      const next: DerivedLane | undefined = lanes[succ[0] as LaneRsl];
      if (!next) break;
      if (next.predecessors.filter((p: LaneRsl) => isCorridorLane(lanes[p])).length !== 1) break;
      cursor = next;
    }

    const profile: SegmentProfileSample[] = [];
    let acc = 0;
    let minSame = Infinity;
    let maxSame = 0;
    let minSpeed = Infinity;
    let maxSpeed = 0;
    for (const chainRsl of chain) {
      const chainLane = lanes[chainRsl];
      if (!chainLane) continue;
      for (let s = 0; s <= chainLane.lengthM; s += PROFILE_STRIDE_M) {
        const cs = crossSectionAt(lanes, chainRsl, s);
        if (!cs) continue;
        const sample: SegmentProfileSample = {
          s: acc + s,
          laneRsl: chainRsl,
          throughLanesSameDir: cs.sameDirDriving.size,
          throughLanesOpposing: cs.opposingDriving.length,
          laneWidthM: cs.laneWidthM,
          speedLimitKph: cs.speedLimitKph,
          curvatureDegPer10m: curvatureDegPer10mAt(chainLane.polyline, s),
          adjacentKinds: adjacentKinds(cs),
        };
        profile.push(sample);
        minSame = Math.min(minSame, sample.throughLanesSameDir);
        maxSame = Math.max(maxSame, sample.throughLanesSameDir);
        minSpeed = Math.min(minSpeed, sample.speedLimitKph);
        maxSpeed = Math.max(maxSpeed, sample.speedLimitKph);
      }
      acc += chainLane.lengthM;
    }

    const head = lanes[chain[0] as LaneRsl];
    const tail = lanes[chain[chain.length - 1] as LaneRsl];
    const entryJunctionId =
      head?.predecessors.map((p) => lanes[p]?.junctionId).find((j) => !!j) ?? null;
    const exitJunctionId =
      tail?.successors.map((s) => lanes[s]?.junctionId).find((j) => !!j) ?? null;

    segments.push({
      id: `seg:${chain[0]}`,
      laneRsls: chain,
      lengthM: acc,
      profile,
      entryJunctionId,
      exitJunctionId,
      minThroughLanesSameDir: Number.isFinite(minSame) ? minSame : 0,
      maxThroughLanesSameDir: maxSame,
      minSpeedLimitKph: Number.isFinite(minSpeed) ? minSpeed : 0,
      maxSpeedLimitKph: maxSpeed,
    });
  }

  segments.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return segments;
}

export function buildFactIndex(
  lanes: Record<LaneRsl, DerivedLane>,
  descriptors: Record<string, JunctionDescriptor>,
  segments: Segment[],
): FactIndex {
  const junctionsByControl: Record<string, string[]> = {};
  const junctionsByArms: Record<string, string[]> = {};
  const junctionsByTurnOption: Record<string, string[]> = {};
  for (const id of Object.keys(descriptors).sort()) {
    const d = descriptors[id];
    if (!d) continue;
    (junctionsByControl[d.control] ??= []).push(id);
    (junctionsByArms[String(d.arms)] ??= []).push(id);
    const turns = new Set<string>();
    for (const a of d.approaches) for (const t of a.turnOptions) turns.add(t);
    for (const t of [...turns].sort()) (junctionsByTurnOption[t] ??= []).push(id);
  }

  const segmentsByLaneCount: Record<string, string[]> = {};
  const segmentIdsByLane: Record<LaneRsl, string> = {};
  for (const seg of segments) {
    for (let n = seg.minThroughLanesSameDir; n <= seg.maxThroughLanesSameDir; n += 1) {
      (segmentsByLaneCount[String(n)] ??= []).push(seg.id);
    }
    for (const rsl of seg.laneRsls) segmentIdsByLane[rsl] = seg.id;
  }
  for (const key of Object.keys(segmentsByLaneCount)) segmentsByLaneCount[key]?.sort();

  return {
    junctionsByControl,
    junctionsByArms,
    junctionsByTurnOption,
    segmentsByLaneCount,
    segmentIdsByLane,
    pointFeaturesByKind: {},
    totals: {
      junctions: Object.keys(descriptors).length,
      segments: segments.length,
      lanes: Object.keys(lanes).length,
    },
  };
}

/** Build a {@link DerivedMapIndex} from the raw topology index. */
export function deriveMapIndexFromTopology(
  raw: RawTopologyIndex,
  options: DeriveOptions,
): DerivedMapIndex {
  const lanes: Record<LaneRsl, DerivedLane> = {};
  for (const rsl of Object.keys(raw.lanes).sort()) {
    const rawLane = raw.lanes[rsl];
    if (!rawLane) continue;
    const polyline = travelPolyline(rawLane);
    const lengthM = polylineLength(polyline);
    lanes[rsl] = {
      rsl,
      roadId: rawLane.roadId,
      section: rawLane.section,
      laneId: rawLane.laneId,
      laneType: rawLane.laneType,
      isJunction: rawLane.isJunction,
      junctionId: rawLane.junctionId,
      polyline,
      lengthM,
      speedLimitKph: rawLane.speedLimitKph,
      representativeWidthM: rawLane.representativeWidthM,
      widthSamples: normalizeWidthSamples(rawLane, lengthM),
      adjacentLanes: {
        left: {
          laneRsl: rawLane.adjacentLanes?.left?.laneRsl ?? null,
          sameDirection: rawLane.adjacentLanes?.left?.sameDirection ?? false,
        },
        right: {
          laneRsl: rawLane.adjacentLanes?.right?.laneRsl ?? null,
          sameDirection: rawLane.adjacentLanes?.right?.sameDirection ?? false,
        },
      },
      laneChangePermissions: normalizePermissions(rawLane, lengthM),
      predecessors: [],
      successors: [],
    };
  }
  const flippedJunctionLanes = alignJunctionLanesToGates(lanes, raw);
  buildDirectedLinks(lanes, raw);

  const gates: DerivedGate[] = raw.gates
    .map((g) => ({
      id: g.id,
      junctionId: g.junctionId,
      turnRelation: normalizeTurn(g.turnRelation),
      headingChangeRad: g.headingChangeRad,
      approachLaneRsl: g.approachLaneRsl,
      connectingLaneRsl: g.connectingLaneRsl,
      exitLaneRsls: [...g.exitLaneRsls].sort(),
    }))
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const gatesById = new Map(gates.map((g) => [g.id, g]));

  const junctions: DerivedMapIndex['junctions'] = {};
  const junctionDescriptors: Record<string, JunctionDescriptor> = {};
  for (const junctionId of Object.keys(raw.junctions).sort()) {
    const rawJunction = raw.junctions[junctionId];
    if (!rawJunction) continue;
    junctions[junctionId] = {
      junctionId,
      gateIds: [...rawJunction.gateIds].sort(),
      internalLaneRsls: [...rawJunction.internalLaneRsls].sort(),
      approachLaneRsls: [...rawJunction.approachLaneRsls].sort(),
    };
    junctionDescriptors[junctionId] = buildJunctionDescriptor(
      junctionId,
      raw,
      lanes,
      gatesById,
      options.searchIndex,
    );
  }

  const segments = buildSegments(lanes);
  const factIndex = buildFactIndex(lanes, junctionDescriptors, segments);

  const digest =
    options.topologyDigest ??
    sha256Hex(
      [
        raw.source?.xodrSha256 ?? 'unknown',
        String(raw.schemaVersion ?? 0),
        String(Object.keys(lanes).length),
        String(gates.length),
        String(Object.keys(junctions).length),
      ].join('|'),
    ).slice(0, 32);

  const hasControl = Object.values(junctionDescriptors).some((d) => d.control !== 'unknown');

  return {
    mapId: options.mapId,
    topologyDigest: digest,
    handedness: options.handedness ?? 'right',
    lanes,
    gates,
    junctions,
    segments,
    junctionDescriptors,
    pointFeatures: [],
    factIndex,
    capabilities: {
      // Polylines are {x, y} only — grade is genuinely unavailable.
      grade: false,
      crossings: false,
      parkingZones: false,
      workZones: false,
      occlusionZones: false,
      junctionControl: hasControl,
    },
    provenance: {
      source: 'self-derived',
      contractVersion: DERIVED_INDEX_CONTRACT_VERSION,
      notes: [
        'derived in ./index.js from topology-index',
        options.searchIndex ? 'junction control from search-index facts' : 'no junction control source',
        `${flippedJunctionLanes} junction lane(s) re-oriented from their gate approach`,
      ],
    },
  };
}

/** Exposed for tests: arc lengths of a travel-ordered polyline. */
export { cumulativeLengths, laneWidthAt };
