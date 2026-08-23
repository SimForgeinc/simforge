BEGIN;

ALTER TABLE uniscenario.worker_nodes
  DROP CONSTRAINT IF EXISTS uniscenario_worker_nodes_hardware_profile_ck,
  ADD CONSTRAINT uniscenario_worker_nodes_hardware_profile_ck
    CHECK (
      hardware_profile IS NULL
      OR hardware_profile IN ('rtx3080-10gb-v1', 'rtx5080-16gb-local-v1')
    ) NOT VALID,
  DROP CONSTRAINT IF EXISTS uniscenario_worker_nodes_approved_identity_ck,
  ADD CONSTRAINT uniscenario_worker_nodes_approved_identity_ck
    CHECK (
      registration_state <> 'active' OR (
        (
          (hardware_profile = 'rtx3080-10gb-v1'
            AND id <> 'uniscenario-render-local-path-pc')
          OR (
            hardware_profile = 'rtx5080-16gb-local-v1'
            AND id = 'uniscenario-render-local-path-pc'
            AND environment = 'dev'
          )
        )
        AND approved_hardware_profile = hardware_profile
        AND approved_worker_version = worker_version
        AND approved_image_digest = image_digest
        AND approved_at IS NOT NULL
      )
    ) NOT VALID;

ALTER TABLE uniscenario.worker_nodes
  VALIDATE CONSTRAINT uniscenario_worker_nodes_hardware_profile_ck;
ALTER TABLE uniscenario.worker_nodes
  VALIDATE CONSTRAINT uniscenario_worker_nodes_approved_identity_ck;

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
  SELECT * INTO worker
    FROM uniscenario.worker_nodes
   WHERE id = NEW.worker_node_id
   FOR SHARE;
  IF NOT FOUND
     OR worker.registration_state <> 'active'
     OR NOT (
       (worker.hardware_profile = 'rtx3080-10gb-v1'
         AND worker.id <> 'uniscenario-render-local-path-pc')
       OR (
         worker.hardware_profile = 'rtx5080-16gb-local-v1'
         AND worker.id = 'uniscenario-render-local-path-pc'
         AND worker.environment = 'dev'
       )
     )
     OR worker.approved_hardware_profile IS DISTINCT FROM worker.hardware_profile
     OR worker.approved_worker_version IS DISTINCT FROM worker.worker_version
     OR worker.approved_image_digest IS DISTINCT FROM worker.image_digest
     OR worker.approved_at IS NULL THEN
    RAISE EXCEPTION 'uniscenario_worker_not_eligible';
  END IF;
  IF worker.last_heartbeat_at < NOW() - INTERVAL '90 seconds' THEN
    RAISE EXCEPTION 'uniscenario_worker_not_eligible';
  END IF;
  RETURN NEW;
END;
$$;

COMMIT;
