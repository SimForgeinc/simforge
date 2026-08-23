-- Local subset of 20260809023000_canonical_artifact_postprocess_jobs.sql.
-- Legacy dataset-export and pipeline reconciliation tables are intentionally absent locally.
BEGIN;

CREATE TABLE IF NOT EXISTS uniscenario.artifact_postprocess_jobs (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  revision_id TEXT REFERENCES uniscenario.revisions(id) ON DELETE RESTRICT,
  postprocess_kind TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'queued' CHECK (state IN ('queued', 'running', 'succeeded', 'failed', 'cancelled')),
  phase TEXT NOT NULL DEFAULT 'queued',
  priority SMALLINT NOT NULL DEFAULT 0 CHECK (priority BETWEEN -100 AND 100),
  progress DOUBLE PRECISION NOT NULL DEFAULT 0 CHECK (progress BETWEEN 0 AND 1),
  attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  max_attempts INTEGER NOT NULL DEFAULT 100 CHECK (max_attempts BETWEEN 1 AND 1000),
  idempotency_key TEXT,
  correlation_id TEXT,
  requested_by_user_id TEXT REFERENCES public.ba_user(id) ON DELETE SET NULL,
  request_payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  result_payload JSONB,
  failure_code TEXT,
  failure_detail JSONB,
  cancel_requested_at TIMESTAMPTZ,
  cancel_reason TEXT,
  dataset_id TEXT,
  dataset_snapshot_id TEXT,
  pipeline_run_id TEXT,
  format TEXT,
  recipe TEXT,
  scope_json JSONB,
  requested_outputs JSONB NOT NULL DEFAULT '[]'::jsonb,
  default_publication_id TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  started_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  CHECK (jsonb_typeof(request_payload) = 'object'),
  CHECK (result_payload IS NULL OR jsonb_typeof(result_payload) = 'object'),
  CHECK (failure_detail IS NULL OR jsonb_typeof(failure_detail) = 'object'),
  CHECK (scope_json IS NULL OR jsonb_typeof(scope_json) = 'object'),
  CHECK (jsonb_typeof(requested_outputs) = 'array'),
  UNIQUE (id, workspace_id)
);

CREATE UNIQUE INDEX IF NOT EXISTS uniscenario_artifact_postprocess_jobs_idempotency_idx
  ON uniscenario.artifact_postprocess_jobs (workspace_id, postprocess_kind, idempotency_key)
  WHERE idempotency_key IS NOT NULL;
CREATE INDEX IF NOT EXISTS uniscenario_artifact_postprocess_jobs_claim_idx
  ON uniscenario.artifact_postprocess_jobs (priority DESC, created_at, id)
  WHERE state = 'queued' AND cancel_requested_at IS NULL;

CREATE OR REPLACE VIEW uniscenario.operational_jobs AS
SELECT e.id, 'openscenario_compile'::TEXT AS job_family, e.workspace_id, e.revision_id,
       e.export_format::TEXT AS job_type, e.export_state::TEXT AS state,
       e.priority::INTEGER AS priority, e.progress::DOUBLE PRECISION AS progress,
       e.attempt_count, e.max_attempts, e.idempotency_key, e.requested_by_user_id,
       e.cancel_requested_at, e.error_code AS failure_code, e.error_detail AS failure_detail,
       e.created_at, e.updated_at, e.started_at, e.completed_at
FROM uniscenario.exports e
UNION ALL
SELECT v.id, 'openscenario_validate'::TEXT, v.workspace_id, v.revision_id,
       v.validator_kind::TEXT, CASE WHEN v.validation_state = 'passed' THEN 'succeeded' ELSE v.validation_state END,
       v.priority::INTEGER, v.progress::DOUBLE PRECISION, v.attempt_count, v.max_attempts,
       v.idempotency_key, v.requested_by_user_id, v.cancel_requested_at,
       v.failure_code, v.failure_detail, v.created_at, v.updated_at, v.started_at, v.completed_at
FROM uniscenario.validation_runs v
UNION ALL
SELECT j.id,
       CASE WHEN j.job_mode IN ('cosmos_augment', 'vlm_annotate') THEN 'artifact_postprocess'::TEXT ELSE 'openscenario_render'::TEXT END,
       j.workspace_id, j.revision_id, j.job_mode::TEXT, j.job_state::TEXT,
       j.priority::INTEGER, j.progress::DOUBLE PRECISION, j.attempt_count, j.max_attempts,
       j.idempotency_key, j.requested_by_user_id, j.cancel_requested_at,
       j.failure_code, j.failure_detail, j.created_at, j.updated_at, j.started_at, j.completed_at
FROM uniscenario.render_jobs j
UNION ALL
SELECT p.id, 'artifact_postprocess'::TEXT, p.workspace_id, p.revision_id,
       p.postprocess_kind, p.state, p.priority::INTEGER, p.progress,
       p.attempt_count, p.max_attempts, p.idempotency_key, p.requested_by_user_id,
       p.cancel_requested_at, p.failure_code, p.failure_detail,
       p.created_at, p.updated_at, p.started_at, p.completed_at
FROM uniscenario.artifact_postprocess_jobs p;

COMMIT;
