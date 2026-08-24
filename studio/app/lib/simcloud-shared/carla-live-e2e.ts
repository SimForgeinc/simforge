import { z } from "zod";

export const CARLA_LIVE_E2E_REPORT_VERSION =
  "simforge.carla-live-e2e-report.v1" as const;
export const CARLA_LIVE_E2E_FIXTURE_VERSION =
  "simforge.carla-live-e2e-fixtures.v1" as const;
export const CARLA_LIVE_E2E_TIMELINE_VERSION =
  "simforge.carla-timeline.v1" as const;

export const CarlaLiveE2eStatusSchema = z.enum([
  "passed",
  "failed_product",
  "failed_worker",
  "failed_artifact_contract",
  "blocked_environment",
  "blocked_capacity",
  "cancelled",
]);
export type CarlaLiveE2eStatus = z.infer<typeof CarlaLiveE2eStatusSchema>;

export const CarlaLiveE2eSuiteSchema = z.enum([
  "contract",
  "merge",
  "promotion",
  "nightly",
]);
export type CarlaLiveE2eSuite = z.infer<typeof CarlaLiveE2eSuiteSchema>;

export const CarlaLiveE2eEnvironmentSchema = z.enum(["dev", "staging"]);
export type CarlaLiveE2eEnvironment = z.infer<
  typeof CarlaLiveE2eEnvironmentSchema
>;

const CarlaLiveE2ePointSchema = z.object({
  x: z.number().finite(),
  y: z.number().finite(),
  z: z.number().finite().optional(),
});

export const CarlaTimelineActorSampleSchema = z
  .object({
    actor_spec_id: z.string().trim().min(1).optional(),
    authored_actor_id: z.string().trim().min(1).optional(),
    id: z.union([z.string(), z.number()]).optional(),
    carla_actor_id: z.union([z.string(), z.number()]).optional(),
    label: z.string().optional(),
    kind: z.string().optional(),
    role: z.string().optional(),
    source: z.string().optional(),
    x: z.number().finite(),
    y: z.number().finite(),
    z: z.number().finite().optional(),
    yaw: z.number().finite().optional(),
    speed_mps: z.number().finite().nonnegative().optional(),
    speed_kph: z.number().finite().nonnegative().optional(),
    road_id: z.union([z.string(), z.number()]).nullable().optional(),
    section_id: z.number().int().nullable().optional(),
    lane_id: z.number().int().nullable().optional(),
    lateral_offset_m: z.number().finite().optional(),
    on_drivable: z.boolean().optional(),
    collision: z.boolean().optional(),
    stopped: z.boolean().optional(),
    diagnostics: z.array(z.record(z.string(), z.unknown())).optional(),
  })
  .passthrough()
  .superRefine((sample, context) => {
    if (!sample.actor_spec_id && !sample.authored_actor_id && sample.id == null) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "timeline actor sample needs a stable authored actor identifier",
      });
    }
    if (sample.speed_mps == null && sample.speed_kph == null) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "timeline actor sample needs speed_mps or speed_kph",
      });
    }
  });
export type CarlaTimelineActorSample = z.infer<
  typeof CarlaTimelineActorSampleSchema
>;

export const CarlaTimelineFrameSchema = z
  .object({
    frame: z.number().int().nonnegative().optional(),
    step: z.number().int().nonnegative().optional(),
    timestamp: z.number().finite().nonnegative(),
    actors: z.array(CarlaTimelineActorSampleSchema),
    diagnostics: z.array(z.record(z.string(), z.unknown())).optional(),
  })
  .passthrough();
export type CarlaTimelineFrame = z.infer<typeof CarlaTimelineFrameSchema>;

/**
 * Canonical input contract for both simulate and render timelines. Existing
 * worker timelines use version=1; newer producers may emit the explicit
 * schema_version string. Unknown major versions are rejected by validators.
 */
export const CarlaTimelineArtifactSchema = z
  .object({
    schema_version: z.string().optional(),
    version: z.union([z.literal(1), z.string()]).optional(),
    job_id: z.string().trim().min(1).optional(),
    fixed_delta_seconds: z.number().finite().positive(),
    timeline_sample_interval_seconds: z.number().finite().positive().optional(),
    frame_count: z.number().int().nonnegative(),
    frames: z.array(CarlaTimelineFrameSchema),
    diagnostics: z.array(z.record(z.string(), z.unknown())).optional(),
  })
  .passthrough()
  .superRefine((timeline, context) => {
    if (timeline.frame_count !== timeline.frames.length) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: `frame_count ${timeline.frame_count} does not match frames length ${timeline.frames.length}`,
        path: ["frame_count"],
      });
    }
    const explicitVersion = timeline.schema_version ?? String(timeline.version ?? "1");
    const major = explicitVersion.match(/(?:^|\.v)(\d+)(?:$|\.)/)?.[1];
    if (major && major !== "1") {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: `unsupported CARLA timeline major version ${major}`,
        path: ["schema_version"],
      });
    }
  });
export type CarlaTimelineArtifact = z.infer<typeof CarlaTimelineArtifactSchema>;

export const CarlaLiveE2eToleranceSchema = z.object({
  maxPositionDeltaM: z.number().finite().nonnegative(),
  maxYawDeltaDeg: z.number().finite().nonnegative(),
  maxSpeedDeltaKph: z.number().finite().nonnegative(),
  staticDriftM: z.number().finite().nonnegative(),
  routeCorridorM: z.number().finite().positive(),
  minimumTargetSpeedRatio: z.number().finite().min(0).max(1),
  maximumTargetSpeedRatio: z.number().finite().min(1),
  minimumTrafficLaneCount: z.number().int().positive(),
  trafficRadiusToleranceM: z.number().finite().nonnegative(),
  minimumAnnotatedFrameRatio: z.number().finite().min(0).max(1),
});
export type CarlaLiveE2eTolerance = z.infer<
  typeof CarlaLiveE2eToleranceSchema
