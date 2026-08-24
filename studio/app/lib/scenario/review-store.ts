import type { AppContext } from "@/app/lib/db/app-context";
import { queryRows } from "@/app/lib/db/data-api";
import {
  SCENARIO_REVIEW_QUEUE_MAX_PAGE_SIZE,
  SCENARIO_REVIEW_QUEUE_PAGE_SIZE,
  type ScenarioReviewQueueItem,
  type ScenarioReviewQueuePage,
  type ScenarioReviewState,
} from "./review-contracts";

/**
 * The operator review queue's read (manifest #42).
 *
 * Separate from `rating-store.ts` on purpose: that file *hydrates* aggregates for document ids you
 * already have (`listScenarioRatingAggregates(context, documentIds)`), which cannot drive a
 * queue. This is *discovery* — find the pending documents, oldest first, paginated. Different
 * access pattern, different file.
 *
 * NOT CACHED, and do not add `"use cache"` to it. Render jobs advance
 * `uniscenario.document_review_state_v` from the worker control plane while an operator is looking
 * at the list, which makes this the background-writer case in the rule at the top of §2.5: a read
 * whose freshness requirement is set by a background writer is dynamic however cacheable its shape
 * looks. A cached queue would keep handing out documents that were rated seconds ago.
 */

type ReviewQueueRow = {
  document_id: string;
  title: string;
  dataset_id: string;
  dataset_name: string | null;
  map_label: string | null;
  created_at: string;
  summary_description: string | null;
  summary_archetype: string | null;
  summary_content_tags: string | string[] | null;
  rating_count: number;
  review_state: ScenarioReviewState;
  viewer_score: number | null;
  revision_id: string | null;
  render_job_id: string | null;
  render_state: string | null;
  preview_artifact_id: string | null;
};

type ReviewQueueCursor = { createdAt: string; id: string };

/**
 * A single space: an ISO-8601 timestamp never contains one and `scenarioId()` tokens are
 * `[a-z0-9_]`, so it cannot collide with either half. Named rather than inlined because an invisible
 * delimiter is exactly the kind of character that gets silently mangled in transit.
 */
const CURSOR_DELIMITER = " ";

function encodeCursor(item: { createdAt: string; documentId: string }): string {
  return Buffer.from(
    `${item.createdAt}${CURSOR_DELIMITER}${item.documentId}`,
    "utf8",
  ).toString("base64url");
}

/**
 * A stale or hand-edited bookmark returns null and the caller starts from the beginning, matching
 * `decodeSummaryCursor` in `document-store.ts`. A bad cursor is a lost place in a queue, not a 500.
 */
function decodeCursor(raw: string): ReviewQueueCursor | null {
  try {
    const [createdAt, id] = Buffer.from(raw, "base64url")
      .toString("utf8")
      .split(CURSOR_DELIMITER);
    if (!createdAt || !id) return null;
    if (Number.isNaN(new Date(createdAt).getTime())) return null;
    return { createdAt, id };
  } catch {
    return null;
  }
}

/**
 * `summary_content_tags` arrives as a JSON string from the Data API but as a real array from a
 * driver that parses jsonb. Handle both rather than assuming, and fall back to empty rather than
 * throwing — a malformed tag list must not take the whole review queue down.
 */
function stringArray(value: string | string[] | null): string[] {
  if (Array.isArray(value)) return value.filter((entry): entry is string => typeof entry === "string");
  if (typeof value !== "string") return [];
  try {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed)
      ? parsed.filter((entry): entry is string => typeof entry === "string")
      : [];
  } catch {
    return [];
  }
}

function reviewQueueItem(row: ReviewQueueRow): ScenarioReviewQueueItem {
  return {
    documentId: row.document_id,
    title: row.title,
    datasetId: row.dataset_id,
    datasetName: row.dataset_name,
    mapLabel: row.map_label,
    createdAt: row.created_at,
    description: row.summary_description,
    archetype: row.summary_archetype,
    contentTags: stringArray(row.summary_content_tags),
    ratingCount: Number(row.rating_count ?? 0),
    // Straight from the view. Never recomputed here — see the note on `reviewState` in
    // `review-contracts.ts` for why a TypeScript recompute inverts the unrated case.
    reviewState: row.review_state,
    viewerScore: row.viewer_score === null ? null : Number(row.viewer_score),
    revisionId: row.revision_id,
    renderJobId: row.render_job_id,
    renderState: row.render_state,
    previewArtifactId: row.preview_artifact_id,
  };
}

