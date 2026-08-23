-- Allow independently authorized workspaces to register the same immutable, content-addressed
-- object without copying its bytes. Tenant ownership remains on artifacts.workspace_id and every
-- artifact foreign key is workspace-composite; storage identity is not an authorization boundary.
--
-- Rollback is safe only after deduplicating rows by (storage_bucket, storage_key):
--   ALTER TABLE uniscenario.artifacts
--     ADD CONSTRAINT artifacts_storage_bucket_storage_key_key UNIQUE (storage_bucket, storage_key);

BEGIN;

ALTER TABLE uniscenario.artifacts
  DROP CONSTRAINT IF EXISTS artifacts_storage_bucket_storage_key_key;

CREATE INDEX IF NOT EXISTS uniscenario_artifacts_storage_object_idx
  ON uniscenario.artifacts (storage_bucket, storage_key);

COMMIT;
