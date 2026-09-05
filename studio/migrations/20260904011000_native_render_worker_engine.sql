BEGIN;

ALTER TABLE simforge.render_jobs
  DROP CONSTRAINT IF EXISTS uniscenario_render_jobs_render_intent_ck,
  ADD CONSTRAINT uniscenario_render_jobs_render_intent_ck CHECK (
    (render_intent IS NULL AND intent_sha256 IS NULL AND renderer_engine IS NULL)
    OR (
      jsonb_typeof(render_intent) = 'object'
      AND render_intent->>'schema' IN ('uniscenario.render-intent/v1', 'simforge.render-intent/v1')
      AND intent_sha256 ~ '^[a-f0-9]{64}$'
      AND renderer_engine IN ('browser', 'carla', 'native')
      AND render_intent #>> '{scenarioRevision,revisionId}' = revision_id
      AND render_intent->'renderSpec' = render_spec
      AND jsonb_typeof(render_intent->'sensorHosts') = 'array'
      AND jsonb_array_length(render_intent->'sensorHosts') > 0
    )
  ) NOT VALID;

ALTER TABLE simforge.worker_nodes
  DROP CONSTRAINT IF EXISTS uniscenario_worker_nodes_renderer_engine_ck,
  ADD CONSTRAINT uniscenario_worker_nodes_renderer_engine_ck
    CHECK (renderer_engine IN ('browser', 'carla', 'native'));

ALTER TABLE simforge.render_attempts
  DROP CONSTRAINT IF EXISTS uniscenario_render_attempts_renderer_provenance_ck,
  ADD CONSTRAINT uniscenario_render_attempts_renderer_provenance_ck CHECK (
    renderer_engine IS NULL OR (
      renderer_engine IN ('browser', 'carla', 'native')
      AND (base_image_digest IS NULL OR base_image_digest ~ '^sha256:[a-f0-9]{64}$')
      AND (base_image_platform_digest IS NULL OR base_image_platform_digest ~ '^sha256:[a-f0-9]{64}$')
      AND engine_capabilities_sha256 ~ '^[a-f0-9]{64}$'
      AND (
        renderer_engine <> 'carla'
        OR (
          base_image_digest = 'sha256:f17c639e5f86fd7458fe1d02d3be1d481deeaa714f3cac30e465187d04ec90e5'
          AND base_image_platform_digest =
            'sha256:baed0d038437c55efe0abe52a762d352aeb21acdeeff5b11a15f6bd8a648de64'
        )
      )
    )
  ) NOT VALID;

COMMIT;