>;

const CarlaLiveE2eMapPinSchema = z.object({
  mapName: z.string().trim().min(1),
  mapAssetId: z.string().trim().min(1).nullable().optional(),
  coverage: z.array(z.enum(["required", "behavior", "render"])).min(1),
  runtimeCatalogVersion: z.string().trim().min(1).nullable().optional(),
  mapBundleVersion: z.string().trim().min(1).nullable().optional(),
});

const CarlaLiveE2eActorInvariantSchema = z
  .object({
    actorId: z.string().trim().min(1),
    behavior: z.enum([
      "autopilot_speed",
      "route_follow",
      "timed_path_best_effort",
      "pedestrian_speed",
      "static",
      "traffic",
    ]),
    targetSpeedKph: z.number().finite().nonnegative().optional(),
    minimumDisplacementM: z.number().finite().nonnegative().optional(),
    route: z.array(CarlaLiveE2ePointSchema).optional(),
    center: CarlaLiveE2ePointSchema.optional(),
    radiusM: z.number().finite().positive().optional(),
    generatedActorPrefix: z.string().trim().min(1).optional(),
    expectedCount: z.number().int().positive().optional(),
  })
  .superRefine((invariant, context) => {
    if (
      ["autopilot_speed", "pedestrian_speed"].includes(invariant.behavior) &&
      invariant.targetSpeedKph == null
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: `${invariant.behavior} requires targetSpeedKph`,
        path: ["targetSpeedKph"],
      });
    }
    if (invariant.behavior === "route_follow" && !invariant.route?.length) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "route_follow requires a nonempty route",
        path: ["route"],
      });
    }
    if (
      invariant.behavior === "traffic" &&
      (!invariant.center || !invariant.radiusM || !invariant.generatedActorPrefix)
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "traffic requires center, radiusM, and generatedActorPrefix",
      });
    }
  });

export const CarlaLiveE2eFixtureSchema = z.object({
  id: z.string().trim().min(1),
  scenarioPath: z.string().trim().min(1),
  runtime: z.literal("carla_ue5"),
  mapName: z.string().trim().min(1),
  durationSeconds: z.number().finite().positive(),
  fixedDeltaSeconds: z.number().finite().positive(),
  invariants: z.array(CarlaLiveE2eActorInvariantSchema).min(1),
  requiredArtifactTypes: z.array(z.string().trim().min(1)).default([]),
});
export type CarlaLiveE2eFixture = z.infer<
  typeof CarlaLiveE2eFixtureSchema
>;

export const CarlaLiveE2eFixtureManifestSchema = z.object({
  schemaVersion: z.literal(CARLA_LIVE_E2E_FIXTURE_VERSION),
  defaultFixtureId: z.string().trim().min(1),
  tolerance: CarlaLiveE2eToleranceSchema,
  maps: z.array(CarlaLiveE2eMapPinSchema).min(1),
  fixtures: z.array(CarlaLiveE2eFixtureSchema).min(1),
});
export type CarlaLiveE2eFixtureManifest = z.infer<
  typeof CarlaLiveE2eFixtureManifestSchema
>;

const CarlaLiveE2eActorDeltaSchema = z.object({
  actorId: z.string().trim().min(1),
  maxPositionDeltaM: z.number().finite().nonnegative(),
  maxYawDeltaDeg: z.number().finite().nonnegative(),
  maxSpeedDeltaKph: z.number().finite().nonnegative(),
  comparedSamples: z.number().int().nonnegative(),
  passed: z.boolean(),
});

export const CarlaLiveE2eComparisonSchema = z.object({
  kind: z.enum(["determinism", "simulate_render_parity"]),
  exactHashes: z.array(z.string().regex(/^[a-f0-9]{64}$/)).min(2),
  exactMatch: z.boolean(),
  tolerantMatch: z.boolean(),
  actorDeltas: z.array(CarlaLiveE2eActorDeltaSchema),
  blockers: z.array(z.string()),
});
export type CarlaLiveE2eComparison = z.infer<
  typeof CarlaLiveE2eComparisonSchema
>;

const CarlaLiveE2eCheckSchema = z.object({
  id: z.string().trim().min(1),
  status: z.enum(["passed", "failed", "blocked"]),
  message: z.string(),
  evidence: z.record(z.string(), z.unknown()).optional(),
  durationMs: z.number().int().nonnegative().optional(),
});

export const CarlaLiveE2eReportSchema = z.object({
  schemaVersion: z.literal(CARLA_LIVE_E2E_REPORT_VERSION),
  status: CarlaLiveE2eStatusSchema,
  suite: CarlaLiveE2eSuiteSchema,
  environment: CarlaLiveE2eEnvironmentSchema,
  runId: z.string().trim().min(1),
  sourceSha: z.string().trim().min(7),
  startedAt: z.string().datetime(),
  finishedAt: z.string().datetime(),
  fixtureId: z.string().trim().min(1).nullable(),
  scenarioId: z.string().trim().min(1).nullable(),
  jobIds: z.array(z.string().trim().min(1)),
  checks: z.array(CarlaLiveE2eCheckSchema),
  blockers: z.array(z.string()),
  cleanup: z.object({
    attempted: z.boolean(),
    passed: z.boolean(),
    remainingResourceIds: z.array(z.string()),
  }),
});
export type CarlaLiveE2eReport = z.infer<typeof CarlaLiveE2eReportSchema>;
