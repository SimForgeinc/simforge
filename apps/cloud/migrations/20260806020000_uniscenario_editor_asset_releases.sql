-- Migration 20260806020000: immutable editor asset release ledger and activation pointer.
-- Rollback: drop editor_asset_release_maps, then editor_asset_releases after no
-- environment depends on release-ledger activation or rollback.

BEGIN;

CREATE TABLE IF NOT EXISTS uniscenario.editor_asset_releases (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES public.workspaces(id) ON DELETE RESTRICT,
  manifest_sha256 TEXT NOT NULL CHECK (manifest_sha256 ~ '^[a-f0-9]{64}$'),
  source_inventory_sha256 TEXT NOT NULL CHECK (source_inventory_sha256 ~ '^[a-f0-9]{64}$'),
  asset_catalog_version_id TEXT NOT NULL REFERENCES uniscenario.asset_catalog_versions(id) ON DELETE RESTRICT,
  source_environment TEXT NOT NULL CHECK (source_environment = 'dev'),
  manifest JSONB NOT NULL,
  release_state TEXT NOT NULL CHECK (release_state IN ('available', 'active', 'retired', 'quarantined')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  activated_at TIMESTAMPTZ,
  CHECK (jsonb_typeof(manifest) = 'object'),
  CHECK (manifest->>'contractVersion' = 'simforge.editor-assets-release/v1'),
  CHECK (manifest->>'manifestSha256' = manifest_sha256),
  UNIQUE (workspace_id, manifest_sha256),
  UNIQUE (id, workspace_id)
);

CREATE UNIQUE INDEX IF NOT EXISTS uniscenario_editor_asset_releases_one_active_idx
  ON uniscenario.editor_asset_releases (workspace_id)
  WHERE release_state = 'active';

CREATE TABLE IF NOT EXISTS uniscenario.editor_asset_release_maps (
  release_id TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  map_version_id TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (release_id, map_version_id),
  FOREIGN KEY (release_id, workspace_id)
    REFERENCES uniscenario.editor_asset_releases(id, workspace_id) ON DELETE CASCADE,
  FOREIGN KEY (map_version_id, workspace_id)
    REFERENCES uniscenario.map_versions(id, workspace_id) ON DELETE RESTRICT
);

CREATE INDEX IF NOT EXISTS uniscenario_editor_asset_release_maps_workspace_idx
  ON uniscenario.editor_asset_release_maps (workspace_id, release_id, map_version_id);

COMMIT;
