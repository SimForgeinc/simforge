import { z } from "zod";
import { SIMULATION_DEFAULTS } from "./defaults";
import { SensorSchema } from "./simulation-run";
import {
  TrafficAggressiveness,
  TrafficCardSchema,
  TrafficDensity,
  TrafficManagerSchema,
  VehicleMixPreset,
} from "./traffic-manager";
import { SemanticActorAuthoringSchema } from "./semantic-actor-authoring";
import { SceneFormationSchema, SceneFormationSolutionSchema } from "./scene-formation";
import {
  ActorBehaviorMetadataSchema,
  ScenarioIntentionSchema,
} from "./scenario-intention";
import { ScenarioMetadataSchema } from "./scenario-metadata";

import { ActorBehaviorProgramSchema, ReactionProfileSchema } from "./scenario-behavior";
import { JunctionSignalPlanSchema } from "./scenario-signals";

/** Re-exported for consumers that import the actor draft's control model from here. */
export {
  ActorBehaviorProgramSchema,
  BehaviorActionSchema,
  BehaviorClipSchema,
  BehaviorTriggerSchema,
  ReactionProfileSchema,
} from "./scenario-behavior";
export type {
  ActorBehaviorProgram,
  BehaviorAction,
  BehaviorClip,
  BehaviorTrigger,
  ReactionProfile,
} from "./scenario-behavior";

export const ScenarioEditorRoadAnchorSchema = z.object({
  road_id: z.string(),
  s_fraction: z.number().min(0).max(1).default(0.5),
  lane_id: z.number().int().nullable().optional(),
  section_id: z.number().int().nullable().optional(),
  /** Controls the road segment from the previous road anchor to this anchor. */
  speed_kph: z.number().min(0).nullable().optional(),
  /** Semantic compiler output must resolve this exact OpenDRIVE anchor. */
  resolution_mode: z.literal("runtime_exact").optional(),
  /** Authoritative WORLD position (runtime/frontend frame: x, y, z meters + yaw
   * degrees), sampled from the accepted runtime-map lane centerline at
   * `s_fraction`. Persisted editor drafts may omit it, but CARLA UE5 execution
   * must not infer placement from a legacy road id after runtime-exact semantic
   * compilation because UE5 can renumber or reuse the UE4 OpenDRIVE id. */
  world_anchor: z
    .object({
      x: z.number(),
      y: z.number(),
      z: z.number(),
      yaw: z.number(),
    })
    .optional(),
});
export type ScenarioEditorRoadAnchor = z.infer<typeof ScenarioEditorRoadAnchorSchema>;

export const ScenarioEditorMapPointSchema = z.object({
  x: z.number(),
  y: z.number(),
  /** Optional intended elevation (world meters). When set, the worker resolves a
   * POINT/timed_path spawn to the ground surface NEAREST this z — disambiguating
   * maps with stacked/overlapping geometry (otherwise a point actor snaps to the
   * topmost surface and floats; the "pedestrian dropped from the sky"). Omit on
   * flat maps to keep the topmost-surface behavior. */
  z: z.number().optional(),
});
export type ScenarioEditorMapPoint = z.infer<typeof ScenarioEditorMapPointSchema>;

export const ScenarioEditorPathSegmentDirectionSchema = z.enum(["forward", "reverse"]);
export type ScenarioEditorPathSegmentDirection = z.infer<
  typeof ScenarioEditorPathSegmentDirectionSchema
>;

export const ScenarioEditorTimedWaypointSchema = ScenarioEditorMapPointSchema.extend({
  /**
   * How this is read depends on the actor's `path_timing`.
   *
   * Under `"ordering"` (the default, and every draft written before 2026-07-25)
   * it orders the polyline and nothing more — vehicles follow it with
   * arc-length pure pursuit at `speed_kph`, and movement is not
   * time-interpolated. Under `"schedule"` it is an arrival time the runtime
   * drives the vehicle to hit. Walkers have always read it as a schedule.
   */
  time: z.number().min(0),
  /** Controls the segment from the previous path point to this waypoint. Ignored under `path_timing: "schedule"`, where spacing is the speed. */
  speed_kph: z.number().min(0).nullable().optional(),
  /** Controls the segment from the previous path point to this waypoint. */
  direction: ScenarioEditorPathSegmentDirectionSchema.optional(),
  /** Placement provenance, for re-snapping on drag and for the marker style.
   *  Absent = "free". Storage stays a WORLD point either way — the world_anchor
   *  doctrine (xosc-writer/geometry.ts:1-17) forbids persisting road ids, which
   *  UE5 renumbers across map rebuilds. */
  snap: z.enum(["lane", "free"]).optional(),
});
export type ScenarioEditorTimedWaypoint = z.infer<typeof ScenarioEditorTimedWaypointSchema>;

/**
 * PARKING MANEUVER contract (emit ⇄ worker). A precise, cusped, gear-aware
 * REAR-AXLE trajectory into a mapped parking bay, planned at emit time by the
 * parking-maneuver core (`planner/parking`). Waypoints are rear-axle poses in
 * the runtime frontend frame (x, y = CARLA x, −y; yaw_deg = frontend yaw); the
 * worker converts rear-axle→actor as needed. Segments run IN ORDER, each a
 * CONSTANT gear; a cusp is the boundary between two segments (ego stops, holds,
 * flips gear). Speeds: ≤1.5 fwd / ≤0.8 rev, ≤0.35 within ~2 m of the goal.
 */
export const ParkingManeuverWaypointSchema = z.object({
  x: z.number(),
  y: z.number(),
  yaw_deg: z.number(),
  speed_mps: z.number().min(0),
});
export type ParkingManeuverWaypoint = z.infer<typeof ParkingManeuverWaypointSchema>;

