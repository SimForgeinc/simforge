/**
 * Matcher outputs: `AnchorFrame`, `ClauseResult`, `FeatureBinding`,
 * `DegradationReport`, `MatchedSite`.
 *
 * `ClauseResult` is deliberately the *same shape* the tier-1/tier-2 validator
 * emits (`docs/agent-authoring-architecture.md` §3) so the UI and the CLI can
 * render one unified quality report.
 */

import type { Essentiality, FeatureKind } from './anchor.js';
import type { ConflictPair, LaneRsl, Point2 } from './map-index.js';
import type { OnMissing, RoleBindingKind } from './roles.js';

/** A pose in the anchor frame. Never world space. */
export interface FramePose {
  /** Signed same-direction lane index; 0 = reference lane, +1 = one to the left. */
  k: number;
  /** Arc length from the origin feature along the reference path. */
  s: number;
  /** Lateral offset as a **fraction of local lane width** (metres don't transfer). */
  tFrac: number;
  headingOffsetRad: number;
}

/** One lane's slice of the reference path. */
export interface ReferenceSpan {
  laneRsl: LaneRsl;
  sStart: number;
  sEnd: number;
  lengthM: number;
  isJunction: boolean;
  /** False when the link into this span is not physically contiguous. */
  contiguous: boolean;
}

/**
 * The coordinate system the whole scenario is expressed in — identical in shape
 * on every map, which is what makes a template portable.
 */
export interface AnchorFrame {
  /** The map feature that establishes `s = 0`. */
  origin: {
    anchorFeatureId: string;
    kind: FeatureKind | 'corridor';
    /** Concrete map feature id, e.g. `junction:115`. Part of the site id. */
    mapFeatureId: string;
  };
  /** Lane the ego enters the origin feature on. Part of the site id. */
  entryLaneRsl: LaneRsl;
  /** Ordered lane chain, junction-internal lanes included, `s` ascending. */
  referencePath: ReferenceSpan[];
  /** Cumulative arc length at each lane's start, keyed by rsl. */
  sOfLane: Record<LaneRsl, number>;
  /** Total `[sMin, sMax]` covered by the reference path. */
  sRange: [number, number];
  /** Same-direction lanes at the origin cross-section, by signed k. */
  lateralLanes: Record<number, LaneRsl>;
  /** Opposing driving lanes at the origin cross-section, innermost first. */
  opposingLanes: LaneRsl[];
  handedness: 'right' | 'left';
  /** True when the site only fits with left/right swapped. */
  mirrored: boolean;
  /** Gate the reference path takes through the origin junction, when any. */
  egoGateId?: string;
  egoTurn?: 'left' | 'right' | 'straight' | 'uturn';
  /** Drivable metres available up/downstream of the origin. */
  runwayUpstreamM: number;
  runwayDownstreamM: number;
}

/** One evaluated clause — the unit of explainability. */
export interface ClauseResult {
  /** Dotted path into the anchor, e.g. `corridor.speedLimitKph`. */
  path: string;
  essentiality: Essentiality;
  /** What the anchor asked for. */
  required: unknown;
  /** What the site actually offers (worst value over the interval). */
  actual: unknown;
  /** 0..1. */
  score: number;
  /** Signed distance outside the accepted band, in clause units. 0 when inside. */
  slack: number;
  weight: number;
  /** False when the derived index cannot answer this clause at all. */
  supported: boolean;
  /** Where the worst sample was taken, when the clause is sampled over `s`. */
  worstAtS?: number;
  reason: string;
}

