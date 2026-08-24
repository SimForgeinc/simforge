-- Migration 20260806012000: report no score, not a zero score, for an unrated document
--
-- Rollback: CREATE OR REPLACE VIEW uniscenario.document_review_state_v with
--           `COALESCE(AVG(r.score), 0)::DOUBLE PRECISION AS average_score` restored, which is the
--           definition 20260805012000 installed. Nothing else in this file changes, so the revert
--           is a single expression and carries no ordering dependency.
--
-- WHAT CHANGES. uniscenario.document_review_state_v reported an asymmetric pair for a document with
-- zero ratings: `average_score = 0.0` but `minimum_score = NULL`. Both describe the same absence, so
-- one of them was lying. This drops the COALESCE so AVG returns its natural NULL over zero rows and
-- the two agree.
--
-- WHY NULL RATHER THAN COALESCING minimum_score TO 0 AS WELL. On this view a score is meaningful and
-- 4 is the accept threshold, so `minimum_score = 0` is indistinguishable from a real, very bad
-- rating -- it would read as the worst possible review rather than as no review. NULL cannot be
-- mistaken for a score. A consumer that forgets to check rating_count now gets a visible NULL or a
-- NaN rather than a plausible-looking 0.0.
--
-- review_state IS UNAFFECTED AND WAS NEVER WRONG. It branches on `COUNT(r.id) = 0` first and returns
-- 'pending' before either score expression is consulted, so no unrated document was ever reported as
-- 'rejected'. This migration does not touch that CASE.
--
-- THIS IS DEFENCE IN DEPTH, NOT A LIVE BUG FIX. Both current consumers already guard correctly, and
-- that was verified rather than assumed:
--   - app/lib/uniscenario/rating-store.ts coerces with `Number(row.average_score ?? 0)`, so the DTO
--     still carries 0 for an unrated document and UniScenarioRatingAggregateDto.averageScore stays
--     non-nullable. This migration is deliberately backward-compatible through that coalesce: no
--     contract, store, or component change is required alongside it.
--   - ScenarioRating.tsx renders the average only under `aggregate.ratingCount > 0` and otherwise
--     prints "No ratings", and its Rejected badge keys off reviewState, so no user ever saw a false
--     rejection.
-- The value is for FUTURE consumers that query the view directly in SQL and skip rating_count. Those
-- now fail visibly instead of silently reading a fabricated zero.
--
-- The column list, order, and types are unchanged -- average_score stays DOUBLE PRECISION -- which is
-- what lets CREATE OR REPLACE VIEW succeed in place rather than needing a DROP.

BEGIN;

CREATE OR REPLACE VIEW uniscenario.document_review_state_v AS
SELECT
  d.workspace_id,
  d.id AS document_id,
  d.dataset_id,
  COUNT(r.id)::INTEGER AS rating_count,
  -- No COALESCE: AVG over zero rows is NULL, which is the honest answer and matches minimum_score.
  AVG(r.score)::DOUBLE PRECISION AS average_score,
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
