/**
 * `./index.js` — logical anchor → ranked concrete sites.
 *
 * ```ts
 * import {
 *   deriveMapIndexFromTopology, normalizeDerivedMapIndex,
 *   parseLogicalAnchor, matchAnchor, matchAnchorReport,
 * } from './index.js';
 *
 * const index = normalizeDerivedMapIndex(derivedJson, { mapId: 'yale-street' });
 * const anchor = parseLogicalAnchor(json);
 * const sites = matchAnchor(anchor, index, { roles });
 * ```
 *
 * The matcher is a **pure function of `(anchor, derivedIndex)`** — no clock, no
 * RNG, sorted iteration at every fan-out — so a `siteId` produced today is the
 * same one produced on another machine next month, provided the map digest and
 * the match-semantics version are unchanged.
 *
 * @packageDocumentation
 */

export { MATCH_SEMANTICS_VERSION, DERIVED_INDEX_CONTRACT_VERSION } from './version.js';

export {
  LogicalAnchorSchema,
  AnchorFeatureSchema,
  CorridorSchema,
  JunctionPredicateSchema,
  CrossingPredicateSchema,
  ParkingPredicateSchema,
  MatchPolicySchema,
  RangeSchema,
  EssentialitySchema,
  JunctionControlSchema,
  TurnSchema,
  ApproachRelationSchema,
  AdjacentKindSchema,
  SideSchema,
  FeatureKindSchema,
  ToleranceOverridesSchema,
  DEFAULT_POLICY,
  DEFAULT_WEIGHTS,
  parseLogicalAnchor,
  resolvePolicy,
  originFeature,
  clauseWeight,
  type LogicalAnchor,
  type AnchorFeature,
  type Corridor,
  type JunctionPredicate,
  type CrossingPredicate,
  type ParkingPredicate,
  type MatchPolicy,
  type Clause,
  type Essentiality,
  type Range,
  type JunctionControl,
  type Turn,
  type ApproachRelation,
  type AdjacentKind,
  type Side,
  type FeatureKind,
  type ToleranceOverrides,
} from './types/anchor.js';

export {
  RoleBindingSchema,
  OnMissingSchema,
  parseRoleBindings,
  type RoleBinding,
  type RoleBindingKind,
  type OnMissing,
} from './types/roles.js';

export type {
  AdjacentLaneRef,
  ConflictPair,
  DerivedGate,
  DerivedLane,
  DerivedMapIndex,
  FactIndex,
  IndexCapabilities,
  JunctionApproach,
  JunctionDescriptor,
  LaneChangePermission,
  LaneRsl,
  Point2,
  PointFeature,
  Segment,
  SegmentProfileSample,
  WidthSample,
} from './types/map-index.js';

export type {
  AnchorFrame,
  ClauseResult,
  DegradationReport,
  FeatureBinding,
  FramePose,
  MatchReport,
  MatchStats,
  MatchedSite,
  ReferenceSpan,
  Repair,
  Verdict,
} from './types/site.js';

export {
  deriveMapIndexFromTopology,
  normalizeTurn,
  relationFromHeadings,
  LINK_TOLERANCE_M,
  PROFILE_STRIDE_M,
  type DeriveOptions,
  type RawSearchIndex,
  type RawTopologyIndex,
  type RawTopologyLane,
} from './derive.js';

export {
  normalizeDerivedMapIndex,
  normalizeControl,
  detectPolylineOrder,
  looksLikeRawTopologyIndex,
  type NormalizeOptions,
} from './normalize.js';

export {
  buildJunctionFrames,
  buildCorridorFrame,
  enumerateChains,
  laneAtS,
  AMBIGUITY_EPS_RAD,
  MAX_FRAMES_PER_CANDIDATE,
  DEFAULT_RUNWAY_UPSTREAM_M,
  DEFAULT_RUNWAY_DOWNSTREAM_M,
  type JunctionFrameOptions,
} from './frame.js';

export {
  crossSectionAt,
  adjacentKinds,
  laneWidthAt,
  type CrossSection,
  type NeighborLane,
} from './cross-section.js';

export {
  evaluateAnchor,
  aggregateScore,
  sampleCorridor,
  junctionsAlongPath,
  laneCountTransitions,
  SAMPLE_STRIDE_M,
  DEFAULT_CORRIDOR_M,
  type CorridorSample,
  type EvaluationResult,
} from './clauses.js';

export {
  bindRoles,
  egoGateForJunction,
  CONFLICT_RUNUP_M,
  DEFAULT_TEMPLATE_ANGLE_DEG,
} from './bind.js';

export { degrade, type DegradeInput, type DegradeResult } from './degradation.js';

export {
  scoreRange,
  scoreSet,
  scoreBool,
  nearMissScore,
  armCountNearMiss,
  toleranceFor,
  passesRequired,
  NEAR_MISS_TABLE,
  DEFAULT_TOLERANCES,
  type ToleranceKind,
} from './scoring.js';

export { mirrorAnchor, mirrorRoleBindings } from './mirror.js';

export { computeSiteId, quantizeS, S_QUANTUM_M, type SiteIdInput } from './site-id.js';

export { projectPoint, headingAtS, pointAtS } from './geometry.js';

export { sha256Hex } from './sha256.js';

export { matchAnchor, matchAnchorReport, resolveExactCorridorSite, type MatchOptions } from './matcher.js';

export {
  VARIATION_CONTRACT_VERSION,
  inferPortableSitePattern,
  reportSiteEquivalence,
  searchScenarioVariations,
  compareBehaviorSignatures,
  finalizeVariationAcceptance,
  type BehaviorEquivalenceReport,
  type BehaviorSignature,
  type InferSitePatternOptions,
  type PortableSitePattern,
  type SiteEquivalenceReport,
  type SitePatternProvenance,
  type SiteStructuralSignature,
  type VariationCandidate,
  type VariationAcceptanceReport,
  type VariationIssue,
  type VariationIssueCode,
  type VariationIssueStage,
  type VariationSearchResult,
} from './variations.js';
