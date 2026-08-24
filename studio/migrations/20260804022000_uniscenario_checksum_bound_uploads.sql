BEGIN;

ALTER TABLE uniscenario.artifact_uploads
  ADD COLUMN IF NOT EXISTS expected_sha256 TEXT,
  ADD COLUMN IF NOT EXISTS expected_byte_length BIGINT,
  ADD COLUMN IF NOT EXISTS bound_at TIMESTAMPTZ;

ALTER TABLE uniscenario.artifact_uploads
  DROP CONSTRAINT IF EXISTS uniscenario_artifact_uploads_expected_sha256_check,
  ADD CONSTRAINT uniscenario_artifact_uploads_expected_sha256_check
    CHECK (expected_sha256 IS NULL OR expected_sha256 ~ '^[a-f0-9]{64}$'),
  DROP CONSTRAINT IF EXISTS uniscenario_artifact_uploads_expected_byte_length_check,
  ADD CONSTRAINT uniscenario_artifact_uploads_expected_byte_length_check
    CHECK (expected_byte_length IS NULL OR expected_byte_length >= 0),
  DROP CONSTRAINT IF EXISTS uniscenario_artifact_uploads_binding_complete_check,
  ADD CONSTRAINT uniscenario_artifact_uploads_binding_complete_check
    CHECK ((expected_sha256 IS NULL) = (expected_byte_length IS NULL)
       AND (expected_sha256 IS NULL) = (bound_at IS NULL));

COMMIT;