/**
 * Oldest-first so the queue drains fairly and a document cannot starve behind newer work — v1's
 * ordering, kept deliberately.
 *
 * `datasetId` is accepted but the route does not pass it yet. v2 can express a per-dataset queue
 * where v1 could not (the view carries `dataset_id`), so the seam is here to make that a query
 * parameter later rather than a route reshape.
 */
export async function listScenarioReviewQueue(
  context: AppContext,
  input: { limit?: number; cursor?: string | null; datasetId?: string | null } = {},
): Promise<ScenarioReviewQueuePage> {
  const limit = Math.max(
    1,
    Math.min(input.limit ?? SCENARIO_REVIEW_QUEUE_PAGE_SIZE, SCENARIO_REVIEW_QUEUE_MAX_PAGE_SIZE),
  );
  const cursor = input.cursor ? decodeCursor(input.cursor) : null;

  const rows = await queryRows<ReviewQueueRow>(
    `SELECT
       d.id                AS document_id,
       d.title,
       d.dataset_id,
       ds.name             AS dataset_name,
       mv.label            AS map_label,
       d.created_at::text  AS created_at,
       dr.summary_description,
       dr.summary_archetype,
       dr.summary_content_tags,
       v.rating_count,
       v.review_state,
       (SELECT r.score FROM uniscenario.document_ratings r
         WHERE r.workspace_id = d.workspace_id AND r.document_id = d.id
           AND r.rater_user_id = :user_id
         LIMIT 1)          AS viewer_score,
       d.latest_revision_id AS revision_id,
       rj.id               AS render_job_id,
       rj.job_state        AS render_state,
       va.id               AS preview_artifact_id
     FROM uniscenario.documents d
     JOIN uniscenario.document_review_state_v v
       ON v.workspace_id = d.workspace_id AND v.document_id = d.id
     JOIN uniscenario.datasets ds
       ON ds.id = d.dataset_id AND ds.workspace_id = d.workspace_id
     LEFT JOIN uniscenario.map_versions mv
       ON mv.id = d.map_version_id
     -- The revision the reviewer is judging carries the classification summary. LEFT, because a
     -- document with no revision yet is still pending and must not vanish from the queue.
     LEFT JOIN uniscenario.revisions dr
       ON dr.id = d.latest_revision_id AND dr.workspace_id = d.workspace_id
     -- Most recent render of the revision the reviewer will judge, so the queue can say which
     -- render was watched rather than implying the document as a whole was.
     LEFT JOIN LATERAL (
       SELECT j.id, j.job_state
       FROM uniscenario.render_jobs j
       WHERE j.workspace_id = d.workspace_id AND j.revision_id = d.latest_revision_id
       ORDER BY j.created_at DESC, j.id DESC
       LIMIT 1
     ) rj ON TRUE
     LEFT JOIN LATERAL (
       SELECT a.id
       FROM uniscenario.artifacts a
       WHERE a.workspace_id = d.workspace_id
         AND a.revision_id = d.latest_revision_id
         AND a.artifact_kind = 'video'
         AND a.artifact_state = 'available'
         AND a.deleted_at IS NULL
       ORDER BY a.created_at DESC, a.id DESC
       LIMIT 1
     ) va ON TRUE
     WHERE d.workspace_id = :workspace_id
       AND d.deleted_at IS NULL
       AND v.review_state = 'pending'
       ${input.datasetId ? "AND d.dataset_id = :dataset_id" : ""}
       ${cursor ? "AND (d.created_at, d.id) > (CAST(:cursor_created_at AS timestamptz), :cursor_id)" : ""}
     ORDER BY d.created_at ASC, d.id ASC
     LIMIT :row_limit`,
    {
      workspace_id: context.workspaceId,
      user_id: context.userId,
      row_limit: limit + 1,
      ...(input.datasetId ? { dataset_id: input.datasetId } : {}),
      ...(cursor ? { cursor_created_at: cursor.createdAt, cursor_id: cursor.id } : {}),
    },
  );

  const hasMore = rows.length > limit;
  const items = (hasMore ? rows.slice(0, limit) : rows).map(reviewQueueItem);
  const last = items.at(-1);
  return {
    items,
    nextCursor: hasMore && last ? encodeCursor(last) : null,
  };
}
