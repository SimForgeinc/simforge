-- Migration 20260806014000: retire the duplicate fork lineage from 20260804025000 and adopt its
-- render-gallery hide
--
-- Rollback: re-apply the documents half of 20260804025000 -- the six columns, both foreign keys, the
--           uniscenario_documents_fork_lineage_check CHECK, and the
--           uniscenario_documents_workspace_fork_idempotency_idx index. That file is committed
--           alongside this one and its statements are all IF NOT EXISTS, so re-running it restores
--           exactly this state and nothing else. Order within the revert: columns, then the CHECK and
--           foreign keys, then the index. No data can be lost by either direction, because all six
--           columns are provably empty (see below).
--
-- WHY. 20260804025000 was applied to dev from a file that existed in no repository. It gave
-- uniscenario.documents a second, parallel representation of the parent edge -- source_document_id,
-- source_revision_id, source_draft_version, source_content_sha256, fork_idempotency_key, forked_at --
-- alongside the one 20260805013000 built as derivation_kind + derived_from_document_id +
-- derived_from_revision_id + derived_from_map_version_id + derived_by_user_id + derived_at.
--
-- That migration's header argued at length for "EXACTLY ONE SOURCE OF TRUTH for the parent edge",
-- criticising v1 for reading `COALESCE(variation_params->>'sourceScenarioId', parent_scenario_id)` --
-- two sources for one edge. The two lanes were unaware of each other, and dev ended up with the very
-- shape that header rejected. This resolves it in favour of derivation_kind + derived_from_*, which
-- is the richer model: it distinguishes copy / variation / cross_map_variation / import, carries a
-- closure CHECK per kind, uses COMPOSITE workspace-scoped foreign keys, and is what
-- app/lib/uniscenario/document-store.ts already writes for the duplicate flow.
--
-- NOTHING IS LOST, AND THAT IS MEASURED. All six columns hold zero non-NULL values across all 19
-- documents in every workspace on dev -- verified column by column, not inferred from the feature
-- being unused. The guard below re-verifies it at apply time and refuses to drop anything if that has
-- stopped being true, so this migration cannot destroy data even if another actor writes to these
-- columns between now and when it runs.
--
-- NOTHING IN THIS REPOSITORY READS THEM, AND THAT WAS CHECKED CAREFULLY, because two hits look like
-- references and are not:
--   - document-store.ts passes :source_document_id and :source_revision_id as BIND PARAMETER names,
--     and binds them into derived_from_document_id / derived_from_revision_id. Parameter names, not
--     columns.
--   - source_draft_version is a real, legitimate, pre-existing column on uniscenario.REVISIONS,
--     created by 20260804010000 and read as `r.source_draft_version`. Only the DOCUMENTS copy is the
--     orphan's. Dropping documents.source_draft_version does not touch revisions.source_draft_version.
-- source_content_sha256, fork_idempotency_key, and forked_at have no references of any kind.
--
-- DROPPING THESE TWO FOREIGN KEYS ALSO FINISHES THE TENANCY WORK. documents_source_document_id_fkey
-- and documents_source_revision_id_fkey were the two tenant-blind single-column references
-- 20260806011000 deliberately left alone, precisely because they belonged to an unowned migration and
-- hardening a column that might be dropped would only create a drop-ordering dependency. Retiring
-- them takes the remaining tenant-blind count on dev from 8 to 6 -- the three nullable-workspace
-- parents (now fenced by 20260806013000) and the three tier-3 references whose child table has no
-- workspace_id to compose with.
--
-- WHAT IS KEPT, DELIBERATELY: render_jobs.hidden_at and hidden_by_user_id are ADOPTED AS-IS, with no
-- DDL at all. Re-adding them under "our" conventions would be pure churn, because they already match
-- them: hidden_at/hidden_by_user_id mirrors the schema's existing deleted_at/deleted_by_user_id and
-- retired_at naming, and render_jobs_hidden_by_user_id_fkey is already
-- REFERENCES public.ba_user(id) ON DELETE SET NULL -- the same attribution shape as
-- requested_by_user_id and datasets.deleted_by_user_id. Two supporting partial indexes already exist,
-- both filtered WHERE hidden_at IS NULL. Dropping and recreating identical columns would rewrite the
-- table, rebuild both indexes, and change nothing.
--
-- ONE CAVEAT ON THAT ADOPTION, recorded so it is not mistaken for a working feature: the hide is
-- SCHEMA ONLY. Nothing in this repository reads or writes hidden_at or hidden_by_user_id -- zero
-- references. Because the two gallery indexes are PARTIAL on `hidden_at IS NULL`, they can only serve
-- a query that carries that predicate, and no query does, so both indexes are currently unusable. The
-- columns and indexes are adopted as the foundation of a feature still to be built, not as one that
-- works. Implementing it means adding `AND hidden_at IS NULL` to the gallery reads, at which point
-- both indexes start earning their keep.
--
-- The four workspace-leading unique indexes 20260804025000 also created are KEPT and are NOT
-- redundant with 20260805010000's (id, workspace_id) constraints: the column order is reversed, so
-- only the workspace-leading shape can serve a workspace_id-prefix scan. Dropping them would remove a
-- usable access path, so they stay. See the note in the reconstruction file.

