import { z } from "zod";

/**
 * Map topology index (schema v1) — **pure XODR**.
 *
 * CARLA drives the XODR (OpenDRIVE); it never sees the geojson. So the
 * topology the planner reasons over must be the XODR's own authoritative,
 * directed connectivity — not the enriched geojson (that stays for the
 * search feature):
 *
 *  - lane / road `<link>` (predecessor/successor, with contactPoint) and
 *    junction `<connection>` (`incomingRoad`→`connectingRoad`, `<laneLink
 *    from to>`) give the exact directed graph CARLA routes on. Lanes are
 *    keyed by `road:section:lane` ("rsl"), the runtime-bundle/CARLA key —
 *    no GUID bridge needed.
 *  - a "gate" is one junction `<connection>` lane-link: an approach lane →
 *    a connecting (junction-internal) lane. XODR has no turn label, so
 *    `turnRelation` is **derived deterministically** from the connecting
 *    road's `<planView>` net heading change — a classification of the
 *    exact arc CARLA will drive, not a connectivity heuristic.
 *
 * Because XODR connectivity is unambiguously directed (unlike the geojson
 * `Dir` flag), the predecessor index round-trips by construction — this
 * is what dissolves plan risk R3.
 *
 * Built once at map metadata population, cached as a `topology_index.json`
 * sidecar (mirrors `search_index.json`). Pure builder lives in
 * `build-topology-index.ts` and is unit-tested against the source XODR.
 */

/**
 * v2 (2026-05): adds `polyline` to every `TopologyLane` — sampled lane
 * centerline in runtime-world meters (CARLA-basis y is the world basis;
 * CARLA's pose flip happens at spawn time downstream). This decouples
 * the gate-driven planner from the geojson-derived runtime lane-graph
 * (which doesn't cover every XODR lane the topology references); given
 * `topology.lanes[rsl].polyline` + `predecessors`, the planner can
 * resolve gate geometry and backward-walk for spawn placement purely
 * from XODR data. Old schema-v1 cached artifacts naturally upgrade on
 * next rebuild — the topology service builds on demand.
 *
 * v3 (2026-06): adds lane-change authority for Timed instructions:
 * representative lane widths, sampled widths, same-direction adjacency,
 * lane-change permission intervals, and lane-marking provenance.
 */
export const MAP_TOPOLOGY_SCHEMA_VERSION = 3 as const;
export const MAP_TOPOLOGY_SCHEMA_VERSION_LABEL = "simforge.map-topology.v3" as const;

/**
 * CARLA runtime lane-type allow-list, lowercased.
 *
 * Mirror of the worker's runtime-map crawl filter — `allowed_lane_types`
 * in `services/carla-worker/carla_worker/metadata.py::_runtime_map`. The
 * runtime bundle only surfaces lanes of these types, so the topology index
 * is constrained to the same set: the gate-driven planner then anchors
 * only to lanes CARLA actually loads, instead of planning on XODR-only
 * lanes and relying on a downstream snap to rescue it.
 *
 * Drivable ramp types (on/off-ramp, entry/exit, connecting-ramp) are
 * intentionally ABSENT, so ramp/highway-merge scenarios stay out of scope.
 * Since the runtime-map slimming rewrite, the worker crawl emits EVERY lane
 * type with a per-segment `lane_type` field and this set is the client-side
 * filter for topology anchoring (`map-topology-build.test.ts` pins both
 * sides of that contract).
 */
export const CARLA_RUNTIME_ALLOWED_LANE_TYPES: ReadonlySet<string> = new Set([
  "driving",
  "bidirectional",
  "parking",
  "shoulder",
  "sidewalk",
  "biking",
]);

export const TurnRelationSchema = z.enum([
  "Left",
  "Right",
  "Straight",
  "UTurnLeft",
  "UTurnRight",
]);
export type TurnRelation = z.infer<typeof TurnRelationSchema>;

