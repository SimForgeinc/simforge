/**
 * `LogicalAnchor` — a predicate over road structure, per
 * `docs/research/retargeting.md` §LogicalAnchor.
 *
 * This is the LLM's emission target and the matcher's input. It contains **no
 * coordinates and no road ids**: the entire vocabulary is lane counts, speed
 * limits, junction classes and distances-along-a-corridor, so the failure mode
 * where a model invents `roadId: "17"` is not expressible rather than merely
 * discouraged.
 *
 * Structure:
 *
 * - `corridor` — clauses about the road the scenario runs along, including the
 *   two "enough room" clauses (`runwayUpstreamM` / `runwayDownstreamM`) that
 *   turn out to be the difference between a scenario that transfers and one
 *   whose actors drive off the end of the map.
 * - `features[]` — ordered points of interest along that corridor
 *   (`atM` measured from the frame origin), each with kind-specific predicates.
 *   `conflictingApproach` on a junction feature is the highest-value clause in
 *   the schema: it is what keeps a left-turn-across-path scenario a
 *   left-turn-across-path scenario on a map that has never heard of it.
 * - `policy` — how many sites to return and how similar they may be.
 * - `pin` — the escape hatch. A pinned anchor still carries its clauses (they
 *   become a self-check against the pinned site), which is why pinning is one
 *   flag rather than a second document type.
 *
 * Every clause is `{value, essentiality, weight?}` so the matcher can return a
 * uniform `ClauseResult` for each one and the site picker can explain a score
 * it does not have special-case code for.
 */

import { z } from 'zod';

import { FeatureIdSchema, RangeSchema, clause } from './common.js';

/** Lane kinds that may be required beside, or forbidden beside, the corridor. */
export const ADJACENT_KINDS = [
  'parking',
  'bike',
  'sidewalk',
  'shoulder',
  'median',
  'bus',
  'rail',
  'none',
] as const;
/** Adjacent-lane kind. */
export const AdjacentKindSchema = z.enum(ADJACENT_KINDS);

/** Which side of the corridor something is on. `either` matches both. */
export const SideSchema = z.enum(['left', 'right', 'either', 'both']);

/** Turn directions, ego-relative. */
export const TURN_DIRECTIONS = ['left', 'right', 'straight', 'uturn'] as const;
/** Turn direction. */
export const TurnDirectionSchema = z.enum(TURN_DIRECTIONS);

/** How a conflicting approach reaches the junction, relative to the ego arm. */
export const APPROACH_RELATIONS = ['opposing', 'from_left', 'from_right', 'same', 'merge'] as const;
/** Approach relation. */
export const ApproachRelationSchema = z.enum(APPROACH_RELATIONS);

/** Junction control classes, as `map-intel` derives them from signals/signs. */
export const JUNCTION_CONTROLS = [
  'signalized',
  'all_way_stop',
  'minor_stop',
  'yield',
  'uncontrolled',
  'roundabout',
] as const;
/** Junction control class. */
export const JunctionControlSchema = z.enum(JUNCTION_CONTROLS);

/** The corridor clause block. Every field is optional; absent means unconstrained. */
export const CorridorSchema = z.strictObject({
  /** Through lanes in the ego's direction of travel. */
  throughLanesSameDir: clause(RangeSchema).optional(),
  /** Through lanes in the opposing direction. `[0, 0]` asserts a one-way street. */
  throughLanesOpposing: clause(RangeSchema).optional(),
  laneWidthM: clause(RangeSchema).optional(),
  speedLimitKph: clause(RangeSchema).optional(),
  /**
   * Drivable distance available *behind* the frame origin, for actors that need
   * a run-up to reach speed during the unrecorded warm-up.
   */
  runwayUpstreamM: clause(RangeSchema).optional(),
  /**
   * Drivable distance available *ahead* of the frame origin. Must cover the
   * whole clip at the intended speed, not just the labelled event window —
   * the single most common cause of actors driving off the end of a map.
   */
  runwayDownstreamM: clause(RangeSchema).optional(),
  /** Curvature magnitude, degrees of heading change per 10 m of arc. */
  curvatureDegPer10m: clause(RangeSchema).optional(),
  gradePct: clause(RangeSchema).optional(),
  /** Lane kinds that must exist beside the corridor (e.g. a parking row to hide behind). */
  requiresAdjacent: clause(z.array(AdjacentKindSchema).min(1)).optional(),
  /** Lane kinds that must NOT exist beside the corridor. */
  forbidsAdjacent: clause(z.array(AdjacentKindSchema).min(1)).optional(),
  /** A legal lane change must be available on `side` over `sRange` of the corridor. */
  laneChangeLegal: clause(
    z.strictObject({ side: SideSchema, sRange: RangeSchema.optional() }),
  ).optional(),
});

