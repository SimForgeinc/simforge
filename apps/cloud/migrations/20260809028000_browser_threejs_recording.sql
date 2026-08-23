-- Migration 20260809028000: persist browser Three.js recordings as canonical local artifacts.
-- Rollback: stop recording admission, remove the origin/link triggers and indexes, then drop the
-- added render-job origin, artifact-link role, and local-producer lifecycle columns.

BEGIN;

ALTER TABLE uniscenario.artifact_postprocess_jobs
  ADD COLUMN IF NOT EXISTS request_payload_sha256 TEXT,
  ADD COLUMN IF NOT EXISTS progress_payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS client_heartbeat_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS expires_at TIMESTAMPTZ;

ALTER TABLE uniscenario.artifact_postprocess_jobs
  DROP CONSTRAINT IF EXISTS artifact_postprocess_jobs_request_payload_sha256_check,
  ADD CONSTRAINT artifact_postprocess_jobs_request_payload_sha256_check CHECK (
    request_payload_sha256 IS NULL OR request_payload_sha256 ~ '^[a-f0-9]{64}$'
  ) NOT VALID,
  DROP CONSTRAINT IF EXISTS artifact_postprocess_jobs_progress_payload_object_check,
  ADD CONSTRAINT artifact_postprocess_jobs_progress_payload_object_check CHECK (
    jsonb_typeof(progress_payload) = 'object'
  ) NOT VALID,
  DROP CONSTRAINT IF EXISTS artifact_postprocess_jobs_browser_recording_closure_check,
  ADD CONSTRAINT artifact_postprocess_jobs_browser_recording_closure_check CHECK (
    postprocess_kind <> 'browser_threejs_recording'
    OR (
      revision_id IS NOT NULL
      AND request_payload_sha256 ~ '^[a-f0-9]{64}$'
      AND client_heartbeat_at IS NOT NULL
      AND expires_at IS NOT NULL
      AND max_attempts = 1
    )
  ) NOT VALID;

ALTER TABLE uniscenario.artifact_postprocess_jobs
  VALIDATE CONSTRAINT artifact_postprocess_jobs_request_payload_sha256_check;
ALTER TABLE uniscenario.artifact_postprocess_jobs
  VALIDATE CONSTRAINT artifact_postprocess_jobs_progress_payload_object_check;
ALTER TABLE uniscenario.artifact_postprocess_jobs
  VALIDATE CONSTRAINT artifact_postprocess_jobs_browser_recording_closure_check;

CREATE INDEX IF NOT EXISTS uniscenario_browser_recording_expiry_idx
  ON uniscenario.artifact_postprocess_jobs (workspace_id, expires_at, id)
  WHERE postprocess_kind = 'browser_threejs_recording' AND state = 'running';

CREATE INDEX IF NOT EXISTS uniscenario_browser_recording_revision_idx
  ON uniscenario.artifact_postprocess_jobs (workspace_id, revision_id, created_at DESC, id DESC)
  WHERE postprocess_kind = 'browser_threejs_recording';

CREATE OR REPLACE FUNCTION uniscenario.reject_browser_recording_identity_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF OLD.postprocess_kind = 'browser_threejs_recording'
     AND (
       NEW.postprocess_kind IS DISTINCT FROM OLD.postprocess_kind
       OR NEW.workspace_id IS DISTINCT FROM OLD.workspace_id
       OR NEW.revision_id IS DISTINCT FROM OLD.revision_id
       OR NEW.request_payload IS DISTINCT FROM OLD.request_payload
       OR NEW.request_payload_sha256 IS DISTINCT FROM OLD.request_payload_sha256
       OR NEW.idempotency_key IS DISTINCT FROM OLD.idempotency_key
     ) THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      CONSTRAINT = 'browser_threejs_recording_identity_immutable',
      MESSAGE = 'browser Three.js recording identity is immutable';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS browser_threejs_recording_identity_immutable
  ON uniscenario.artifact_postprocess_jobs;
CREATE TRIGGER browser_threejs_recording_identity_immutable
BEFORE UPDATE OF postprocess_kind, workspace_id, revision_id, request_payload,
  request_payload_sha256, idempotency_key
ON uniscenario.artifact_postprocess_jobs
FOR EACH ROW EXECUTE FUNCTION uniscenario.reject_browser_recording_identity_mutation();

ALTER TABLE uniscenario.operational_job_artifact_links
  ADD COLUMN IF NOT EXISTS artifact_role TEXT;

ALTER TABLE uniscenario.operational_job_artifact_links
  DROP CONSTRAINT IF EXISTS operational_job_artifact_links_artifact_role_check,
  ADD CONSTRAINT operational_job_artifact_links_artifact_role_check CHECK (
    artifact_role IS NULL OR artifact_role IN ('video', 'poster', 'manifest', 'trace', 'log')
  ) NOT VALID;
