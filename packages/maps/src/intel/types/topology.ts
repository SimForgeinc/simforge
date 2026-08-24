/**
 * Derived per-map topology — the indexes an anchor matcher runs against.
 *
 * Per `docs/research/retargeting.md` §"Derived per-map indexes": Segments,
 * JunctionDescriptors (with `conflictPairs`), and a FactIndex for
 * selectivity-ordered candidate generation.
 */

import type { GateId, JunctionId, LaneRef, LocationId, MapId, SegmentId } from './ids.js';

/** One sample of a segment's piecewise profile. */
export interface SegmentProfileSample {
  /** Arc length from the segment start, metres. */
  s: number;
  /** Lanes travelling the same direction as the segment, including this one. */
  lanesSameDir: number;
  /** Lanes travelling the opposing direction on the same carriageway. */
  lanesOpposing: number;
  speedLimitKph: number;
  laneWidthM: number;
  /** Absolute heading change per 10 m of arc length, degrees. */
  curvatureDegPer10m: number;
}

/** A lane-change opportunity expressed in segment arc length. */
export interface LaneChangeInterval {
  side: 'left' | 'right';
  startS: number;
  endS: number;
  allowed: boolean;
  /** Target lane, when the topology index names one. */
  targetRsl: LaneRef | null;
}

/** A stretch of a segment that lies inside a junction. */
export interface JunctionInterval {
  junctionId: JunctionId;
  /** Arc length along the segment where the junction is entered. */
  startS: number;
  /** Arc length along the segment where the junction is left. */
  endS: number;
}

/**
 * A maximal same-direction driving corridor.
 *
 * Chains are built geometrically: a link exists only when the successor's
 * polyline actually starts at the predecessor's end (within
 * `CHAIN_GAP_TOLERANCE_M`) with a continuous heading, *and* the link is
 * unambiguous in both directions. That rules out the "successors that aren't
 * physically contiguous" failure mode.
 *
 * **Junction traversal.** The research doc specifies "non-junction" chains, but
 * on the real dev maps that definition is degenerate: 363 of Yale's 622 driving
 * lanes are junction-internal, and 251 of its 259 non-junction driving lanes
 * have *no* non-junction successor at all — every road stub is bounded by
 * junction lanes on both ends, so "maximal non-junction chain" == "one 25 m
 * road stub". Chains therefore continue through a junction when — and only
 * when — the movement is the unambiguous **straight-through** one
 * (`turnRelation === 'Straight'` and a small heading change). Direction is
 * still preserved, and the junctions traversed are recorded in
 * {@link junctionIntervals} so "no junction within 80 m" stays answerable.
 */
export interface Segment {
  id: SegmentId;
  /** Ordered lane chain, including any junction-internal lanes traversed. */
  laneRefs: LaneRef[];
  /** The subset of `laneRefs` that is junction-internal. */
  junctionLaneRefs: LaneRef[];
  /** Where along the chain the junctions are. */
  junctionIntervals: JunctionInterval[];
  /** Cumulative arc length at the start of each lane in `laneRefs`. */
  laneStartS: number[];
  lengthM: number;
  /** Display only. Most common road name over the chain, or `''`. */
  roadName: string;
  laneType: string;
  /** Profile sampled at a fixed stride (see `PROFILE_STRIDE_M`). */
  profile: SegmentProfileSample[];
  /** Worst-case (minimum) same-direction lane count over the whole chain. */
  minLanesSameDir: number;
  maxLanesSameDir: number;
  minSpeedLimitKph: number;
  maxSpeedLimitKph: number;
  maxCurvatureDegPer10m: number;
  hasParkingAdjacent: boolean;
  hasBikeAdjacent: boolean;
  hasSidewalkAdjacent: boolean;
  hasShoulderAdjacent: boolean;
  hasMedianAdjacent: boolean;
  isOneWay: boolean;
  laneChangeIntervals: LaneChangeInterval[];
  /** Junction the chain emerges from, if any. */
  entryJunctionId: JunctionId | null;
  /** Junction the chain feeds into, if any. */
  exitJunctionId: JunctionId | null;
}

/** How a junction arm's approach can proceed. */
export interface TurnOption {
  gateId: GateId;
  /** `Left` | `Right` | `Straight` | `UTurnLeft` | `UTurnRight`. */
  turn: string;
  connectingLaneRsl: LaneRef;
  exitLaneRsls: LaneRef[];
  headingChangeRad: number;
}

/** One inbound lane at a junction. */
export interface JunctionApproach {
  laneRsl: LaneRef;
  /** Compass bearing of travel *into* the junction, degrees (0 = north, CW). */
  bearingDeg: number;
  /** Index into {@link JunctionDescriptor.arms}. */
  armIndex: number;
  roadName: string;
  speedLimitKph: number;
  turnOptions: TurnOption[];
}