/** 2D point in runtime-world meters (CARLA basis). */
export const Vec2Schema = z.object({
  x: z.number(),
  y: z.number(),
});
export type Vec2 = z.infer<typeof Vec2Schema>;

export const LaneChangeSideSchema = z.enum(["left", "right"]);
export type LaneChangeSide = z.infer<typeof LaneChangeSideSchema>;

export const TopologyLaneChangePermissionSchema = z.object({
  id: z.string(),
  side: LaneChangeSideSchema,
  startS: z.number().min(0),
  endS: z.number().min(0),
  allowed: z.boolean(),
  marking: z.string().nullable().default(null),
  source: z.enum(["xodr_lane_link", "derived_same_section", "unknown"]).default("unknown"),
});
export type TopologyLaneChangePermission = z.infer<
  typeof TopologyLaneChangePermissionSchema
>;

export const TopologyAdjacentLaneSchema = z.object({
  side: LaneChangeSideSchema,
  laneRsl: z.string().nullable(),
  sameDirection: z.boolean().default(false),
  permissionIds: z.array(z.string()).default([]),
});
export type TopologyAdjacentLane = z.infer<typeof TopologyAdjacentLaneSchema>;

/** A lane node, keyed by `rsl` = `"<road>:<section>:<lane>"`. */
export const TopologyLaneSchema = z.object({
  rsl: z.string(),
  roadId: z.number().int(),
  /** 0-based `<laneSection>` ordinal within the road (s-ordered). */
  section: z.number().int(),
  /** Signed OpenDRIVE lane id (sign = side of road reference line). */
  laneId: z.number().int(),
  /** Lowercased XODR lane `type` (driving | biking | sidewalk | none …). */
  laneType: z.string(),
  /** True when the lane belongs to a connecting road (road junction!=-1). */
  isJunction: z.boolean(),
  /** XODR `<junction id>` (string) the lane is internal to, else null. */
  junctionId: z.string().nullable().default(null),
  /** Upstream lanes (rsl). The precomputed backward index. */
  predecessors: z.array(z.string()).default([]),
  /** Downstream lanes (rsl). */
  successors: z.array(z.string()).default([]),
  speedLimitKph: z.number().nullable().default(null),
  representativeWidthM: z.number().positive().nullable().optional(),
  widthSamples: z
    .array(
      z.object({
        s: z.number().min(0),
        widthM: z.number().positive(),
      }),
    )
    .optional(),
  adjacentLanes: z.object({
    left: TopologyAdjacentLaneSchema.optional(),
    right: TopologyAdjacentLaneSchema.optional(),
  }).optional(),
  laneChangePermissions: z.array(TopologyLaneChangePermissionSchema).optional(),
  /**
   * Sampled lane centerline in runtime-world meters, ordered in the
   * lane's direction of travel (left-side lanes follow the road's `s`
   * axis; right-side lanes are reversed). Two or more points; empty
   * only when the lane has zero length or the builder couldn't sample
   * it (rare, e.g. unsupported geometry kind). Sampling step is
   * adaptive (~1m on long lanes, ~0.5m on junction-internal lanes).
   */
  polyline: z.array(Vec2Schema).default([]),
});
export type TopologyLane = z.infer<typeof TopologyLaneSchema>;

/** One turn affordance — one junction `<connection>` lane-link. */
export const TopologyGateSchema = z.object({
  /** Stable id: `"<junction>:<connection>:<from>-<to>"`. */
  id: z.string(),
  junctionId: z.string(),
  /** {@link headingChangeRad}, classified by `classifyTurn`. */
  turnRelation: TurnRelationSchema,
  /**
   * Net heading change of the connecting LANE in its travel direction, radians
   * (signed; +CCW).
   *
   * The connector's own curvature, not the change relative to the approach — the
   * two differ by how the connector leaves the stop line, which is under half a
   * degree on measured maps. `junction-direction.ts::junctionBranchHeadingChangeDeg`
   * is the approach-relative reading; see `laneTravelHeadingChange` for why they
   * are not reconciled.
   */
  headingChangeRad: z.number(),
  /** The junction-internal connecting lane (rsl). */
  connectingLaneRsl: z.string(),
  /** The approach (incoming) lane feeding this gate (rsl). */
  approachLaneRsl: z.string(),
  /** Post-turn exit lane(s) the connecting lane leads to (rsl). */
  exitLaneRsls: z.array(z.string()).default([]),
});
export type TopologyGate = z.infer<typeof TopologyGateSchema>;

