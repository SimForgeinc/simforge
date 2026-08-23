-- Migration 20260804025000: UniScenario workflow parity -- document forking and render-gallery hiding
--
-- ############################################################################################
-- ##  RECONSTRUCTION OF AN ALREADY-APPLIED UNTRACKED MIGRATION. COMMITTED FOR PROVENANCE.   ##
-- ##  DO NOT EDIT TO "IMPROVE" IT. IT IS A RECORD, NOT A PROPOSAL.                          ##
-- ############################################################################################
--
-- WHY THIS FILE EXISTS. A migration with this exact id was applied to the dev database on
-- 2026-08-04 at 21:37:43 UTC, after every other 20260804* migration. Its FILE existed in no branch,
-- no worktree, and no commit anywhere in this repository -- `git log --all --diff-filter=A` finds no
-- commit that ever added it. Because schema_migrations.id IS the filename, and the runner decides
-- what to apply purely by filename membership, that id can never surface as pending again. The
-- migration was therefore permanently invisible: dev carried schema that the repository's migration
-- history did not describe, and `npm run db:migrate:status:dev` reported a clean tree while saying
-- nothing about it.
--
-- This file is a RECONSTRUCTION of that migration, recovered by diffing the live dev schema against
-- everything the eight tracked 20260804* migrations create. It is committed so the repo stops lying
-- about what dev contains. It is NOT a new migration and it is NOT to be re-run against dev.
--
-- IT WILL NOT RE-RUN ON DEV, AND THAT IS VERIFIED, NOT ASSUMED. scripts/db-migrate-v2.mjs computes
-- pending work as `getMigrationFiles()` minus `appliedMigrationIds()`, comparing filenames only.
-- schema_migrations is (id TEXT PRIMARY KEY, applied_at TIMESTAMPTZ) -- there is NO checksum, hash,
-- or content column anywhere in the runner or the table, so content drift between this file and what
-- actually ran cannot trigger a re-apply or a mismatch error. Committing this filename makes the
-- runner report it as applied (a checked entry) rather than as pending.
--
-- ON A DATABASE THAT NEVER RECEIVED IT -- staging, prod, or a fresh local -- this file WILL execute,
-- in filename order, before the 20260805* migrations. That is intentional and correct: it reproduces
-- the state dev reached, and 20260806014000 then retires the half of it we do not keep, so every
-- environment converges on the same end state by the same path. Everything below is guarded with
-- IF NOT EXISTS so it is also safe to replay.
--
-- FIDELITY. Column types, nullability, constraint names, delete actions, CHECK expressions, and
-- index predicates below were all read back out of live dev via the catalog, not guessed. What
-- cannot be recovered is the original author's comments and intent -- those are gone with the file.
-- The commentary here describes what the schema DOES, and is not a claim about what the author meant.
--
-- WHAT BECAME OF IT. Reconciled by 20260806014000, which:
--   - DROPS the six documents.source_*/fork_*/forked_at columns, both their foreign keys, the
--     fork-lineage CHECK, and the fork idempotency index. They duplicate the parent-edge model
--     20260805013000 built (derivation_kind + derived_from_*), which is the single source of truth.
--     All six held zero non-NULL values in every workspace, so nothing was lost.
--   - KEEPS render_jobs.hidden_at and hidden_by_user_id, adopted as-is.

BEGIN;

-- Document forking: a fork records which document, revision, and exact content it came from.
-- Superseded by 20260805013000's derivation_kind + derived_from_* and retired in 20260806014000.
ALTER TABLE uniscenario.documents
  ADD COLUMN IF NOT EXISTS source_document_id TEXT,
  ADD COLUMN IF NOT EXISTS source_revision_id TEXT,
  ADD COLUMN IF NOT EXISTS source_draft_version BIGINT,
  ADD COLUMN IF NOT EXISTS source_content_sha256 TEXT,
  ADD COLUMN IF NOT EXISTS fork_idempotency_key TEXT,
  ADD COLUMN IF NOT EXISTS forked_at TIMESTAMPTZ;

