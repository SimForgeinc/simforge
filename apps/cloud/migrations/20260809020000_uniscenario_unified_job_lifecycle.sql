-- Migration 20260809020000: one logical UniScenarios job lifecycle.
--
-- The first convergence migration deliberately keeps exports, validation runs, and render jobs in
-- their existing physical tables.  `uniscenario.operational_jobs` is the common product read model,
-- while `cpu_job_attempts` and `operational_job_events` give validation and post-processing the same
-- fenced attempt/event semantics already used by compilation and rendering.  A later migration may
-- consolidate storage after the old table-specific APIs have drained; callers must use the view and
-- the shared service layer rather than depending on that future physical shape.
--
-- Rollback is safe only after the general CPU runner is stopped and all nonterminal CPU work is
-- drained. Drop the two views, the new tables/indexes, then the added columns.

BEGIN;

ALTER TABLE uniscenario.exports
  ADD COLUMN IF NOT EXISTS priority SMALLINT NOT NULL DEFAULT 0 CHECK (priority BETWEEN -100 AND 100),
  ADD COLUMN IF NOT EXISTS progress DOUBLE PRECISION NOT NULL DEFAULT 0 CHECK (progress BETWEEN 0 AND 1),
  ADD COLUMN IF NOT EXISTS cancel_requested_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS requested_by_user_id TEXT REFERENCES public.ba_user(id) ON DELETE SET NULL;