export const TopologyJunctionSchema = z.object({
  /** XODR `<junction id>` as a string. */
  junctionId: z.string(),
  gateIds: z.array(z.string()).default([]),
  /** Connecting-road lanes internal to this junction (rsl). */
  internalLaneRsls: z.array(z.string()).default([]),
  /** Distinct approach lanes feeding this junction (rsl). */
  approachLaneRsls: z.array(z.string()).default([]),
});
export type TopologyJunction = z.infer<typeof TopologyJunctionSchema>;

/** Backfill QA + runtime-parity read these. */
export const TopologyStatsSchema = z.object({
  roads: z.number().int(),
  lanes: z.number().int(),
  drivingLanes: z.number().int(),
  junctions: z.number().int(),
  gates: z.number().int(),
  connectionsParsed: z.number().int(),
  gatesDropped: z.number().int(),
  turnHistogram: z.record(z.string(), z.number().int()),
  /** Optional cross-check vs geojson Gate.TurnRelation (ingestion QA only;
   *  null when geojson was not supplied). */
  geojsonTurnAgreementPct: z.number().nullable().default(null),
});
export type TopologyStats = z.infer<typeof TopologyStatsSchema>;

export const MapTopologyIndexSchema = z.object({
  schemaVersion: z.literal(MAP_TOPOLOGY_SCHEMA_VERSION),
  mapName: z.string(),
  generatedAt: z.string(),
  source: z.object({
    xodrSha256: z.string().nullable().default(null),
    generationTool: z.string().optional(),
    generationToolVersion: z.string().optional(),
    runtimeCatalogVersion: z.string().nullable().optional(),
  }),
  /** Lane nodes keyed by rsl. */
  lanes: z.record(z.string(), TopologyLaneSchema),
  gates: z.array(TopologyGateSchema),
  junctions: z.record(z.string(), TopologyJunctionSchema),
  stats: TopologyStatsSchema,
});
export type MapTopologyIndex = z.infer<typeof MapTopologyIndexSchema>;

export const RuntimeTopologyFamilySchema = z.enum(["carla_ue4", "carla_ue5"]);
export type RuntimeTopologyFamily = z.infer<typeof RuntimeTopologyFamilySchema>;

export const RuntimeTopologyParityDiagnosticSchema = z.object({
  code: z.enum([
    "DUPLICATE_RUNTIME_RSL",
    "TOPOLOGY_LANE_MISSING_AT_RUNTIME",
    "TOPOLOGY_LANE_LINK_ATTESTED",
    "RUNTIME_LANE_MISSING_IN_TOPOLOGY",
    "LANE_TYPE_MISMATCH",
    "JUNCTION_FLAG_MISMATCH",
    "GATE_RUNTIME_UNBOUND",
  ]),
  rsl: z.string().nullable().default(null),
  gateId: z.string().nullable().default(null),
  message: z.string(),
});
export type RuntimeTopologyParityDiagnostic = z.infer<
  typeof RuntimeTopologyParityDiagnosticSchema
>;

