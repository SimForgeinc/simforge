-- Migration 20260804011000: fenced UniScenario compiler and immutable map closure
-- Rollback: drop export_attempts and the added map/export columns only after all compiler work is drained.

BEGIN;

ALTER TABLE uniscenario.exports
  ADD COLUMN IF NOT EXISTS attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  ADD COLUMN IF NOT EXISTS max_attempts INTEGER NOT NULL DEFAULT 3 CHECK (max_attempts BETWEEN 1 AND 20),
  ADD COLUMN IF NOT EXISTS sumo_version TEXT,
  ADD COLUMN IF NOT EXISTS sumo_seed TEXT,
  ADD COLUMN IF NOT EXISTS sumo_deterministic_config JSONB,
  ADD COLUMN IF NOT EXISTS sumo_config_sha256 TEXT CHECK (sumo_config_sha256 IS NULL OR sumo_config_sha256 ~ '^[a-f0-9]{64}$'),
  ADD COLUMN IF NOT EXISTS materialized_traffic_result_sha256 TEXT CHECK (materialized_traffic_result_sha256 IS NULL OR materialized_traffic_result_sha256 ~ '^[a-f0-9]{64}$'),
  ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW();

CREATE INDEX IF NOT EXISTS uniscenario_exports_claim_idx
  ON uniscenario.exports (created_at, id)
  WHERE export_state = 'queued';

CREATE TABLE IF NOT EXISTS uniscenario.export_attempts (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  export_id TEXT NOT NULL REFERENCES uniscenario.exports(id) ON DELETE CASCADE,
  attempt_number INTEGER NOT NULL CHECK (attempt_number > 0),
  worker_id TEXT NOT NULL,
  fence_token_sha256 TEXT NOT NULL CHECK (fence_token_sha256 ~ '^[a-f0-9]{64}$'),
  attempt_state TEXT NOT NULL DEFAULT 'active'
    CHECK (attempt_state IN ('active', 'succeeded', 'failed', 'expired')),
  leased_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  heartbeat_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at TIMESTAMPTZ NOT NULL,
  completed_at TIMESTAMPTZ,
  failure_code TEXT,
  failure_detail JSONB,
  UNIQUE (export_id, attempt_number),
  UNIQUE (fence_token_sha256)
);

CREATE UNIQUE INDEX IF NOT EXISTS uniscenario_export_attempts_one_active_idx
  ON uniscenario.export_attempts (export_id)
  WHERE attempt_state = 'active';

ALTER TABLE uniscenario.map_versions
  ADD COLUMN IF NOT EXISTS topology_artifact_id TEXT,
  ADD COLUMN IF NOT EXISTS derived_topology_artifact_id TEXT,
  ADD COLUMN IF NOT EXISTS locations_artifact_id TEXT,
  ADD COLUMN IF NOT EXISTS signals_artifact_id TEXT,
  ADD COLUMN IF NOT EXISTS browser_manifest_artifact_id TEXT,
  ADD COLUMN IF NOT EXISTS asset_catalog_version_id TEXT,
  ADD COLUMN IF NOT EXISTS sumo_network_sha256 TEXT,
  ADD COLUMN IF NOT EXISTS compiler_bundle_version TEXT NOT NULL DEFAULT 'uniscenario.map-compiler-bundle/v1';

ALTER TABLE uniscenario.execution_packages
  ADD COLUMN IF NOT EXISTS asset_catalog_version_id TEXT,
  ADD COLUMN IF NOT EXISTS sumo_version TEXT,
  ADD COLUMN IF NOT EXISTS sumo_network_sha256 TEXT,
  ADD COLUMN IF NOT EXISTS sumo_seed TEXT,
  ADD COLUMN IF NOT EXISTS sumo_deterministic_config JSONB,
  ADD COLUMN IF NOT EXISTS sumo_config_sha256 TEXT,
  ADD COLUMN IF NOT EXISTS materialized_traffic_result_sha256 TEXT;

DO $$
DECLARE
  column_name TEXT;
  constraint_name TEXT;
BEGIN
  FOR column_name, constraint_name IN
    SELECT * FROM (VALUES
      ('xodr_artifact_id', 'uniscenario_map_versions_xodr_artifact_fk'),
      ('topology_artifact_id', 'uniscenario_map_versions_topology_artifact_fk'),
      ('derived_topology_artifact_id', 'uniscenario_map_versions_derived_artifact_fk'),
      ('locations_artifact_id', 'uniscenario_map_versions_locations_artifact_fk'),
      ('signals_artifact_id', 'uniscenario_map_versions_signals_artifact_fk'),
      ('browser_manifest_artifact_id', 'uniscenario_map_versions_browser_manifest_artifact_fk')
    ) AS entries(column_name, constraint_name)
  LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = constraint_name) THEN
      EXECUTE format(
        'ALTER TABLE uniscenario.map_versions ADD CONSTRAINT %I FOREIGN KEY (%I) REFERENCES uniscenario.artifacts(id) ON DELETE RESTRICT',
        constraint_name,
        column_name
      );
    END IF;
  END LOOP;
END $$;

COMMIT;
