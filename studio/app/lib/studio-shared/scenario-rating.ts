import { z } from "zod";

export const SCENARIO_RATING_SCHEMA_VERSION =
  "simforge.scenario-rating.v1" as const;

export const ScenarioReviewStateSchema = z.enum([
  "pending",
  "accepted",
  "rejected",
]);

export const ScenarioReviewedViaSchema = z.enum(["queue", "browser"]);

const ratingFields = {
  score: z.number().int().min(1).max(5),
  comment: z.string().trim().min(1).max(10_000).nullable(),
};

export const ScenarioRatingSchema = z
  .object({
    ...ratingFields,
    schemaVersion: z.literal(SCENARIO_RATING_SCHEMA_VERSION),
    id: z.string().trim().min(1),
    scenarioId: z.string().trim().min(1),
    raterUserId: z.string().trim().min(1),
    createdAt: z.string(),
    updatedAt: z.string(),
  })
  .strict();

export const ScenarioRatingInputSchema = z
  .object({
    score: ratingFields.score,
    comment: ratingFields.comment.optional(),
  })
  .strict();

export const ScenarioRatingAggregateSchema = z
  .object({
    scenarioId: z.string().trim().min(1),
    averageScore: z.number().min(0).max(5),
    ratingCount: z.number().int().nonnegative(),
    myScore: z.number().int().min(1).max(5).nullable(),
    reviewState: ScenarioReviewStateSchema,
  })
  .strict();

export const ScenarioReviewQueueRenderSchema = z
  .object({
    jobId: z.string().trim().min(1),
    createdAt: z.string(),
    videoMediaPath: z.string().trim().min(1).nullable(),
    posterMediaPath: z.string().trim().min(1).nullable(),
    lintVerdict: z.string().trim().min(1).nullable(),
  })
  .strict();

export const ScenarioReviewQueueItemSchema = z
  .object({
    scenarioId: z.string().trim().min(1),
    displayName: z.string().trim().min(1),
    mapName: z.string().trim().min(1).nullable(),
    family: z.string().trim().min(1).nullable(),
    scenarioIntention: z.record(z.unknown()).nullable(),
    createdAt: z.string(),
    latestRender: ScenarioReviewQueueRenderSchema.nullable(),
  })
  .strict();

export const ScenarioReviewQueuePageSchema = z
  .object({
    items: z.array(ScenarioReviewQueueItemSchema),
    nextCursor: z.string().trim().min(1).nullable(),
  })
  .strict();

export type ScenarioRating = z.infer<typeof ScenarioRatingSchema>;
export type ScenarioRatingInput = z.infer<typeof ScenarioRatingInputSchema>;
export type ScenarioRatingAggregate = z.infer<
  typeof ScenarioRatingAggregateSchema
>;
export type ScenarioReviewState = z.infer<typeof ScenarioReviewStateSchema>;
export type ScenarioReviewedVia = z.infer<typeof ScenarioReviewedViaSchema>;
export type ScenarioReviewQueueRender = z.infer<
  typeof ScenarioReviewQueueRenderSchema
>;
export type ScenarioReviewQueueItem = z.infer<
  typeof ScenarioReviewQueueItemSchema
>;
export type ScenarioReviewQueuePage = z.infer<
  typeof ScenarioReviewQueuePageSchema
>;