export const RuntimeTopologyParitySchema = z.object({
  status: z.enum(["exact", "partial", "incompatible"]),
  topologyAuthorableLaneCount: z.number().int().nonnegative(),
  runtimeAuthorableLaneCount: z.number().int().nonnegative(),
  boundLaneRsls: z.array(z.string()),
  /**
   * Bound lanes the crawl never sampled, vouched for by its own links.
   *
   * A subset of `boundLaneRsls`, listed separately because their geometry comes
   * from the OpenDRIVE rather than from CARLA, and a consumer that needs
   * crawl-exact geometry has to be able to tell. Defaulted so a parity record
   * written before this existed still parses as "none".
   */
  linkAttestedLaneRsls: z.array(z.string()).default([]),
  topologyOnlyLaneRsls: z.array(z.string()),
  runtimeOnlyLaneRsls: z.array(z.string()),
  laneTypeMismatchRsls: z.array(z.string()),
  junctionFlagMismatchRsls: z.array(z.string()),
  duplicateRuntimeRsls: z.array(z.string()),
  boundGateIds: z.array(z.string()),
  unboundGateIds: z.array(z.string()),
  diagnostics: z.array(RuntimeTopologyParityDiagnosticSchema),
});
export type RuntimeTopologyParity = z.infer<typeof RuntimeTopologyParitySchema>;

export const RuntimeTopologyProvenanceSchema = z.object({
  mapAssetId: z.string().min(1),
  runtimeFamily: RuntimeTopologyFamilySchema,
  runtimeMapName: z.string().min(1),
  runtimeCatalogVersion: z.string().min(1),
  bundleVersion: z.string().min(1),
  imageDigest: z.string().min(1),
  xodrSha256: z.string().regex(/^[a-f0-9]{64}$/),
  runtimeRoadGraphSha256: z.string().regex(/^[a-f0-9]{64}$/),
  projectionIdentitySha256: z.string().regex(/^[a-f0-9]{64}$/),
  compilerVersion: z.string().min(1),
});
export type RuntimeTopologyProvenance = z.infer<
  typeof RuntimeTopologyProvenanceSchema
>;

export const RuntimeBoundMapTopologyIndexSchema = MapTopologyIndexSchema.extend({
  runtimeProvenance: RuntimeTopologyProvenanceSchema,
  runtimeParity: RuntimeTopologyParitySchema,
  /**
   * Whether each lane is DRIVEN along increasing `s`, keyed by RSL.
   *
   * The OpenDRIVE alone cannot say. `parseXodr` does not read the road's
   * `rule` (RHT/LHT) attribute, so every consumer that needed this used to
   * infer it from the lane-id sign — negative runs with `+s`, positive against
   * it. That is a convention the standard does not guarantee, and it decides
   * which way vehicles face; guessing it puts cars head-on into traffic.
   *
   * Resolved instead from CARLA's waypoint crawl at bind time, where the
   * per-waypoint yaw IS the direction of travel. Read it through
   * `laneTravelIncreasesS()` rather than directly, so the one remaining
   * fallback stays in one place.
   *
   * Absent on indexes compiled before this existed (published artifacts are
   * immutable), hence optional.
   */
  laneTravelIncreasesS: z.record(z.string(), z.boolean()).optional(),
});
export type RuntimeBoundMapTopologyIndex = z.infer<
  typeof RuntimeBoundMapTopologyIndexSchema
>;

/** Minimal live-runtime binding surface needed for exact RSL parity. */
export type RuntimeTopologySegment = {
  road_id: string | number;
  section_id: number;
  lane_id: number;
  lane_type?: string | null;
  is_junction: boolean;
  /**
   * The lanes CARLA itself resolves as reachable from this one.
   *
   * Carried because the crawl's lane LIST and the crawl's lane LINKS disagree
   * about what exists, and the links are the more complete of the two: CARLA
   * names successors it never sampled a waypoint on. Binding against the list
   * alone therefore severs connections the runtime considers real — measured on
   * the nine dev maps, 89 corridors stranded that way and 47 junction gates
   * dropped, all on lane-sections shorter than the crawl's own sampling step.
   *
   * Optional so a caller with only the parity surface still compiles; a bundle
   * that omits them simply gets the old list-only binding.
   */
  successors?: readonly { rsl?: string | null }[] | null;
  predecessors?: readonly { rsl?: string | null }[] | null;
};