export const ParkingManeuverSegmentSchema = z.object({
  gear: z.enum(["forward", "reverse"]),
  /** ≥2: a segment is a constant-gear TRAJECTORY, and the worker's
   * `parse_parking_maneuver` rejects a single-waypoint segment as
   * `degenerate_segment` (→ `parking.parse_failed`, ego held in place). The
   * schema minimum matches the executor contract so a scenario that validates
   * here cannot be a guaranteed runtime failure. */
  waypoints: z.array(ParkingManeuverWaypointSchema).min(2),
});
export type ParkingManeuverSegment = z.infer<typeof ParkingManeuverSegmentSchema>;

export const ParkingManeuverSchema = z.object({
  frame: z.literal("rear_axle"),
  vehicle: z.object({
    wheelbase_m: z.number().positive(),
    front_overhang_m: z.number().min(0),
    rear_overhang_m: z.number().min(0),
    half_width_m: z.number().positive(),
  }),
  segments: z.array(ParkingManeuverSegmentSchema).min(1),
  terminal: z.object({
    x: z.number(),
    y: z.number(),
    yaw_deg: z.number(),
    hold_s: z.number().min(0),
    clearance_m: z.number(),
    bay_id: z.union([z.string(), z.number()]),
  }),
});
export type ParkingManeuver = z.infer<typeof ParkingManeuverSchema>;

export const ScenarioEditorActorPlacementModeSchema = z.enum([
  "road",
  "path",
  "point",
  "timed_path",
]);
export type ScenarioEditorActorPlacementMode = z.infer<typeof ScenarioEditorActorPlacementModeSchema>;

/**
 * Provenance and runtime guard for a vehicle interaction that was rebound to a
 * different junction on the same map. The ids are deliberately topology ids,
 * not CARLA actor ids: the concrete road anchors and dense path remain the
 * worker input, while this block makes stale/partial relocation output
 * distinguishable from an ordinary authored timed path.
 */
export const InteractionRelocationActorProvenanceSchema = z
  .object({
    schemaVersion: z.literal("simforge.interaction-relocation.v1"),
    sourceJunctionId: z.string().trim().min(1),
    targetJunctionId: z.string().trim().min(1),
    sourceGateId: z.string().trim().min(1),
    targetGateId: z.string().trim().min(1),
    turnRelation: z.enum(["Left", "Right", "Straight"]),
    topologyXodrSha256: z.string().trim().min(1),
  })
  .strict();
export type InteractionRelocationActorProvenance = z.infer<
  typeof InteractionRelocationActorProvenanceSchema
>;

export const CrossMapActorTransferProvenanceSchema = z
  .object({
    schemaVersion: z.literal("simforge.cross-map-actor-transfer.v2"),
    motifHash: z.string().regex(/^sha256:[a-f0-9]{64}$/),
    formationId: z.string().trim().min(1),
    formationHash: z.string().regex(/^sha256:[a-f0-9]{64}$/),
    formationContractHash: z.string().regex(/^sha256:[a-f0-9]{64}$/),
    matchId: z.string().trim().min(1),
    sourceScenarioId: z.string().trim().min(1),
    sourceMapAssetId: z.string().trim().min(1),
    targetMapAssetId: z.string().trim().min(1),
    targetFeatureGraphRevision: z.string().regex(/^sha256:[a-f0-9]{64}$/),
    sourceActorId: z.string().trim().min(1),
  })
  .strict();
export type CrossMapActorTransferProvenance = z.infer<
  typeof CrossMapActorTransferProvenanceSchema
>;

export const ScenarioEditorTimelineActionSchema = z.enum([
  "follow_route",
  "set_speed",
  "stop",
  "hold_position",
  "enable_autopilot",
  "disable_autopilot",
  "lane_change_left",
  "lane_change_right",
  "turn_left_at_next_intersection",
  "turn_right_at_next_intersection",
  "chase_actor",
  "ram_actor",
  "drive_reverse",
  "creep_forward",
  "yield_to_actor",
  "swerve",
]);
export type ScenarioEditorTimelineAction = z.infer<typeof ScenarioEditorTimelineActionSchema>;

/**
 * MIGRATION INPUT ONLY. The legacy pre-behavior timeline clip.
 *
 * The persisted actor no longer declares a `timeline` field (schema-prune,
 * wave 2b): stored clips parse through `ScenarioEditorActorLegacyMotionSchema`
 * at load, migrate into the behavior program, and the field is stripped from
 * the normalized draft. This schema survives because the migration still has
 * to READ the old shape, and because the CARLA wire still carries a `timeline`
 * array (see `ScenarioEditorActorLegacyWireSchema`).
 */
export const ScenarioEditorTimelineClipSchema = z.object({
  id: z.string(),
  start_time: z.number().min(0).default(0),
  end_time: z.number().min(0).nullable().optional(),
  action: ScenarioEditorTimelineActionSchema,
  target_speed_kph: z.number().min(0).nullable().optional(),
  target_actor_id: z.string().nullable().optional(),
  following_distance_m: z.number().min(0).nullable().optional(),
  enabled: z.boolean().default(true),
}).passthrough();
export type ScenarioEditorTimelineClip = z.infer<typeof ScenarioEditorTimelineClipSchema>;

export const TimedInstructionPrimitiveIdSchema = z.enum([
  "lane_follow",
  "turn_left_at_next_intersection",
  "turn_right_at_next_intersection",
  "go_straight_at_next_intersection",
  "lane_change_left",
  "lane_change_right",
  "set_speed",
  "stop",
  "hold_position",
]);
export type TimedInstructionPrimitiveId = z.infer<typeof TimedInstructionPrimitiveIdSchema>;

export const TimedInstructionArgsSchema = z
  .object({
    speedKph: z.number().min(0).max(130).optional(),
    distanceMeters: z.number().positive().optional(),
    durationSeconds: z.number().positive().optional(),
    transitionMeters: z.number().positive().optional(),
    maxWaitSeconds: z.number().positive().optional(),
    brakingWindowSeconds: z.number().positive().optional(),
    until: z.enum(["next_instruction", "scenario_end"]).optional(),
  })
  .default({});
