-- Bind the exact browser-recorded dynamic traffic clip through immutable export and CARLA replay.
BEGIN;

ALTER TABLE uniscenario.revisions
  ADD COLUMN IF NOT EXISTS materialized_traffic_artifact_id TEXT REFERENCES uniscenario.artifacts(id) ON DELETE RESTRICT,
  ADD COLUMN IF NOT EXISTS materialized_traffic_sha256 TEXT,
  ADD COLUMN IF NOT EXISTS materialized_traffic_size_bytes BIGINT,
  ADD COLUMN IF NOT EXISTS materialized_traffic_source_input_digest TEXT;

ALTER TABLE uniscenario.exports
  ADD COLUMN IF NOT EXISTS materialized_traffic_artifact_id TEXT REFERENCES uniscenario.artifacts(id) ON DELETE RESTRICT,
  ADD COLUMN IF NOT EXISTS materialized_traffic_sha256 TEXT,
  ADD COLUMN IF NOT EXISTS materialized_traffic_size_bytes BIGINT,
  ADD COLUMN IF NOT EXISTS materialized_traffic_source_input_digest TEXT;

ALTER TABLE uniscenario.execution_packages
  ADD COLUMN IF NOT EXISTS materialized_traffic_source_input_digest TEXT;

DO $$
DECLARE table_name TEXT;
BEGIN
  FOREACH table_name IN ARRAY ARRAY['revisions', 'exports'] LOOP
    IF NOT EXISTS (
      SELECT 1 FROM pg_constraint
      WHERE conname = 'uniscenario_' || table_name || '_materialized_traffic_binding_check'
        AND conrelid = format('uniscenario.%I', table_name)::regclass
    ) THEN
      EXECUTE format(
      'ALTER TABLE uniscenario.%I ADD CONSTRAINT %I CHECK (
        (materialized_traffic_artifact_id IS NULL AND materialized_traffic_sha256 IS NULL
          AND materialized_traffic_size_bytes IS NULL AND materialized_traffic_source_input_digest IS NULL)
        OR
        (materialized_traffic_artifact_id IS NOT NULL
          AND materialized_traffic_sha256 ~ ''^[a-f0-9]{64}$''
          AND materialized_traffic_sha256 = ambient_result_sha256
          AND materialized_traffic_size_bytes > 0
          AND materialized_traffic_source_input_digest ~ ''^[a-f0-9]{64}$'')
      ) NOT VALID',
      table_name,
      'uniscenario_' || table_name || '_materialized_traffic_binding_check'
      );
    END IF;
  END LOOP;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'uniscenario_execution_packages_materialized_traffic_source_check'
      AND conrelid = 'uniscenario.execution_packages'::regclass
  ) THEN
    ALTER TABLE uniscenario.execution_packages
      ADD CONSTRAINT uniscenario_execution_packages_materialized_traffic_source_check
      CHECK (
        materialized_traffic_artifact_id IS NOT NULL
        AND materialized_traffic_sha256 ~ '^[a-f0-9]{64}$'
        AND materialized_traffic_sha256 = ambient_result_sha256
        AND materialized_traffic_source_input_digest = source_input_digest
      ) NOT VALID;
  END IF;
END $$;

COMMIT;
