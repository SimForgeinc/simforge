/**
 * `../index.js` — layer 1 of the UniScenarios stack.
 *
 * Per map, offline, one build step, cached by source hashes:
 *
 * 1. **Location catalog** — the search index's typed objects adopted and
 *    *anchor-lifted* onto the lane graph, then densified with the things nobody
 *    derived before (parking bays with entry poses, one record per junction
 *    movement, 50 m midblock stride, MUTCD school zones, work-zone-suitable
 *    stretches, address-derived building entrances), with content-stable ids
 *    and unique handles.
 * 2. **Derived topology** — Segments with piecewise profiles,
 *    JunctionDescriptors with precomputed **conflictPairs**, and a FactIndex.
 * 3. **Query API** — `findLocations` / `getLocation` / `describeLocation` /
 *    `resolveReference`, pure functions over the built artifacts.
 *
 * ```ts
 * import { buildMapIntelFromDir, findLocations, describeLocation } from '../index.js';
 *
 * const { catalog, derived } = await buildMapIntelFromDir('dev-assets/yale-street');
 *
 * const unprotectedLefts = findLocations(catalog, {
 *   type: 'junction_movement',
 *   facts: [{ key: 'turn_relation', op: 'eq', value: 'Left' },
 *           { key: 'is_protected',  op: 'eq', value: false }],
 *   limit: 10,
 * }, { index: derived.factIndex });
 *
 * console.log(describeLocation(catalog, unprotectedLefts[0]!.location.handle));
 * ```
 *
 * Nothing here imports three.js, and nothing here reads the network.
 *
 * @packageDocumentation
 */

// --- identity -------------------------------------------------------------
export {
  asGateId,
  asHandle,
  asJunctionId,
  asLaneRef,
  asLocationId,
  asMapId,
  asSegmentId,
  formatLaneRef,
  isHandle,
  isLaneRef,
  isLocationId,
  parseLaneRef,
  type Brand,
  type GateId,
  type Handle,
  type JunctionId,
  type LaneRef,
  type LaneRefParts,
  type LocationId,
  type MapId,
  type SegmentId,
} from './types/ids.js';

// --- catalog types --------------------------------------------------------
export {
  AFFORDANCES,
  LOCATION_TYPES,
  RELATION_KINDS,
  type Affordance,
  type AnchorQuality,
  type CatalogStats,
  type FactValue,
  type GeoPoint,
  type LocationAnchor,
  type LocationCatalog,
  type LocationExtent,
  type LocationRelation,
  type LocationType,
  type ProvenanceEntry,
  type RelationKind,
  type RoadAnchor,
  type ScenePoint,
  type StudioLocation,
} from './types/location.js';

// --- derived topology types -----------------------------------------------
export type {
  ConflictPair,
  ConflictRelation,
  DerivedTopology,
  DerivedTopologyStats,
  FactIndex,
  JunctionApproach,
  JunctionArm,
  JunctionControl,
  JunctionDescriptor,
  LaneChangeInterval,
  Segment,
  SegmentProfileSample,
  TurnOption,
} from './types/topology.js';

// --- source types (foreign data shapes) ------------------------------------
export type {
  GeoFeature,
  GeoFeatureCollection,
  OverlayPayload,
  SearchIndex,
  SearchObject,
  TopologyGate,
  TopologyIndex,
  TopologyJunction,
  TopologyLane,
} from './types/sources.js';

// --- geometry --------------------------------------------------------------
export { LaneGraph, type LaneHit, type LaneNode, type NearestLaneOptions } from './geometry/lane-graph.js';
export { ElevationField } from './geometry/elevation.js';
export {
  angleBetween,
  bearingDegBetween,
  headingToBearingDeg,
  poseAtS,
  projectOnSegment,
  segmentIntersection,
  wrapPi,
  type Point2,
} from './geometry/vec.js';

// --- build -----------------------------------------------------------------
export {
  buildMapIntel,
  buildMapIntelFromDir,
  junctionLocationId,
  CATALOG_VERSION,
  DERIVED_VERSION,
  type MapIntelBuild,
} from './build/build.js';
export { createBuildContext, roadNameFor, type BuildContext } from './build/context.js';
export {
  anchorOnLane,
  liftAnchor,
  qualityForDistance,
  ANCHOR_EXACT_M,
  ANCHOR_INFERRED_M,
  ANCHOR_PROJECTED_M,
} from './build/anchor-lift.js';
export { buildSegments, PROFILE_STRIDE_M } from './build/segments.js';
export {
  buildJunctionDescriptors,
  classifyRelation,
  computeConflictPairs,
  conflictingGates,
  indexDescriptors,
} from './build/junctions.js';
export { buildFactIndex, factKeyOf, MAX_INDEXED_CARDINALITY } from './build/fact-index.js';
export { assignHandles, LADDER_RUNGS, type LadderRung } from './build/handles.js';
export { buildRelations } from './build/relations.js';
export { compass8, compassLong, slugify } from './build/slug.js';
export {
  assertDeclaredFactsProduced,
  summariseFactKeys,
  DECLARED_FACT_KEYS,
  DECLARED_FACT_KEY_MAP,
  type FactKeyAudit,
  type FactKeySpec,
} from './build/facts.js';
export { MIDBLOCK_STRIDE_M } from './build/densify/midblock-segments.js';
export { SCHOOL_ZONE_MUTCD } from './build/densify/school-zones.js';
export {
  WORK_ZONE_JUNCTION_CLEARANCE_M,
  WORK_ZONE_MAX_CURVATURE_DEG_PER_10M,
  WORK_ZONE_MIN_LANES_SAME_DIR,
  WORK_ZONE_STRIDE_M,
} from './build/densify/work-zones.js';

// --- query -----------------------------------------------------------------
export { findLocations, findLocationsLinear, idIndex, knownFactKeys, type FindOptions } from './query/find.js';
export {
  describeLocation,
  getLocation,
  relationsFrom,
  relationsTo,
  requireLocation,
  type DescribeOptions,
} from './query/describe.js';
export { diceCoefficient, resolveReference, type ResolveOptions, type ResolvedReference } from './query/resolve.js';
export {
  FACT_OPS,
  DEFAULT_RESULT_LIMIT,
  MAX_RESULT_LIMIT,
  MapIntelQueryError,
  type FactFilter,
  type FactFilterGroup,
  type FactOp,
  type FindLocationsQuery,
  type LocationMatch,
  type NearFilter,
  type SetFilter,
} from './query/types.js';

// --- cli helpers -----------------------------------------------------------
