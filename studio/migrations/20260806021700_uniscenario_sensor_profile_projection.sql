-- Migration 20260806021700: expose actor sensor-profile readiness to document list rows
-- Rollback: ALTER TABLE uniscenario.drafts DROP COLUMN IF EXISTS summary_has_sensor_profile;

BEGIN;

ALTER TABLE uniscenario.drafts
  ADD COLUMN IF NOT EXISTS summary_has_sensor_profile BOOLEAN
  GENERATED ALWAYS AS (
    jsonb_path_exists(canonical_content, '$.roles[*].actor.sensors[*]')
  ) STORED;

COMMIT;
