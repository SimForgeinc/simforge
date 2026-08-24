-- Migration 20260805016000: Cosmos augmentation and VLM annotation as UniScenario job modes
-- Rollback: restore uniscenario_render_jobs_mode_check to ('interaction_2d','full_render'), drop
--           parent_render_job_id, source_artifact_id, model_family, model_config,
--           model_config_sha256, and drop uniscenario_render_jobs_mode_claim_idx after every
--           postprocess job is drained. (Dropping the five columns takes
--           uniscenario_render_jobs_postprocess_closure_check, both new foreign keys and
--           uniscenario_render_jobs_parent_idx with them; the mode-claim index is on pre-existing
--           columns and survives, so it must be dropped explicitly.)
--
-- Cosmos and VLM are LIVE in v1, not vestigial: cosmos_jobs carries runpod_job_id, model_family,
-- progress_pct, gpu_memory_used_mb and cost_cents; RunPod handlers exist under
-- docker/runpod-model-services/handlers/cosmos-reason2-{prediction,sft}/handler.py; and both feed
-- the dataset browse counters. So they must be replicated — but reshaped, not copied.
--
-- Copying v1's cosmos_jobs table would rebuild leasing, heartbeats, progress and artifact binding
-- that the v2 control plane already does better (fenced worker_leases, ordinal job_events,
-- expected_sha256-bound uploads, the artifact cleanup outbox). A postprocess run is a render job
-- with a different mode, a parent job, an input artifact and a hashed model config.
--
-- TWO FOLLOW-ONS THIS MIGRATION DELIBERATELY DOES NOT TOUCH — both are real and still open:
--
--   (a) uniscenario_render_jobs_free_check, added by 20260804020000, is
--       CHECK (billing_mode = 'free' AND estimated_cost_cents = 0). It is unconditional, so a
--       Cosmos job on a paid provider CANNOT be inserted with a real cost. v1's
--       cosmos_jobs.cost_cents was populated. That check must be relaxed to something like
--       "free implies zero cost" before any paid postprocess provider is enabled. Not done here
--       because relaxing a billing invariant is a billing decision, not a schema one.
--
--   (b) uniscenario.worker_nodes.capabilities has no key describing these modes, and
--       uniscenario_render_jobs_claim_idx does not include job_mode. Until the lease query filters
--       on a declared capability, a CARLA render worker can lease a cosmos_augment job. The
--       supporting index is added below so that filter is cheap when it lands, but the lease query
--       itself is untouched.

BEGIN;

ALTER TABLE uniscenario.render_jobs
  ADD COLUMN IF NOT EXISTS parent_render_job_id TEXT,
  ADD COLUMN IF NOT EXISTS source_artifact_id TEXT,
  ADD COLUMN IF NOT EXISTS model_family TEXT,
  ADD COLUMN IF NOT EXISTS model_config JSONB,
  ADD COLUMN IF NOT EXISTS model_config_sha256 TEXT;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'uniscenario_render_jobs_parent_fk'
      AND conrelid = 'uniscenario.render_jobs'::regclass
  ) THEN
    ALTER TABLE uniscenario.render_jobs
      ADD CONSTRAINT uniscenario_render_jobs_parent_fk
      FOREIGN KEY (parent_render_job_id, workspace_id)
      REFERENCES uniscenario.render_jobs(id, workspace_id)
      DEFERRABLE INITIALLY DEFERRED;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'uniscenario_render_jobs_source_artifact_fk'
      AND conrelid = 'uniscenario.render_jobs'::regclass
  ) THEN
    ALTER TABLE uniscenario.render_jobs
      ADD CONSTRAINT uniscenario_render_jobs_source_artifact_fk
      FOREIGN KEY (source_artifact_id, workspace_id)
      REFERENCES uniscenario.artifacts(id, workspace_id) ON DELETE RESTRICT;
  END IF;
END $$;

-- Widen the mode enum. Replacing the constraint rather than adding a second one keeps a single
-- authoritative list of legal modes.
ALTER TABLE uniscenario.render_jobs
  DROP CONSTRAINT IF EXISTS uniscenario_render_jobs_mode_check,
  ADD CONSTRAINT uniscenario_render_jobs_mode_check
    CHECK (job_mode IN ('interaction_2d', 'full_render', 'cosmos_augment', 'vlm_annotate'));

-- Per-mode closure: simulation modes carry NONE of the postprocess columns, and postprocess modes
-- carry ALL of them. There is no half-specified job, and no simulation job silently holding a
-- model config that nothing reads.
ALTER TABLE uniscenario.render_jobs
  DROP CONSTRAINT IF EXISTS uniscenario_render_jobs_postprocess_closure_check,
  ADD CONSTRAINT uniscenario_render_jobs_postprocess_closure_check
    CHECK (
      (job_mode IN ('interaction_2d', 'full_render')
        AND parent_render_job_id IS NULL
        AND source_artifact_id IS NULL
        AND model_family IS NULL
        AND model_config IS NULL
        AND model_config_sha256 IS NULL)
      OR
      (job_mode IN ('cosmos_augment', 'vlm_annotate')
        AND parent_render_job_id IS NOT NULL
        AND parent_render_job_id <> id
        AND source_artifact_id IS NOT NULL
        AND char_length(BTRIM(model_family)) > 0
        AND jsonb_typeof(model_config) = 'object'
        AND model_config_sha256 ~ '^[a-f0-9]{64}$')
    );

CREATE INDEX IF NOT EXISTS uniscenario_render_jobs_parent_idx
  ON uniscenario.render_jobs (workspace_id, parent_render_job_id, job_mode, created_at DESC)
  WHERE parent_render_job_id IS NOT NULL;

-- Supports the capability-filtered lease query described in follow-on (b) above.
CREATE INDEX IF NOT EXISTS uniscenario_render_jobs_mode_claim_idx
  ON uniscenario.render_jobs (job_mode, priority DESC, created_at, id)
  WHERE job_state = 'queued' AND cancel_requested_at IS NULL;

COMMIT;
