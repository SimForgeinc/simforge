-- migration-impact: destructive
-- migration-window: widens browser-recording artifact-role constraints and replaces the
--   role indexes/closure trigger so LiDAR and radar sources may publish sensor-scoped WebM previews.
--   Existing rows remain valid; dropped constraints and indexes are recreated in this transaction.
BEGIN;

ALTER TABLE uniscenario.operational_job_artifact_links
  DROP CONSTRAINT IF EXISTS operational_job_artifact_links_artifact_role_check,
  ADD CONSTRAINT operational_job_artifact_links_artifact_role_check CHECK (
    artifact_role IS NULL OR artifact_role IN (
      'video', 'poster', 'manifest', 'frames', 'sensor_archive', 'sensor_video', 'trace', 'log'
    )
  ) NOT VALID,
  DROP CONSTRAINT IF EXISTS operational_job_artifact_links_sensor_identity_check,
  ADD CONSTRAINT operational_job_artifact_links_sensor_identity_check CHECK (
    (
      artifact_role IN ('sensor_archive', 'sensor_video')
      AND NULLIF(BTRIM(artifact_sensor_actor_id), '') IS NOT NULL
      AND NULLIF(BTRIM(artifact_sensor_id), '') IS NOT NULL
      AND artifact_sensor_modality IN ('rgb', 'depth', 'semantic', 'instance', 'lidar', 'radar')
    ) OR (
      (artifact_role IS NULL OR artifact_role NOT IN ('sensor_archive', 'sensor_video'))
      AND artifact_sensor_actor_id IS NULL
      AND artifact_sensor_id IS NULL
      AND artifact_sensor_modality IS NULL
    )
  ) NOT VALID;

ALTER TABLE uniscenario.operational_job_artifact_links
  VALIDATE CONSTRAINT operational_job_artifact_links_artifact_role_check;
ALTER TABLE uniscenario.operational_job_artifact_links
  VALIDATE CONSTRAINT operational_job_artifact_links_sensor_identity_check;

DROP INDEX IF EXISTS uniscenario.uniscenario_operational_job_artifact_role_idx;
DROP INDEX IF EXISTS uniscenario.uniscenario_operational_job_sensor_artifact_role_idx;
CREATE UNIQUE INDEX uniscenario_operational_job_artifact_role_idx
  ON uniscenario.operational_job_artifact_links
    (workspace_id, job_family, job_id, artifact_role)
  WHERE attempt_id IS NULL
    AND artifact_role IS NOT NULL
    AND artifact_role NOT IN ('sensor_archive', 'sensor_video');
CREATE UNIQUE INDEX uniscenario_operational_job_sensor_artifact_role_idx
  ON uniscenario.operational_job_artifact_links
    (workspace_id, job_family, job_id, artifact_role,
     artifact_sensor_actor_id, artifact_sensor_id, artifact_sensor_modality)
  WHERE attempt_id IS NULL
    AND artifact_role IN ('sensor_archive', 'sensor_video');

CREATE OR REPLACE FUNCTION uniscenario.enforce_browser_recording_artifact_closure()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  spec JSONB := NEW.request_payload->'renderSpec';
  spec_schema TEXT := spec->>'schema';
BEGIN
  IF NEW.postprocess_kind <> 'browser_threejs_recording'
     OR NEW.state <> 'succeeded'
     OR OLD.state = 'succeeded' THEN
    RETURN NEW;
  END IF;

  IF spec_schema NOT IN ('uniscenario.render-spec/v2', 'uniscenario.render-spec/v3') THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      CONSTRAINT = 'browser_recording_artifact_closure_invalid',
      MESSAGE = 'browser recording render spec is not supported';
  END IF;

  IF spec_schema = 'uniscenario.render-spec/v3'
     AND EXISTS (
       SELECT 1
         FROM jsonb_array_elements_text(spec->'artifacts') artifact(value)
        WHERE artifact.value NOT IN ('video', 'manifest', 'frames', 'sensorArchive')
     ) THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      CONSTRAINT = 'browser_recording_artifact_closure_invalid',
      MESSAGE = 'browser recording render spec declares an unsupported artifact';
  END IF;

  IF EXISTS (
    WITH expected(role, actor_id, sensor_id, modality, relationship) AS (
      SELECT 'manifest'::TEXT, NULL::TEXT, NULL::TEXT, NULL::TEXT, 'output'::TEXT
      UNION ALL
      SELECT 'video', NULL, NULL, NULL, 'output' WHERE spec->'artifacts' ? 'video'
      UNION ALL
      SELECT 'frames', NULL, NULL, NULL, 'output'
       WHERE spec_schema = 'uniscenario.render-spec/v3'
         AND spec->'artifacts' ? 'frames'
      UNION ALL
      SELECT 'sensor_archive', source->>'actorId', source->>'sensorId',
             source->>'modality', 'output'
        FROM jsonb_array_elements(spec->'sources') source
       WHERE spec_schema = 'uniscenario.render-spec/v3'
         AND spec->'artifacts' ? 'sensorArchive'
      UNION ALL
      SELECT 'sensor_video', source->>'actorId', source->>'sensorId',
             source->>'modality', 'output'
        FROM jsonb_array_elements(spec->'sources') source
       WHERE spec_schema = 'uniscenario.render-spec/v3'
         AND spec->'artifacts' ? 'sensorArchive'
         AND spec ? 'video'
         AND source->>'modality' IN ('lidar', 'radar')
    ), actual(role, actor_id, sensor_id, modality, relationship) AS (
      SELECT link.artifact_role, link.artifact_sensor_actor_id,
             link.artifact_sensor_id, link.artifact_sensor_modality, link.relationship
        FROM uniscenario.operational_job_artifact_links link
        JOIN uniscenario.artifacts artifact
          ON artifact.id = link.artifact_id
         AND artifact.workspace_id = link.workspace_id
       WHERE link.workspace_id = NEW.workspace_id
         AND link.job_family = 'artifact_postprocess'
         AND link.job_id = NEW.id
         AND link.attempt_id IS NULL
         AND link.artifact_role IS NOT NULL
         AND artifact.artifact_state = 'available'
         AND artifact.deleted_at IS NULL
    )
    (SELECT * FROM expected EXCEPT SELECT * FROM actual)
    UNION ALL
    (SELECT * FROM actual EXCEPT SELECT * FROM expected)
  ) THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      CONSTRAINT = 'browser_recording_artifact_closure_invalid',
      MESSAGE = 'browser recording artifacts do not equal the render spec closure';
  END IF;

  RETURN NEW;
END;
$$;

INSERT INTO schema_migrations (id)
VALUES ('20260820140000_browser_active_sensor_videos.sql')
ON CONFLICT (id) DO NOTHING;

COMMIT;