const featureBase = {
  id: FeatureIdSchema,
  /**
   * Where the feature sits along the corridor, metres from the frame origin.
   * Negative is upstream. Open ends are legal: `[20, null]` means "somewhere
   * at least 20 m ahead".
   */
  atM: clause(RangeSchema).optional(),
  /** Absolute lateral distance from the reference path to a point feature. */
  lateralDistanceM: clause(RangeSchema).optional(),
  /** Require the feature's source lane to share the reference road and section. */
  sameRoad: clause(z.boolean()).optional(),
  /** Which side of the corridor the feature is on, where that is meaningful. */
  side: clause(SideSchema).optional(),
  /** How badly the feature's *presence* is wanted. Its predicates carry their own. */
  essentiality: z.enum(['required', 'preferred', 'cosmetic']).default('required'),
  weight: z.number().min(0).max(100).optional(),
  /** Author-facing label, e.g. "the signalised intersection ego turns at". */
  label: z.string().max(200).optional(),
};

/** A junction on the corridor, with the clauses that make conflicts portable. */
export const JunctionFeatureSchema = z.strictObject({
  ...featureBase,
  kind: z.literal('junction'),
  /** Number of arms. `[4, 4]` is a four-way. */
  arms: clause(RangeSchema).optional(),
  control: clause(z.array(JunctionControlSchema).min(1)).optional(),
  /** Which way the reference path goes through the junction. */
  egoTurn: clause(z.array(TurnDirectionSchema).min(1)).optional(),
  /**
   * A movement that geometrically conflicts with the ego's. Backed by the
   * precomputed `conflictPairs` of the junction descriptor, so "a car coming
   * the other way that turns across me" survives retargeting onto a junction
   * with a different geometry.
   */
  conflictingApproach: clause(
    z.strictObject({
      from: ApproachRelationSchema,
      turn: TurnDirectionSchema,
      /** Acceptable crossing angle in degrees; keeps a T-bone a T-bone. */
      crossingAngleDeg: RangeSchema.optional(),
    }),
  ).optional(),
  /** Inscribed size of the junction, metres. */
  sizeM: clause(RangeSchema).optional(),
  /** Whether at least one leg carries a marked pedestrian crossing. */
  hasCrossingOnLeg: clause(z.boolean()).optional(),
});

/** A pedestrian crossing. */
export const CrossingFeatureSchema = z.strictObject({
  ...featureBase,
  kind: z.literal('crossing'),
  /** Marked/unmarked. */
  marked: clause(z.boolean()).optional(),
  /** Signal-controlled (pelican/puffin) versus uncontrolled zebra. */
  controlled: clause(z.boolean()).optional(),
  /** Crossing length across the carriageway, metres. */
  lengthM: clause(RangeSchema).optional(),
  /** Whether the crossing sits on a junction leg or mid-block. */
  placement: clause(z.enum(['junction_leg', 'midblock', 'either'])).optional(),
});

/** A parking zone beside the corridor — the occluder source and the cut-in source. */
export const ParkingZoneFeatureSchema = z.strictObject({
  ...featureBase,
  kind: z.literal('parking_zone'),
  orientation: clause(z.enum(['parallel', 'angled', 'perpendicular'])).optional(),
  /** Number of spaces in the zone. */
  capacity: clause(RangeSchema).optional(),
  /** Fraction of spaces occupied, 0..1. Density is what makes an occluder wall. */
  occupancy: clause(RangeSchema).optional(),
  /** Contiguous length of the zone, metres. */
  lengthM: clause(RangeSchema).optional(),
});

/** Kinds with no predicates of their own beyond position and side. */
export const SIMPLE_FEATURE_KINDS = [
  'merge',
  'diverge',
  'lane_drop',
  'driveway',
  'bus_stop',
  'school_zone',
  'work_zone_suitable',
  'occlusion_zone',
  'crest',
  'curve',
  'rail_crossing',
] as const;