/** A physical leg of a junction (one road stub), grouping inbound and outbound lanes. */
export interface JunctionArm {
  index: number;
  /** Compass bearing from the junction centre out along the leg, degrees. */
  bearingDeg: number;
  roadName: string;
  approachLaneRefs: LaneRef[];
  exitLaneRefs: LaneRef[];
  inboundLaneCount: number;
  outboundLaneCount: number;
}

/** Derived control type. */
export type JunctionControl =
  | 'signalized'
  | 'all_way_stop'
  | 'minor_stop'
  | 'yield'
  | 'uncontrolled';

/** How two conflicting movements relate, from A's point of view. */
export type ConflictRelation = 'opposing' | 'from_left' | 'from_right' | 'same_dir_merge';

/**
 * A precomputed crossing between two junction movements.
 *
 * This is the single highest-value derived fact in the whole index: it is what
 * lets "a car turns left across your path" survive being retargeted onto a
 * different junction on a different map.
 */
export interface ConflictPair {
  gateA: GateId;
  gateB: GateId;
  /**
   * `crossing` — the two centrelines properly intersect.
   * `merge` — they converge into a shared exit lane without crossing.
   * Different scenarios: a crossing is a T-bone risk, a merge is a squeeze.
   */
  kind: 'crossing' | 'merge';
  /** Crossing point in xodr-local metres. */
  pointXY: readonly [number, number];
  /** Arc length along A's connecting lane at the crossing, metres. */
  sOnA: number;
  /** Arc length along B's connecting lane at the crossing, metres. */
  sOnB: number;
  /** Angle between the two paths at the crossing, radians in `[0, PI]`. */
  crossingAngleRad: number;
  relation: ConflictRelation;
  /** `Left`/`Straight`/... for A and B, hoisted for cheap filtering. */
  turnA: string;
  turnB: string;
}

/** Everything a matcher needs to know about one junction. */
export interface JunctionDescriptor {
  junctionId: JunctionId;
  /** Catalog record for the same junction. */
  locationId: LocationId;
  /** Centroid in xodr-local metres. */
  centerXY: readonly [number, number];
  /** Largest extent of the junction footprint, metres. */
  sizeM: number;
  arms: JunctionArm[];
  armCount: number;
  approaches: JunctionApproach[];
  control: JunctionControl;
  /** Evidence that produced `control`, for explainability. */
  controlEvidence: string[];
  internalLaneRefs: LaneRef[];
  /** Crosswalk catalog records within the junction footprint. */
  crossingLocationIds: LocationId[];
  conflictPairs: ConflictPair[];
}

/**
 * Inverted indexes for selectivity-ordered candidate generation.
 *
 * Linear scan is already fast at this scale (≈700 locations, ≈70 junctions per
 * map). The index exists so the *rarest* clause can be evaluated first, not
 * because scanning is slow — hence the deliberately simple representation, and
 * the test that index and linear scan agree exactly.
 */
export interface FactIndex {
  locationsByType: Record<string, LocationId[]>;
  locationsBySubtype: Record<string, LocationId[]>;
  locationsByTag: Record<string, LocationId[]>;
  locationsByAffordance: Record<string, LocationId[]>;
  /** `factKey` → stringified value → ids. Only low-cardinality facts. */
  locationsByFact: Record<string, Record<string, LocationId[]>>;
  /** Fact keys deliberately left out of `locationsByFact` (too high-cardinality). */
  unindexedFactKeys: string[];
  segmentsByLaneCount: Record<string, SegmentId[]>;
  segmentsBySpeedLimitKph: Record<string, SegmentId[]>;
  junctionsByControl: Record<string, JunctionId[]>;
  junctionsByArmCount: Record<string, JunctionId[]>;
  /** Lane → the segment that contains it. */
  segmentByLaneRef: Record<string, SegmentId>;
}

/** The built, serialisable derived topology. */
export interface DerivedTopology {
  derivedVersion: number;
  /** Same value as the catalog's — the two artifacts are built together. */
  catalogRevision: string;
  mapId: MapId;
  mapAssetId: string;
  /** sha256 over the topology index alone; a matcher stamp field. */
  topologyDigest: string;
  builtAt: string;
  segments: Segment[];
  junctions: JunctionDescriptor[];
  factIndex: FactIndex;
  stats: DerivedTopologyStats;
}

/** Build-time summary for the derived topology. */
export interface DerivedTopologyStats {
  segmentCount: number;
  junctionCount: number;
  conflictPairCount: number;
  conflictPairsByRelation: Record<string, number>;
  junctionsByControl: Record<string, number>;
  totalSegmentLengthM: number;
}