export type TimedInstructionArgs = z.infer<typeof TimedInstructionArgsSchema>;

export const TimedInstructionIntentSchema = z.object({
  id: z.string().regex(/^tii_/),
  timestampSeconds: z.number().min(0),
  rowOrder: z.number().int().min(0),
  enabled: z.boolean().default(true),
  primitiveId: TimedInstructionPrimitiveIdSchema,
  args: TimedInstructionArgsSchema,
  source: z.enum(["manual", "generator", "migration"]).default("manual"),
  generator: z
    .object({
      seed: z.string(),
      strategyId: z.string(),
      candidateRank: z.number().int().min(0),
      tags: z.array(z.string()).default([]),
    })
    .optional(),
  repair: z
    .object({
      accepted: z.boolean().default(false),
      originalTimestampSeconds: z.number().min(0).optional(),
      originalArgs: z.record(z.unknown()).optional(),
      reason: z.string().optional(),
    })
    .optional(),
  validationErrors: z.array(z.string()).default([]),
});
export type TimedInstructionIntent = z.infer<typeof TimedInstructionIntentSchema>;

export const TimedInstructionHashesSchema = z.object({
  runtimeMapHash: z.string().optional(),
  runtimeMapSchemaVersion: z.string().optional(),
  runtimeCatalogVersion: z.string(),
  compilerVersion: z.string(),
  actorSpawnHash: z.string(),
  instructionHash: z.string(),
  resolvedPlanHash: z.string().nullable().default(null),
});
export type TimedInstructionHashes = z.infer<typeof TimedInstructionHashesSchema>;

export const TimedInstructionManifestRowSchema = z
  .object({
    instructionId: z.string(),
    primitiveId: TimedInstructionPrimitiveIdSchema,
    expectedStartS: z.number().min(0),
    expectedCompleteS: z.number().min(0).optional(),
    routeAnchorStart: z.number().int().min(0).optional(),
    routeAnchorEnd: z.number().int().min(0).optional(),
    sampleStart: z.number().int().min(0).optional(),
    sampleEnd: z.number().int().min(0).optional(),
    laneIds: z.array(z.string()).optional(),
    gateId: z.string().optional(),
    status: z.enum(["planned", "rejected"]).default("planned"),
    notes: z.string().optional(),
  })
  .passthrough();
export type TimedInstructionManifestRow = z.infer<typeof TimedInstructionManifestRowSchema>;

export const TimedInstructionPrimitiveResultSchema = z.object({
  instructionId: z.string(),
  primitiveId: TimedInstructionPrimitiveIdSchema,
  pass: z.boolean(),
  actualStartS: z.number().min(0).nullable().optional(),
  actualCompleteS: z.number().min(0).nullable().optional(),
  maxDeviationM: z.number().min(0).nullable().optional(),
  notes: z.string().nullable().optional(),
});

export const TimedInstructionValidationSchema = z.object({
  status: z.enum(["not_run", "passed", "failed", "stale"]).default("not_run"),
  simulate2dJobId: z.string().nullable().optional(),
  completedAt: z.string().nullable().optional(),
  hashes: TimedInstructionHashesSchema.optional(),
  evidence: z
    .object({
      runtimeEventIds: z.array(z.string()).default([]),
      timelineArtifactId: z.string().nullable().optional(),
      traceArtifactId: z.string().nullable().optional(),
      playbackFrameRange: z.tuple([z.number().int().min(0), z.number().int().min(0)]).nullable().optional(),
      artifactIds: z.array(z.string()).default([]),
    })
    .default({ runtimeEventIds: [], artifactIds: [] }),
  primitiveResults: z.array(TimedInstructionPrimitiveResultSchema).default([]),
  divergenceSummary: z.string().nullable().optional(),
});
export type TimedInstructionValidation = z.infer<typeof TimedInstructionValidationSchema>;

export const TimedInstructionWorkerValidationSchema =
  TimedInstructionValidationSchema.extend({
    carlaJobId: z.string().nullable().optional(),
    requestJsonArtifactId: z.string().nullable().optional(),
    renderOrRuntimeArtifactIds: z.array(z.string()).default([]),
    projectionChecks: z
      .object({
        movementVariant: z.enum(["follow_route", "runtime_native", "semantic_execution"]).optional(),
        routeAnchorCount: z.number().int().min(0).optional(),
        pathPointCount: z.number().int().min(0).optional(),
        hashRejectedCasePassed: z.boolean().optional(),
      })
      .default({}),
  });
export type TimedInstructionWorkerValidation = z.infer<
  typeof TimedInstructionWorkerValidationSchema
>;

export const TimedInstructionPlanTraceSampleSchema = ScenarioEditorMapPointSchema.extend({
  t: z.number().min(0),
  laneRsl: z.string().optional(),
  speedKph: z.number().min(0).nullable().optional(),
});

export const TimedInstructionFollowRoutePlanSchema = z.object({
  kind: z.literal("follow_route"),
  schemaVersion: z.literal("simforge.timed-instruction-plan.v1"),
  route: z.array(ScenarioEditorRoadAnchorSchema),
  traceSamples: z.array(TimedInstructionPlanTraceSampleSchema).default([]),
  manifest: z.array(TimedInstructionManifestRowSchema).default([]),
});

export const TimedInstructionRuntimeNativePlanSchema = z.object({
  kind: z.literal("runtime_native"),
  schemaVersion: z.literal("simforge.timed-instruction-plan.v1"),
  source: z.literal("carla_runtime_waypoints"),
  actorSpawnRsl: z.string(),
  runtimeMapSchemaVersion: z.number().int().min(1).nullable().optional(),
  manifest: z.array(TimedInstructionManifestRowSchema).default([]),
});

