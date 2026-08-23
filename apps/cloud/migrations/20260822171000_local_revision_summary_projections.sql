BEGIN;

-- local-synthesized: current review/document queries read immutable revision
-- summaries, while the tracked upstream projection migration only adds them to drafts.
ALTER TABLE uniscenario.revisions
  ADD COLUMN IF NOT EXISTS summary_description TEXT
  GENERATED ALWAYS AS (
    NULLIF(BTRIM(COALESCE(canonical_content->'meta'->>'description', '')), '')
  ) STORED;

ALTER TABLE uniscenario.revisions
  ADD COLUMN IF NOT EXISTS summary_archetype TEXT
  GENERATED ALWAYS AS (
    NULLIF(BTRIM(COALESCE(canonical_content->'meta'->>'archetype', '')), '')
  ) STORED;

ALTER TABLE uniscenario.revisions
  ADD COLUMN IF NOT EXISTS summary_content_tags JSONB
  GENERATED ALWAYS AS (
    CASE
      WHEN jsonb_typeof(canonical_content->'meta'->'tags') = 'array'
        THEN canonical_content->'meta'->'tags'
      ELSE '[]'::jsonb
    END
  ) STORED;

COMMIT;
