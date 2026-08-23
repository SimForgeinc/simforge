-- Migration 20260820160000: asset gallery generation jobs (reference photos -> 3D model)
-- migration-impact: contract
-- Rollback: DROP TABLE asset_gallery.generation_jobs; then
--   ALTER TABLE asset_gallery.assets DROP CONSTRAINT asset_gallery_assets_removed_check,
--   DROP COLUMN removed_by_user_id, DROP COLUMN removed_at.
--
-- Generating a gallery asset from reference photographs.
--
-- The provider (Meshy) takes minutes per model, which is longer than a request,
-- so the work has to survive the tab that started it. This table is the durable
-- record: it owns the reference-image object keys before the bytes are uploaded,
-- holds the provider task id across polls, and ends by pointing at the gallery
-- asset it produced. It is deliberately separate from `asset_gallery.assets`
-- because a generation that fails must leave no asset behind, and an asset that
-- exists must be indistinguishable from an uploaded one.

CREATE TABLE IF NOT EXISTS asset_gallery.generation_jobs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  state TEXT NOT NULL DEFAULT 'draft',
  title TEXT NOT NULL,
  description TEXT,
  actor_class TEXT NOT NULL,
  texture_prompt TEXT,
  -- Reference images, in author order: the first is the primary (front) view.
  -- Each element is {key, sha256, byteLength, mediaType}; the bucket is shared
  -- with the rest of the gallery and recorded once.
  source_bucket TEXT NOT NULL,
  images JSONB NOT NULL,
  -- Parameters actually sent to the provider, kept for reproducing a result
  -- after we change our defaults.
  request JSONB NOT NULL DEFAULT '{}'::JSONB,
  provider TEXT NOT NULL DEFAULT 'meshy',
  provider_task_id TEXT,
  progress INTEGER NOT NULL DEFAULT 0,
  -- Provider preview, usable in the UI before our own thumbnail exists. Held as
  -- a URL string because provider URLs are short-lived and re-fetched.
  preview_url TEXT,
  -- One of the named reasons in generation-contracts.ts, never provider text.
  failure_code TEXT,
  -- Full provider error for operators; never returned to a client.
  provider_error TEXT,
  asset_id UUID REFERENCES asset_gallery.assets(id) ON DELETE SET NULL,
  created_by_user_id TEXT NOT NULL,
  created_by_workspace_id TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  submitted_at TIMESTAMPTZ,
  finished_at TIMESTAMPTZ,
  -- Guards the import step: whoever sets this owns the download/publish pass, so
  -- two concurrent pollers cannot both publish the same model.
  import_lease_until TIMESTAMPTZ
);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'asset_gallery_generation_state_check'
  ) THEN
    ALTER TABLE asset_gallery.generation_jobs
      ADD CONSTRAINT asset_gallery_generation_state_check CHECK (
        state IN ('draft', 'generating', 'importing', 'ready', 'failed', 'cancelled')
      );
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'asset_gallery_generation_actor_class_check'
  ) THEN
    ALTER TABLE asset_gallery.generation_jobs
      ADD CONSTRAINT asset_gallery_generation_actor_class_check CHECK (
        actor_class IN ('static_object', 'animal', 'sidewalk_robot', 'drone', 'pedestrian', 'vehicle')
      );
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'asset_gallery_generation_title_check'
  ) THEN
    ALTER TABLE asset_gallery.generation_jobs
      ADD CONSTRAINT asset_gallery_generation_title_check CHECK (char_length(title) BETWEEN 1 AND 120);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'asset_gallery_generation_progress_check'
  ) THEN
    ALTER TABLE asset_gallery.generation_jobs
      ADD CONSTRAINT asset_gallery_generation_progress_check CHECK (progress BETWEEN 0 AND 100);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'asset_gallery_generation_images_check'
  ) THEN
    ALTER TABLE asset_gallery.generation_jobs
      ADD CONSTRAINT asset_gallery_generation_images_check CHECK (
        jsonb_typeof(images) = 'array' AND jsonb_array_length(images) BETWEEN 1 AND 4
      );
  END IF;

  -- A ready generation must name what it produced; a failed one must say why.
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'asset_gallery_generation_ready_check'
  ) THEN
    ALTER TABLE asset_gallery.generation_jobs
      ADD CONSTRAINT asset_gallery_generation_ready_check CHECK (
        state <> 'ready' OR asset_id IS NOT NULL
      );
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'asset_gallery_generation_failed_check'
  ) THEN
    ALTER TABLE asset_gallery.generation_jobs
      ADD CONSTRAINT asset_gallery_generation_failed_check CHECK (
        state <> 'failed' OR failure_code IS NOT NULL
      );
  END IF;
END
$$;

-- The author's own recent generations, newest first: this drives the progress
-- list and the resume-on-load sweep.
CREATE INDEX IF NOT EXISTS asset_gallery_generations_by_user_idx
  ON asset_gallery.generation_jobs (created_by_user_id, created_at DESC, id DESC);

-- Unfinished work needing a poll. Partial so the scan stays proportional to
-- what is actually in flight rather than to everything ever generated.
CREATE INDEX IF NOT EXISTS asset_gallery_generations_live_idx
  ON asset_gallery.generation_jobs (updated_at)
  WHERE state IN ('generating', 'importing');

-- Deletion is open to any signed-in user, so record who did it. Soft delete
-- already keeps the row; without this the gallery could not answer "who removed
-- this and when", which is the minimum an open moderation policy needs.
ALTER TABLE asset_gallery.assets ADD COLUMN IF NOT EXISTS removed_by_user_id TEXT;
ALTER TABLE asset_gallery.assets ADD COLUMN IF NOT EXISTS removed_at TIMESTAMPTZ;

-- Assets soft-deleted before this migration have no removal timestamp, and the
-- constraint below would reject them. `updated_at` is when the delete ran, so it
-- is the honest backfill; the actor is genuinely unknown and stays NULL.
UPDATE asset_gallery.assets
SET removed_at = updated_at
WHERE status = 'removed' AND removed_at IS NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'asset_gallery_assets_removed_check'
  ) THEN
    ALTER TABLE asset_gallery.assets
      ADD CONSTRAINT asset_gallery_assets_removed_check CHECK (
        status <> 'removed' OR removed_at IS NOT NULL
      );
  END IF;
END
$$;