-- Render-gallery hiding: a soft hide that keeps the row and its artifacts. Attribution follows the
-- schema's existing deleted_by_user_id shape -- ON DELETE SET NULL, so removing a user does not
-- remove the hide. KEPT by 20260806014000.
ALTER TABLE uniscenario.render_jobs
  ADD COLUMN IF NOT EXISTS hidden_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS hidden_by_user_id TEXT;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'documents_source_document_id_fkey'
      AND conrelid = 'uniscenario.documents'::regclass
  ) THEN
    ALTER TABLE uniscenario.documents
      ADD CONSTRAINT documents_source_document_id_fkey
      FOREIGN KEY (source_document_id) REFERENCES uniscenario.documents(id) ON DELETE RESTRICT;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'documents_source_revision_id_fkey'
      AND conrelid = 'uniscenario.documents'::regclass
  ) THEN
    ALTER TABLE uniscenario.documents
      ADD CONSTRAINT documents_source_revision_id_fkey
      FOREIGN KEY (source_revision_id) REFERENCES uniscenario.revisions(id) ON DELETE RESTRICT;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'render_jobs_hidden_by_user_id_fkey'
      AND conrelid = 'uniscenario.render_jobs'::regclass
  ) THEN
    ALTER TABLE uniscenario.render_jobs
      ADD CONSTRAINT render_jobs_hidden_by_user_id_fkey
      FOREIGN KEY (hidden_by_user_id) REFERENCES public.ba_user(id) ON DELETE SET NULL;
  END IF;

  -- Either the row is not a fork at all, or it carries the whole fork receipt.
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'uniscenario_documents_fork_lineage_check'
      AND conrelid = 'uniscenario.documents'::regclass
  ) THEN
    ALTER TABLE uniscenario.documents
      ADD CONSTRAINT uniscenario_documents_fork_lineage_check
      CHECK (
        (source_document_id IS NULL
          AND source_revision_id IS NULL
          AND source_draft_version IS NULL
          AND source_content_sha256 IS NULL
          AND fork_idempotency_key IS NULL
          AND forked_at IS NULL)
        OR
        (source_document_id IS NOT NULL
          AND source_draft_version > 0
          AND source_content_sha256 ~ '^[a-f0-9]{64}$'
          AND fork_idempotency_key IS NOT NULL
          AND forked_at IS NOT NULL)
      );
  END IF;
END $$;

-- Retried forks collapse onto one document per workspace.
CREATE UNIQUE INDEX IF NOT EXISTS uniscenario_documents_workspace_fork_idempotency_idx
  ON uniscenario.documents (workspace_id, fork_idempotency_key)
  WHERE fork_idempotency_key IS NOT NULL;

-- Title-ordered browse within a workspace.
CREATE INDEX IF NOT EXISTS uniscenario_documents_workspace_search_idx
  ON uniscenario.documents (workspace_id, lower(title), updated_at DESC, id)
  WHERE deleted_at IS NULL;

-- Gallery ordering, per workspace and per revision, skipping hidden jobs.
CREATE INDEX IF NOT EXISTS uniscenario_render_jobs_workspace_gallery_idx
  ON uniscenario.render_jobs (workspace_id, created_at DESC, id)
  WHERE hidden_at IS NULL;

CREATE INDEX IF NOT EXISTS uniscenario_render_jobs_revision_gallery_idx
  ON uniscenario.render_jobs (workspace_id, revision_id, created_at DESC, id)
  WHERE hidden_at IS NULL;

-- Workspace-leading uniqueness on the four browse roots. Note these are NOT redundant with the
-- (id, workspace_id) unique constraints 20260805010000 adds: the column order is reversed, so only
-- these can serve a workspace_id-prefix scan. Both shapes are kept deliberately.
CREATE UNIQUE INDEX IF NOT EXISTS uniscenario_documents_workspace_id_idx
  ON uniscenario.documents (workspace_id, id);

CREATE UNIQUE INDEX IF NOT EXISTS uniscenario_datasets_workspace_id_idx
  ON uniscenario.datasets (workspace_id, id);

CREATE UNIQUE INDEX IF NOT EXISTS uniscenario_maps_workspace_id_idx
  ON uniscenario.map_versions (workspace_id, id);

CREATE UNIQUE INDEX IF NOT EXISTS uniscenario_revisions_workspace_document_id_idx
  ON uniscenario.revisions (workspace_id, document_id, id);

COMMIT;
