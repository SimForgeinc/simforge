-- Bind every UniScenario map version to the exact immutable SimCloud map asset
-- that supplied its source objects. `source_map_id` was historically populated
-- with a display slug, so it is deliberately not reused as the authority.
--
-- Rollback: drop uniscenario_map_versions_source_map_asset_fk, then
--           uniscenario_map_versions_source_map_asset_idx, then
--           uniscenario.map_versions.source_map_asset_id after proving no
--           published map version relies on the linkage.

BEGIN;

ALTER TABLE uniscenario.map_versions
  ADD COLUMN IF NOT EXISTS source_map_asset_id TEXT,
  ADD COLUMN IF NOT EXISTS derivative_release_id TEXT;

-- XODR + coordinate frame identify the source, not a browser derivative
-- release. Keeping this historical unique would force a publisher to repoint
-- an already-authored map_version when optimized bytes change.
ALTER TABLE uniscenario.map_versions
  DROP CONSTRAINT IF EXISTS map_versions_workspace_id_xodr_sha256_coordinate_system_sha256_key;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'uniscenario_map_versions_source_map_asset_fk'
      AND conrelid = 'uniscenario.map_versions'::regclass
  ) THEN
    ALTER TABLE uniscenario.map_versions
      ADD CONSTRAINT uniscenario_map_versions_source_map_asset_fk
      FOREIGN KEY (source_map_asset_id)
      REFERENCES public.map_assets(id) ON DELETE RESTRICT;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS uniscenario_map_versions_source_map_asset_idx
  ON uniscenario.map_versions (source_map_asset_id, workspace_id, created_at DESC)
  WHERE source_map_asset_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS uniscenario_map_versions_source_release_unique
  ON uniscenario.map_versions (workspace_id, source_map_asset_id, derivative_release_id)
  WHERE source_map_asset_id IS NOT NULL AND derivative_release_id IS NOT NULL;

COMMIT;