export const TimedInstructionSemanticExecutionPlanSchema = z.object({
  kind: z.literal("semantic_execution"),
  schemaVersion: z.literal("simforge.timed-instruction-plan.v1"),
  source: z.literal("semantic_execution_index"),
  actorStart: z.object({
    corridorId: z.string().trim().min(1),
    stationM: z.number().nonnegative(),
  }),
  semanticMapGraphRevision: z.string().trim().min(1),
  semanticExecutionIndexRevision: z.string().trim().min(1),
  manifest: z.array(TimedInstructionManifestRowSchema).default([]),
});

export const TimedInstructionRejectedPlanSchema = z.object({
  kind: z.literal("rejected"),
  schemaVersion: z.literal("simforge.timed-instruction-plan.v1"),
  blockingInstructionIds: z.array(z.string()).default([]),
  categories: z.array(z.string()).default([]),
  candidateCounts: z.record(z.number().int().min(0)).default({}),
  repairSuggestions: z.array(z.string()).default([]),
});

export const TimedInstructionResolvedPlanSchema = z.discriminatedUnion("kind", [
  TimedInstructionFollowRoutePlanSchema,
  TimedInstructionRuntimeNativePlanSchema,
  TimedInstructionSemanticExecutionPlanSchema,
  TimedInstructionRejectedPlanSchema,
]);
export type TimedInstructionResolvedPlan = z.infer<typeof TimedInstructionResolvedPlanSchema>;

export const TimedInstructionsSchema = z.object({
  schemaVersion: z.literal("simforge.timed-instructions.v1"),
  intent: z.array(TimedInstructionIntentSchema).default([]),
  resolvedPlan: TimedInstructionResolvedPlanSchema.nullable().default(null),
  status: z
    .enum([
      "draft",
      "resolving",
      "resolved",
      "stale",
      "rejected",
      "disabled_topology_v3_required",
    ])
    .default("draft"),
  hashes: TimedInstructionHashesSchema.optional(),
  timedInstructionValidation: TimedInstructionValidationSchema.optional(),
  workerValidation: TimedInstructionWorkerValidationSchema.optional(),
  manifest: z.array(TimedInstructionManifestRowSchema).default([]),
  rejection: TimedInstructionRejectedPlanSchema.nullable().optional(),
});
export type TimedInstructions = z.infer<typeof TimedInstructionsSchema>;

/**
 * Structured origin for an EPHEMERAL actor expanded out of the scene's ambient
 * traffic region. Part of the ambient-traffic contract with
 * `ScenarioEditorAmbientTrafficSchema` below.
 *
 * `expandRandomTrafficActors` stamps it on every generated member and nothing
 * else does. It is the machine-readable form of the id convention
 * (`<regionId>:vehicle:<memberIndex>`): `regionId` is the region's
 * `legacyActorId` and `memberIndex` is the 1-based ordinal in the member id.
 *
 * An actor carrying this origin must NEVER be persisted — the region spec is
 * what saves, and members are recomputed at every payload build
 * (`draft-normalization.ts` refuses to serialize one). It is likewise stripped
 * from the CARLA wire (`projectRuntimeActorWirePayload`): the worker has no
 * reader for it, and provenance the runtime cannot act on does not ship.
 */
export const AmbientRegionOriginSchema = z
  .object({
    kind: z.literal("ambient_region"),
    regionId: z.string().min(1),
    memberIndex: z.number().int().min(1),
  })
  .strict();
export type AmbientRegionOrigin = z.infer<typeof AmbientRegionOriginSchema>;

/**
 * The versioned LEGACY schema the load-time migration parses stored drafts
 * through (schema-prune, wave 2b). These are the authored keys the persisted
 * actor no longer declares; `draft-normalization.ts` reads them off the raw
 * record via this schema, converts them into `behavior` / `reaction_profile`
 * (`migrateLegacyScenarioEditorActor`), and STRIPS them from the normalized
 * draft — saving writes only the pruned shape.
 *
 * Defaults here are the ones the pruned fields used to carry on the actor
 * schema itself (`autopilot` defaulted TRUE, `timeline` to `[]`), so a stored
 * row parses to exactly what it parsed to before the prune.
 */
export const ACTOR_LEGACY_MOTION_SCHEMA_VERSION = "simforge.actor-legacy-motion.v1";

export const ScenarioEditorActorLegacyMotionSchema = z.object({
  /** Legacy TM baseline flag. True (the historical schema default) when absent. */
  autopilot: z.boolean().default(true),
  timeline: z.array(ScenarioEditorTimelineClipSchema).default([]),
  timedInstructions: TimedInstructionsSchema.optional(),
  /** Fix 7 legacy flag: opt a scripted ego back into the obstacle scan. */
  reactive_braking: z.boolean().optional(),
  /** Worker-only narrow scan (stopped vehicles only). Never a declared field —
   * it always rode through `.passthrough()` — but the migration owns it now. */
  anti_plow: z.boolean().optional(),
  /** The one actor this actor was MEANT to hit; everyone else gets braked for. */
  collision_target_id: z.string().optional(),
  /** DEAD (report-schema-liveness): no production reader ever existed. Parsed
   * only so the migration can strip it deliberately rather than leak it. */
  notes: z.string().nullable().optional(),
  /** DEAD (report-schema-liveness): the route-compiler cache stamp whose
   * machinery never shipped. Parsed only to be stripped. */
  compiled_route_stamp: z
    .object({
      graphRevision: z.string(),
      seed: z.string(),
      start: z.object({ x: z.number(), y: z.number() }),
    })
    .optional(),
});
export type ScenarioEditorActorLegacyMotion = z.infer<
  typeof ScenarioEditorActorLegacyMotionSchema
>;

