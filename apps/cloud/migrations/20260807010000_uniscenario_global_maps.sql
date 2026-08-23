-- Migration 20260807010000: make published UniScenario maps platform-global.
--
-- A map version has one owning workspace for immutable artifact provenance, but ownership is not
-- visibility. Every authenticated workspace must be able to browse the map, author a document
-- against it, and compile that document. The previous composite foreign keys accidentally turned
-- artifact ownership into a product tenancy boundary, leaving every workspace except the release
-- owner's with an empty map catalog.
--
-- Rollback is intentionally not offered as a blind schema reversal. Once another workspace has
-- authored against a shared map, restoring the composite keys would reject valid rows. A rollback
-- must first prove that every consumer below again matches map_versions.workspace_id.

BEGIN;

-- Consumer rows may reference any globally published map version. Map-owned rows
-- (browser_asset_sets and editor_asset_release_maps) deliberately keep their composite ownership
-- keys because they are part of the immutable publication itself, not tenant-authored consumers.
ALTER TABLE uniscenario.documents
  DROP CONSTRAINT IF EXISTS documents_map_version_id_fkey;
ALTER TABLE uniscenario.documents
  DROP CONSTRAINT IF EXISTS uniscenario_documents_workspace_map_fk;
ALTER TABLE uniscenario.documents
  ADD CONSTRAINT documents_map_version_id_fkey
  FOREIGN KEY (map_version_id) REFERENCES uniscenario.map_versions(id) ON DELETE RESTRICT;

ALTER TABLE uniscenario.documents
  DROP CONSTRAINT IF EXISTS uniscenario_documents_derived_from_map_version_fk;
ALTER TABLE uniscenario.documents
  ADD CONSTRAINT uniscenario_documents_derived_from_map_version_fk
  FOREIGN KEY (derived_from_map_version_id) REFERENCES uniscenario.map_versions(id)
  DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE uniscenario.drafts
  DROP CONSTRAINT IF EXISTS drafts_map_version_id_fkey;
ALTER TABLE uniscenario.drafts
  ADD CONSTRAINT drafts_map_version_id_fkey
  FOREIGN KEY (map_version_id) REFERENCES uniscenario.map_versions(id) ON DELETE RESTRICT;

ALTER TABLE uniscenario.revisions
  DROP CONSTRAINT IF EXISTS revisions_map_version_id_fkey;
ALTER TABLE uniscenario.revisions
  ADD CONSTRAINT revisions_map_version_id_fkey
  FOREIGN KEY (map_version_id) REFERENCES uniscenario.map_versions(id) ON DELETE RESTRICT;

ALTER TABLE uniscenario.simulation_previews
  DROP CONSTRAINT IF EXISTS simulation_previews_map_version_id_workspace_id_fkey;
ALTER TABLE uniscenario.simulation_previews
  ADD CONSTRAINT simulation_previews_map_version_id_fkey
  FOREIGN KEY (map_version_id) REFERENCES uniscenario.map_versions(id) ON DELETE RESTRICT;

ALTER TABLE uniscenario.variation_transfers
  DROP CONSTRAINT IF EXISTS variation_transfers_source_map_version_id_workspace_id_fkey;
ALTER TABLE uniscenario.variation_transfers
  ADD CONSTRAINT variation_transfers_source_map_version_id_fkey
  FOREIGN KEY (source_map_version_id) REFERENCES uniscenario.map_versions(id)
  DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE uniscenario.variation_transfers
  DROP CONSTRAINT IF EXISTS variation_transfers_target_map_version_id_workspace_id_fkey;
ALTER TABLE uniscenario.variation_transfers
  ADD CONSTRAINT variation_transfers_target_map_version_id_fkey
  FOREIGN KEY (target_map_version_id) REFERENCES uniscenario.map_versions(id)
  DEFERRABLE INITIALLY DEFERRED;

-- An execution package belongs to the authoring workspace, while its immutable XODR belongs to the
-- map publisher. Keep a real FK to the artifact id, then fence the XODR/catalog pair to an actual
-- active map publication so this cannot become a generic cross-workspace artifact reference.
ALTER TABLE uniscenario.execution_packages
  DROP CONSTRAINT IF EXISTS execution_packages_xodr_artifact_id_fkey;
ALTER TABLE uniscenario.execution_packages
  ADD CONSTRAINT execution_packages_xodr_artifact_id_fkey
  FOREIGN KEY (xodr_artifact_id) REFERENCES uniscenario.artifacts(id) ON DELETE RESTRICT;

DROP TRIGGER IF EXISTS uniscenario_execution_packages_asset_catalog_scope_fence
  ON uniscenario.execution_packages;

CREATE OR REPLACE FUNCTION uniscenario.enforce_execution_package_map_closure()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM uniscenario.map_versions mv
    WHERE mv.xodr_artifact_id = NEW.xodr_artifact_id
      AND mv.asset_catalog_version_id = NEW.asset_catalog_version_id
      AND mv.retired_at IS NULL
  ) THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      CONSTRAINT = 'uniscenario_execution_packages_global_map_closure_fence',
      MESSAGE = 'execution package XODR and asset catalog must belong to the same active global map version';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS uniscenario_execution_packages_global_map_closure_fence
  ON uniscenario.execution_packages;
CREATE TRIGGER uniscenario_execution_packages_global_map_closure_fence
BEFORE INSERT OR UPDATE OF xodr_artifact_id, asset_catalog_version_id
ON uniscenario.execution_packages
FOR EACH ROW
EXECUTE FUNCTION uniscenario.enforce_execution_package_map_closure();

COMMIT;
