-- Migration 20260824180000: SimForge model registry and run ledger.
--
-- New `simforge` schema (like `asset_gallery`, deliberately OUTSIDE the frozen
-- `uniscenario.*` wire surface — see docs/engineering/simcloud-sync.md): a
-- studio-local registry of model checkpoints (`model_versions`), how each one
-- is served (`model_endpoints`), and an append-only execution ledger
-- (`model_runs` + `model_run_attempts` + `model_run_events`).
--
-- Ledger rules enforced here rather than in the store so no code path can
-- bypass them:
--   * a run row is frozen once it reaches a terminal status (succeeded/failed);
--   * attempts are append-only: they finish exactly once and are never deleted;
--   * events are append-only;
--   * promoting a version requires a reference to a SUCCEEDED evaluation run
--     (openloop or policy_episode) of that same version.
--
-- Rollback: drop the triggers, functions, tables, then the schema.

BEGIN;

CREATE SCHEMA IF NOT EXISTS simforge;

CREATE TABLE simforge.model_versions (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  family TEXT NOT NULL CHECK (family ~ '^[a-z0-9][a-z0-9_.-]*$'),
  name TEXT NOT NULL CHECK (BTRIM(name) <> ''),
  -- Where the checkpoint comes from: HF repo id, local path, or URL.
  source TEXT NOT NULL CHECK (BTRIM(source) <> ''),
  checkpoint_digest TEXT NOT NULL CHECK (checkpoint_digest ~ '^[a-f0-9]{64}$'),
  quant TEXT NOT NULL DEFAULT 'none' CHECK (quant IN ('none', 'fp16', 'bf16', 'int8', 'nf4', 'gptq', 'awq')),
  license TEXT NOT NULL DEFAULT 'unknown' CHECK (BTRIM(license) <> ''),
  status TEXT NOT NULL DEFAULT 'registered'
    CHECK (status IN ('registered', 'validating', 'promoted', 'retired')),
  -- Set when status becomes 'promoted'; the trigger below requires it to be a
  -- succeeded evaluation run of this version. FK added after model_runs exists.
  promoted_run_id TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (workspace_id, family, checkpoint_digest, quant)
);

CREATE INDEX simforge_model_versions_family_idx
  ON simforge.model_versions (workspace_id, family, created_at DESC);

CREATE TABLE simforge.model_endpoints (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  model_version_id TEXT NOT NULL REFERENCES simforge.model_versions(id) ON DELETE CASCADE,
  name TEXT NOT NULL CHECK (BTRIM(name) <> ''),
  kind TEXT NOT NULL CHECK (kind IN ('process', 'socket')),
  -- process: argv the worker spawns, e.g. ["bash","adapters/alpamayo/scripts/run_server.sh",...]
  command_json JSONB CHECK (command_json IS NULL OR jsonb_typeof(command_json) = 'array'),
  cwd TEXT,
  env_json JSONB NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(env_json) = 'object'),
  -- socket: path of an already-running unix socket the worker connects to.
  socket_path TEXT,
  -- {"kind":"http","path":"/healthz"} | {"kind":"stdout","pattern":"^READY "} | {"kind":"socket"}
  health_json JSONB NOT NULL CHECK (jsonb_typeof(health_json) = 'object'),
  -- {"kind":"http-json","path":"/invoke"} | {"kind":"unix-msgpack","op":"act"}
  invoke_json JSONB NOT NULL CHECK (jsonb_typeof(invoke_json) = 'object'),
  enabled BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (model_version_id, name),
  CONSTRAINT simforge_model_endpoints_kind_shape_check CHECK (
    (kind = 'process' AND command_json IS NOT NULL)
    OR (kind = 'socket' AND NULLIF(BTRIM(socket_path), '') IS NOT NULL)
  )
);

