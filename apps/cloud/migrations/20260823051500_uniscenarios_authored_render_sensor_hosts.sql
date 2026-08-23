-- migration-impact: constraint-cutover
-- Render intents may target an authored sensor rig as well as the fixed Pronto rig.
BEGIN;

ALTER TABLE uniscenario.render_jobs
  DROP CONSTRAINT IF EXISTS uniscenario_render_jobs_render_intent_ck,
  ADD CONSTRAINT uniscenario_render_jobs_render_intent_ck CHECK (
    (render_intent IS NULL AND intent_sha256 IS NULL AND renderer_engine IS NULL)
    OR (
      jsonb_typeof(render_intent) = 'object'
      AND render_intent->>'schema' = 'uniscenario.render-intent/v1'
      AND intent_sha256 ~ '^[a-f0-9]{64}$'
      AND renderer_engine IN ('browser', 'carla')
      AND render_intent #>> '{scenarioRevision,revisionId}' = revision_id
      AND render_intent->'renderSpec' = render_spec
      AND (
        (
          render_intent #>> '{sensorHost,vehicleAsset,catalogAssetId}' = 'vehicle.kia.carnival'
          AND render_intent #>> '{sensorHost,vehicleAsset,carlaBlueprintId}' = 'vehicle.kia.carnival'
          AND render_intent #>> '{sensorHost,vehicleAsset,carlaClassPath}' =
            '/Game/Carla/Blueprints/Vehicles/KiaCarnival2025/BP_KiaCarnival2025.BP_KiaCarnival2025_C'
          AND render_intent #>> '{sensorHost,vehicleAsset,sourceImage,indexSha256}' =
            'f17c639e5f86fd7458fe1d02d3be1d481deeaa714f3cac30e465187d04ec90e5'
          AND render_intent #>> '{sensorHost,vehicleAsset,sourceImage,linuxAmd64ManifestSha256}' =
            'baed0d038437c55efe0abe52a762d352aeb21acdeeff5b11a15f6bd8a648de64'
          AND render_intent #>> '{sensorHost,sensorRig,rigId}' = 'pronto.8-camera-6-lidar-4-radar'
          AND (render_intent #>> '{sensorHost,sensorRig,cameras}')::integer = 8
          AND (render_intent #>> '{sensorHost,sensorRig,lidars}')::integer = 6
          AND (render_intent #>> '{sensorHost,sensorRig,radars}')::integer = 4
        )
        OR (
          render_intent #>> '{sensorHost,sensorRig,rigId}' = 'authored'
          AND length(render_intent #>> '{sensorHost,actorId}') > 0
          AND length(render_intent #>> '{sensorHost,vehicleAsset,catalogAssetId}') > 0
          AND (render_intent #>> '{sensorHost,sensorRig,cameras}')::integer >= 0
          AND (render_intent #>> '{sensorHost,sensorRig,lidars}')::integer >= 0
          AND (render_intent #>> '{sensorHost,sensorRig,radars}')::integer >= 0
        )
      )
    )
  ) NOT VALID;

COMMIT;
