-- Migration 20260805015000: content-addressed map thumbnails and preview videos
-- Rollback: drop uniscenario_map_versions_thumbnail_artifact_fk and
--           uniscenario_map_versions_preview_video_artifact_fk, then
--           uniscenario_map_versions_thumbnail_idx, then
--           map_versions.thumbnail_artifact_id and map_versions.preview_video_artifact_id --
--           after the map descriptor stops presigning them. Order matters: both foreign keys
--           depend on the index behind uniscenario_artifacts_id_workspace_unique (added by
--           20260805010000), so 20260805010000 cannot be rolled back until these two constraints
--           are gone -- along with uniscenario_render_jobs_source_artifact_fk from 20260805016000,
--           which shares that index. Dropping the two columns would take the foreign keys and the
--           partial index with them; they are listed separately so a rollback that only reverts
--           the constraints is possible.
--
-- These are ARTIFACT ROWS, not a key convention. v1 derived thumbnails from the literal path
-- `maps/{id}/{id}_thumbnail.png`, which is unverifiable: nothing bound the bytes at that key to a
-- checksum, so a truncated or replaced object was indistinguishable from a good one. Pointing at
-- uniscenario.artifacts inherits sha256 + byte_length + artifact_state + the verification outbox
-- for free.
--
-- BOTH FOREIGN KEYS ARE COMPOSITE (artifact_id, workspace_id) ON PURPOSE, and deliberately do NOT
-- match the single-column shape of the six map artifact pointers 20260804011000 added to this
-- table. A single-column FK to uniscenario.artifacts(id) lets a workspace-A map_version name a
-- workspace-B artifact, and these two pointers are presigned into the map descriptor
-- (listUniScenarioMapDescriptors), so the failure mode is a CROSS-TENANT READ, not an integrity
-- nit. Today the descriptor query is the only thing preventing it -- it joins
-- `artifacts.workspace_id = map_versions.workspace_id` -- and a tenancy boundary must not depend on
-- every future reader remembering that predicate. Composite (id, workspace_id) makes the database
-- reject the assignment outright, matching uniscenario_render_jobs_source_artifact_fk in
-- 20260805016000.
--
-- The six pre-existing map_versions pointers -- uniscenario_map_versions_{xodr,topology,derived,
-- locations,signals,browser_manifest}_artifact_fk -- carry the same exposure, and so do ~46 other
-- single-column FKs into workspace-scoped uniscenario tables. Those are already applied and need a
-- separate forward migration (several of their parent tables still lack an (id, workspace_id)
-- unique to point at, and three child tables have no workspace_id to compose with), so this
-- migration deliberately fixes only the two pointers it introduces.
--
-- ORDERING: the composite target requires uniscenario_artifacts_id_workspace_unique, which
-- 20260805010000 adds. This file sorts after it, so the dependency holds -- but applying
-- 20260805015000 against a schema that lacks that unique fails outright.

BEGIN;

ALTER TABLE uniscenario.map_versions
  ADD COLUMN IF NOT EXISTS thumbnail_artifact_id TEXT,
  ADD COLUMN IF NOT EXISTS preview_video_artifact_id TEXT;

DO $$
DECLARE
  target_column TEXT;
  target_constraint TEXT;
BEGIN
  FOR target_column, target_constraint IN
    SELECT * FROM (VALUES
      ('thumbnail_artifact_id', 'uniscenario_map_versions_thumbnail_artifact_fk'),
      ('preview_video_artifact_id', 'uniscenario_map_versions_preview_video_artifact_fk')
    ) AS entries(target_column, target_constraint)
  LOOP
    IF NOT EXISTS (
      SELECT 1 FROM pg_constraint
      WHERE conname = target_constraint
        AND conrelid = 'uniscenario.map_versions'::regclass
    ) THEN
      EXECUTE format(
        'ALTER TABLE uniscenario.map_versions ADD CONSTRAINT %I FOREIGN KEY (%I, workspace_id) REFERENCES uniscenario.artifacts(id, workspace_id) ON DELETE RESTRICT',
        target_constraint,
        target_column
      );
    END IF;
  END LOOP;
END $$;

-- Map-group cards read the thumbnail for every live map version in one query.
CREATE INDEX IF NOT EXISTS uniscenario_map_versions_thumbnail_idx
  ON uniscenario.map_versions (workspace_id, id)
  WHERE thumbnail_artifact_id IS NOT NULL AND retired_at IS NULL;

COMMIT;