/** The legacy top-level keys the migration removes from a normalized draft. */
export const ACTOR_LEGACY_MOTION_KEYS = [
  "autopilot",
  "timeline",
  "timedInstructions",
  "reactive_braking",
  "anti_plow",
  "collision_target_id",
  "notes",
  "compiled_route_stamp",
] as const;

/**
 * The migration's WIRE-compat residue: legacy values the deployed CARLA worker
 * and the preview engine still read off the actor spec, preserved verbatim so
 * the wire stays byte-identical while the authored surface is pruned.
 *
 * Everything representable moved into `behavior` / `reaction_profile`; this
 * envelope carries only what cannot go there without changing engine behavior
 * in this wave:
 *
 * - a NON-EMPTY legacy `timeline`. Both engines read the wire timeline for the
 *   spawn speed (`_initial_vehicle_speed_mps` and its browser twin), and a
 *   timeline on an actor that already had a behavior program has no migration
 *   at all yet (merging is deferred; report-control-systems FINDING 8.2).
 * - `timedInstructions`. Three row arguments (`distanceMeters`,
 *   `maxWaitSeconds`, `until`) have no behavior equivalent, and the worker
 *   runner still reads the field for provenance/expected-maneuver.
 * - the reaction trio. `anti_plow`'s stopped-vehicles-only scan has no
 *   `reaction_profile` equivalent (`behavior/state.py::anti_plow_enabled` reads
 *   the raw wire key), and the worker's TM pair-exemption carve-out
 *   distinguishes a legacy AVOIDED ego from an authored profile
 *   (`tm_collision_exempt_actor_ids`).
 *
 * INTERNAL to the migration output: the payload boundary
 * (`expandLegacyWireActor`) re-emits these under their ORIGINAL wire
 * spellings and deletes the envelope, so no new wire field exists. Telemetry
 * (`legacy-motion-keys.ts`) reports carriers so the corpus migration can burn
 * the envelope down to nothing.
 */
export const ScenarioEditorActorLegacyWireSchema = z
  .object({
    schema_version: z.literal(ACTOR_LEGACY_MOTION_SCHEMA_VERSION),
    timeline: z.array(ScenarioEditorTimelineClipSchema).optional(),
    timedInstructions: TimedInstructionsSchema.optional(),
    reactive_braking: z.boolean().optional(),
    anti_plow: z.boolean().optional(),
    collision_target_id: z.string().optional(),
  })
  .strict();
export type ScenarioEditorActorLegacyWire = z.infer<
  typeof ScenarioEditorActorLegacyWireSchema
>;

const ScenarioEditorActorRoleSchema = z.preprocess(
  // Persisted drafts used both spellings before sensor presence became authoritative.
  (role) => (role === "ego" || role === "hero" ? "subject" : role),
  z.enum(["subject", "traffic", "pedestrian", "prop"]),
);

