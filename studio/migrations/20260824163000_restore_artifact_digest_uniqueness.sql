-- Correct installations that temporarily used finalized-only deduplication.
-- Live pending/available artifacts are unique; quarantined/deleted producer
-- history remains immutable without blocking a clean retry of the same bytes.
DROP INDEX IF EXISTS uniscenario.uniscenario_artifacts_available_digest_unique;
DROP INDEX IF EXISTS uniscenario.uniscenario_artifacts_live_digest_unique;
ALTER TABLE uniscenario.artifacts
  DROP CONSTRAINT IF EXISTS artifacts_workspace_id_sha256_artifact_kind_key;

CREATE UNIQUE INDEX uniscenario_artifacts_live_digest_unique
  ON uniscenario.artifacts (workspace_id, sha256, artifact_kind)
  WHERE artifact_state IN ('pending', 'available') AND deleted_at IS NULL;