ALTER TABLE uniscenario.operational_job_artifact_links
  VALIDATE CONSTRAINT operational_job_artifact_links_artifact_role_check;

-- Replace the tenant-blind artifact edge by shape. Re-running this migration sees the
-- two-column foreign key and leaves it in place.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'operational_job_artifact_links_artifact_id_fkey'
      AND conrelid = 'uniscenario.operational_job_artifact_links'::regclass
      AND array_length(conkey, 1) = 1
  ) THEN
    ALTER TABLE uniscenario.operational_job_artifact_links
      DROP CONSTRAINT operational_job_artifact_links_artifact_id_fkey;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'operational_job_artifact_links_artifact_id_fkey'
      AND conrelid = 'uniscenario.operational_job_artifact_links'::regclass
  ) THEN
    ALTER TABLE uniscenario.operational_job_artifact_links
      ADD CONSTRAINT operational_job_artifact_links_artifact_id_fkey
      FOREIGN KEY (artifact_id, workspace_id)
      REFERENCES uniscenario.artifacts(id, workspace_id) ON DELETE CASCADE;
  END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS uniscenario_operational_job_artifact_role_idx
  ON uniscenario.operational_job_artifact_links
    (workspace_id, job_family, job_id, artifact_role)
  WHERE attempt_id IS NULL AND artifact_role IS NOT NULL;

ALTER TABLE uniscenario.render_jobs
  ADD COLUMN IF NOT EXISTS origin_recording_job_id TEXT;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'uniscenario_render_jobs_origin_recording_workspace_fk'
      AND conrelid = 'uniscenario.render_jobs'::regclass
  ) THEN
    ALTER TABLE uniscenario.render_jobs
      ADD CONSTRAINT uniscenario_render_jobs_origin_recording_workspace_fk
      FOREIGN KEY (origin_recording_job_id, workspace_id)
      REFERENCES uniscenario.artifact_postprocess_jobs(id, workspace_id)
      ON DELETE RESTRICT;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS uniscenario_render_jobs_origin_recording_idx
  ON uniscenario.render_jobs (workspace_id, origin_recording_job_id)
  WHERE origin_recording_job_id IS NOT NULL;

CREATE OR REPLACE FUNCTION uniscenario.reject_render_origin_recording_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF OLD.origin_recording_job_id IS NOT NULL
     AND NEW.origin_recording_job_id IS DISTINCT FROM OLD.origin_recording_job_id THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      CONSTRAINT = 'render_origin_recording_immutable',
      MESSAGE = 'render origin recording is immutable';
  END IF;
  IF OLD.origin_recording_job_id IS NULL
     AND NEW.origin_recording_job_id IS NOT NULL
     AND OLD.job_state <> 'queued' THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      CONSTRAINT = 'render_origin_recording_late_binding_forbidden',
      MESSAGE = 'render origin recording must be bound before execution';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS uniscenario_render_origin_recording_immutable
  ON uniscenario.render_jobs;
CREATE TRIGGER uniscenario_render_origin_recording_immutable
BEFORE UPDATE OF origin_recording_job_id
ON uniscenario.render_jobs
FOR EACH ROW EXECUTE FUNCTION uniscenario.reject_render_origin_recording_mutation();

CREATE OR REPLACE FUNCTION uniscenario.enforce_render_origin_recording()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.origin_recording_job_id IS NOT NULL AND NOT EXISTS (
    SELECT 1
      FROM uniscenario.artifact_postprocess_jobs recording
     WHERE recording.id = NEW.origin_recording_job_id
       AND recording.workspace_id = NEW.workspace_id
       AND recording.revision_id = NEW.revision_id
       AND recording.postprocess_kind = 'browser_threejs_recording'
       AND recording.state = 'succeeded'
  ) THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      CONSTRAINT = 'render_origin_recording_invalid',
      MESSAGE = 'render origin must resolve to a succeeded browser recording of the same revision';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS uniscenario_render_origin_recording_enforced
  ON uniscenario.render_jobs;
CREATE CONSTRAINT TRIGGER uniscenario_render_origin_recording_enforced
AFTER INSERT OR UPDATE OF origin_recording_job_id, workspace_id, revision_id
ON uniscenario.render_jobs
DEFERRABLE INITIALLY IMMEDIATE
FOR EACH ROW EXECUTE FUNCTION uniscenario.enforce_render_origin_recording();

INSERT INTO schema_migrations (id)
VALUES ('20260809028000_browser_threejs_recording.sql')
ON CONFLICT (id) DO NOTHING;

COMMIT;
