-- Immutable public render-attempt lineage.
--
-- Existing attempts deliberately remain NULL: their lease-time package and worker
-- registration cannot be reconstructed safely after the fact. Public reads fail
-- closed for those rows instead of guessing from a later worker registration.

BEGIN;

ALTER TABLE uniscenario.render_jobs
  ADD COLUMN IF NOT EXISTS execution_package_control_sha256 TEXT;

ALTER TABLE uniscenario.render_jobs
  DROP CONSTRAINT IF EXISTS uniscenario_render_jobs_execution_package_control_sha256_check;
ALTER TABLE uniscenario.render_jobs
  ADD CONSTRAINT uniscenario_render_jobs_execution_package_control_sha256_check
  CHECK (
    execution_package_control_sha256 IS NULL
    OR execution_package_control_sha256 ~ '^[a-f0-9]{64}$'
  );

ALTER TABLE uniscenario.render_attempts
  ADD COLUMN IF NOT EXISTS execution_package_id TEXT,
  ADD COLUMN IF NOT EXISTS execution_package_control_sha256 TEXT,
  ADD COLUMN IF NOT EXISTS worker_class TEXT;

ALTER TABLE uniscenario.render_attempts
  DROP CONSTRAINT IF EXISTS uniscenario_render_attempts_execution_package_control_sha256_check;
ALTER TABLE uniscenario.render_attempts
  ADD CONSTRAINT uniscenario_render_attempts_execution_package_control_sha256_check
  CHECK (
    execution_package_control_sha256 IS NULL
    OR execution_package_control_sha256 ~ '^[a-f0-9]{64}$'
  );

ALTER TABLE uniscenario.render_attempts
  DROP CONSTRAINT IF EXISTS uniscenario_render_attempts_execution_package_workspace_fkey;
ALTER TABLE uniscenario.render_attempts
  ADD CONSTRAINT uniscenario_render_attempts_execution_package_workspace_fkey
  FOREIGN KEY (execution_package_id, workspace_id)
  REFERENCES uniscenario.execution_packages(id, workspace_id)
  ON DELETE RESTRICT;

-- The application is allowed to stamp the job digest exactly once when the
-- first lease is issued. Once any lineage field has a value, even the normal
-- application role cannot rewrite or clear it through future SQL.
CREATE OR REPLACE FUNCTION uniscenario.reject_render_lineage_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_TABLE_NAME = 'render_jobs' THEN
    IF NEW.execution_package_id IS DISTINCT FROM OLD.execution_package_id THEN
      RAISE EXCEPTION 'render job execution-package lineage is immutable'
        USING ERRCODE = '23514';
    END IF;
    IF OLD.execution_package_control_sha256 IS NOT NULL
       AND NEW.execution_package_control_sha256 IS DISTINCT FROM OLD.execution_package_control_sha256 THEN
      RAISE EXCEPTION 'render job control digest is immutable'
        USING ERRCODE = '23514';
    END IF;
  ELSIF TG_TABLE_NAME = 'render_attempts' THEN
    IF (OLD.render_job_id IS NOT NULL AND NEW.render_job_id IS DISTINCT FROM OLD.render_job_id)
       OR (OLD.execution_package_id IS NOT NULL
           AND NEW.execution_package_id IS DISTINCT FROM OLD.execution_package_id)
       OR (OLD.execution_package_control_sha256 IS NOT NULL
           AND NEW.execution_package_control_sha256 IS DISTINCT FROM OLD.execution_package_control_sha256)
       OR (OLD.worker_node_id IS NOT NULL AND NEW.worker_node_id IS DISTINCT FROM OLD.worker_node_id)
       OR (OLD.worker_class IS NOT NULL AND NEW.worker_class IS DISTINCT FROM OLD.worker_class)
       OR (OLD.runtime_version IS NOT NULL AND NEW.runtime_version IS DISTINCT FROM OLD.runtime_version)
       OR (OLD.image_digest IS NOT NULL AND NEW.image_digest IS DISTINCT FROM OLD.image_digest) THEN
      RAISE EXCEPTION 'render attempt lineage is immutable'
        USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS uniscenario_render_jobs_lineage_immutable
  ON uniscenario.render_jobs;
CREATE TRIGGER uniscenario_render_jobs_lineage_immutable
BEFORE UPDATE OF execution_package_id, execution_package_control_sha256
ON uniscenario.render_jobs
FOR EACH ROW
EXECUTE FUNCTION uniscenario.reject_render_lineage_mutation();

DROP TRIGGER IF EXISTS uniscenario_render_attempts_lineage_immutable
  ON uniscenario.render_attempts;
CREATE TRIGGER uniscenario_render_attempts_lineage_immutable
BEFORE UPDATE OF render_job_id, execution_package_id, execution_package_control_sha256,
  worker_node_id, worker_class, runtime_version, image_digest
ON uniscenario.render_attempts
FOR EACH ROW
EXECUTE FUNCTION uniscenario.reject_render_lineage_mutation();

COMMIT;