ALTER TABLE uniscenario.validation_runs
  ADD COLUMN IF NOT EXISTS priority SMALLINT NOT NULL DEFAULT 0 CHECK (priority BETWEEN -100 AND 100),
  ADD COLUMN IF NOT EXISTS attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  ADD COLUMN IF NOT EXISTS max_attempts INTEGER NOT NULL DEFAULT 3 CHECK (max_attempts BETWEEN 1 AND 20),
  ADD COLUMN IF NOT EXISTS progress DOUBLE PRECISION NOT NULL DEFAULT 0 CHECK (progress BETWEEN 0 AND 1),
  ADD COLUMN IF NOT EXISTS cancel_requested_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS failure_code TEXT,
  ADD COLUMN IF NOT EXISTS failure_detail JSONB,
  ADD COLUMN IF NOT EXISTS requested_by_user_id TEXT REFERENCES public.ba_user(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW();

CREATE INDEX IF NOT EXISTS uniscenario_validation_runs_claim_idx
  ON uniscenario.validation_runs (priority DESC, created_at, id)
  WHERE validation_state = 'queued' AND cancel_requested_at IS NULL;

CREATE TABLE IF NOT EXISTS uniscenario.cpu_job_attempts (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  job_family TEXT NOT NULL CHECK (job_family IN ('openscenario_validate', 'artifact_postprocess')),
  job_id TEXT NOT NULL,
  attempt_number INTEGER NOT NULL CHECK (attempt_number > 0),
  worker_id TEXT NOT NULL,
  fence_token_sha256 TEXT NOT NULL CHECK (fence_token_sha256 ~ '^[a-f0-9]{64}$'),
  attempt_state TEXT NOT NULL DEFAULT 'active'
    CHECK (attempt_state IN ('active', 'succeeded', 'failed', 'expired', 'cancelled')),
  progress DOUBLE PRECISION NOT NULL DEFAULT 0 CHECK (progress BETWEEN 0 AND 1),
  leased_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  heartbeat_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at TIMESTAMPTZ NOT NULL,
  completed_at TIMESTAMPTZ,
  failure_code TEXT,
  failure_detail JSONB,
  UNIQUE (job_family, job_id, attempt_number),
  UNIQUE (fence_token_sha256)
);

CREATE UNIQUE INDEX IF NOT EXISTS uniscenario_cpu_job_attempts_one_active_idx
  ON uniscenario.cpu_job_attempts (job_family, job_id)
  WHERE attempt_state = 'active';

CREATE INDEX IF NOT EXISTS uniscenario_cpu_job_attempts_worker_idx
  ON uniscenario.cpu_job_attempts (worker_id, heartbeat_at DESC);

CREATE TABLE IF NOT EXISTS uniscenario.operational_job_events (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  job_family TEXT NOT NULL CHECK (
    job_family IN ('openscenario_compile', 'openscenario_validate', 'artifact_postprocess')
  ),
  job_id TEXT NOT NULL,
  attempt_id TEXT,
  event_ordinal BIGINT NOT NULL CHECK (event_ordinal > 0),
  event_type TEXT NOT NULL,
  event_payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  occurred_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (job_family, job_id, event_ordinal)
);

CREATE INDEX IF NOT EXISTS uniscenario_operational_job_events_job_idx
  ON uniscenario.operational_job_events (workspace_id, job_family, job_id, event_ordinal);

ALTER TABLE uniscenario.artifacts
  ADD COLUMN IF NOT EXISTS producer_job_family TEXT,
  ADD COLUMN IF NOT EXISTS producer_job_id TEXT,
  ADD COLUMN IF NOT EXISTS producer_attempt_id TEXT,
  ADD COLUMN IF NOT EXISTS provenance JSONB NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS authorization_scope TEXT NOT NULL DEFAULT 'workspace';

ALTER TABLE uniscenario.artifacts
  DROP CONSTRAINT IF EXISTS uniscenario_artifacts_producer_closure_check,
  ADD CONSTRAINT uniscenario_artifacts_producer_closure_check CHECK (
    (producer_job_family IS NULL AND producer_job_id IS NULL)
    OR (producer_job_family IN (
      'openscenario_compile', 'openscenario_validate', 'openscenario_render', 'artifact_postprocess'
    ) AND NULLIF(BTRIM(producer_job_id), '') IS NOT NULL)
  ),
  DROP CONSTRAINT IF EXISTS uniscenario_artifacts_provenance_object_check,
  ADD CONSTRAINT uniscenario_artifacts_provenance_object_check
    CHECK (jsonb_typeof(provenance) = 'object'),
  DROP CONSTRAINT IF EXISTS uniscenario_artifacts_authorization_scope_check,
  ADD CONSTRAINT uniscenario_artifacts_authorization_scope_check
    CHECK (authorization_scope = 'workspace');

CREATE INDEX IF NOT EXISTS uniscenario_artifacts_producer_idx
  ON uniscenario.artifacts (workspace_id, producer_job_family, producer_job_id, created_at DESC)
  WHERE producer_job_id IS NOT NULL AND deleted_at IS NULL;

CREATE TABLE IF NOT EXISTS uniscenario.operational_job_artifact_links (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  artifact_id TEXT NOT NULL REFERENCES uniscenario.artifacts(id) ON DELETE CASCADE,
  job_family TEXT NOT NULL CHECK (
    job_family IN ('openscenario_compile', 'openscenario_validate', 'artifact_postprocess')
  ),
  job_id TEXT NOT NULL,
  attempt_id TEXT,
  relationship TEXT NOT NULL CHECK (relationship IN ('output', 'report', 'provenance')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (artifact_id, job_family, job_id, attempt_id, relationship)
);

CREATE INDEX IF NOT EXISTS uniscenario_operational_job_artifact_links_job_idx
  ON uniscenario.operational_job_artifact_links
    (workspace_id, job_family, job_id, created_at, artifact_id);

CREATE OR REPLACE VIEW uniscenario.operational_jobs AS
SELECT e.id,
       'openscenario_compile'::TEXT AS job_family,
       e.workspace_id,
       e.revision_id,
       e.export_format::TEXT AS job_type,
       e.export_state::TEXT AS state,
       e.priority::INTEGER AS priority,
       e.progress::DOUBLE PRECISION AS progress,
       e.attempt_count,
       e.max_attempts,
       e.idempotency_key,
       e.requested_by_user_id,
       e.cancel_requested_at,
       e.error_code AS failure_code,
       e.error_detail AS failure_detail,
       e.created_at,
       e.updated_at,
       e.started_at,
       e.completed_at
  FROM uniscenario.exports e
UNION ALL
SELECT v.id,
       'openscenario_validate'::TEXT,
       v.workspace_id,
       v.revision_id,
       v.validator_kind::TEXT,
       CASE WHEN v.validation_state = 'passed' THEN 'succeeded' ELSE v.validation_state END,
       v.priority::INTEGER,
       v.progress::DOUBLE PRECISION,
       v.attempt_count,
       v.max_attempts,
       v.idempotency_key,
       v.requested_by_user_id,
       v.cancel_requested_at,
       v.failure_code,
       v.failure_detail,
       v.created_at,
       v.updated_at,
       v.started_at,
       v.completed_at
  FROM uniscenario.validation_runs v
UNION ALL
SELECT j.id,
       CASE WHEN j.job_mode IN ('cosmos_augment', 'vlm_annotate')
         THEN 'artifact_postprocess'::TEXT ELSE 'openscenario_render'::TEXT END,
       j.workspace_id,
       j.revision_id,
       j.job_mode::TEXT,
       j.job_state::TEXT,
       j.priority::INTEGER,
       j.progress::DOUBLE PRECISION,
       j.attempt_count,
       j.max_attempts,
       j.idempotency_key,
       j.requested_by_user_id,
       j.cancel_requested_at,
       j.failure_code,
       j.failure_detail,
       j.created_at,
       j.updated_at,
       j.started_at,
       j.completed_at
  FROM uniscenario.render_jobs j;

CREATE OR REPLACE VIEW uniscenario.operational_job_attempts AS
SELECT a.id,
       'openscenario_compile'::TEXT AS job_family,
       a.workspace_id,
       a.export_id AS job_id,
       a.attempt_number,
       a.worker_id,
       a.attempt_state::TEXT AS state,
       0::DOUBLE PRECISION AS progress,
       a.leased_at,
       a.heartbeat_at,
       a.expires_at,
       a.completed_at,
       a.failure_code,
       a.failure_detail
  FROM uniscenario.export_attempts a
UNION ALL
SELECT a.id, a.job_family, a.workspace_id, a.job_id, a.attempt_number, a.worker_id,
       a.attempt_state, a.progress, a.leased_at, a.heartbeat_at, a.expires_at,
       a.completed_at, a.failure_code, a.failure_detail
  FROM uniscenario.cpu_job_attempts a
UNION ALL
SELECT a.id,
       CASE WHEN j.job_mode IN ('cosmos_augment', 'vlm_annotate')
         THEN 'artifact_postprocess'::TEXT ELSE 'openscenario_render'::TEXT END,
       a.workspace_id,
       a.render_job_id,
       a.attempt_number,
       a.worker_node_id,
       a.attempt_state::TEXT,
       0::DOUBLE PRECISION,
       a.leased_at,
       COALESCE(l.heartbeat_at, a.leased_at),
       COALESCE(l.expires_at, a.completed_at, a.leased_at),
       a.completed_at,
       NULL::TEXT,
       a.metrics
  FROM uniscenario.render_attempts a
  JOIN uniscenario.render_jobs j ON j.id = a.render_job_id
  LEFT JOIN uniscenario.worker_leases l ON l.render_attempt_id = a.id;

COMMIT;
