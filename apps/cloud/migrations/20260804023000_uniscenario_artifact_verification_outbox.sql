BEGIN;

ALTER TABLE uniscenario.artifacts
  ADD COLUMN IF NOT EXISTS verification_method TEXT,
  ADD COLUMN IF NOT EXISTS verification_sha256 TEXT;

ALTER TABLE uniscenario.artifacts
  DROP CONSTRAINT IF EXISTS uniscenario_artifacts_verification_method_check,
  ADD CONSTRAINT uniscenario_artifacts_verification_method_check
    CHECK (verification_method IS NULL OR verification_method IN ('s3_checksum_sha256', 'stream_sha256')),
  DROP CONSTRAINT IF EXISTS uniscenario_artifacts_verification_sha256_check,
  ADD CONSTRAINT uniscenario_artifacts_verification_sha256_check
    CHECK (verification_sha256 IS NULL OR verification_sha256 ~ '^[a-f0-9]{64}$'),
  DROP CONSTRAINT IF EXISTS uniscenario_artifacts_verification_complete_check,
  ADD CONSTRAINT uniscenario_artifacts_verification_complete_check
    CHECK ((verification_method IS NULL) = (verification_sha256 IS NULL));

CREATE TABLE IF NOT EXISTS uniscenario.artifact_cleanup_outbox (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  render_job_id TEXT NOT NULL REFERENCES uniscenario.render_jobs(id) ON DELETE CASCADE,
  render_attempt_id TEXT NOT NULL REFERENCES uniscenario.render_attempts(id) ON DELETE CASCADE,
  artifact_upload_id TEXT REFERENCES uniscenario.artifact_uploads(id) ON DELETE SET NULL,
  storage_bucket TEXT NOT NULL,
  storage_key TEXT NOT NULL,
  cleanup_state TEXT NOT NULL DEFAULT 'pending'
    CHECK (cleanup_state IN ('pending', 'deleted')),
  attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  last_error_code TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_attempt_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  UNIQUE (storage_bucket, storage_key)
);

CREATE INDEX IF NOT EXISTS uniscenario_artifact_cleanup_outbox_pending_idx
  ON uniscenario.artifact_cleanup_outbox (created_at ASC)
  WHERE cleanup_state = 'pending';

COMMIT;
