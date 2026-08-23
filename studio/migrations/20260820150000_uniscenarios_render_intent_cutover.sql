-- migration-impact: additive-with-control-plane-cutover
-- Canonical UniScenarios render intent, renderer admission, durable progress and sensor-scoped artifacts.
BEGIN;

ALTER TABLE uniscenario.render_jobs
  ADD COLUMN IF NOT EXISTS render_intent JSONB,
  ADD COLUMN IF NOT EXISTS intent_sha256 TEXT,
  ADD COLUMN IF NOT EXISTS renderer_engine TEXT,
  ADD COLUMN IF NOT EXISTS progress_detail JSONB;

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
      AND render_intent #>> '{sensorHost,vehicleAsset,catalogAssetId}' = 'vehicle.kia.carnival'
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
      AND render_intent->'renderSpec' = render_spec
    )
  ) NOT VALID,
  DROP CONSTRAINT IF EXISTS uniscenario_render_jobs_progress_detail_ck,
  ADD CONSTRAINT uniscenario_render_jobs_progress_detail_ck CHECK (
    progress_detail IS NULL OR (
      jsonb_typeof(progress_detail) = 'object'
      AND (progress_detail->>'sequence')::bigint >= 0
      AND progress_detail->>'event' IN (
        'job.started', 'stage.started', 'stage.progress', 'artifact.ready', 'warning', 'job.canceled'
      )
    )
  ) NOT VALID;

ALTER TABLE uniscenario.render_jobs
  DROP CONSTRAINT IF EXISTS uniscenario_render_jobs_browser_render_success_origin_ck,
  ADD CONSTRAINT uniscenario_render_jobs_browser_render_success_origin_ck CHECK (
    job_mode <> 'browser_render'
    OR job_state <> 'succeeded'
    OR (
      request_contract_version = 'uniscenario.render-intent/v1'
      AND origin_recording_job_id IS NULL
      AND renderer_engine = 'browser'
      AND render_intent->>'schema' = 'uniscenario.render-intent/v1'
    )
    OR (
      request_contract_version <> 'uniscenario.render-intent/v1'
      AND origin_recording_job_id IS NOT NULL
    )
  ) NOT VALID;

ALTER TABLE uniscenario.render_jobs
  DROP CONSTRAINT IF EXISTS uniscenario_render_jobs_success_requires_accepted_evidence_ck,
  ADD CONSTRAINT uniscenario_render_jobs_success_requires_accepted_evidence_ck CHECK (
    job_state <> 'succeeded'
    OR request_contract_version = 'uniscenario.render-intent/v1'
    OR job_mode NOT IN ('interaction_2d', 'full_render')
    OR (
      parity_accepted IS TRUE
      AND parity_evidence_schema = 'uniscenario.parity-evidence/v1'
      AND parity_evidence IS NOT NULL
    )
  ) NOT VALID;

CREATE INDEX IF NOT EXISTS uniscenario_render_jobs_engine_claim_idx
  ON uniscenario.render_jobs (renderer_engine, priority DESC, created_at, id)
  WHERE job_state = 'queued' AND cancel_requested_at IS NULL;

ALTER TABLE uniscenario.worker_nodes
  ADD COLUMN IF NOT EXISTS registration_id TEXT,
  ADD COLUMN IF NOT EXISTS instance_id TEXT,
  ADD COLUMN IF NOT EXISTS renderer_engine TEXT;

UPDATE uniscenario.worker_nodes
   SET registration_id = COALESCE(registration_id, id),
       instance_id = COALESCE(instance_id, id),
       renderer_engine = COALESCE(renderer_engine, 'carla')
 WHERE registration_id IS NULL OR instance_id IS NULL OR renderer_engine IS NULL;

ALTER TABLE uniscenario.worker_nodes
  ALTER COLUMN registration_id SET NOT NULL,
  ALTER COLUMN instance_id SET NOT NULL,
  ALTER COLUMN renderer_engine SET NOT NULL,
  DROP CONSTRAINT IF EXISTS uniscenario_worker_nodes_renderer_engine_ck,
  ADD CONSTRAINT uniscenario_worker_nodes_renderer_engine_ck
    CHECK (renderer_engine IN ('browser', 'carla')),
  DROP CONSTRAINT IF EXISTS uniscenario_worker_nodes_registration_unique,
  ADD CONSTRAINT uniscenario_worker_nodes_registration_unique UNIQUE (registration_id),
  DROP CONSTRAINT IF EXISTS uniscenario_worker_nodes_instance_unique,
  ADD CONSTRAINT uniscenario_worker_nodes_instance_unique UNIQUE (instance_id);

