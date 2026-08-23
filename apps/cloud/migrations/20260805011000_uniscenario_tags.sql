-- Migration 20260805011000: workspace-scoped organizational tags for UniScenario documents
-- Rollback: drop uniscenario.dataset_view_preferences, uniscenario.document_tags,
--           and uniscenario.tags after the list UI stops reading them.
--
-- Two deliberate departures from the v1 shape:
--
-- 1. The catalog is scoped to the WORKSPACE, not the dataset. v1 re-seeded the same four defaults
--    into every dataset, which made "show me every crash" impossible across datasets. Per-dataset
--    filtering survives by joining document_tags to documents.dataset_id.
--
-- 2. These are organizational labels and are strictly separate from the template's authored
--    `meta.tags`, which lives inside drafts.canonical_content and is covered by content_sha256
--    (projected read-only as drafts.summary_content_tags by 20260805010000). Renaming or
--    recolouring an organizational tag must never change a document digest, so nothing here is
--    ever written back into canonical_content.

BEGIN;

CREATE TABLE IF NOT EXISTS uniscenario.tags (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  slug TEXT NOT NULL CHECK (slug ~ '^[a-z0-9][a-z0-9-]{0,62}$'),
  label TEXT NOT NULL CHECK (char_length(BTRIM(label)) BETWEEN 1 AND 64),
  color TEXT CHECK (color IS NULL OR color ~ '^#[0-9a-f]{6}$'),
  is_system_default BOOLEAN NOT NULL DEFAULT FALSE,
  created_by_user_id TEXT REFERENCES public.ba_user(id) ON DELETE SET NULL,
  updated_by_user_id TEXT REFERENCES public.ba_user(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  deleted_at TIMESTAMPTZ,
  UNIQUE (workspace_id, slug),
  UNIQUE (id, workspace_id)
);

CREATE INDEX IF NOT EXISTS uniscenario_tags_workspace_label_idx
  ON uniscenario.tags (workspace_id, label, id)
  WHERE deleted_at IS NULL;

CREATE TABLE IF NOT EXISTS uniscenario.document_tags (
  workspace_id TEXT NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  document_id TEXT NOT NULL,
  tag_id TEXT NOT NULL,
  assigned_by_user_id TEXT REFERENCES public.ba_user(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (document_id, tag_id),
  FOREIGN KEY (document_id, workspace_id)
    REFERENCES uniscenario.documents(id, workspace_id) ON DELETE CASCADE,
  FOREIGN KEY (tag_id, workspace_id)
    REFERENCES uniscenario.tags(id, workspace_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS uniscenario_document_tags_tag_idx
  ON uniscenario.document_tags (workspace_id, tag_id, document_id);

CREATE INDEX IF NOT EXISTS uniscenario_document_tags_document_idx
  ON uniscenario.document_tags (workspace_id, document_id, tag_id);

-- Seed v1's four defaults once per workspace. Replay-safe and non-destructive: a workspace that
-- has renamed or deleted one of these keeps its own version, because the conflict target is the
-- workspace-scoped slug.
INSERT INTO uniscenario.tags (id, workspace_id, slug, label, color, is_system_default)
SELECT
  'ustag_' || md5(w.id || ':' || seed.slug),
  w.id,
  seed.slug,
  seed.label,
  seed.color,
  TRUE
FROM public.workspaces w
CROSS JOIN (VALUES
  ('variation', 'Variation', '#38bdf8'),
  ('crash', 'Crash', '#ef4444'),
  ('near-miss', 'Near-miss', '#f59e0b'),
  ('nominal', 'Nominal', '#22c55e')
) AS seed(slug, label, color)
WHERE w.deleted_at IS NULL
ON CONFLICT (workspace_id, slug) DO NOTHING;

-- §11 q6 is still open: server-side filter state vs per-device localStorage. Kept additive and
-- trivially droppable — nothing else references this table, and no column is NOT NULL without a
-- default, so `DROP TABLE uniscenario.dataset_view_preferences` is the entire rollback.
CREATE TABLE IF NOT EXISTS uniscenario.dataset_view_preferences (
  workspace_id TEXT NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES public.ba_user(id) ON DELETE CASCADE,
  dataset_id TEXT NOT NULL,
  preferences JSONB NOT NULL DEFAULT '{}'::jsonb,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (user_id, dataset_id),
  CHECK (jsonb_typeof(preferences) = 'object'),
  FOREIGN KEY (dataset_id, workspace_id)
    REFERENCES uniscenario.datasets(id, workspace_id) ON DELETE CASCADE
);

COMMIT;
