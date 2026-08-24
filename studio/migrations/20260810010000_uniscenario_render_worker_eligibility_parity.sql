BEGIN;

-- Renderer nodes are deployment inventory, never product scheduling input.
-- Existing registrations are disabled fail-closed; only an explicit control-
-- plane enable operation may pin and admit one exact runtime identity again.
ALTER TABLE uniscenario.worker_nodes
  ADD COLUMN IF NOT EXISTS hardware_profile TEXT,
  ADD COLUMN IF NOT EXISTS approved_worker_version TEXT,
  ADD COLUMN IF NOT EXISTS approved_image_digest TEXT,
  ADD COLUMN IF NOT EXISTS approved_hardware_profile TEXT,
  ADD COLUMN IF NOT EXISTS approved_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS state_changed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  ADD COLUMN IF NOT EXISTS last_idle_heartbeat_at TIMESTAMPTZ;

UPDATE uniscenario.worker_nodes
   SET registration_state = 'disabled',
       approved_worker_version = NULL,
       approved_image_digest = NULL,
       approved_hardware_profile = NULL,
       approved_at = NULL,
       state_changed_at = NOW()
 WHERE registration_state <> 'disabled'
    OR approved_worker_version IS NOT NULL
    OR approved_image_digest IS NOT NULL
    OR approved_hardware_profile IS NOT NULL;

ALTER TABLE uniscenario.worker_nodes
  DROP CONSTRAINT IF EXISTS uniscenario_worker_nodes_hardware_profile_ck,
  ADD CONSTRAINT uniscenario_worker_nodes_hardware_profile_ck
    CHECK (
      hardware_profile IS NULL OR hardware_profile = 'rtx3080-10gb-v1'
    ) NOT VALID,
  DROP CONSTRAINT IF EXISTS uniscenario_worker_nodes_approved_identity_ck,
  ADD CONSTRAINT uniscenario_worker_nodes_approved_identity_ck
    CHECK (
      registration_state <> 'active' OR (
        hardware_profile = 'rtx3080-10gb-v1'
        AND approved_hardware_profile = hardware_profile
        AND approved_worker_version = worker_version
        AND approved_image_digest = image_digest
        AND approved_at IS NOT NULL
      )
    ) NOT VALID;

-- A node is a single-GPU executor. This is a database fence, not merely a
-- scheduler preference, so two polling processes sharing a node id cannot
-- concurrently consume the same RTX 3080.
CREATE UNIQUE INDEX IF NOT EXISTS uniscenario_worker_leases_one_active_node_idx
  ON uniscenario.worker_leases (worker_node_id)
  WHERE lease_state = 'active';

CREATE TABLE IF NOT EXISTS uniscenario.render_worker_credentials (
  id TEXT PRIMARY KEY,
  worker_node_id TEXT NOT NULL REFERENCES uniscenario.worker_nodes(id) ON DELETE CASCADE,
  token_sha256 TEXT NOT NULL CHECK (token_sha256 ~ '^[a-f0-9]{64}$'),
  credential_state TEXT NOT NULL DEFAULT 'active'
    CHECK (credential_state IN ('active', 'revoked')),
  reason TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  revoked_at TIMESTAMPTZ,
  UNIQUE (token_sha256)
);

CREATE UNIQUE INDEX IF NOT EXISTS uniscenario_render_worker_credentials_one_active_node_idx
  ON uniscenario.render_worker_credentials (worker_node_id)
  WHERE credential_state = 'active';

ALTER TABLE uniscenario.render_jobs
  ADD COLUMN IF NOT EXISTS resource_request JSONB,
  ADD COLUMN IF NOT EXISTS parity_evidence_schema TEXT,
  ADD COLUMN IF NOT EXISTS parity_evidence JSONB,
  ADD COLUMN IF NOT EXISTS parity_accepted BOOLEAN;

ALTER TABLE uniscenario.render_jobs
  DROP CONSTRAINT IF EXISTS uniscenario_render_jobs_resource_request_ck,
  ADD CONSTRAINT uniscenario_render_jobs_resource_request_ck
    CHECK (
      resource_request IS NULL OR (
        jsonb_typeof(resource_request) = 'object'
        AND resource_request->>'schema' = 'uniscenario.render-resource-request/v1'
      )
    ) NOT VALID,
  DROP CONSTRAINT IF EXISTS uniscenario_render_jobs_parity_evidence_ck,
  ADD CONSTRAINT uniscenario_render_jobs_parity_evidence_ck
    CHECK (
      (parity_evidence IS NULL AND parity_evidence_schema IS NULL AND parity_accepted IS NULL)
      OR (
        jsonb_typeof(parity_evidence) = 'object'
        AND parity_evidence_schema = 'uniscenario.parity-evidence/v1'
        AND parity_evidence->>'schema' = parity_evidence_schema
        AND parity_accepted = ((parity_evidence->>'verdict') = 'pass')
      )
    ) NOT VALID,
  DROP CONSTRAINT IF EXISTS uniscenario_render_jobs_success_requires_accepted_evidence_ck,
  ADD CONSTRAINT uniscenario_render_jobs_success_requires_accepted_evidence_ck
    CHECK (
      job_state <> 'succeeded' OR (
        parity_accepted IS TRUE
        AND parity_evidence_schema = 'uniscenario.parity-evidence/v1'
        AND parity_evidence IS NOT NULL
      )
    ) NOT VALID;

ALTER TABLE uniscenario.render_attempts
  ADD COLUMN IF NOT EXISTS parity_evidence_schema TEXT,
  ADD COLUMN IF NOT EXISTS parity_evidence JSONB,
  ADD COLUMN IF NOT EXISTS parity_accepted BOOLEAN;

ALTER TABLE uniscenario.render_attempts
  DROP CONSTRAINT IF EXISTS uniscenario_render_attempts_parity_evidence_ck,
  ADD CONSTRAINT uniscenario_render_attempts_parity_evidence_ck
    CHECK (
      (parity_evidence IS NULL AND parity_evidence_schema IS NULL AND parity_accepted IS NULL)
      OR (
        jsonb_typeof(parity_evidence) = 'object'
        AND parity_evidence_schema = 'uniscenario.parity-evidence/v1'
        AND parity_evidence->>'schema' = parity_evidence_schema
        AND parity_accepted = ((parity_evidence->>'verdict') = 'pass')
      )
    ) NOT VALID,
  DROP CONSTRAINT IF EXISTS uniscenario_render_attempts_success_requires_accepted_evidence_ck,
  ADD CONSTRAINT uniscenario_render_attempts_success_requires_accepted_evidence_ck
    CHECK (
      attempt_state <> 'succeeded' OR (
        parity_accepted IS TRUE
        AND parity_evidence_schema = 'uniscenario.parity-evidence/v1'
        AND parity_evidence IS NOT NULL
      )
    ) NOT VALID;

-- The active lease fence is repeated in the database so a future scheduler
-- cannot bypass exact node approval with a weaker query.
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
     OR worker.hardware_profile <> 'rtx3080-10gb-v1'
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

DROP TRIGGER IF EXISTS uniscenario_worker_leases_eligibility_fence
  ON uniscenario.worker_leases;
CREATE TRIGGER uniscenario_worker_leases_eligibility_fence
  BEFORE INSERT OR UPDATE OF lease_state, worker_node_id
  ON uniscenario.worker_leases
  FOR EACH ROW EXECUTE FUNCTION uniscenario.enforce_render_worker_lease_eligibility();

COMMIT;