CREATE TABLE simforge.model_runs (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  model_version_id TEXT NOT NULL REFERENCES simforge.model_versions(id) ON DELETE CASCADE,
  endpoint_id TEXT NOT NULL REFERENCES simforge.model_endpoints(id),
  kind TEXT NOT NULL CHECK (kind IN ('openloop', 'policy_episode', 'artifact')),
  status TEXT NOT NULL DEFAULT 'queued'
    CHECK (status IN ('queued', 'running', 'succeeded', 'failed')),
  params_json JSONB NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(params_json) = 'object'),
  seed BIGINT NOT NULL DEFAULT 0,
  -- Snapshot of the endpoint descriptor, written by the FIRST lease and reused
  -- verbatim by every retry so a run is reproducible even if the endpoint row
  -- is edited later.
  resolved_descriptor_json JSONB
    CHECK (resolved_descriptor_json IS NULL OR jsonb_typeof(resolved_descriptor_json) = 'object'),
  metrics_json JSONB CHECK (metrics_json IS NULL OR jsonb_typeof(metrics_json) = 'object'),
  output_refs JSONB NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(output_refs) = 'array'),
  attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  max_attempts INTEGER NOT NULL DEFAULT 3 CHECK (max_attempts BETWEEN 1 AND 20),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  started_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ
);

CREATE INDEX simforge_model_runs_claim_idx
  ON simforge.model_runs (kind, created_at, id)
  WHERE status = 'queued';

CREATE INDEX simforge_model_runs_version_idx
  ON simforge.model_runs (workspace_id, model_version_id, created_at DESC);

ALTER TABLE simforge.model_versions
  ADD CONSTRAINT simforge_model_versions_promoted_run_fk
    FOREIGN KEY (promoted_run_id) REFERENCES simforge.model_runs(id);

CREATE TABLE simforge.model_run_attempts (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  run_id TEXT NOT NULL REFERENCES simforge.model_runs(id) ON DELETE CASCADE,
  attempt_number INTEGER NOT NULL CHECK (attempt_number > 0),
  worker_id TEXT NOT NULL CHECK (BTRIM(worker_id) <> ''),
  state TEXT NOT NULL DEFAULT 'active' CHECK (state IN ('active', 'succeeded', 'failed')),
  resolved_descriptor_json JSONB NOT NULL CHECK (jsonb_typeof(resolved_descriptor_json) = 'object'),
  started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  finished_at TIMESTAMPTZ,
  error_code TEXT,
  error_detail JSONB CHECK (error_detail IS NULL OR jsonb_typeof(error_detail) = 'object'),
  UNIQUE (run_id, attempt_number),
  CONSTRAINT simforge_model_run_attempts_finished_shape_check CHECK (
    (state = 'active' AND finished_at IS NULL AND error_code IS NULL)
    OR (state = 'succeeded' AND finished_at IS NOT NULL AND error_code IS NULL)
    OR (state = 'failed' AND finished_at IS NOT NULL AND error_code IS NOT NULL)
  )
);

CREATE UNIQUE INDEX simforge_model_run_attempts_one_active_idx
  ON simforge.model_run_attempts (run_id)
  WHERE state = 'active';

CREATE TABLE simforge.model_run_events (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  run_id TEXT NOT NULL REFERENCES simforge.model_runs(id) ON DELETE CASCADE,
  attempt_id TEXT REFERENCES simforge.model_run_attempts(id),
  event_ordinal BIGINT NOT NULL CHECK (event_ordinal > 0),
  event_type TEXT NOT NULL CHECK (BTRIM(event_type) <> ''),
  event_payload JSONB NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(event_payload) = 'object'),
  occurred_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (run_id, event_ordinal)
);

-- Run rows freeze at a terminal status.
CREATE FUNCTION simforge.enforce_model_run_terminal_immutable()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF OLD.status IN ('succeeded', 'failed') THEN
    RAISE EXCEPTION 'model_run_terminal_immutable: run % is % and cannot be %',
      OLD.id, OLD.status, LOWER(TG_OP);
  END IF;
  IF TG_OP = 'UPDATE' THEN
    -- Identity and request fields never change, terminal or not.
    IF NEW.id IS DISTINCT FROM OLD.id
      OR NEW.workspace_id IS DISTINCT FROM OLD.workspace_id
      OR NEW.model_version_id IS DISTINCT FROM OLD.model_version_id
      OR NEW.endpoint_id IS DISTINCT FROM OLD.endpoint_id
      OR NEW.kind IS DISTINCT FROM OLD.kind
      OR NEW.params_json IS DISTINCT FROM OLD.params_json
      OR NEW.seed IS DISTINCT FROM OLD.seed
      OR NEW.created_at IS DISTINCT FROM OLD.created_at
    THEN
      RAISE EXCEPTION 'model_run_request_immutable: run % request fields cannot change', OLD.id;
    END IF;
    -- The descriptor is resolved exactly once.
    IF OLD.resolved_descriptor_json IS NOT NULL
      AND NEW.resolved_descriptor_json IS DISTINCT FROM OLD.resolved_descriptor_json
    THEN
      RAISE EXCEPTION 'model_run_descriptor_resolved_once: run % descriptor already resolved', OLD.id;
    END IF;
    RETURN NEW;
  END IF;
  RETURN OLD;
