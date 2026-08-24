import type { AppContext } from "@/app/lib/db/app-context";
import { queryOne, queryRows } from "@/app/lib/db/data-api";
import type {
  ScenarioDocumentRatingDto,
  ScenarioRatingAggregateDto,
} from "./contracts";
import { scenarioId } from "./core";

type RatingRow = {
  document_id: string;
  revision_id: string | null;
  render_job_id: string | null;
  rater_user_id: string;
  score: number;
  comment: string | null;
  reviewed_via: ScenarioDocumentRatingDto["reviewedVia"];
  created_at: string;
  updated_at: string;
};

type AggregateRow = {
  document_id: string;
  rating_count: number;
  average_score: number;
  minimum_score: number | null;
  review_state: ScenarioRatingAggregateDto["reviewState"];
  viewer_score: number | null;
};

function ratingDto(row: RatingRow): ScenarioDocumentRatingDto {
  return {
    documentId: row.document_id,
    revisionId: row.revision_id,
    renderJobId: row.render_job_id,
    raterUserId: row.rater_user_id,
    score: Number(row.score),
    comment: row.comment,
    reviewedVia: row.reviewed_via,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function aggregateDto(row: AggregateRow): ScenarioRatingAggregateDto {
  return {
    documentId: row.document_id,
    ratingCount: Number(row.rating_count ?? 0),
    averageScore: Number(row.average_score ?? 0),
    minimumScore: row.minimum_score === null ? null : Number(row.minimum_score),
    reviewState: row.review_state,
    viewerScore: row.viewer_score === null ? null : Number(row.viewer_score),
  };
}

/**
 * Record this caller's rating of a document.
 *
 * One row per (document, rater) exactly as v1, so re-rating updates in place. The optional
 * `revisionId` / `renderJobId` are the improvement over v1: they say WHICH immutable revision and
 * WHICH render the reviewer actually looked at. v1 structurally could not express this because
 * `draft_json` was mutable underneath the rating.
 *
 * The `SELECT ... WHERE` source row is what enforces tenancy and existence: an id from another
 * workspace, or a soft-deleted document, inserts nothing.
 */
export async function upsertScenarioDocumentRating(
  context: AppContext,
  documentId: string,
  input: {
    score: number;
    comment?: string | null;
    reviewedVia: ScenarioDocumentRatingDto["reviewedVia"];
    revisionId?: string | null;
    renderJobId?: string | null;
  },
) {
  const rows = await queryRows<RatingRow>(
    `INSERT INTO uniscenario.document_ratings (
       id, workspace_id, document_id, revision_id, render_job_id, rater_user_id,
       score, comment, reviewed_via
     )
     SELECT :id, d.workspace_id, d.id, rev.id, rj.id, :user_id,
       :score, :comment, :reviewed_via
     FROM uniscenario.documents d
     LEFT JOIN uniscenario.revisions rev
       ON rev.workspace_id = d.workspace_id AND rev.document_id = d.id AND rev.id = :revision_id
     LEFT JOIN uniscenario.render_jobs rj
       ON rj.workspace_id = d.workspace_id AND rj.id = :render_job_id
     WHERE d.workspace_id = :workspace_id AND d.id = :document_id AND d.deleted_at IS NULL
       -- PGlite: untyped parameter in IS NOT NULL
       AND (CAST(:revision_id AS TEXT) IS NULL OR rev.id IS NOT NULL)
       AND (CAST(:render_job_id AS TEXT) IS NULL OR rj.id IS NOT NULL)
     ON CONFLICT (document_id, rater_user_id) DO UPDATE SET
       score = EXCLUDED.score,
       comment = EXCLUDED.comment,
       reviewed_via = EXCLUDED.reviewed_via,
       revision_id = EXCLUDED.revision_id,
       render_job_id = EXCLUDED.render_job_id,
       updated_at = NOW()
     RETURNING document_id, revision_id, render_job_id, rater_user_id, score, comment,
       reviewed_via, created_at::text AS created_at, updated_at::text AS updated_at`,
    {
      id: scenarioId("usrt"),
      workspace_id: context.workspaceId,
      document_id: documentId,
      revision_id: input.revisionId ?? null,
      render_job_id: input.renderJobId ?? null,
      user_id: context.userId,
      score: input.score,
      comment: input.comment ?? null,
      reviewed_via: input.reviewedVia,
    },
  );
  return rows[0] ? ratingDto(rows[0]) : null;
}

export async function deleteScenarioDocumentRating(
  context: AppContext,
  documentId: string,
) {
  const rows = await queryRows<{ document_id: string }>(
    `DELETE FROM uniscenario.document_ratings
     WHERE workspace_id = :workspace_id AND document_id = :document_id
       AND rater_user_id = :user_id
     RETURNING document_id`,
    { workspace_id: context.workspaceId, document_id: documentId, user_id: context.userId },
  );
  return rows.length > 0;
}

export async function getScenarioRatingAggregate(
  context: AppContext,
  documentId: string,
): Promise<ScenarioRatingAggregateDto | null> {
  const row = await queryOne<AggregateRow>(
    `${AGGREGATE_SELECT}
     WHERE v.workspace_id = :workspace_id AND v.document_id = :document_id
     LIMIT 1`,
    { workspace_id: context.workspaceId, document_id: documentId, user_id: context.userId },
  );
  return row ? aggregateDto(row) : null;
}

/**
 * Batch aggregate for the list view, so N rows cost one query rather than N.
 *
 * Reads `uniscenario.document_review_state_v`, which carries v1's exact semantics: zero ratings is
 * pending, any single score below four rejects, otherwise accepted.
 */
export async function listScenarioRatingAggregates(
  context: AppContext,
  documentIds: string[],
): Promise<ScenarioRatingAggregateDto[]> {
  if (documentIds.length === 0) return [];
  const rows = await queryRows<AggregateRow>(
    `${AGGREGATE_SELECT}
     WHERE v.workspace_id = :workspace_id
       AND v.document_id = ANY(CAST(:document_ids AS text[]))
     ORDER BY v.document_id`,
    {
      workspace_id: context.workspaceId,
      // Data API has no array parameter type, so the list crosses as a Postgres array literal and
      // is cast server-side. Ids are opaque `scenarioId()` tokens, and this is still a bound
      // parameter, not string interpolation into the statement.
      document_ids: `{${documentIds.map((id) => `"${id.replaceAll('"', '')}"`).join(",")}}`,
      user_id: context.userId,
    },
  );
  return rows.map(aggregateDto);
}

const AGGREGATE_SELECT = `SELECT v.document_id, v.rating_count, v.average_score,
    v.minimum_score, v.review_state,
    (SELECT r.score FROM uniscenario.document_ratings r
      WHERE r.workspace_id = v.workspace_id AND r.document_id = v.document_id
        AND r.rater_user_id = :user_id
      LIMIT 1) AS viewer_score
  FROM uniscenario.document_review_state_v v`;