/** A feature identified by kind and position only. */
export const SimpleFeatureSchema = z.strictObject({
  ...featureBase,
  kind: z.enum(SIMPLE_FEATURE_KINDS),
  /** Length of the feature along the corridor where that is meaningful. */
  lengthM: clause(RangeSchema).optional(),
  /**
   * Require the bound location's own `supported_scenario_templates` whitelist
   * to name one of these templates.
   *
   * `map-intel` records, on every occlusion zone it derives, which scenario
   * templates that occluder was actually built to serve
   * (`child_dartout_from_parked_cars`, `pedestrian_emerging_around_bus`,
   * `double_parked_delivery_truck`, …). It is the strongest statement of author
   * intent in the whole location catalog, and this clause is how an anchor asks
   * for it instead of binding whichever occluder happens to be nearest.
   */
  supportsScenario: clause(z.array(z.string().min(1).max(120)).min(1).max(8)).optional(),
});

/** Any anchor feature. */
export const AnchorFeatureSchema = z.discriminatedUnion('kind', [
  JunctionFeatureSchema,
  CrossingFeatureSchema,
  ParkingZoneFeatureSchema,
  SimpleFeatureSchema,
]);

/** Matcher policy: how many sites, how different, how good. */
export const AnchorPolicySchema = z.strictObject({
  /** Allow a mirrored match (left-hand rendition of a right-hand scenario). */
  allowMirror: z.boolean().default(false),
  maxSitesPerMap: z.number().int().min(1).max(1000).default(10),
  /** Deduplication strength: `strict` = one site per junction/road-direction. */
  diversity: z.enum(['strict', 'moderate', 'off']).default('strict'),
  /** Sites scoring below this are not returned at all. */
  minScore: z.number().min(0).max(1).default(0.5),
});

/**
 * The manual escape hatch: this template, this exact place.
 *
 * `siteId` is optional because a migrated v1 document is pinned to a *map* but
 * to no site — v1 had no site ids to preserve. That state is real, so the schema
 * represents it instead of inviting a fabricated id; the validator reports
 * `pin_site_unresolved` until an author or the matcher fills it in.
 */
export const AnchorPinSchema = z.strictObject({
  mapId: z.string().min(1).max(200),
  siteId: z.string().min(1).max(200).optional(),
  /**
   * Topology digest of the map when the pin was made. A mismatch means the site
   * id may no longer denote the same place — re-match with a visible diff,
   * never silently re-bind.
   */
  topologyDigest: z.string().min(1).max(200).optional(),
});

/** The `anchor` block. */
export const LogicalAnchorSchema = z.strictObject({
  /** Stable id, used in the `siteId` hash so matches survive re-authoring. */
  id: z.string().regex(/^[A-Za-z][A-Za-z0-9_-]{0,63}$/).optional(),
  corridor: CorridorSchema.optional(),
  features: z.array(AnchorFeatureSchema).max(16).default([]),
  policy: AnchorPolicySchema.prefault({}),
  pin: AnchorPinSchema.optional(),
});

/** A logical anchor. */
export type LogicalAnchor = z.infer<typeof LogicalAnchorSchema>;
/** A logical anchor as authored. */
export type LogicalAnchorInput = z.input<typeof LogicalAnchorSchema>;
/** Any anchor feature. */
export type AnchorFeature = z.infer<typeof AnchorFeatureSchema>;
/** A junction feature. */
export type JunctionFeature = z.infer<typeof JunctionFeatureSchema>;
/** A crossing feature. */
export type CrossingFeature = z.infer<typeof CrossingFeatureSchema>;
/** A parking-zone feature. */
export type ParkingZoneFeature = z.infer<typeof ParkingZoneFeatureSchema>;
/** The corridor clause block. */
export type Corridor = z.infer<typeof CorridorSchema>;
/** Matcher policy. */
export type AnchorPolicy = z.infer<typeof AnchorPolicySchema>;
/** A site pin. */
export type AnchorPin = z.infer<typeof AnchorPinSchema>;
/** Turn direction. */
export type TurnDirection = z.infer<typeof TurnDirectionSchema>;
/** Approach relation. */
export type ApproachRelation = z.infer<typeof ApproachRelationSchema>;
/** Junction control class. */
export type JunctionControl = z.infer<typeof JunctionControlSchema>;
/** Side of the corridor. */
export type Side = z.infer<typeof SideSchema>;
