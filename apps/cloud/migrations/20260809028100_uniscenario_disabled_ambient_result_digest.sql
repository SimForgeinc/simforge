-- Align disabled ambient provenance with the materialized-traffic contract.
-- A disabled provider still produces a deterministic empty traffic artifact,
-- so its result digest is content-addressed rather than one global constant.

BEGIN;

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
          AND ambient_result_sha256 ~ '^[a-f0-9]{64}$')
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
          AND ambient_result_sha256 ~ '^[a-f0-9]{64}$')
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

    EXECUTE format(
      'ALTER TABLE uniscenario.%I DROP CONSTRAINT IF EXISTS %I',
      table_name,
      constraint_name
    );
    EXECUTE format(
      'ALTER TABLE uniscenario.%I ADD CONSTRAINT %I CHECK (%s)',
      table_name,
      constraint_name,
      closure_sql
    );
  END LOOP;
END $$;

INSERT INTO schema_migrations (id)
VALUES ('20260809028100_uniscenario_disabled_ambient_result_digest.sql')
ON CONFLICT (id) DO NOTHING;

COMMIT;
