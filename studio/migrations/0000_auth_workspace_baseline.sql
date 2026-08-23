-- Local subset of the SimCloud identity and map catalog baseline.
-- Better Auth sessions/accounts/invitations, Stripe columns, and cloud fleet tables are omitted.
CREATE TABLE IF NOT EXISTS public.ba_user (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  email TEXT NOT NULL UNIQUE,
  "emailVerified" BOOLEAN NOT NULL DEFAULT TRUE,
  image TEXT,
  "createdAt" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  role TEXT NOT NULL DEFAULT 'owner',
  credits_balance BIGINT NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS public.ba_organization (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  slug TEXT NOT NULL UNIQUE,
  logo TEXT,
  metadata TEXT,
  "createdAt" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  "updatedAt" TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS public.ba_member (
  id TEXT PRIMARY KEY,
  "organizationId" TEXT NOT NULL REFERENCES public.ba_organization(id) ON DELETE CASCADE,
  "userId" TEXT NOT NULL REFERENCES public.ba_user(id) ON DELETE CASCADE,
  role TEXT NOT NULL DEFAULT 'owner',
  "createdAt" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE ("organizationId", "userId")
);

CREATE TABLE IF NOT EXISTS public.workspaces (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL DEFAULT 'personal',
  slug TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  created_by_user_id TEXT REFERENCES public.ba_user(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  credits_balance BIGINT NOT NULL DEFAULT 0,
  deleted_at TIMESTAMPTZ,
  auth_organization_id TEXT NOT NULL UNIQUE REFERENCES public.ba_organization(id)
);

-- Curated public.map_assets catalog with the enrichment projections consumed by the local UI.
CREATE TABLE IF NOT EXISTS public.map_assets (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT,
  crs TEXT NOT NULL DEFAULT 'EPSG:4326',
  bbox_min_lat DOUBLE PRECISION NOT NULL DEFAULT 0,
  bbox_min_lng DOUBLE PRECISION NOT NULL DEFAULT 0,
  bbox_max_lat DOUBLE PRECISION NOT NULL DEFAULT 0,
  bbox_max_lng DOUBLE PRECISION NOT NULL DEFAULT 0,
  center_lat DOUBLE PRECISION NOT NULL DEFAULT 0,
  center_lng DOUBLE PRECISION NOT NULL DEFAULT 0,
  tags JSONB NOT NULL DEFAULT '[]'::jsonb,
  carla_map_name TEXT,
  ue5_carla_map_name TEXT,
  imagery_tilesets JSONB,
  map_source JSONB,
  map_coordinate_ref JSONB,
  place_context JSONB,
  coverage_geojson JSONB,
  metadata_last_populated_at TIMESTAMPTZ,
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS public.map_asset_artifacts (
  id TEXT PRIMARY KEY,
  map_asset_id TEXT NOT NULL REFERENCES public.map_assets(id) ON DELETE CASCADE,
  artifact_type TEXT NOT NULL,
  s3_bucket TEXT NOT NULL,
  s3_key TEXT NOT NULL,
  content_type TEXT,
  size_bytes BIGINT,
  checksum_sha256 TEXT NOT NULL,
  label TEXT,
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (map_asset_id, s3_bucket, s3_key)
);

CREATE TABLE IF NOT EXISTS public.map_asset_stats (
  map_asset_id TEXT PRIMARY KEY REFERENCES public.map_assets(id) ON DELETE CASCADE,
  stats JSONB NOT NULL DEFAULT '{}'::jsonb,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS public.map_asset_enrichments (
  map_asset_id TEXT PRIMARY KEY REFERENCES public.map_assets(id) ON DELETE CASCADE,
  summary_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
