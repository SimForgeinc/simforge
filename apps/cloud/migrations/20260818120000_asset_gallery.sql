CREATE SCHEMA IF NOT EXISTS asset_gallery;

CREATE TABLE asset_gallery.assets (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  catalog_slug TEXT NOT NULL UNIQUE,
  title TEXT NOT NULL,
  description TEXT,
  actor_class TEXT NOT NULL,
  tags TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  created_by_user_id TEXT NOT NULL,
  created_by_workspace_id TEXT NOT NULL,
  visibility TEXT NOT NULL DEFAULT 'public',
  status TEXT NOT NULL DEFAULT 'draft',
  current_version INTEGER NOT NULL DEFAULT 1,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT asset_gallery_assets_title_check CHECK (char_length(title) BETWEEN 1 AND 120),
  CONSTRAINT asset_gallery_assets_actor_class_check CHECK (
    actor_class IN ('static_object', 'animal', 'sidewalk_robot', 'drone', 'pedestrian', 'vehicle')
  ),
  CONSTRAINT asset_gallery_assets_visibility_check CHECK (visibility IN ('public')),
  CONSTRAINT asset_gallery_assets_status_check CHECK (
    status IN ('draft', 'verifying', 'ready', 'rejected', 'removed')
  ),
  CONSTRAINT asset_gallery_assets_current_version_check CHECK (current_version > 0)
);

CREATE TABLE asset_gallery.asset_versions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  asset_id UUID NOT NULL REFERENCES asset_gallery.assets(id) ON DELETE CASCADE,
  version INTEGER NOT NULL,
  source_bucket TEXT NOT NULL,
  source_key TEXT NOT NULL,
  source_sha256 TEXT NOT NULL,
  source_format TEXT NOT NULL,
  byte_length BIGINT NOT NULL,
  media_type TEXT NOT NULL DEFAULT 'model/gltf-binary',
  dims JSONB NOT NULL,
  bounds JSONB NOT NULL,
  triangle_count INTEGER NOT NULL,
  mesh_count INTEGER NOT NULL DEFAULT 0,
  material_count INTEGER NOT NULL DEFAULT 0,
  extensions TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  transform JSONB NOT NULL DEFAULT '{}'::JSONB,
  animation JSONB NOT NULL DEFAULT '{}'::JSONB,
  thumbnail_key TEXT NOT NULL,
  thumbnail_sha256 TEXT NOT NULL,
  thumbnail_byte_length BIGINT NOT NULL,
  verification_state TEXT NOT NULL DEFAULT 'pending',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT asset_gallery_asset_versions_asset_version_key UNIQUE (asset_id, version),
  CONSTRAINT asset_gallery_asset_versions_source_sha256_check CHECK (source_sha256 ~ '^[a-f0-9]{64}$'),
  CONSTRAINT asset_gallery_asset_versions_thumbnail_sha256_check CHECK (thumbnail_sha256 ~ '^[a-f0-9]{64}$'),
  CONSTRAINT asset_gallery_asset_versions_byte_length_check CHECK (byte_length > 0),
  CONSTRAINT asset_gallery_asset_versions_thumbnail_byte_length_check CHECK (thumbnail_byte_length > 0),
  CONSTRAINT asset_gallery_asset_versions_version_check CHECK (version > 0),
  CONSTRAINT asset_gallery_asset_versions_triangle_count_check CHECK (triangle_count >= 0),
  CONSTRAINT asset_gallery_asset_versions_source_format_check CHECK (
    source_format IN ('glb', 'gltf', 'fbx', 'obj', 'stl', 'dae', 'ply', 'usdz')
  ),
  CONSTRAINT asset_gallery_asset_versions_verification_state_check CHECK (
    verification_state IN ('pending', 'verified', 'failed', 'quarantined')
  )
);

CREATE TABLE asset_gallery.asset_reports (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  asset_id UUID NOT NULL REFERENCES asset_gallery.assets(id) ON DELETE CASCADE,
  reporter_user_id TEXT NOT NULL,
  reason TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  resolved_at TIMESTAMPTZ,
  resolution TEXT
);

CREATE INDEX asset_gallery_assets_ready_created_idx
  ON asset_gallery.assets (created_at DESC, id DESC)
  WHERE status = 'ready' AND visibility = 'public';

CREATE INDEX asset_gallery_assets_ready_actor_class_idx
  ON asset_gallery.assets (actor_class, created_at DESC, id DESC)
  WHERE status = 'ready' AND visibility = 'public';

-- pg_trgm is not bundled in PGlite; local catalog search uses ordinary predicates.

CREATE INDEX asset_gallery_asset_versions_asset_idx
  ON asset_gallery.asset_versions (asset_id, version DESC);

CREATE INDEX asset_gallery_asset_reports_asset_idx
  ON asset_gallery.asset_reports (asset_id, created_at DESC);