/** Structural binding of one role at one site. */
export interface FeatureBinding {
  role: string;
  kind: RoleBindingKind;
  status: 'bound' | 'clamped' | 'dropped' | 'failed';
  pose?: FramePose;
  laneRsl?: LaneRsl;
  /** Lane chain the actor drives, for the solver's route walk. */
  routeLaneChain?: LaneRsl[];
  /** Conflict geometry handed to the arrival solver. */
  conflict?: {
    gateId: string;
    egoGateId: string;
    point: Point2;
    /** Arc length along the ego reference path at the conflict point. */
    sOnEgo: number;
    /** Arc length along the actor route at the conflict point. */
    sOnActor: number;
    crossingAngleDeg: number;
    relation: ConflictPair['relation'];
    /** |actual - template| crossing-angle error used to rank this gate. */
    angleErrorDeg: number;
  };
  arrival?: { relativeTo: string; deltaT: number };
  onMissing?: OnMissing;
  /**
   * The signed lane index the role actually asked for, when the binding is
   * lane-indexed. `pose.k` is where the actor ended up; these differ exactly
   * when `onMissing: 'clamp'` moved it. `relative_to` needs this recorded
   * because its request is `ref.pose.k + dLane` and cannot be recovered from
   * the role alone.
   */
  requestedK?: number;
  notes: string[];
}

/** A relaxation the matcher applied to make a site work. */
export type Repair =
  | {
      kind: 'speed_clamp';
      path: string;
      requestedKph: [number, number];
      appliedKph: number;
      touchesRequired: boolean;
      note: string;
    }
  | {
      kind: 'runway_shorten';
      path: string;
      requestedM: number;
      availableM: number;
      touchesRequired: boolean;
      note: string;
    }
  | {
      kind: 'feature_distance_relax';
      path: string;
      requestedM: [number, number];
      actualM: number;
      slackM: number;
      touchesRequired: boolean;
      note: string;
    }
  | {
      kind: 'lane_offset_clamp';
      role: string;
      requestedK: number;
      appliedK: number;
      touchesRequired: boolean;
      note: string;
    }
  | {
      kind: 'junction_class_substitute';
      path: string;
      requested: string[];
      actual: string;
      nearMissScore: number;
      touchesRequired: boolean;
      note: string;
    }
  | {
      kind: 'actor_drop';
      role: string;
      reason: string;
      touchesRequired: boolean;
      note: string;
    };

export type Verdict = 'exact' | 'degraded' | 'infeasible';

export interface DegradationReport {
  verdict: Verdict;
  score: number;
  repairs: Repair[];
  /** Paths of required clauses (or roles) that could not be satisfied. */
  failedRequiredClauses: string[];
  /** Plain language, for the site picker and the .xosc provenance block. */
  summary: string;
  /**
   * True when nothing that changes *what the scenario tests* was relaxed.
   * Degradation may relax presentation, never intent.
   */
  intentPreserved: boolean;
}

export interface MatchedSite {
  siteId: string;
  mapId: string;
  topologyDigest: string;
  matchSemanticsVersion: string;
  anchorId: string;
  score: number;
  frame: AnchorFrame;
  clauses: ClauseResult[];
  bindings: FeatureBinding[];
  /** Concrete map features bound to each anchor feature id. */
  featureMatches: Record<string, { mapFeatureId: string; s: number; kind: FeatureKind }>;
  degradation: DegradationReport;
  /** Human-readable, UI-ready justification lines. */
  matchedReasons: string[];
  /** Frames that resolved to the same site id and lost on score. */
  alternateFrames: number;
}

export interface MatchStats {
  candidatesConsidered: number;
  framesBuilt: number;
  sitesScored: number;
  sitesInfeasible: number;
  sitesBelowMinScore: number;
  sitesDroppedByDiversity: number;
  /** Clause paths ordered by the selectivity used for candidate generation. */
  selectivityOrder: string[];
}

export interface MatchReport {
  sites: MatchedSite[];
  /** Sites that were generated but rejected, with their reports. */
  rejected: MatchedSite[];
  stats: MatchStats;
  /** Plain-language explanation when `sites` is empty. */
  failureSummary: string;
  /** Capability gaps that affected the result. */
  warnings: string[];
}
