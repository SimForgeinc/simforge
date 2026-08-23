-- Migration 20260805012000: per-operator UniScenario document ratings and derived review state
-- Rollback: drop view uniscenario.document_review_state_v then table uniscenario.document_ratings.
--
-- This is a NEW narrow table, not a polymorphic generalisation of public.scenario_ratings:
-- 20260804020000 states this schema is intentionally independent of public datasets, scenarios,
-- CARLA jobs and billing; going polymorphic would trade a real FK for an application invariant on
-- a table that already holds live v1 rows; and v1 is slated for deletion, so the generalisation
-- would have to be re-narrowed afterwards.
--
-- The rated unit is the DOCUMENT (the browsable thing), but the row also pins which revision and
-- which render job the reviewer actually looked at. v1 structurally could not express that,
-- because draft_json was mutable underneath the rating.
--
-- Kept verbatim from v1 so ScenarioRatingAggregate ports one-to-one:
--   UNIQUE (document_id, rater_user_id), score BETWEEN 1 AND 5, reviewed_via IN (queue, browser),
--   the score < 4 partial index, and the pending/rejected/accepted view semantics.

BEGIN;

CREATE TABLE IF NOT EXISTS uniscenario.document_ratings (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  document_id TEXT NOT NULL,
  revision_id TEXT,
  render_job_id TEXT,
  rater_user_id TEXT NOT NULL REFERENCES public.ba_user(id) ON DELETE RESTRICT,
  score SMALLINT NOT NULL,
  comment TEXT CHECK (comment IS NULL OR char_length(comment) <= 4000),
  reviewed_via TEXT NOT NULL DEFAULT 'browser',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT uniscenario_document_ratings_score_check CHECK (score BETWEEN 1 AND 5),
  CONSTRAINT uniscenario_document_ratings_reviewed_via_check
    CHECK (reviewed_via IN ('queue', 'browser')),
  CONSTRAINT uniscenario_document_ratings_document_rater_unique
    UNIQUE (document_id, rater_user_id),
  FOREIGN KEY (document_id, workspace_id)
    REFERENCES uniscenario.documents(id, workspace_id) ON DELETE CASCADE,
  -- Composite so a rating can never point at another tenant's revision or job. ON DELETE SET NULL
  -- is deliberately NOT used on these: a multi-column SET NULL would also null workspace_id, which
  -- is NOT NULL. Deferring the check instead keeps the workspace-level CASCADE from tripping over
  -- rows that are being removed in the same statement.
  FOREIGN KEY (revision_id, workspace_id)
    REFERENCES uniscenario.revisions(id, workspace_id)
    DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY (render_job_id, workspace_id)
    REFERENCES uniscenario.render_jobs(id, workspace_id)
    DEFERRABLE INITIALLY DEFERRED
);

CREATE INDEX IF NOT EXISTS uniscenario_document_ratings_workspace_document_idx
  ON uniscenario.document_ratings (workspace_id, document_id);

CREATE INDEX IF NOT EXISTS uniscenario_document_ratings_rejected_idx
  ON uniscenario.document_ratings (workspace_id, document_id)
  WHERE score < 4;

CREATE INDEX IF NOT EXISTS uniscenario_document_ratings_rater_idx
  ON uniscenario.document_ratings (workspace_id, rater_user_id, created_at DESC);

-- v1's exact semantics: no ratings at all is pending, any single score below four rejects the
-- document without deleting it, otherwise accepted. Soft-deleted documents are simply absent.
CREATE OR REPLACE VIEW uniscenario.document_review_state_v AS
SELECT
  d.workspace_id,
  d.id AS document_id,
  d.dataset_id,
  COUNT(r.id)::INTEGER AS rating_count,
  COALESCE(AVG(r.score), 0)::DOUBLE PRECISION AS average_score,
  MIN(r.score)::SMALLINT AS minimum_score,
  CASE
    WHEN COUNT(r.id) = 0 THEN 'pending'
    WHEN MIN(r.score) < 4 THEN 'rejected'
    ELSE 'accepted'
  END AS review_state
FROM uniscenario.documents d
LEFT JOIN uniscenario.document_ratings r
  ON r.workspace_id = d.workspace_id
 AND r.document_id = d.id
WHERE d.deleted_at IS NULL
GROUP BY d.workspace_id, d.id, d.dataset_id;

COMMIT;
