import { z } from "zod";

export const PARITY_REPORT_VERSION = "simforge.parity-report.v1" as const;

export const ParityConfigSchema = z.object({
  sampleRateHz: z.number().finite().positive(),
  position: z.object({
    maxDeviationMeters: z.object({
      vehicle: z.number().finite().nonnegative(),
      walker: z.number().finite().nonnegative(),
    }),
    rmseMeters: z.number().finite().nonnegative(),
    endStateMeters: z.number().finite().nonnegative(),
  }),
  speed: z.object({
    smoothingWindowSeconds: z.number().finite().positive(),
    maxDeltaMetersPerSecond: z.number().finite().nonnegative(),
  }),
  collisionEvents: z.object({
    presenceExact: z.boolean(),
    maxTimingDeltaSeconds: z.number().finite().nonnegative(),
  }),
  duration: z.object({
    maxDeltaSeconds: z.number().finite().nonnegative(),
  }),
});

export const ParityActorResultSchema = z.object({
  actorId: z.string().min(1),
  actorKind: z.enum(["vehicle", "walker"]),
  sampleCount: z.number().int().nonnegative(),
  maxDeviation: z.number().finite().nonnegative(),
  rmse: z.number().finite().nonnegative(),
  endStateDelta: z.number().finite().nonnegative(),
  maxSpeedDelta: z.number().finite().nonnegative().nullable(),
  verdict: z.enum(["pass", "fail"]),
});

export const ParityExcludedActorSchema = z.object({
  actorId: z.string().min(1),
  reason: z.enum([
    "missing_from_reference",
    "missing_from_candidate",
    "no_common_time_window",
  ]),
});

export const ParityCollisionPairResultSchema = z.object({
  pair: z.tuple([z.string().min(1), z.string().min(1)]),
  referenceTime: z.number().finite().nonnegative().nullable(),
  candidateTime: z.number().finite().nonnegative().nullable(),
  timingDelta: z.number().finite().nonnegative().nullable(),
  presence: z.object({
    reference: z.boolean(),
    candidate: z.boolean(),
  }),
  verdict: z.enum(["pass", "fail"]),
});

export const ParityReportSchema = z.object({
  schemaVersion: z.literal(PARITY_REPORT_VERSION),
  verdict: z.enum(["pass", "fail", "partial"]),
  config: ParityConfigSchema,
  timeline: z.object({
    referenceDuration: z.number().finite().nonnegative(),
    candidateDuration: z.number().finite().nonnegative(),
    commonStart: z.number().finite().nonnegative().nullable(),
    commonDuration: z.number().finite().nonnegative(),
    durationDelta: z.number().finite().nonnegative(),
    durationVerdict: z.enum(["pass", "fail"]),
  }),
  actors: z.array(ParityActorResultSchema),
  excludedActors: z.array(ParityExcludedActorSchema),
  collisions: z.object({
    evaluated: z.boolean(),
    verdict: z.enum(["pass", "fail", "not_evaluated"]),
    pairs: z.array(ParityCollisionPairResultSchema),
  }),
});

export type ParityReport = z.infer<typeof ParityReportSchema>;
export type ParityActorResult = z.infer<typeof ParityActorResultSchema>;
export type ParityExcludedActor = z.infer<typeof ParityExcludedActorSchema>;
