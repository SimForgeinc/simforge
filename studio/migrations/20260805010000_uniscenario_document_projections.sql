-- Migration 20260805010000: derived UniScenario document projections for bounded list reads
-- Rollback: drop the summary_* generated columns, dataset_sort_order, deleted_by_user_id,
--           uniscenario_documents_dataset_updated_idx, uniscenario_documents_dataset_sort_idx,
--           and the composite unique constraints after every list query stops reading them.
--           The composite uniques must be dropped LAST: 20260805011000, 20260805012000,
--           20260805013000 and 20260805016000 back their composite foreign keys with these
--           indexes, so DROP CONSTRAINT fails while any of those migrations is still applied.
--           (Dropping the summary_* columns drops uniscenario_drafts_content_tags_idx and
--           uniscenario_drafts_workspace_archetype_idx with them; the two documents indexes
--           above are on pre-existing columns and must be dropped explicitly.)
--
-- Every projection here is STORED GENERATED off uniscenario.drafts.canonical_content, which is
-- the exact JSON covered by drafts.content_sha256. There is deliberately no writable copy of
-- meta.description, meta.tags, meta.archetype, or any count: a second write path could drift
-- from content_sha256 and therefore from every exported .xosc for the same revision.

BEGIN;

ALTER TABLE uniscenario.drafts
  ADD COLUMN IF NOT EXISTS summary_description TEXT
  GENERATED ALWAYS AS (
    NULLIF(BTRIM(COALESCE(canonical_content->'meta'->>'description', '')), '')
  ) STORED;

ALTER TABLE uniscenario.drafts
  ADD COLUMN IF NOT EXISTS summary_archetype TEXT
  GENERATED ALWAYS AS (
    NULLIF(BTRIM(COALESCE(canonical_content->'meta'->>'archetype', '')), '')
  ) STORED;

ALTER TABLE uniscenario.drafts
  ADD COLUMN IF NOT EXISTS summary_author TEXT
  GENERATED ALWAYS AS (
    NULLIF(BTRIM(COALESCE(canonical_content->'meta'->>'author', '')), '')
  ) STORED;

-- The template's own authored tag list. This is content, covered by content_sha256, and is
-- strictly distinct from the organizational catalog added by 20260805011000.
--
-- Projected as JSONB rather than TEXT[] on purpose: a generation expression may not contain a
-- subquery, so `ARRAY(SELECT jsonb_array_elements_text(...))` is rejected by Postgres. The
-- containment operator `summary_content_tags @> '["crash"]'::jsonb` is GIN-indexable and needs
-- no unnesting.
ALTER TABLE uniscenario.drafts
  ADD COLUMN IF NOT EXISTS summary_content_tags JSONB
  GENERATED ALWAYS AS (
    CASE
      WHEN jsonb_typeof(canonical_content->'meta'->'tags') = 'array'
        THEN canonical_content->'meta'->'tags'
      ELSE '[]'::jsonb
    END
  ) STORED;

ALTER TABLE uniscenario.drafts
  ADD COLUMN IF NOT EXISTS summary_role_count INTEGER
  GENERATED ALWAYS AS (
    CASE
      WHEN jsonb_typeof(canonical_content->'roles') = 'array'
        THEN jsonb_array_length(canonical_content->'roles')
      ELSE 0
    END
  ) STORED;

ALTER TABLE uniscenario.drafts
  ADD COLUMN IF NOT EXISTS summary_prop_count INTEGER
  GENERATED ALWAYS AS (
    CASE
      WHEN jsonb_typeof(canonical_content->'props') = 'array'
        THEN jsonb_array_length(canonical_content->'props')
      ELSE 0
    END
  ) STORED;

ALTER TABLE uniscenario.drafts
  ADD COLUMN IF NOT EXISTS summary_variant_count INTEGER
  GENERATED ALWAYS AS (
    CASE
      WHEN jsonb_typeof(canonical_content->'variants') = 'array'
        THEN jsonb_array_length(canonical_content->'variants')
      ELSE 0
    END
  ) STORED;

