-- Migration 20260804021000: truthful, mode-specific UniScenario ambient provenance.
-- Replay-safe: every addition is conditional and existing non-materialized rows become disabled.

BEGIN;

ALTER TABLE uniscenario.revisions
  ADD COLUMN IF NOT EXISTS ambient_mode TEXT NOT NULL DEFAULT 'disabled',
  ADD COLUMN IF NOT EXISTS ambient_runtime_version TEXT,
  ADD COLUMN IF NOT EXISTS ambient_sumo_version TEXT,
  ADD COLUMN IF NOT EXISTS ambient_network_sha256 TEXT,
  ADD COLUMN IF NOT EXISTS ambient_seed TEXT,
  ADD COLUMN IF NOT EXISTS ambient_config JSONB NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS ambient_config_sha256 TEXT NOT NULL DEFAULT '44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a',
  ADD COLUMN IF NOT EXISTS ambient_result_sha256 TEXT NOT NULL DEFAULT '1925590408012373ea3cc6b9d02703527531492efb52aa39689d541a0581f840';

ALTER TABLE uniscenario.exports
  ADD COLUMN IF NOT EXISTS ambient_mode TEXT NOT NULL DEFAULT 'disabled',
  ADD COLUMN IF NOT EXISTS ambient_runtime_version TEXT,
  ADD COLUMN IF NOT EXISTS ambient_sumo_version TEXT,
  ADD COLUMN IF NOT EXISTS ambient_network_sha256 TEXT,
  ADD COLUMN IF NOT EXISTS ambient_seed TEXT,
  ADD COLUMN IF NOT EXISTS ambient_config JSONB NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS ambient_config_sha256 TEXT NOT NULL DEFAULT '44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a',
  ADD COLUMN IF NOT EXISTS ambient_result_sha256 TEXT NOT NULL DEFAULT '1925590408012373ea3cc6b9d02703527531492efb52aa39689d541a0581f840';

ALTER TABLE uniscenario.execution_packages
  ADD COLUMN IF NOT EXISTS ambient_mode TEXT NOT NULL DEFAULT 'disabled',
  ADD COLUMN IF NOT EXISTS ambient_runtime_version TEXT,
  ADD COLUMN IF NOT EXISTS ambient_sumo_version TEXT,
  ADD COLUMN IF NOT EXISTS ambient_network_sha256 TEXT,
  ADD COLUMN IF NOT EXISTS ambient_seed TEXT,
  ADD COLUMN IF NOT EXISTS ambient_config JSONB NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS ambient_config_sha256 TEXT NOT NULL DEFAULT '44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a',
  ADD COLUMN IF NOT EXISTS ambient_result_sha256 TEXT NOT NULL DEFAULT '1925590408012373ea3cc6b9d02703527531492efb52aa39689d541a0581f840';

-- Promote only rows already proven to have the complete materialized SUMO closure.
UPDATE uniscenario.execution_packages
SET ambient_mode = 'sumo',
    ambient_sumo_version = sumo_version,
    ambient_network_sha256 = sumo_network_sha256,
    ambient_seed = traffic_seed,
    ambient_config = traffic_config,
    ambient_config_sha256 = traffic_config_sha256,
    ambient_result_sha256 = materialized_traffic_sha256
WHERE traffic_mode = 'sumo'
  AND sumo_version IS NOT NULL
  AND sumo_network_sha256 ~ '^[a-f0-9]{64}$'
  AND traffic_seed IS NOT NULL
  AND traffic_config_sha256 ~ '^[a-f0-9]{64}$'
  AND materialized_traffic_artifact_id IS NOT NULL
  AND materialized_traffic_sha256 ~ '^[a-f0-9]{64}$';

DO $$
DECLARE
  table_name TEXT;
  constraint_name TEXT;
  closure_sql TEXT;
BEGIN
  FOREACH table_name IN ARRAY ARRAY['revisions', 'exports', 'execution_packages']
  LOOP
    constraint_name := 'uniscenario_' || table_name || '_ambient_provenance_check';
    IF table_name = 'execution_packages' THEN
      closure_sql := $closure$
        (ambient_mode = 'disabled' AND ambient_runtime_version IS NULL AND ambient_sumo_version IS NULL
          AND ambient_network_sha256 IS NULL AND ambient_seed IS NULL AND ambient_config = '{}'::jsonb
          AND ambient_config_sha256 = '44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a'
          AND ambient_result_sha256 = '1925590408012373ea3cc6b9d02703527531492efb52aa39689d541a0581f840')
        OR
        (ambient_mode = 'native' AND char_length(ambient_runtime_version) > 0 AND ambient_sumo_version IS NULL
          AND ambient_network_sha256 IS NULL AND char_length(ambient_seed) > 0
          AND jsonb_typeof(ambient_config) = 'object' AND ambient_config_sha256 ~ '^[a-f0-9]{64}$'
          AND ambient_result_sha256 ~ '^[a-f0-9]{64}$')
        OR
        (ambient_mode = 'sumo' AND ambient_runtime_version IS NULL AND char_length(ambient_sumo_version) > 0
          AND ambient_network_sha256 ~ '^[a-f0-9]{64}$' AND char_length(ambient_seed) > 0
          AND jsonb_typeof(ambient_config) = 'object' AND ambient_config_sha256 ~ '^[a-f0-9]{64}$'
          AND ambient_result_sha256 ~ '^[a-f0-9]{64}$' AND materialized_traffic_artifact_id IS NOT NULL
          AND materialized_traffic_sha256 = ambient_result_sha256)
      $closure$;
    ELSE
      closure_sql := $closure$
        (ambient_mode = 'disabled' AND ambient_runtime_version IS NULL AND ambient_sumo_version IS NULL
          AND ambient_network_sha256 IS NULL AND ambient_seed IS NULL AND ambient_config = '{}'::jsonb
          AND ambient_config_sha256 = '44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a'
          AND ambient_result_sha256 = '1925590408012373ea3cc6b9d02703527531492efb52aa39689d541a0581f840')
        OR
        (ambient_mode = 'native' AND char_length(ambient_runtime_version) > 0 AND ambient_sumo_version IS NULL
          AND ambient_network_sha256 IS NULL AND char_length(ambient_seed) > 0
          AND jsonb_typeof(ambient_config) = 'object' AND ambient_config_sha256 ~ '^[a-f0-9]{64}$'
          AND ambient_result_sha256 ~ '^[a-f0-9]{64}$')
        OR
        (ambient_mode = 'sumo' AND ambient_runtime_version IS NULL AND char_length(ambient_sumo_version) > 0
          AND ambient_network_sha256 ~ '^[a-f0-9]{64}$' AND char_length(ambient_seed) > 0
          AND jsonb_typeof(ambient_config) = 'object' AND ambient_config_sha256 ~ '^[a-f0-9]{64}$'
          AND ambient_result_sha256 ~ '^[a-f0-9]{64}$')
      $closure$;
    END IF;
    IF NOT EXISTS (
      SELECT 1 FROM pg_constraint
      WHERE conname = constraint_name AND conrelid = format('uniscenario.%I', table_name)::regclass
    ) THEN
      EXECUTE format('ALTER TABLE uniscenario.%I ADD CONSTRAINT %I CHECK (%s)', table_name, constraint_name, closure_sql);
    END IF;
  END LOOP;
END $$;

COMMIT;
