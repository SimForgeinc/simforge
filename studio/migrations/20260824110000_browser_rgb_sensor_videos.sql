-- Browser recordings publish one selectable video per RGB camera while keeping
-- LiDAR/radar visualizations and archive-light raw sensor products.
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
        WHERE artifact.value NOT IN (
          'video', 'manifest', 'frames', 'sensorArchive', 'trace', 'annotations'
        )
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
         AND (
           spec->'artifacts' ? 'frames'
           OR source->>'modality' IN ('lidar', 'radar')
         )
      UNION ALL
      SELECT 'sensor_video', source->>'actorId', source->>'sensorId',
             source->>'modality', 'output'
        FROM jsonb_array_elements(spec->'sources') source
       WHERE spec_schema = 'uniscenario.render-spec/v3'
         AND spec->'artifacts' ? 'sensorArchive'
         AND spec ? 'video'
         AND source->>'modality' IN ('rgb', 'lidar', 'radar')
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
