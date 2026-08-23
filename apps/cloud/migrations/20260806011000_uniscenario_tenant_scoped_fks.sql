-- Migration 20260806011000: bind the remaining tenant-blind uniscenario foreign keys to the owning
-- workspace
--
-- Rollback: re-add each of the 38 constraints in its original single-column shape --
--           FOREIGN KEY (<col>) REFERENCES uniscenario.<parent>(id) ON DELETE <original action> --
--           after dropping the composite form, then drop the four parent uniques
--           uniscenario_{artifact_uploads,execution_packages,exports,render_attempts}_id_workspace_unique.
--           Order matters: the parent uniques cannot be dropped until every composite foreign key
--           that depends on their index is gone. The original action per constraint is recorded in
--           the VALUES table below -- it is the fifth column -- so the revert does not have to
--           guess. Reverting REOPENS cross-tenant references, so it is a containment regression,
--           not a neutral undo.
--
-- WHAT THIS CLOSES. 20260806010000 fixed the six map_versions artifact pointers, the proven
-- presigned read path. This file finishes the schema: 38 more single-column foreign keys, across 16
-- tables, that reference a workspace-scoped uniscenario parent without a workspace component. Each
-- one lets a child row in workspace A name a parent row in workspace B. Containment currently rests
-- on every call site remembering to filter on workspace_id, which is not a tenancy boundary.
--
-- VERIFIED AGAINST LIVE DEV BEFORE WRITING: all 46 convertible constraints were re-checked
-- immediately before this file was authored -- 0 cross-workspace references across 985 resolved
-- parent references. No backfill or cleanup is required; every ADD CONSTRAINT validates as-is.
--
-- EVERY ORIGINAL DELETE ACTION IS PRESERVED EXACTLY: 19 CASCADE, 15 RESTRICT, 4 SET NULL. This
-- migration changes the tenancy shape and NOTHING else. Homogenising these to RESTRICT would break
-- workspace deletion -- the CASCADE edges are what let a workspace tear down its own rows -- and
-- homogenising to CASCADE would silently delete data that today refuses to be orphaned.
--
-- THE SET NULL CASE IS WHY THIS NEEDS POSTGRES 15 OR NEWER. A composite foreign key declared
-- `ON DELETE SET NULL` nulls EVERY column in the key, which here would include workspace_id. All
-- four SET NULL children (artifact_cleanup_outbox, artifact_uploads, dataset_items, documents) have
-- workspace_id NOT NULL, so the plain composite form would create a constraint that parses, applies
-- cleanly, and then fails at DELETE time with a not-null violation -- a latent break that no schema
-- assertion would catch. The column-list form `ON DELETE SET NULL (<col>)`, added in PostgreSQL 15,
-- nulls only the pointer and leaves workspace_id intact. Dev is PostgreSQL 17.7. Do not rewrite
-- these four as a bare `SET NULL`.
--
-- FOUR PARENT UNIQUES ARE ADDED FIRST. A composite reference requires a matching unique on the
-- parent. uniscenario.{artifacts,datasets,documents,map_versions,render_jobs,revisions} already have
-- one -- 20260805010000 added five of them and 20260804011000 covers map_versions -- but
-- artifact_uploads, execution_packages, exports, and render_attempts do not, so they are added here.
-- They are additive and independently useful.
--
-- DELIBERATELY EXCLUDED, ALL THREE ON PURPOSE -- these must STAY SINGLE-COLUMN:
--   uniscenario_map_versions_asset_catalog_version_fk
--   uniscenario_execution_packages_asset_catalog_version_fk
--   render_jobs_render_profile_id_fkey
-- uniscenario.asset_catalog_versions.workspace_id and uniscenario.render_profiles.workspace_id are
-- both NULLABLE: a row with workspace_id IS NULL is a GLOBAL catalog or profile shared by every
-- workspace. A composite reference can never match a NULL workspace_id, so composing these would
-- make global rows unreferenceable and break cross-workspace sharing outright. Note there are TWO
-- asset_catalog_versions references, not one -- execution_packages carries one as well. Do not
-- "finish the job" on any of the three; tenancy for nullable-workspace parents needs a different
-- mechanism (a CHECK that the child's workspace matches OR the parent is global).
--
-- ALSO EXCLUDED, PENDING OTHER WORK:
--   documents_source_document_id_fkey
--   documents_source_revision_id_fkey
-- These two belong to columns added by 20260804025000_uniscenario_workflow_parity.sql, a migration
-- that is applied to dev but whose FILE EXISTS IN NO BRANCH AND NO WORKTREE. Its provenance is
-- still being traced and its columns hold zero rows in every workspace, so there is no live
-- exposure to close. Hardening a constraint on a column that may be dropped outright would only
-- create a drop-ordering dependency between two unrelated migrations. Revisit once that migration
-- has an owner.
--
-- THREE MORE CANNOT BE FIXED THIS WAY AT ALL -- see the tier-3 note at the end of this file.

BEGIN;

-- Parent uniques first: every composite foreign key below depends on one of these indexes.
DO $$
DECLARE
  parent RECORD;
BEGIN
  FOR parent IN
    SELECT *
    FROM (VALUES
      ('artifact_uploads', 'uniscenario_artifact_uploads_id_workspace_unique'),
      ('execution_packages', 'uniscenario_execution_packages_id_workspace_unique'),
      ('exports', 'uniscenario_exports_id_workspace_unique'),
      ('render_attempts', 'uniscenario_render_attempts_id_workspace_unique')
    ) AS t(table_name, constraint_name)
  LOOP
    IF NOT EXISTS (
      SELECT 1 FROM pg_constraint
      WHERE conname = parent.constraint_name
        AND conrelid = format('uniscenario.%I', parent.table_name)::regclass
    ) THEN
      EXECUTE format(
        'ALTER TABLE uniscenario.%I ADD CONSTRAINT %I UNIQUE (id, workspace_id)',
        parent.table_name,
        parent.constraint_name
      );
    END IF;
  END LOOP;
END $$;

DO $$
DECLARE
  target RECORD;
  delete_action TEXT;
BEGIN
  FOR target IN
    SELECT *
    FROM (VALUES
      ('artifact_cleanup_outbox', 'artifact_upload_id'              , 'artifact_uploads'  , 'artifact_cleanup_outbox_artifact_upload_id_fkey'         , 'SET NULL'),
      ('artifact_cleanup_outbox', 'render_attempt_id'               , 'render_attempts'   , 'artifact_cleanup_outbox_render_attempt_id_fkey'          , 'CASCADE'),
      ('artifact_cleanup_outbox', 'render_job_id'                   , 'render_jobs'       , 'artifact_cleanup_outbox_render_job_id_fkey'              , 'CASCADE'),
      ('artifact_links'         , 'artifact_id'                     , 'artifacts'         , 'artifact_links_artifact_id_fkey'                         , 'CASCADE'),
      ('artifact_links'         , 'render_attempt_id'               , 'render_attempts'   , 'artifact_links_render_attempt_id_fkey'                   , 'CASCADE'),
      ('artifact_links'         , 'render_job_id'                   , 'render_jobs'       , 'artifact_links_render_job_id_fkey'                       , 'CASCADE'),
      ('artifact_uploads'       , 'completed_artifact_id'           , 'artifacts'         , 'artifact_uploads_completed_artifact_id_fkey'             , 'SET NULL'),
      ('artifact_uploads'       , 'render_attempt_id'               , 'render_attempts'   , 'artifact_uploads_render_attempt_id_fkey'                 , 'CASCADE'),
      ('artifact_uploads'       , 'render_job_id'                   , 'render_jobs'       , 'artifact_uploads_render_job_id_fkey'                     , 'CASCADE'),
      ('artifact_uploads'       , 'revision_id'                     , 'revisions'         , 'artifact_uploads_revision_id_fkey'                       , 'CASCADE'),
      ('artifacts'              , 'revision_id'                     , 'revisions'         , 'artifacts_revision_id_fkey'                              , 'CASCADE'),
      ('asset_catalog_versions' , 'manifest_artifact_id'            , 'artifacts'         , 'asset_catalog_versions_manifest_artifact_id_fkey'        , 'RESTRICT'),
      ('dataset_items'          , 'render_job_id'                   , 'render_jobs'       , 'dataset_items_render_job_id_fkey'                        , 'SET NULL'),
      ('dataset_items'          , 'revision_id'                     , 'revisions'         , 'dataset_items_revision_id_fkey'                          , 'RESTRICT'),
      ('dataset_items'          , 'dataset_id'                      , 'datasets'          , 'uniscenario_dataset_items_dataset_fk'                    , 'CASCADE'),
      ('documents'              , 'dataset_id'                      , 'datasets'          , 'documents_dataset_id_fkey'                               , 'RESTRICT'),
      ('documents'              , 'map_version_id'                  , 'map_versions'      , 'documents_map_version_id_fkey'                           , 'RESTRICT'),
      ('documents'              , 'latest_revision_id'              , 'revisions'         , 'uniscenario_documents_latest_revision_fk'                , 'SET NULL'),
      ('drafts'                 , 'document_id'                     , 'documents'         , 'drafts_document_id_fkey'                                 , 'CASCADE'),
      ('drafts'                 , 'map_version_id'                  , 'map_versions'      , 'drafts_map_version_id_fkey'                              , 'RESTRICT'),
      ('execution_packages'     , 'materialized_traffic_artifact_id', 'artifacts'         , 'execution_packages_materialized_traffic_artifact_id_fkey', 'RESTRICT'),
      ('execution_packages'     , 'package_artifact_id'             , 'artifacts'         , 'execution_packages_package_artifact_id_fkey'             , 'RESTRICT'),
      ('execution_packages'     , 'revision_id'                     , 'revisions'         , 'execution_packages_revision_id_fkey'                     , 'CASCADE'),
      ('execution_packages'     , 'xodr_artifact_id'                , 'artifacts'         , 'execution_packages_xodr_artifact_id_fkey'                , 'RESTRICT'),
      ('execution_packages'     , 'xosc_artifact_id'                , 'artifacts'         , 'execution_packages_xosc_artifact_id_fkey'                , 'RESTRICT'),
      ('export_attempts'        , 'export_id'                       , 'exports'           , 'export_attempts_export_id_fkey'                          , 'CASCADE'),
      ('exports'                , 'artifact_id'                     , 'artifacts'         , 'exports_artifact_id_fkey'                                , 'RESTRICT'),
      ('exports'                , 'revision_id'                     , 'revisions'         , 'exports_revision_id_fkey'                                , 'CASCADE'),
      ('exports'                , 'execution_package_id'            , 'execution_packages', 'uniscenario_exports_execution_package_fk'                , 'RESTRICT'),
      ('job_events'             , 'render_attempt_id'               , 'render_attempts'   , 'job_events_render_attempt_id_fkey'                       , 'CASCADE'),
      ('job_events'             , 'render_job_id'                   , 'render_jobs'       , 'job_events_render_job_id_fkey'                           , 'CASCADE'),
      ('render_attempts'        , 'render_job_id'                   , 'render_jobs'       , 'render_attempts_render_job_id_fkey'                      , 'CASCADE'),
      ('render_jobs'            , 'execution_package_id'            , 'execution_packages', 'render_jobs_execution_package_id_fkey'                   , 'RESTRICT'),
      ('render_jobs'            , 'revision_id'                     , 'revisions'         , 'render_jobs_revision_id_fkey'                            , 'RESTRICT'),
      ('revisions'              , 'document_id'                     , 'documents'         , 'revisions_document_id_fkey'                              , 'CASCADE'),
      ('revisions'              , 'map_version_id'                  , 'map_versions'      , 'revisions_map_version_id_fkey'                           , 'RESTRICT'),
      ('validation_runs'        , 'report_artifact_id'              , 'artifacts'         , 'validation_runs_report_artifact_id_fkey'                 , 'RESTRICT'),
      ('validation_runs'        , 'revision_id'                     , 'revisions'         , 'validation_runs_revision_id_fkey'                        , 'CASCADE')
    ) AS t(child_table, column_name, parent_table, constraint_name, on_delete)
  LOOP
    -- SET NULL must name its column explicitly, or it would also null workspace_id (NOT NULL on
    -- every child here) and the constraint would fail at DELETE time instead of at apply time.
    IF target.on_delete = 'SET NULL' THEN
      delete_action := format('SET NULL (%I)', target.column_name);
    ELSE
      delete_action := target.on_delete;
    END IF;

    -- Replay-safe by SHAPE, not by name -- the constraint name survives the rewrite, so an
    -- existence check on the name alone could never repair a half-converted table. Dropping only
    -- the single-column form means a second run sees conkey length 2, skips the drop, then sees the
    -- name already present and skips the add.
    IF EXISTS (
      SELECT 1 FROM pg_constraint
      WHERE conname = target.constraint_name
        AND conrelid = format('uniscenario.%I', target.child_table)::regclass
        AND array_length(conkey, 1) = 1
    ) THEN
      EXECUTE format(
        'ALTER TABLE uniscenario.%I DROP CONSTRAINT %I',
        target.child_table,
        target.constraint_name
      );
    END IF;

    IF NOT EXISTS (
      SELECT 1 FROM pg_constraint
      WHERE conname = target.constraint_name
        AND conrelid = format('uniscenario.%I', target.child_table)::regclass
    ) THEN
      EXECUTE format(
        'ALTER TABLE uniscenario.%I ADD CONSTRAINT %I FOREIGN KEY (%I, workspace_id) REFERENCES uniscenario.%I(id, workspace_id) ON DELETE %s',
        target.child_table,
        target.constraint_name,
        target.column_name,
        target.parent_table,
        delete_action
      );
    END IF;
  END LOOP;
END $$;

COMMIT;

-- TIER 3 -- NOT IMPLEMENTED HERE, AND NOT IMPLEMENTABLE AS A COMPOSITE FOREIGN KEY.
--
-- Three tenant-blind references cannot be composed, because the CHILD table has no workspace_id
-- column to compose with:
--
--   browser_asset_members.asset_set_id  -> browser_asset_sets(id)   ON DELETE CASCADE
--     constraint browser_asset_members_asset_set_id_fkey
--   worker_leases.render_attempt_id     -> render_attempts(id)      ON DELETE CASCADE
--     constraint worker_leases_render_attempt_id_fkey
--   worker_leases.render_job_id         -> render_jobs(id)          ON DELETE CASCADE
--     constraint worker_leases_render_job_id_fkey
--
-- Closing these requires a schema change, not a constraint change:
--
--   1. ADD COLUMN workspace_id TEXT to each child (nullable at first).
--   2. Backfill from the parent -- browser_asset_members from its asset set, worker_leases from its
--      render job. Both parents already carry workspace_id, and worker_leases.render_job_id is the
--      more reliable source than render_attempt_id since the latter is nullable.
--   3. SET NOT NULL once the backfill is verified complete.
--   4. Add the workspace FK to public.workspaces(id) ON DELETE CASCADE, then convert these three to
--      the composite shape used above.
--
-- Two things make this materially riskier than tiers 1 and 2, which is why it is deliberately
-- deferred rather than folded in:
--
--   - worker_leases is on the live render lease path. It is written by workers claiming and
--      renewing leases, so ADD COLUMN + backfill + SET NOT NULL races in-flight lease writes in a
--      way that a constraint swap on a cold table does not. It wants a two-phase deploy: add the
--      column and start populating it from application code, then backfill the remainder and
--      enforce NOT NULL in a later migration.
--   - browser_asset_members is the largest table in the schema by row count (~217 rows on dev
--      today, but it grows per asset blob per set, so it is the one that will not stay small).
--
-- Neither carries a presigned cross-tenant read path today, so the exposure is lower than the
-- map_versions pointers 20260806010000 closes. Sequence them after this file lands.