CREATE TABLE IF NOT EXISTS uniscenario.render_worker_credentials (
  id TEXT PRIMARY KEY,
  worker_node_id TEXT NOT NULL REFERENCES uniscenario.worker_nodes(id) ON DELETE CASCADE,
  token_sha256 TEXT NOT NULL CHECK (token_sha256 ~ '^[a-f0-9]{64}$'),
  credential_state TEXT NOT NULL DEFAULT 'active'
    CHECK (credential_state IN ('active', 'revoked')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at TIMESTAMPTZ,
  revoked_at TIMESTAMPTZ,
  UNIQUE (worker_node_id, token_sha256),
  CHECK (
    (credential_state = 'active' AND revoked_at IS NULL)
    OR (credential_state = 'revoked' AND revoked_at IS NOT NULL)
  )
);

-- `20260810010000_uniscenario_render_worker_eligibility_parity.sql` already
-- created this table without `expires_at`, so on every database that ran it the
-- CREATE above is a no-op and the index below referenced a column that never
-- arrived — the migration failed with `column "expires_at" does not exist` and
-- blocked everything ordered after it. Converge the existing shape explicitly
-- instead of relying on the CREATE, which by definition cannot alter a table
-- that is already there.
ALTER TABLE uniscenario.render_worker_credentials
  ADD COLUMN IF NOT EXISTS expires_at TIMESTAMPTZ;
CREATE INDEX IF NOT EXISTS uniscenario_render_worker_credentials_active_idx
  ON uniscenario.render_worker_credentials (worker_node_id, expires_at)
  WHERE credential_state = 'active';

ALTER TABLE uniscenario.worker_nodes
  DROP CONSTRAINT IF EXISTS uniscenario_worker_nodes_carla_image_provenance_ck,
  ADD CONSTRAINT uniscenario_worker_nodes_carla_image_provenance_ck CHECK (
    renderer_engine <> 'carla' OR (
      capabilities->>'backend' = 'carla'
      AND metadata->>'baseImage' = 'ghcr.io/simforgeinc/carla-rfs-munich-belmont:0.10.0-kia'
      AND metadata->>'baseImageDigest' =
        'sha256:f17c639e5f86fd7458fe1d02d3be1d481deeaa714f3cac30e465187d04ec90e5'
      AND metadata->>'baseImagePlatformDigest' =
        'sha256:baed0d038437c55efe0abe52a762d352aeb21acdeeff5b11a15f6bd8a648de64'
    )
  ) NOT VALID;

-- The 5080 is an ordinary registered GPU profile, not a hard-coded workstation identity.
ALTER TABLE uniscenario.worker_nodes
  DROP CONSTRAINT IF EXISTS uniscenario_worker_nodes_hardware_profile_ck,
  ADD CONSTRAINT uniscenario_worker_nodes_hardware_profile_ck CHECK (
    hardware_profile IS NULL
    OR hardware_profile IN ('rtx3080-10gb-v1', 'rtx5080-16gb-v1', 'rtx5080-16gb-local-v1')
  ) NOT VALID;

ALTER TABLE uniscenario.worker_nodes
  DROP CONSTRAINT IF EXISTS uniscenario_worker_nodes_approved_identity_ck,
  ADD CONSTRAINT uniscenario_worker_nodes_approved_identity_ck CHECK (
    registration_state <> 'active' OR (
      hardware_profile IN ('rtx3080-10gb-v1', 'rtx5080-16gb-v1', 'rtx5080-16gb-local-v1')
      AND approved_hardware_profile = hardware_profile
      AND approved_worker_version = worker_version
      AND approved_image_digest = image_digest
      AND approved_at IS NOT NULL
    )
  ) NOT VALID;

CREATE OR REPLACE FUNCTION uniscenario.enforce_render_worker_lease_eligibility()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  worker uniscenario.worker_nodes%ROWTYPE;
BEGIN
  IF NEW.lease_state <> 'active' THEN
    RETURN NEW;
  END IF;
  SELECT * INTO worker FROM uniscenario.worker_nodes
   WHERE id = NEW.worker_node_id FOR SHARE;
  IF NOT FOUND
     OR worker.registration_state <> 'active'
     OR worker.hardware_profile NOT IN ('rtx3080-10gb-v1', 'rtx5080-16gb-v1', 'rtx5080-16gb-local-v1')
     OR worker.approved_hardware_profile IS DISTINCT FROM worker.hardware_profile
     OR worker.approved_worker_version IS DISTINCT FROM worker.worker_version
     OR worker.approved_image_digest IS DISTINCT FROM worker.image_digest
     OR worker.approved_at IS NULL
     OR worker.last_heartbeat_at < NOW() - INTERVAL '90 seconds' THEN
    RAISE EXCEPTION 'uniscenario_worker_not_eligible';

  END IF;
  RETURN NEW;
END;
$$;
ALTER TABLE uniscenario.render_attempts
  ADD COLUMN IF NOT EXISTS renderer_engine TEXT,
  ADD COLUMN IF NOT EXISTS base_image_digest TEXT,
  ADD COLUMN IF NOT EXISTS base_image_platform_digest TEXT,
  ADD COLUMN IF NOT EXISTS engine_capabilities_sha256 TEXT;

ALTER TABLE uniscenario.render_attempts
  DROP CONSTRAINT IF EXISTS uniscenario_render_attempts_renderer_provenance_ck,
  ADD CONSTRAINT uniscenario_render_attempts_renderer_provenance_ck CHECK (
    renderer_engine IS NULL OR (
      renderer_engine IN ('browser', 'carla')
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

ALTER TABLE uniscenario.artifact_uploads
  ADD COLUMN IF NOT EXISTS artifact_role TEXT,
  ADD COLUMN IF NOT EXISTS artifact_actor_id TEXT,
  ADD COLUMN IF NOT EXISTS artifact_sensor_id TEXT,
  ADD COLUMN IF NOT EXISTS artifact_modality TEXT,
  ADD COLUMN IF NOT EXISTS expected_sha256 TEXT,
  ADD COLUMN IF NOT EXISTS expected_size_bytes BIGINT;
ALTER TABLE uniscenario.artifact_uploads
  DROP CONSTRAINT IF EXISTS uniscenario_artifact_uploads_identity_ck,
  ADD CONSTRAINT uniscenario_artifact_uploads_identity_ck CHECK (
    (
      artifact_role IN ('video', 'frames', 'sensorArchive')
      AND NULLIF(BTRIM(artifact_actor_id), '') IS NOT NULL
      AND NULLIF(BTRIM(artifact_sensor_id), '') IS NOT NULL
      AND artifact_modality IN ('rgb', 'depth', 'semantic', 'instance', 'lidar', 'radar')
    ) OR (
      artifact_role IN ('manifest', 'trace', 'annotations', 'diagnostics')
      AND artifact_actor_id IS NULL
      AND artifact_sensor_id IS NULL
      AND artifact_modality IS NULL
    ) OR artifact_role IS NULL
  ) NOT VALID,
  DROP CONSTRAINT IF EXISTS uniscenario_artifact_uploads_expected_object_ck,
  ADD CONSTRAINT uniscenario_artifact_uploads_expected_object_ck CHECK (
    (expected_sha256 IS NULL AND expected_size_bytes IS NULL)
    OR (expected_sha256 ~ '^[a-f0-9]{64}$' AND expected_size_bytes >= 0)
  ) NOT VALID;

ALTER TABLE uniscenario.artifact_uploads
  DROP CONSTRAINT IF EXISTS artifact_uploads_render_attempt_id_artifact_kind_key;
CREATE UNIQUE INDEX IF NOT EXISTS uniscenario_artifact_uploads_attempt_identity_idx
  ON uniscenario.artifact_uploads (
    render_attempt_id, artifact_role,
    COALESCE(artifact_actor_id, ''), COALESCE(artifact_sensor_id, ''), COALESCE(artifact_modality, '')
  ) WHERE render_attempt_id IS NOT NULL AND artifact_role IS NOT NULL;

ALTER TABLE uniscenario.artifact_links
  ADD COLUMN IF NOT EXISTS artifact_role TEXT,
  ADD COLUMN IF NOT EXISTS artifact_actor_id TEXT,
  ADD COLUMN IF NOT EXISTS artifact_sensor_id TEXT,
  ADD COLUMN IF NOT EXISTS artifact_modality TEXT;

ALTER TABLE uniscenario.artifact_links
  DROP CONSTRAINT IF EXISTS uniscenario_artifact_links_render_identity_ck,
  ADD CONSTRAINT uniscenario_artifact_links_render_identity_ck CHECK (
    (
      artifact_role IN ('video', 'frames', 'sensorArchive')
      AND NULLIF(BTRIM(artifact_actor_id), '') IS NOT NULL
      AND NULLIF(BTRIM(artifact_sensor_id), '') IS NOT NULL
      AND artifact_modality IN ('rgb', 'depth', 'semantic', 'instance', 'lidar', 'radar')
    ) OR (
      artifact_role IN ('manifest', 'trace', 'annotations', 'diagnostics')
      AND artifact_actor_id IS NULL
      AND artifact_sensor_id IS NULL
      AND artifact_modality IS NULL
    ) OR artifact_role IS NULL
  ) NOT VALID;

CREATE UNIQUE INDEX IF NOT EXISTS uniscenario_artifact_links_render_identity_idx
  ON uniscenario.artifact_links (
    render_attempt_id, artifact_role,
    COALESCE(artifact_actor_id, ''), COALESCE(artifact_sensor_id, ''), COALESCE(artifact_modality, '')
  ) WHERE render_attempt_id IS NOT NULL AND artifact_role IS NOT NULL;

-- Preserve every progress record as JSONL-equivalent ordered rows; render_jobs.progress_detail is the reconnect snapshot.
CREATE TABLE IF NOT EXISTS uniscenario.render_progress_records (
  render_job_id TEXT NOT NULL REFERENCES uniscenario.render_jobs(id) ON DELETE CASCADE,
  render_attempt_id TEXT NOT NULL REFERENCES uniscenario.render_attempts(id) ON DELETE CASCADE,
  sequence BIGINT NOT NULL CHECK (sequence >= 0),
  record JSONB NOT NULL CHECK (jsonb_typeof(record) = 'object'),
  recorded_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (render_attempt_id, sequence)
);
CREATE INDEX IF NOT EXISTS uniscenario_render_progress_job_idx
  ON uniscenario.render_progress_records (render_job_id, render_attempt_id, sequence);

INSERT INTO schema_migrations (id)
VALUES ('20260820150000_uniscenarios_render_intent_cutover.sql')
ON CONFLICT (id) DO NOTHING;

COMMIT;
