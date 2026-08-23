-- Migration 20260804024000: immutable UniScenario browser bundle registry
-- Rollback: drop browser_asset_set_id, browser_asset_members, browser_asset_sets,
--           and browser_asset_blobs after unbinding every map version.

BEGIN;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'uniscenario_map_versions_id_workspace_unique'
  ) THEN
    ALTER TABLE uniscenario.map_versions
      ADD CONSTRAINT uniscenario_map_versions_id_workspace_unique UNIQUE (id, workspace_id);
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS uniscenario.browser_asset_blobs (
  id TEXT PRIMARY KEY,
  storage_bucket TEXT NOT NULL,
  storage_key TEXT NOT NULL,
  object_version_id TEXT,
  sha256 TEXT NOT NULL CHECK (sha256 ~ '^[a-f0-9]{64}$'),
  byte_length BIGINT NOT NULL CHECK (byte_length >= 0),
  media_type TEXT NOT NULL,
  verification_state TEXT NOT NULL CHECK (verification_state IN ('pending', 'verified', 'quarantined')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  verified_at TIMESTAMPTZ,
  UNIQUE NULLS NOT DISTINCT (storage_bucket, storage_key, object_version_id),
  UNIQUE (sha256, byte_length, media_type)
);

CREATE TABLE IF NOT EXISTS uniscenario.browser_asset_sets (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  map_version_id TEXT NOT NULL,
  contract_version TEXT NOT NULL DEFAULT 'uniscenario.browser-asset-set/v1',
  closure_sha256 TEXT NOT NULL CHECK (closure_sha256 ~ '^[a-f0-9]{64}$'),
  object_count INTEGER NOT NULL CHECK (object_count > 0),
  byte_length BIGINT NOT NULL CHECK (byte_length >= 0),
  asset_set_state TEXT NOT NULL CHECK (asset_set_state IN ('building', 'available', 'retired')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  verified_at TIMESTAMPTZ,
  UNIQUE (workspace_id, map_version_id, closure_sha256),
  UNIQUE (id, workspace_id),
  FOREIGN KEY (map_version_id, workspace_id)
    REFERENCES uniscenario.map_versions(id, workspace_id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS uniscenario.browser_asset_members (
  asset_set_id TEXT NOT NULL REFERENCES uniscenario.browser_asset_sets(id) ON DELETE CASCADE,
  relative_path TEXT NOT NULL,
  blob_id TEXT NOT NULL REFERENCES uniscenario.browser_asset_blobs(id) ON DELETE RESTRICT,
  role TEXT NOT NULL CHECK (role IN ('manifest', 'environment', 'geometry', 'texture', 'metadata', 'runtime')),
  required BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (asset_set_id, relative_path),
  CHECK (relative_path <> ''),
  CHECK (relative_path !~ '(^|/)\.\.(/|$)'),
  CHECK (relative_path !~ '(^|/)\.(/|$)'),
  CHECK (relative_path !~ '(^/|//|\\|[[:cntrl:]])'),
  CHECK (relative_path !~* '^[a-z][a-z0-9+.-]*://')
);

ALTER TABLE uniscenario.map_versions
  ADD COLUMN IF NOT EXISTS browser_asset_set_id TEXT;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'uniscenario_map_versions_browser_asset_set_fk'
  ) THEN
    ALTER TABLE uniscenario.map_versions
      ADD CONSTRAINT uniscenario_map_versions_browser_asset_set_fk
      FOREIGN KEY (browser_asset_set_id, workspace_id)
      REFERENCES uniscenario.browser_asset_sets(id, workspace_id) ON DELETE RESTRICT;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS uniscenario_browser_asset_sets_workspace_idx
  ON uniscenario.browser_asset_sets (workspace_id, map_version_id)
  WHERE asset_set_state = 'available';

COMMIT;