ALTER TABLE uniscenario.drafts
  ADD COLUMN IF NOT EXISTS summary_clip_seconds DOUBLE PRECISION
  GENERATED ALWAYS AS (
    CASE
      WHEN jsonb_typeof(canonical_content->'choreography'->'clipSeconds') = 'number'
        THEN (canonical_content->'choreography'->>'clipSeconds')::DOUBLE PRECISION
      ELSE NULL
    END
  ) STORED;

ALTER TABLE uniscenario.drafts
  ADD COLUMN IF NOT EXISTS summary_negative_control BOOLEAN
  GENERATED ALWAYS AS (
    CASE
      WHEN jsonb_typeof(canonical_content->'meta'->'negativeControl') = 'boolean'
        THEN (canonical_content->'meta'->>'negativeControl')::BOOLEAN
      ELSE FALSE
    END
  ) STORED;

CREATE INDEX IF NOT EXISTS uniscenario_drafts_content_tags_idx
  ON uniscenario.drafts USING GIN (summary_content_tags);

CREATE INDEX IF NOT EXISTS uniscenario_drafts_workspace_archetype_idx
  ON uniscenario.drafts (workspace_id, summary_archetype, document_id)
  WHERE summary_archetype IS NOT NULL;

-- Cursor pagination for the per-dataset document list is keyed on (updated_at DESC, id DESC).
CREATE INDEX IF NOT EXISTS uniscenario_documents_dataset_updated_idx
  ON uniscenario.documents (workspace_id, dataset_id, updated_at DESC, id DESC)
  WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS uniscenario_documents_dataset_sort_idx
  ON uniscenario.documents (workspace_id, dataset_id, id)
  WHERE deleted_at IS NULL;

ALTER TABLE uniscenario.datasets
  ADD COLUMN IF NOT EXISTS deleted_by_user_id TEXT REFERENCES public.ba_user(id) ON DELETE SET NULL;

ALTER TABLE uniscenario.documents
  ADD COLUMN IF NOT EXISTS dataset_sort_order INTEGER NOT NULL DEFAULT 0;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'uniscenario_documents_dataset_sort_order_check'
      AND conrelid = 'uniscenario.documents'::regclass
  ) THEN
    ALTER TABLE uniscenario.documents
      ADD CONSTRAINT uniscenario_documents_dataset_sort_order_check
      CHECK (dataset_sort_order >= 0);
  END IF;
END $$;

-- Composite (id, workspace_id) uniques so later migrations can carry workspace_id through a
-- composite foreign key instead of trusting application code to re-check tenancy.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'uniscenario_documents_id_workspace_unique'
  ) THEN
    ALTER TABLE uniscenario.documents
      ADD CONSTRAINT uniscenario_documents_id_workspace_unique UNIQUE (id, workspace_id);
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'uniscenario_datasets_id_workspace_unique'
  ) THEN
    ALTER TABLE uniscenario.datasets
      ADD CONSTRAINT uniscenario_datasets_id_workspace_unique UNIQUE (id, workspace_id);
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'uniscenario_revisions_id_workspace_unique'
  ) THEN
    ALTER TABLE uniscenario.revisions
      ADD CONSTRAINT uniscenario_revisions_id_workspace_unique UNIQUE (id, workspace_id);
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'uniscenario_render_jobs_id_workspace_unique'
  ) THEN
    ALTER TABLE uniscenario.render_jobs
      ADD CONSTRAINT uniscenario_render_jobs_id_workspace_unique UNIQUE (id, workspace_id);
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'uniscenario_artifacts_id_workspace_unique'
  ) THEN
    ALTER TABLE uniscenario.artifacts
      ADD CONSTRAINT uniscenario_artifacts_id_workspace_unique UNIQUE (id, workspace_id);
  END IF;
END $$;

COMMIT;
