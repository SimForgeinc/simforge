-- Migration 20260806010000: bind the six pre-existing map_versions artifact pointers to the
-- owning workspace
--
-- Rollback: re-add each of the six constraints in its original single-column shape --
--           FOREIGN KEY (<col>) REFERENCES uniscenario.artifacts(id) ON DELETE RESTRICT --
--           after dropping the composite form. Reverting REOPENS the cross-tenant read path
--           described below, so it is a containment regression, not a neutral undo. Order does
--           not matter against uniscenario_artifacts_id_workspace_unique: the single-column form
--           does not depend on it.
--
-- WHAT THIS CLOSES. 20260804011000 added six artifact pointers to uniscenario.map_versions as
-- single-column foreign keys to uniscenario.artifacts(id). A single-column reference carries no
-- workspace component, so a map_version owned by workspace A can name an artifact owned by
-- workspace B and the database will accept it. topology_artifact_id and browser_manifest_artifact_id
-- are presigned into the map descriptor and handed to a browser, so this is a cross-tenant READ
-- path, not a bookkeeping wart. The containment currently rests on application code remembering to
-- filter `artifacts.workspace_id = map_versions.workspace_id`, and a tenancy boundary must not
-- depend on every future call site remembering a join predicate.
--
-- 20260805015000 already established the correct shape for the two thumbnail pointers it added.
-- This migration retrofits the six that predate it, so the whole table is consistent and nobody has
-- to remember which pointers are safe.
--
-- VERIFIED AGAINST LIVE DEV BEFORE WRITING: all six pointers are non-NULL on all three map_versions
-- rows, every one resolves to a real artifact, and zero of them cross a workspace boundary. There is
-- no violating row to clean up first, so ADD CONSTRAINT validates without a backfill.
--
-- ORDERING: the composite target requires uniscenario_artifacts_id_workspace_unique, which
-- 20260805010000 adds. Applied against a schema without it, every ADD CONSTRAINT below fails with
-- `there is no unique constraint matching given keys for referenced table "artifacts"`.
--
-- DELIBERATELY NOT TOUCHED -- uniscenario_map_versions_asset_catalog_version_fk STAYS
-- SINGLE-COLUMN. uniscenario.asset_catalog_versions.workspace_id is NULLABLE, because a catalog
-- version with workspace_id IS NULL is a global catalog shared across every workspace. A composite
-- (asset_catalog_version_id, workspace_id) reference can never match a row whose workspace_id is
-- NULL, so composing it would make global catalogs unreferenceable and break cross-workspace
-- catalog sharing outright. The same applies to render_jobs.render_profile_id, since
-- uniscenario.render_profiles.workspace_id is nullable for the same reason. Neither is an oversight.
-- Do not "finish the job" by composing them; they need a different mechanism entirely.
--
-- The other ~38 tenant-blind pointers elsewhere in this schema are real and carry the same
-- exposure. They are handled in 20260806011000, which is separate so this file -- the proven
-- presigned read path -- can ship and be reverted on its own.

BEGIN;

DO $$
DECLARE
  target RECORD;
BEGIN
  -- Note the naming: five constraints follow uniscenario_map_versions_<thing>_artifact_fk, but the
  -- derived topology pointer is uniscenario_map_versions_derived_artifact_fk, with no `topology`.
  -- It is spelled out here so a future edit does not silently miss it to a typo.
  FOR target IN
    SELECT *
    FROM (VALUES
      ('xodr_artifact_id', 'uniscenario_map_versions_xodr_artifact_fk'),
      ('topology_artifact_id', 'uniscenario_map_versions_topology_artifact_fk'),
      ('derived_topology_artifact_id', 'uniscenario_map_versions_derived_artifact_fk'),
      ('locations_artifact_id', 'uniscenario_map_versions_locations_artifact_fk'),
      ('signals_artifact_id', 'uniscenario_map_versions_signals_artifact_fk'),
      ('browser_manifest_artifact_id', 'uniscenario_map_versions_browser_manifest_artifact_fk')
    ) AS t(column_name, constraint_name)
  LOOP
    -- Replay-safe by SHAPE, not by name: the constraint name survives the rewrite, so a plain
    -- "IF NOT EXISTS on the name" would make a re-run a no-op on the FIRST run's behalf and could
    -- never repair a half-converted table. Dropping only the single-column form means a second run
    -- sees conkey length 2, skips the drop, then sees the name already present and skips the add.
    IF EXISTS (
      SELECT 1 FROM pg_constraint
      WHERE conname = target.constraint_name
        AND conrelid = 'uniscenario.map_versions'::regclass
        AND array_length(conkey, 1) = 1
    ) THEN
      EXECUTE format(
        'ALTER TABLE uniscenario.map_versions DROP CONSTRAINT %I',
        target.constraint_name
      );
    END IF;

    IF NOT EXISTS (
      SELECT 1 FROM pg_constraint
      WHERE conname = target.constraint_name
        AND conrelid = 'uniscenario.map_versions'::regclass
    ) THEN
      -- ON DELETE RESTRICT preserves the original action exactly. All six were RESTRICT, so
      -- nothing about deletion behaviour changes here -- only the tenancy component is added.
      EXECUTE format(
        'ALTER TABLE uniscenario.map_versions ADD CONSTRAINT %I FOREIGN KEY (%I, workspace_id) REFERENCES uniscenario.artifacts(id, workspace_id) ON DELETE RESTRICT',
        target.constraint_name,
        target.column_name
      );
    END IF;
  END LOOP;
END $$;

COMMIT;