export const ScenarioEditorActorDraftSchema = z.object({
  id: z.string(),
  label: z.string(),
  kind: z.enum(["vehicle", "walker", "prop"]),
  role: ScenarioEditorActorRoleSchema.default("traffic"),
  is_static: z.boolean().default(false),
  /**
   * True only for a vehicle SYNTHESIZED inside a random-traffic region by
   * `expandRandomTrafficActors`, and stamped by nothing else.
   *
   * It exists because "did an author decide this?" is a question several places
   * need and no other field answers. `role: "traffic"` is the schema DEFAULT, so
   * every hand-placed car that carries no sensors has the same value; the
   * generated id shape (`<region>:vehicle:<n>`) is an implementation detail of
   * one expander. Both were tried as the discriminator and both were wrong in
   * the same direction — they made the editor guess on cars somebody had placed
   * by hand (see `junction-direction.ts`).
   *
   * Expanded actors are ephemeral: the region spec is what gets persisted, so
   * this never appears in a saved draft.
   *
   * Kept alongside `origin` rather than replaced by it: this flag is the
   * SEMANTIC discriminator junction routing branches on
   * (`junction-direction.ts`), and pre-migration drafts carry baked snapshots
   * with the flag but no origin. `origin` adds the provenance (which region,
   * which member) the flag cannot express.
   */
  ambient_generated: z.boolean().optional(),
  /** Structured provenance for an ambient-region member. See
   * `AmbientRegionOriginSchema` — ephemeral, never persisted, never on the
   * CARLA wire. */
  origin: AmbientRegionOriginSchema.optional(),
  placement_mode: ScenarioEditorActorPlacementModeSchema.default("road"),
  blueprint: z.string(),
  spawn: ScenarioEditorRoadAnchorSchema,
  spawn_point: ScenarioEditorMapPointSchema.nullable().optional(),
  spawn_yaw: z.number().optional(),
  route: z.array(ScenarioEditorRoadAnchorSchema).default([]),
  route_direction: z.enum(["forward", "reverse"]).default("forward"),
  lane_facing: z.enum(["with_lane", "against_lane"]).default("with_lane"),
  destination: ScenarioEditorRoadAnchorSchema.nullable().optional(),
  destination_point: ScenarioEditorMapPointSchema.nullable().optional(),
  /** Default road-vehicle/autopilot target: 30 mph in the km/h runtime contract. */
  speed_kph: z.number().min(0).default(48.28032),
  /** Route-follower stop-line stop: the worker eases this actor to a controlled stop at
   * the nearest stop-line landmark ahead on its route (nominal `stop` / stop_line).
   * NOTE: this is a COMPLIANCE flag (don't blow a stop sign) — lane_keep and turn egos
   * carry it too. It is NOT a statement of scenario intent; use `expected_maneuver`. */
  stop_at_stop_line: z.boolean().optional(),
  /** The maneuver this actor's scenario is ABOUT — the ground truth the
   * maneuver/scene metrics score against. Route-follower egos (lane_keep, the
   * cause-first stop, ramps) carry NO timed instructions, so the worker cannot
   * derive intent from the plan and previously guessed it from `stop_at_stop_line`
   * — which made every lane_keep ego score against a "stop" expectation and get
   * auto-rejected by the 2D gate. Set explicitly by the generator; the worker
   * prefers it over any inference. */
  expected_maneuver: z
    .enum(["lane_keep", "lane_change_left", "lane_change_right", "turn_left", "turn_right", "stop"])
    .optional(),
  color: z.string().nullable().optional(),
  /** The unified control model (plan 2026-07-24 section 3): trigger-started
   * clips — the ONE authored motion surface. Optional only for construction
   * convenience: the load path (`draft-normalization.ts`) migrates every legacy
   * draft to a program and synthesizes a base clip, so a normalized actor
   * always carries one. The legacy `timeline` / `timedInstructions` fields are
   * gone from this schema; they parse through
   * `ScenarioEditorActorLegacyMotionSchema` at load and are stripped. */
  behavior: ActorBehaviorProgramSchema.optional(),
  /** Actor-level reactive safety layer — the authored generalization of the
   * legacy `reactive_braking` / `anti_plow` / `collision_target_id` trio (now
   * migration input, not schema fields). Standing property, not a clip: it must
   * be able to interrupt whatever clip is running. */
  reaction_profile: ReactionProfileSchema.optional(),
  /** Wire-compat residue owned by the load-time migration. See
   * `ScenarioEditorActorLegacyWireSchema` — expanded back to the original wire
   * spellings at the payload boundary, never authored, never a new wire field. */
  legacy_wire: ScenarioEditorActorLegacyWireSchema.optional(),
  interaction_relocation: InteractionRelocationActorProvenanceSchema.optional(),
  cross_map_transfer: CrossMapActorTransferProvenanceSchema.optional(),
  semantic_authoring: SemanticActorAuthoringSchema.optional(),
  timed_waypoints: z.array(ScenarioEditorTimedWaypointSchema).optional(),
  /** Precise Phase-1a parking maneuver (rear-axle, cusped, gear-aware) for a
   * `timed_path` parking ego. Emitted by the parking-maneuver core; executed by
   * the worker's parking executor. */
  parking_maneuver: ParkingManeuverSchema.optional(),
  /**
   * How the worker reads `timed_waypoints[].time`.
   *
   * "ordering" (the default, and every draft written before 2026-07-25): the
   * times order the polyline and nothing more — vehicles follow it with
   * arc-length pure pursuit at `speed_kph`. This is the behavior every existing
   * timed_path vehicle has today and it is preserved bit-for-bit.
   *
   * "schedule": the times are arrival times the runtime must hit. Speed is
   * derived per segment as distance/duration; coincident points are a hold;
   * `speed_kph` on a waypoint is ignored. Walkers already behave as "schedule"
   * unconditionally and ignore this field.
   */
  path_timing: z.enum(["ordering", "schedule"]).optional(),
  /**
   * Authoring cadence in seconds — the interval each appended point advances the
   * clock. The runtime never reads it (times are materialized per waypoint); it
   * exists so the editor can stamp, re-time after an insert, draw the dock ticks,
   * and assert the index × cadence = time invariant on load.
   */
  path_cadence_s: z.number().positive().max(5).optional(),
  path_placement: z.array(ScenarioEditorMapPointSchema).optional(),
  path_spacing: z.number().optional(),
  sensors: z.array(SensorSchema).default([]),
  behaviorMetadata: ActorBehaviorMetadataSchema.optional(),
}).passthrough();
export type ScenarioEditorActorDraft = z.infer<typeof ScenarioEditorActorDraftSchema>;

/**
 * An actor as the RUNTIME surfaces see it: the pruned persisted draft plus the
 * legacy fields the payload boundary compiles (`autopilot`, from the base clip
 * via `placementFieldsFromBaseClip`) or expands back out of the migration's
 * wire-compat envelope (`expandLegacyWireActor`). This is the shape the CARLA
 * worker validates and the preview engine simulates; it is never persisted.
 */
export type RuntimeScenarioEditorActor = ScenarioEditorActorDraft & {
  /** Compiled from the base clip at the boundary; the wire still carries it. */
  autopilot?: boolean;
  timeline?: ScenarioEditorTimelineClip[];
  timedInstructions?: TimedInstructions;
  reactive_braking?: boolean;
  anti_plow?: boolean;
  collision_target_id?: string;
};

/**
 * Read the legacy authored keys off a raw/stored actor record.
 *
 * `hadLegacyKeys` distinguishes "carried at least one legacy key" from "already
 * pruned": a pruned draft round-trips through the migration untouched, which is
 * what makes the load a fixed point. Throws only what the legacy schema itself
 * rejects — the load path surfaces that as an unloadable actor, exactly as the
 * old inline declarations did.
 */
export function readLegacyActorMotion(record: Record<string, unknown>): {
  legacy: ScenarioEditorActorLegacyMotion;
  hadLegacyKeys: boolean;
} {
  const present: Record<string, unknown> = {};
  let hadLegacyKeys = false;
  for (const key of ACTOR_LEGACY_MOTION_KEYS) {
    if (!Object.prototype.hasOwnProperty.call(record, key)) continue;
    hadLegacyKeys = true;
    present[key] = record[key];
  }
  return { legacy: ScenarioEditorActorLegacyMotionSchema.parse(present), hadLegacyKeys };
}

/**
 * Validation intent carried on a draft so the esmini-in-the-loop verdict and
 * repair are driven by the scenario's declared collision family rather than a
 * hardcoded assumption. Written by the collision-scenario builder; consumed by
 * the validation orchestrator + Lambda. Optional — hand-authored drafts (or
 * drafts predating this field) omit it and the validator falls back to
 * `collision` defaults.
 */
