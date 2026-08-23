-- migration-impact: contract

CREATE TABLE uniscenario.map_upload_drafts (
  id TEXT PRIMARY KEY CHECK (id ~ '^usmapdraft_[a-f0-9]{32}$'),
  workspace_id TEXT NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  created_by_user_id TEXT REFERENCES public.ba_user(id) ON DELETE SET NULL,
  label TEXT NOT NULL CHECK (char_length(BTRIM(label)) BETWEEN 3 AND 120),
  locality TEXT NOT NULL CHECK (char_length(BTRIM(locality)) BETWEEN 2 AND 120),
  carla_map_name TEXT,
  source_map_id TEXT NOT NULL UNIQUE,
  xodr_sha256 TEXT NOT NULL CHECK (xodr_sha256 ~ '^[a-f0-9]{64}$'),
  xodr_byte_length BIGINT NOT NULL CHECK (xodr_byte_length > 0),
  thumbnail_sha256 TEXT NOT NULL CHECK (thumbnail_sha256 ~ '^[a-f0-9]{64}$'),
  thumbnail_byte_length BIGINT NOT NULL CHECK (thumbnail_byte_length > 0),
  layers JSONB NOT NULL CHECK (jsonb_typeof(layers) = 'array'),
  preflight JSONB NOT NULL CHECK (jsonb_typeof(preflight) = 'object'),
  draft_state TEXT NOT NULL DEFAULT 'pending'
    CHECK (draft_state IN ('pending', 'publishing', 'published', 'failed')),
  failure_reason TEXT,
  map_version_id TEXT REFERENCES uniscenario.map_versions(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX map_upload_drafts_workspace_created_idx
  ON uniscenario.map_upload_drafts (workspace_id, created_at DESC, id DESC);

CREATE INDEX map_upload_drafts_workspace_state_idx
  ON uniscenario.map_upload_drafts (workspace_id, draft_state, updated_at DESC);