BEGIN;

-- Refuse to drop a column that has acquired data since this was written. The orphan proves other
-- actors write to this database, so emptiness is re-established here rather than trusted.
DO $$
DECLARE
  present INT;
  populated BIGINT;
BEGIN
  SELECT count(*) INTO present
  FROM information_schema.columns
  WHERE table_schema = 'uniscenario' AND table_name = 'documents'
    AND column_name IN (
      'source_document_id', 'source_revision_id', 'source_draft_version',
      'source_content_sha256', 'fork_idempotency_key', 'forked_at'
    );

  -- Already retired. Returning early is what makes this file replay-safe: the emptiness query below
  -- names the very columns being dropped, so on a second run it would fail to parse rather than
  -- finding nothing to do. The DROP ... IF EXISTS statements that follow are no-ops.
  IF present = 0 THEN
    RETURN;
  END IF;

  IF present <> 6 THEN
    RAISE EXCEPTION
      'refusing to retire the 20260804025000 fork columns: % of 6 are present, so the table is half-retired; reconcile it by hand before re-running',
      present;
  END IF;

  -- EXECUTE, not a static statement: a static reference would be parsed even on the path where the
  -- columns are gone, which is exactly how the first version of this guard broke its own replay.
  EXECUTE $q$
    SELECT count(*) FROM uniscenario.documents
     WHERE source_document_id IS NOT NULL
        OR source_revision_id IS NOT NULL
        OR source_draft_version IS NOT NULL
        OR source_content_sha256 IS NOT NULL
        OR fork_idempotency_key IS NOT NULL
        OR forked_at IS NOT NULL
  $q$ INTO populated;

  IF populated > 0 THEN
    RAISE EXCEPTION
      'refusing to retire the 20260804025000 fork columns: % document(s) now carry fork data; migrate it onto derivation_kind/derived_from_* first',
      populated;
  END IF;
END $$;

-- The CHECK spans all six columns, so it must go before them. Dropping it explicitly rather than
-- relying on DROP COLUMN's dependency cascade keeps the intent visible and the revert symmetric.
ALTER TABLE uniscenario.documents
  DROP CONSTRAINT IF EXISTS uniscenario_documents_fork_lineage_check;

ALTER TABLE uniscenario.documents
  DROP CONSTRAINT IF EXISTS documents_source_document_id_fkey;

ALTER TABLE uniscenario.documents
  DROP CONSTRAINT IF EXISTS documents_source_revision_id_fkey;

-- Indexed on fork_idempotency_key, so it cannot outlive the column. Dropped explicitly for the same
-- reason as the CHECK.
DROP INDEX IF EXISTS uniscenario.uniscenario_documents_workspace_fork_idempotency_idx;

ALTER TABLE uniscenario.documents
  DROP COLUMN IF EXISTS source_document_id,
  DROP COLUMN IF EXISTS source_revision_id,
  DROP COLUMN IF EXISTS source_draft_version,
  DROP COLUMN IF EXISTS source_content_sha256,
  DROP COLUMN IF EXISTS fork_idempotency_key,
  DROP COLUMN IF EXISTS forked_at;

COMMIT;