export const ScenarioValidationIntentSchema = z.object({
  /** What the scripted esmini rollout should produce. */
  expectedOutcome: z.enum(["collision", "near_miss"]),
  /** Planned time-of-impact (s) the actors were back-calculated to. */
  conflictTimeS: z.number(),
});
export type ScenarioValidationIntent = z.infer<typeof ScenarioValidationIntentSchema>;

export const ScenarioEditorMetadataSchema = z.object({
  sourceScenarioId: z.string(),
  mapAssetId: z.string(),
  mapName: z.string(),
  backendMapName: z.string().optional(),
  activeScenarioSimulationId: z.string().nullable().optional(),
  latestScenarioSimulationId: z.string().nullable().optional(),
  notes: z.string().default(""),
  worldSensorYawBasis: z.string().optional(),
  validationIntent: ScenarioValidationIntentSchema.optional(),
  scenarioIntention: ScenarioIntentionSchema.optional(),
  scenarioMetadata: ScenarioMetadataSchema.optional(),
  /**
   * Generation-time actor-randomness seed, pinned by the deterministic
   * generators (Engine A/B stamp their per-scene seed here). When present the
   * runtime payload builder uses it as the EXPLICIT `behavior_seed` +
   * `traffic_manager_seed` instead of the semantic_default content hash — so
   * editing one actor (the 2D repair loop retiming the conflict walker) no
   * longer re-rolls the TM seed for every ambient actor (invariant: "change
   * only the conflicting actor and the rest of the scene stays the same").
   * Non-negative safe integer.
   */
  actorRandomnessSeed: z.number().int().nonnegative().optional(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type ScenarioEditorMetadata = z.infer<typeof ScenarioEditorMetadataSchema>;

export const PhysicsProfileIdSchema = z.enum([
  "carla_default",
  "nvidia_aligned",
]);
export type PhysicsProfileId = z.infer<typeof PhysicsProfileIdSchema>;

export function normalizePhysicsProfileId(value: unknown): PhysicsProfileId {
  const parsed = PhysicsProfileIdSchema.safeParse(value);
  return parsed.success ? parsed.data : SIMULATION_DEFAULTS.physicsProfileId;
}

export const ScenarioEditorSimulationConfigSchema = z.object({
  duration_seconds: z.number().min(1).max(60).default(SIMULATION_DEFAULTS.durationSeconds),
  fixed_delta_seconds: z.number().min(0.01).max(0.2).default(SIMULATION_DEFAULTS.fixedDeltaSeconds),
  physics_profile_id: PhysicsProfileIdSchema.default(
    SIMULATION_DEFAULTS.physicsProfileId,
  ),
});
export type ScenarioEditorSimulationConfig = z.infer<typeof ScenarioEditorSimulationConfigSchema>;

/**
 * Draft schema v2: recording config lives on individual sensors in the ego
 * rig (not draft-level). worldSensors carries world-placed sensors.
 *
 * The legacy v1 schema and v1->v2 transform were removed after a staging
 * Aurora audit confirmed zero scenario_drafts rows at schema_version null/1
 * (all 57 rows at v2). Drafts at schema_version=1 are now rejected at parse.
 */
/**
 * Ambient traffic: a property of the SCENE, not an actor in it.
 *
 * The Traffic Manager cars were authored as one actor carrying a
 * `random_traffic_region` config, which the payload build expanded into as many
 * as 112 ephemeral vehicles. That made background traffic look like something an
 * author had placed — it appeared in the actor list, could be selected, given a
 * behavior program it would never run, and counted against every "how many
 * actors does this scenario have" question. Statistical behaviour is correct for
 * background and only ever wrong as authored intent
 * (`plans/2026-07-29-one-motion-model.md` §2.4).
 *
 * ## The ONE persisted home
 *
 * This field lives at `setup.scene.ambientTraffic` in the portable/persisted
 * v3 setup (`draft-normalization.ts::ScenarioSetupJsonV3`) and as the
 * `ambientTraffic` field of the native editor draft below — nowhere else. The
 * draft PUT route hoists a still-actor-shaped region into it at the write
 * boundary; normalization reads it back and serialization round-trips it, so
 * the declarative spec survives every save. The expander's OUTPUT never
 * persists: members carry `origin.kind === "ambient_region"` and the
 * serializers refuse them.
 *
 * ## `legacyActorId` is load-bearing, not vestigial
 *
 * The expander derives each generated car's id as `<region-actor-id>:vehicle:<n>`,
 * so the region actor's id is IN THE WIRE PAYLOAD of every ambient car. Moving
 * the config to the scene without carrying that id would renumber all 112 of
 * them and break the byte-identical requirement this migration is gated on. So
 * the id travels with the field, and the payload build synthesizes the same
 * actor the draft used to persist.
 *
 * ## What `region` carries
 *
 * The COMPLETE declarative population request — everything expansion is a
 * deterministic function of: `bounds`, `count`, the four seeds
 * (`placementSeed` / `colorSeed` / `blueprintSeed` / `speedSeed`),
 * `randomizeColors` / `randomizeBlueprints`, `minimumSpacingMeters`,
 * `baseSpeedKph`, `aggressiveness`, and the `blueprintPool` / `colorPool`
 * allowlists. Shaped as a passthrough of the editor's own
 * `RandomTrafficRegionConfig` rather than a re-declaration: the config is owned
 * by `apps/web/app/lib/scenario-editor/random-traffic-region.ts` and
 * duplicating it here is how two copies drift. What this schema pins is the
 * part the migration depends on.
 */
export const ScenarioEditorAmbientTrafficSchema = z
  .object({
    /** The id the retired region actor had. See above — do not regenerate it. */
    legacyActorId: z.string().min(1),
    /** The retired region actor's `spawn_point`; the expander reads it. */
    spawnPoint: ScenarioEditorMapPointSchema.nullable().optional(),
    region: z.object({ kind: z.literal("random_traffic_region") }).passthrough(),
  })
  .passthrough();
export type ScenarioEditorAmbientTraffic = z.infer<
  typeof ScenarioEditorAmbientTrafficSchema
>;

export const ScenarioEditorDraftSchema = z.object({
  version: z.literal(2),
  metadata: ScenarioEditorMetadataSchema,
  simulationConfig: ScenarioEditorSimulationConfigSchema.optional(),
  actors: z.array(ScenarioEditorActorDraftSchema).default([]),
  /**
   * Background traffic, expanded at payload build. The native-draft spelling of
   * the one scene home (`setup.scene.ambientTraffic` in the persisted v3
   * setup) — see `ScenarioEditorAmbientTrafficSchema`. `.optional()` for the
   * same reason as `signalPlans` below: a default would make the inferred type
   * required on every draft literal in the repo for a field that means nothing
   * when absent.
   */
  ambientTraffic: ScenarioEditorAmbientTrafficSchema.optional(),
  /**
   * Traffic-signal authoring, one plan per junction the author touched
   * (plan 2026-07-24, section 4.3). Draft-level rather than per-actor because a
   * junction belongs to the SCENE, not to any car: it is the SCENE lane's data.
   * Absent or empty means every junction runs `map_default`, which is exactly
   * what every draft written before this field did.
   *
   * `.optional()` rather than `.default([])` on purpose: a default makes the
   * INFERRED type required, which would break every `ScenarioEditorDraft`
   * object literal in the repo for a field that means nothing when absent.
   * Same call as `semanticFormations` next door. Read it as
   * `draft.signal_plans ?? []`.
   */
  signal_plans: z.array(JunctionSignalPlanSchema).optional(),
  semanticFormations: z.array(SceneFormationSchema).optional(),
  semanticFormationSolutions: z.array(SceneFormationSolutionSchema).optional(),
  selectedActorId: z.string().nullable().optional(),
  worldSensors: z.array(SensorSchema).default([]),
  carLedTrafficEnabled: z.boolean().default(false),
  carLedTrafficCarsPerActor: z.number().int().min(1).max(20).default(4),
  carLedTrafficRadiusMeters: z.number().int().min(5).max(100).default(30),
  carLedTrafficMinimumSpacingMeters: z.number().int().min(2).max(40).default(8),
  /** Per-car desired-speed band and headway scaling for car-led traffic. */
  carLedTrafficAggressiveness: TrafficAggressiveness.optional(),
  /** The speed that band multiplies. Not the posted limit — the runtime road
   * overlay carries none, so this knob stands in for it. */
  carLedTrafficBaseSpeedKph: z.number().int().min(5).max(130).optional(),
  /** Reroll counter: bump it for a different draw of the same settings. */
  carLedTrafficVariantSeed: z.number().int().min(0).optional(),
  trafficEnabled: z.boolean().default(false),
  trafficDensity: TrafficDensity.default("moderate"),
  trafficAggressiveness: TrafficAggressiveness.default("normal"),
  trafficVehicleCount: z.number().int().min(1).default(30),
  trafficVehicleMix: VehicleMixPreset.default("mixed"),
  trafficVehicleMixWeights: z
    .object({
      passenger: z.number().min(0).max(100).default(70),
      truck: z.number().min(0).max(100).default(20),
      bus: z.number().min(0).max(100).default(10),
    })
    .default({ passenger: 70, truck: 20, bus: 10 }),
  trafficManager: TrafficManagerSchema.nullable().optional(),
  trafficCards: z.array(TrafficCardSchema).default([]),
  selectedTrafficCardId: z.string().nullable().optional(),
  renderConfig: z
    .object({
      environmentPreset: z.record(z.unknown()).optional(),
    })
    .passthrough()
    .optional(),
});
export type ScenarioEditorDraft = z.infer<typeof ScenarioEditorDraftSchema>;

export const ScenarioEditorTemplateSchema = z.object({
  id: z.string(),
  name: z.string(),
  map_name: z.string(),
  actors: z.array(ScenarioEditorActorDraftSchema).default([]),
  selected_actor_id: z.string().nullable().optional(),
  worldSensors: z.array(SensorSchema).default([]),
  created_at: z.string(),
  updated_at: z.string(),
});
export type ScenarioEditorTemplate = z.infer<typeof ScenarioEditorTemplateSchema>;

// ---------------------------------------------------------------------------
// Derived subject
// ---------------------------------------------------------------------------

/** Anything shaped enough to answer whether it is the recording subject. */
type SubjectCandidate = Pick<ScenarioEditorActorDraft, "kind"> & {
  sensors?: unknown[];
  role?: ScenarioEditorActorDraft["role"];
};

/**
 * The scenario's recording subject: the first vehicle carrying a configured
 * sensor rig. Sensor presence is the authoritative fact because a scene records
 * what that rig observes; a separate actor designation can only disagree with
 * the actual measurement source.
 *
 * Returns null when no vehicle carries sensors. Callers mid-way through
 * BUILDING a draft want `plannedSubjectActor` instead.
 */
export function primaryActor<T extends SubjectCandidate>(actors: readonly T[]): T | null {
  return actors.find(
    (actor) => actor.kind === "vehicle" && (actor.sensors?.length ?? 0) > 0,
  ) ?? null;
}

/**
 * The subject a generator is planning around, which exists slightly before the
 * sensors do.
 *
 * A collision planner picks its principal vehicle, anchors the recipe on it,
 * times the conflict against it and only then equips it — so inside that window
 * the declared `subject` role is the only statement of intent available. This
 * is deliberately NOT `primaryActor`: nothing user-facing may call a vehicle
 * the recording subject on the strength of a label.
 */
export function plannedSubjectActor<T extends SubjectCandidate>(actors: readonly T[]): T | null {
  return primaryActor(actors)
    ?? actors.find((actor) => actor.kind === "vehicle" && actor.role === "subject")
    ?? null;
}
