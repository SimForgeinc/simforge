import { z } from "zod";

/**
 * Wire contracts for the operator review queue (manifest #42).
 *
 * Separate from `contracts.ts` so the client component can import the schema without dragging
 * `review-store.ts` — and therefore `data-api` — into the browser bundle.
 */

export const SCENARIO_REVIEW_STATES = ["pending", "accepted", "rejected"] as const;

export type ScenarioReviewState = (typeof SCENARIO_REVIEW_STATES)[number];

export const ScenarioReviewQueueItemSchema = z.object({
  documentId: z.string(),
  title: z.string(),
  datasetId: z.string(),
  datasetName: z.string().nullable(),
  mapLabel: z.string().nullable(),
  createdAt: z.string(),

  /**
   * Classification context for the reviewer, read off the revision being judged.
   *
   * v1 showed seven `INTENTION_FIELDS` here (`subject`, `outcome`, `context`, `category`,
   * `primary_maneuver_category`, `alpamayo_causal_category`, `failure_mode_target`). Those are NOT
   * portable: they are defined in `packages/shared/src/scenario-intention.ts`, which is v1's model,
   * and `scenario` carries no intention metadata at all. `summary_archetype` and
   * `summary_content_tags` on `uniscenario.revisions` are v2's equivalents, so the queue shows those
   * instead — a reviewer still needs to know what kind of scenario they are judging.
   */
  description: z.string().nullable(),
  archetype: z.string().nullable(),
  contentTags: z.array(z.string()),

  /**
   * `rating_count` is the ONLY trustworthy "is this rated" discriminator, so it crosses the wire
   * even though `reviewState` already encodes it. `document_review_state_v` returns
   * `minimum_score = NULL` when unrated, and `null < 4` is `true` in JavaScript — so a consumer that
   * recomputes the verdict from a minimum score marks every unrated document `rejected`. See the
   * note on `reviewState`.
   */
  ratingCount: z.number().int().min(0),

  /**
   * Computed by Postgres in `uniscenario.document_review_state_v`, never in TypeScript.
   *
   * DO NOT derive this client-side from a minimum score. The view's `CASE` tests
   * `COUNT(r.id) = 0 THEN 'pending'` first and only then `MIN(r.score) < 4`, and SQL's `NULL < 4`
   * is NULL rather than true. JavaScript disagrees: `null < 4 === true`, and `(null ?? 0) < 4` is
   * also `true`, so the obvious defensive coalesce does not help either. Trust the view.
   */
  reviewState: z.enum(SCENARIO_REVIEW_STATES),

  /** The reviewer's own score, when they have already rated it. */
  viewerScore: z.number().int().min(1).max(5).nullable(),

  /**
   * What the reviewer is actually judging. v1 could not express this — its `draft_json` was mutable
   * underneath the rating — so recording it is the point of the reshape (§6.2).
   */
  revisionId: z.string().nullable(),
  renderJobId: z.string().nullable(),
  renderState: z.string().nullable(),

  /**
   * `artifacts.id` for the render's `artifact_kind = 'video'`, or null when the render has not
   * produced one. The client streams it from `/api/uniscenario/artifacts/{id}`, which is
   * authenticated and sets `private, no-store`. Deliberately NOT a presigned URL: §2.5 RULE 3 —
   * presigned URLs must never travel through anything cacheable, and this payload is a wire
   * response that a CDN could otherwise hold.
   */
  previewArtifactId: z.string().nullable(),
});

export type ScenarioReviewQueueItem = z.infer<typeof ScenarioReviewQueueItemSchema>;

export const ScenarioReviewQueuePageSchema = z.object({
  items: z.array(ScenarioReviewQueueItemSchema),
  nextCursor: z.string().nullable(),
});

export type ScenarioReviewQueuePage = z.infer<typeof ScenarioReviewQueuePageSchema>;

/** Matches v1's `PAGE_SIZE`, so the queue tops up at the same cadence operators are used to. */
export const SCENARIO_REVIEW_QUEUE_PAGE_SIZE = 12;
export const SCENARIO_REVIEW_QUEUE_MAX_PAGE_SIZE = 50;
