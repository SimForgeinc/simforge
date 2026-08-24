-- Migration 20260804020000: permanent UniScenario product flow.
-- This schema is intentionally independent of public datasets, scenarios, CARLA jobs, and billing.

BEGIN;

CREATE TABLE IF NOT EXISTS uniscenario.datasets (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  name TEXT NOT NULL CHECK (char_length(name) BETWEEN 1 AND 200),
  description TEXT,
  created_by_user_id TEXT REFERENCES public.ba_user(id) ON DELETE SET NULL,
  updated_by_user_id TEXT REFERENCES public.ba_user(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  deleted_at TIMESTAMPTZ,
  UNIQUE (workspace_id, name)
);

CREATE INDEX IF NOT EXISTS uniscenario_datasets_workspace_updated_idx
  ON uniscenario.datasets (workspace_id, updated_at DESC, id)
  WHERE deleted_at IS NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'uniscenario_dataset_items_dataset_fk'
      AND conrelid = 'uniscenario.dataset_items'::regclass
  ) THEN
    ALTER TABLE uniscenario.dataset_items
      ADD CONSTRAINT uniscenario_dataset_items_dataset_fk
      FOREIGN KEY (dataset_id) REFERENCES uniscenario.datasets(id) ON DELETE CASCADE;
  END IF;
END $$;

ALTER TABLE uniscenario.documents
  ADD COLUMN IF NOT EXISTS dataset_id TEXT REFERENCES uniscenario.datasets(id) ON DELETE RESTRICT;

INSERT INTO uniscenario.datasets (id, workspace_id, name, description)
SELECT
  'usds_migrated_' || md5(d.workspace_id),
  d.workspace_id,
  'Imported UniScenarios',
  'Created by the UniScenario v2 product-flow migration.'
FROM uniscenario.documents d
WHERE d.dataset_id IS NULL
GROUP BY d.workspace_id
ON CONFLICT (workspace_id, name) DO NOTHING;

UPDATE uniscenario.documents d
SET dataset_id = ds.id
FROM uniscenario.datasets ds
WHERE d.dataset_id IS NULL
  AND ds.workspace_id = d.workspace_id
  AND ds.name = 'Imported UniScenarios';

ALTER TABLE uniscenario.documents
  ALTER COLUMN dataset_id SET NOT NULL;

ALTER TABLE uniscenario.drafts
  ADD COLUMN IF NOT EXISTS authoring_quality_id TEXT;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'uniscenario_drafts_authoring_quality_check'
      AND conrelid = 'uniscenario.drafts'::regclass
  ) THEN
    ALTER TABLE uniscenario.drafts
      ADD CONSTRAINT uniscenario_drafts_authoring_quality_check
      CHECK (authoring_quality_id IS NULL OR authoring_quality_id IN (
        'roads-only', 'ultra-low-3d', 'minimal', 'high'
      ));
  END IF;
END $$;

ALTER TABLE uniscenario.execution_packages
  ADD COLUMN IF NOT EXISTS traffic_mode TEXT NOT NULL DEFAULT 'disabled',
  ADD COLUMN IF NOT EXISTS sumo_version TEXT,
  ADD COLUMN IF NOT EXISTS sumo_network_sha256 TEXT,
  ADD COLUMN IF NOT EXISTS traffic_seed TEXT,
  ADD COLUMN IF NOT EXISTS traffic_config JSONB NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS traffic_config_sha256 TEXT,
  ADD COLUMN IF NOT EXISTS materialized_traffic_artifact_id TEXT REFERENCES uniscenario.artifacts(id) ON DELETE RESTRICT,
  ADD COLUMN IF NOT EXISTS materialized_traffic_sha256 TEXT;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'uniscenario_execution_packages_traffic_mode_check'
      AND conrelid = 'uniscenario.execution_packages'::regclass
  ) THEN
    ALTER TABLE uniscenario.execution_packages
      ADD CONSTRAINT uniscenario_execution_packages_traffic_mode_check
      CHECK (traffic_mode IN ('disabled', 'native', 'sumo'));
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'uniscenario_execution_packages_sumo_closure_check'
      AND conrelid = 'uniscenario.execution_packages'::regclass
  ) THEN
    ALTER TABLE uniscenario.execution_packages
      ADD CONSTRAINT uniscenario_execution_packages_sumo_closure_check
      CHECK (
        traffic_mode <> 'sumo' OR (
          sumo_version IS NOT NULL AND
          sumo_network_sha256 ~ '^[a-f0-9]{64}$' AND
          traffic_seed IS NOT NULL AND
          traffic_config_sha256 ~ '^[a-f0-9]{64}$' AND
          materialized_traffic_artifact_id IS NOT NULL AND
          materialized_traffic_sha256 ~ '^[a-f0-9]{64}$'
        )
      );
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'uniscenario_execution_packages_traffic_config_object_check'
      AND conrelid = 'uniscenario.execution_packages'::regclass
  ) THEN
    ALTER TABLE uniscenario.execution_packages
      ADD CONSTRAINT uniscenario_execution_packages_traffic_config_object_check
      CHECK (jsonb_typeof(traffic_config) = 'object');
  END IF;
END $$;

ALTER TABLE uniscenario.render_jobs
  ADD COLUMN IF NOT EXISTS job_mode TEXT NOT NULL DEFAULT 'full_render',
  ADD COLUMN IF NOT EXISTS billing_mode TEXT NOT NULL DEFAULT 'free',
  ADD COLUMN IF NOT EXISTS estimated_cost_cents BIGINT NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS telemetry JSONB NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS parity_result JSONB,
  ADD COLUMN IF NOT EXISTS worker_attestation JSONB;

ALTER TABLE uniscenario.render_jobs
  ADD COLUMN IF NOT EXISTS progress DOUBLE PRECISION NOT NULL DEFAULT 0;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'uniscenario_render_jobs_mode_check'
      AND conrelid = 'uniscenario.render_jobs'::regclass
  ) THEN
    ALTER TABLE uniscenario.render_jobs
      ADD CONSTRAINT uniscenario_render_jobs_mode_check
      CHECK (job_mode IN ('interaction_2d', 'full_render'));
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'uniscenario_render_jobs_free_check'
      AND conrelid = 'uniscenario.render_jobs'::regclass
  ) THEN
    ALTER TABLE uniscenario.render_jobs
      ADD CONSTRAINT uniscenario_render_jobs_free_check
      CHECK (billing_mode = 'free' AND estimated_cost_cents = 0);
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'uniscenario_render_jobs_telemetry_object_check'
      AND conrelid = 'uniscenario.render_jobs'::regclass
  ) THEN
    ALTER TABLE uniscenario.render_jobs
      ADD CONSTRAINT uniscenario_render_jobs_telemetry_object_check
      CHECK (jsonb_typeof(telemetry) = 'object');
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'uniscenario_render_jobs_progress_check'
      AND conrelid = 'uniscenario.render_jobs'::regclass
  ) THEN
    ALTER TABLE uniscenario.render_jobs
      ADD CONSTRAINT uniscenario_render_jobs_progress_check
      CHECK (progress BETWEEN 0 AND 1);
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS uniscenario_render_jobs_workspace_active_idx
  ON uniscenario.render_jobs (workspace_id, job_mode, created_at)
  WHERE job_state IN ('queued', 'leased', 'running');

COMMIT;
