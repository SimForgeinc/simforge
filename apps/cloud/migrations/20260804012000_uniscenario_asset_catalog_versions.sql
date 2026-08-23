-- Migration 20260804012000: immutable UniScenario asset catalog versions.
--
-- This migration intentionally assumes the new UniScenario domain is empty.
-- Asset catalogs are a required signed execution input, never a legacy or
-- optional runtime lookup. Roll forward by publishing a new catalog version;
-- immutable rows and artifacts are never updated in place.

BEGIN;

CREATE TABLE IF NOT EXISTS uniscenario.asset_catalog_versions (
  id TEXT PRIMARY KEY,
  -- NULL means a platform-global catalog. A workspace-scoped catalog may only
  -- be referenced by rows in that workspace; application writes enforce that
  -- ownership boundary before creating map/execution records.
  workspace_id TEXT REFERENCES public.workspaces(id) ON DELETE RESTRICT,
  manifest_artifact_id TEXT NOT NULL REFERENCES uniscenario.artifacts(id) ON DELETE RESTRICT,
  manifest_sha256 TEXT NOT NULL CHECK (manifest_sha256 ~ '^[a-f0-9]{64}$'),
  source_inventory_sha256 TEXT NOT NULL CHECK (source_inventory_sha256 ~ '^[a-f0-9]{64}$'),
  contract_version TEXT NOT NULL DEFAULT 'uniscenario.asset-catalog/v1'
    CHECK (contract_version = 'uniscenario.asset-catalog/v1'),
  pipeline_version TEXT NOT NULL,
  toolchain JSONB NOT NULL,
  provenance JSONB NOT NULL,
  status TEXT NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'retired', 'quarantined')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  retired_at TIMESTAMPTZ,
  CHECK (jsonb_typeof(toolchain) = 'object'),
  CHECK (jsonb_typeof(provenance) = 'object'),
  CHECK ((status = 'retired') = (retired_at IS NOT NULL)),
  UNIQUE (manifest_sha256),
  UNIQUE (manifest_artifact_id)
);

CREATE INDEX IF NOT EXISTS uniscenario_asset_catalog_versions_scope_status_idx
  ON uniscenario.asset_catalog_versions (workspace_id, status, created_at DESC, id);

ALTER TABLE uniscenario.map_versions
  ADD COLUMN IF NOT EXISTS asset_catalog_version_id TEXT;

ALTER TABLE uniscenario.execution_packages
  ADD COLUMN IF NOT EXISTS asset_catalog_version_id TEXT;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'uniscenario_map_versions_asset_catalog_version_fk'
  ) THEN
    ALTER TABLE uniscenario.map_versions
      ADD CONSTRAINT uniscenario_map_versions_asset_catalog_version_fk
      FOREIGN KEY (asset_catalog_version_id)
      REFERENCES uniscenario.asset_catalog_versions(id) ON DELETE RESTRICT;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'uniscenario_execution_packages_asset_catalog_version_fk'
  ) THEN
    ALTER TABLE uniscenario.execution_packages
      ADD CONSTRAINT uniscenario_execution_packages_asset_catalog_version_fk
      FOREIGN KEY (asset_catalog_version_id)
      REFERENCES uniscenario.asset_catalog_versions(id) ON DELETE RESTRICT;
  END IF;
END $$;

-- The foundation is not yet populated. Fail closed now so the permanent
-- schema cannot create a map or execution package without a signed catalog.
ALTER TABLE uniscenario.map_versions
  ALTER COLUMN asset_catalog_version_id SET NOT NULL;

ALTER TABLE uniscenario.execution_packages
  ALTER COLUMN asset_catalog_version_id SET NOT NULL;

CREATE INDEX IF NOT EXISTS uniscenario_map_versions_asset_catalog_idx
  ON uniscenario.map_versions (asset_catalog_version_id, workspace_id, created_at DESC);

CREATE INDEX IF NOT EXISTS uniscenario_execution_packages_asset_catalog_idx
  ON uniscenario.execution_packages (asset_catalog_version_id, workspace_id, created_at DESC);

-- Remove the superseded loose artifact pointer. The catalog version row owns
-- the manifest artifact identity and its provenance/toolchain receipts.
ALTER TABLE uniscenario.execution_packages
  DROP COLUMN IF EXISTS asset_catalog_artifact_id;

COMMIT;