END;
$$;

CREATE TRIGGER simforge_model_runs_terminal_freeze
BEFORE UPDATE OR DELETE ON simforge.model_runs
FOR EACH ROW EXECUTE FUNCTION simforge.enforce_model_run_terminal_immutable();

-- Attempts are append-only: created active, finished exactly once, never deleted.
CREATE FUNCTION simforge.enforce_model_run_attempt_append_only()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'model_run_attempt_append_only: attempt % cannot be deleted', OLD.id;
  END IF;
  IF OLD.state <> 'active' THEN
    RAISE EXCEPTION 'model_run_attempt_append_only: attempt % already finished as %', OLD.id, OLD.state;
  END IF;
  IF NEW.id IS DISTINCT FROM OLD.id
    OR NEW.workspace_id IS DISTINCT FROM OLD.workspace_id
    OR NEW.run_id IS DISTINCT FROM OLD.run_id
    OR NEW.attempt_number IS DISTINCT FROM OLD.attempt_number
    OR NEW.worker_id IS DISTINCT FROM OLD.worker_id
    OR NEW.resolved_descriptor_json IS DISTINCT FROM OLD.resolved_descriptor_json
    OR NEW.started_at IS DISTINCT FROM OLD.started_at
  THEN
    RAISE EXCEPTION 'model_run_attempt_identity_immutable: attempt % identity cannot change', OLD.id;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER simforge_model_run_attempts_append_only
BEFORE UPDATE OR DELETE ON simforge.model_run_attempts
FOR EACH ROW EXECUTE FUNCTION simforge.enforce_model_run_attempt_append_only();

-- Events are append-only.
CREATE FUNCTION simforge.enforce_model_run_event_append_only()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'model_run_event_append_only: event % cannot be %', OLD.id, LOWER(TG_OP);
END;
$$;

CREATE TRIGGER simforge_model_run_events_append_only
BEFORE UPDATE OR DELETE ON simforge.model_run_events
FOR EACH ROW EXECUTE FUNCTION simforge.enforce_model_run_event_append_only();

-- Promotion requires a succeeded evaluation run of the same version.
CREATE FUNCTION simforge.enforce_model_version_promotion_evidence()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.status = 'promoted' THEN
    IF NEW.promoted_run_id IS NULL THEN
      RAISE EXCEPTION 'model_version_promotion_requires_run: version % has no promoted_run_id', NEW.id;
    END IF;
    IF NOT EXISTS (
      SELECT 1 FROM simforge.model_runs r
      WHERE r.id = NEW.promoted_run_id
        AND r.model_version_id = NEW.id
        AND r.status = 'succeeded'
        AND r.kind IN ('openloop', 'policy_episode')
    ) THEN
      RAISE EXCEPTION
        'model_version_promotion_requires_succeeded_eval: run % is not a succeeded openloop/policy_episode run of version %',
        NEW.promoted_run_id, NEW.id;
    END IF;
  ELSIF NEW.promoted_run_id IS NOT NULL AND TG_OP = 'INSERT' THEN
    RAISE EXCEPTION 'model_version_promoted_run_requires_promotion: version % is not promoted', NEW.id;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER simforge_model_versions_promotion_evidence
BEFORE INSERT OR UPDATE OF status, promoted_run_id ON simforge.model_versions
FOR EACH ROW EXECUTE FUNCTION simforge.enforce_model_version_promotion_evidence();

COMMIT;
