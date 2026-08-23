-- Migration 20260804010000: permanent UniScenario domain and independent render control plane
-- Rollback: drop schema uniscenario cascade after proving no UniScenario documents or render artifacts remain.

BEGIN;

CREATE SCHEMA IF NOT EXISTS uniscenario;

CREATE TABLE IF NOT EXISTS uniscenario.map_versions (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  source_map_id TEXT,
  label TEXT NOT NULL,
  locality TEXT,
  browser_manifest_url TEXT NOT NULL,
  topology_artifact_url TEXT NOT NULL,
  xodr_artifact_id TEXT NOT NULL,
  xodr_sha256 TEXT NOT NULL CHECK (xodr_sha256 ~ '^[a-f0-9]{64}$'),
  coordinate_system_id TEXT NOT NULL,
  coordinate_system_sha256 TEXT NOT NULL CHECK (coordinate_system_sha256 ~ '^[a-f0-9]{64}$'),
  descriptor JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_by_user_id TEXT REFERENCES public.ba_user(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  retired_at TIMESTAMPTZ,
  UNIQUE (workspace_id, xodr_sha256, coordinate_system_sha256)
);

CREATE TABLE IF NOT EXISTS uniscenario.documents (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  title TEXT NOT NULL CHECK (char_length(title) BETWEEN 1 AND 200),
  schema_version TEXT NOT NULL,
  map_version_id TEXT REFERENCES uniscenario.map_versions(id) ON DELETE RESTRICT,
  latest_revision_id TEXT,
  created_by_user_id TEXT REFERENCES public.ba_user(id) ON DELETE SET NULL,
  updated_by_user_id TEXT REFERENCES public.ba_user(id) ON DELETE SET NULL,
  deleted_by_user_id TEXT REFERENCES public.ba_user(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  deleted_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS uniscenario_documents_workspace_updated_idx
  ON uniscenario.documents (workspace_id, updated_at DESC, id)
  WHERE deleted_at IS NULL;

CREATE TABLE IF NOT EXISTS uniscenario.drafts (
  document_id TEXT PRIMARY KEY REFERENCES uniscenario.documents(id) ON DELETE CASCADE,
  workspace_id TEXT NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  draft_version BIGINT NOT NULL DEFAULT 1 CHECK (draft_version > 0),
  schema_version TEXT NOT NULL,
  canonical_content JSONB NOT NULL,
  content_sha256 TEXT NOT NULL CHECK (content_sha256 ~ '^[a-f0-9]{64}$'),
  map_version_id TEXT REFERENCES uniscenario.map_versions(id) ON DELETE RESTRICT,
  updated_by_user_id TEXT REFERENCES public.ba_user(id) ON DELETE SET NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK (jsonb_typeof(canonical_content) = 'object'),
  UNIQUE (workspace_id, document_id)
);

CREATE TABLE IF NOT EXISTS uniscenario.revisions (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  document_id TEXT NOT NULL REFERENCES uniscenario.documents(id) ON DELETE CASCADE,
  revision_number BIGINT NOT NULL CHECK (revision_number > 0),
  source_draft_version BIGINT NOT NULL CHECK (source_draft_version > 0),
  schema_version TEXT NOT NULL,
  canonical_content JSONB NOT NULL,
  content_sha256 TEXT NOT NULL CHECK (content_sha256 ~ '^[a-f0-9]{64}$'),
  map_version_id TEXT REFERENCES uniscenario.map_versions(id) ON DELETE RESTRICT,
  compiler_version TEXT NOT NULL,
  openscenario_profile TEXT NOT NULL DEFAULT 'ASAM OpenSCENARIO XML 1.4',
  capability_report JSONB NOT NULL DEFAULT '{}'::jsonb,
  provenance JSONB NOT NULL DEFAULT '{}'::jsonb,
  idempotency_key TEXT,
  created_by_user_id TEXT REFERENCES public.ba_user(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK (jsonb_typeof(canonical_content) = 'object'),
  UNIQUE (workspace_id, document_id, revision_number),
  UNIQUE (workspace_id, document_id, source_draft_version),
  UNIQUE (workspace_id, document_id, idempotency_key)
);

CREATE INDEX IF NOT EXISTS uniscenario_revisions_document_created_idx
  ON uniscenario.revisions (workspace_id, document_id, revision_number DESC);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'uniscenario_documents_latest_revision_fk'
  ) THEN
    ALTER TABLE uniscenario.documents
      ADD CONSTRAINT uniscenario_documents_latest_revision_fk
      FOREIGN KEY (latest_revision_id) REFERENCES uniscenario.revisions(id) ON DELETE SET NULL;
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS uniscenario.artifacts (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  revision_id TEXT REFERENCES uniscenario.revisions(id) ON DELETE CASCADE,
  artifact_kind TEXT NOT NULL,
  media_type TEXT NOT NULL,
  storage_bucket TEXT NOT NULL,
  storage_key TEXT NOT NULL,
  sha256 TEXT NOT NULL CHECK (sha256 ~ '^[a-f0-9]{64}$'),
  byte_length BIGINT NOT NULL CHECK (byte_length >= 0),
  artifact_state TEXT NOT NULL DEFAULT 'pending'
    CHECK (artifact_state IN ('pending', 'available', 'quarantined', 'deleted')),
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_by_user_id TEXT REFERENCES public.ba_user(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  verified_at TIMESTAMPTZ,
  deleted_at TIMESTAMPTZ,
  UNIQUE (storage_bucket, storage_key),
  UNIQUE (workspace_id, sha256, artifact_kind)
);

CREATE INDEX IF NOT EXISTS uniscenario_artifacts_revision_idx
  ON uniscenario.artifacts (workspace_id, revision_id, created_at DESC)
  WHERE deleted_at IS NULL;

CREATE TABLE IF NOT EXISTS uniscenario.exports (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  revision_id TEXT NOT NULL REFERENCES uniscenario.revisions(id) ON DELETE CASCADE,
  export_format TEXT NOT NULL CHECK (export_format IN ('openscenario_xml_1_4')),
  export_state TEXT NOT NULL DEFAULT 'queued'
    CHECK (export_state IN ('queued', 'running', 'succeeded', 'failed', 'cancelled')),
  artifact_id TEXT REFERENCES uniscenario.artifacts(id) ON DELETE RESTRICT,
  compiler_version TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  error_code TEXT,
  error_detail JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  started_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  UNIQUE (workspace_id, revision_id, export_format, idempotency_key)
);

CREATE TABLE IF NOT EXISTS uniscenario.validation_runs (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  revision_id TEXT NOT NULL REFERENCES uniscenario.revisions(id) ON DELETE CASCADE,
  validator_kind TEXT NOT NULL,
  validator_version TEXT NOT NULL,
  validation_state TEXT NOT NULL DEFAULT 'queued'
    CHECK (validation_state IN ('queued', 'running', 'passed', 'failed', 'cancelled')),
  report_artifact_id TEXT REFERENCES uniscenario.artifacts(id) ON DELETE RESTRICT,
  summary JSONB NOT NULL DEFAULT '{}'::jsonb,
  idempotency_key TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  started_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  UNIQUE (workspace_id, revision_id, validator_kind, idempotency_key)
);

CREATE TABLE IF NOT EXISTS uniscenario.execution_packages (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  revision_id TEXT NOT NULL REFERENCES uniscenario.revisions(id) ON DELETE CASCADE,
  xosc_artifact_id TEXT NOT NULL REFERENCES uniscenario.artifacts(id) ON DELETE RESTRICT,
  xodr_artifact_id TEXT NOT NULL REFERENCES uniscenario.artifacts(id) ON DELETE RESTRICT,
  asset_catalog_artifact_id TEXT REFERENCES uniscenario.artifacts(id) ON DELETE RESTRICT,
  package_artifact_id TEXT NOT NULL REFERENCES uniscenario.artifacts(id) ON DELETE RESTRICT,
  manifest_sha256 TEXT NOT NULL CHECK (manifest_sha256 ~ '^[a-f0-9]{64}$'),
  xsd_sha256 TEXT NOT NULL CHECK (xsd_sha256 ~ '^[a-f0-9]{64}$'),
  runtime_contract_version TEXT NOT NULL,
  compiler_version TEXT NOT NULL,
  capability_profile TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (workspace_id, revision_id, manifest_sha256)
);

ALTER TABLE uniscenario.exports
  ADD COLUMN IF NOT EXISTS execution_package_id TEXT;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'uniscenario_exports_execution_package_fk'
  ) THEN
    ALTER TABLE uniscenario.exports
      ADD CONSTRAINT uniscenario_exports_execution_package_fk
      FOREIGN KEY (execution_package_id) REFERENCES uniscenario.execution_packages(id) ON DELETE RESTRICT;
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS uniscenario.render_profiles (
  id TEXT PRIMARY KEY,
  workspace_id TEXT REFERENCES public.workspaces(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  profile_version BIGINT NOT NULL DEFAULT 1 CHECK (profile_version > 0),
  render_spec JSONB NOT NULL,
  render_spec_sha256 TEXT NOT NULL CHECK (render_spec_sha256 ~ '^[a-f0-9]{64}$'),
  created_by_user_id TEXT REFERENCES public.ba_user(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  retired_at TIMESTAMPTZ,
  CHECK (jsonb_typeof(render_spec) = 'object'),
  UNIQUE (workspace_id, name, profile_version)
);

CREATE TABLE IF NOT EXISTS uniscenario.render_jobs (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  revision_id TEXT NOT NULL REFERENCES uniscenario.revisions(id) ON DELETE RESTRICT,
  execution_package_id TEXT NOT NULL REFERENCES uniscenario.execution_packages(id) ON DELETE RESTRICT,
  render_profile_id TEXT REFERENCES uniscenario.render_profiles(id) ON DELETE RESTRICT,
  render_spec JSONB NOT NULL,
  render_spec_sha256 TEXT NOT NULL CHECK (render_spec_sha256 ~ '^[a-f0-9]{64}$'),
  parity_thresholds JSONB,
  request_contract_version TEXT NOT NULL,
  job_state TEXT NOT NULL DEFAULT 'queued'
    CHECK (job_state IN ('queued', 'leased', 'running', 'succeeded', 'failed', 'cancelled')),
  priority SMALLINT NOT NULL DEFAULT 0 CHECK (priority BETWEEN -100 AND 100),
  attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  max_attempts INTEGER NOT NULL DEFAULT 3 CHECK (max_attempts BETWEEN 1 AND 20),
  idempotency_key TEXT NOT NULL,
  requested_by_user_id TEXT REFERENCES public.ba_user(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  started_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  cancel_requested_at TIMESTAMPTZ,
  failure_code TEXT,
  failure_detail JSONB,
  CHECK (jsonb_typeof(render_spec) = 'object'),
  CHECK (parity_thresholds IS NULL OR jsonb_typeof(parity_thresholds) = 'object'),
  UNIQUE (workspace_id, idempotency_key)
);

CREATE INDEX IF NOT EXISTS uniscenario_render_jobs_claim_idx
  ON uniscenario.render_jobs (priority DESC, created_at, id)
  WHERE job_state = 'queued' AND cancel_requested_at IS NULL;

CREATE INDEX IF NOT EXISTS uniscenario_render_jobs_workspace_idx
  ON uniscenario.render_jobs (workspace_id, created_at DESC, id);

CREATE TABLE IF NOT EXISTS uniscenario.render_attempts (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  render_job_id TEXT NOT NULL REFERENCES uniscenario.render_jobs(id) ON DELETE CASCADE,
  attempt_number INTEGER NOT NULL CHECK (attempt_number > 0),
  worker_node_id TEXT NOT NULL,
  attempt_state TEXT NOT NULL DEFAULT 'leased'
    CHECK (attempt_state IN ('leased', 'running', 'succeeded', 'failed', 'expired', 'cancelled')),
  runtime_version TEXT,
  image_digest TEXT,
  metrics JSONB NOT NULL DEFAULT '{}'::jsonb,
  leased_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  started_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  UNIQUE (render_job_id, attempt_number)
);

CREATE TABLE IF NOT EXISTS uniscenario.worker_nodes (
  id TEXT PRIMARY KEY,
  environment TEXT NOT NULL CHECK (environment IN ('dev', 'staging', 'prod')),
  worker_version TEXT NOT NULL,
  image_digest TEXT NOT NULL,
  capabilities JSONB NOT NULL,
  registration_state TEXT NOT NULL DEFAULT 'active'
    CHECK (registration_state IN ('active', 'draining', 'disabled')),
  registered_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_heartbeat_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  CHECK (jsonb_typeof(capabilities) = 'object')
);

CREATE TABLE IF NOT EXISTS uniscenario.worker_leases (
  id TEXT PRIMARY KEY,
  render_job_id TEXT NOT NULL REFERENCES uniscenario.render_jobs(id) ON DELETE CASCADE,
  render_attempt_id TEXT NOT NULL REFERENCES uniscenario.render_attempts(id) ON DELETE CASCADE,
  worker_node_id TEXT NOT NULL REFERENCES uniscenario.worker_nodes(id) ON DELETE RESTRICT,
  lease_token_sha256 TEXT NOT NULL CHECK (lease_token_sha256 ~ '^[a-f0-9]{64}$'),
  lease_state TEXT NOT NULL DEFAULT 'active'
    CHECK (lease_state IN ('active', 'released', 'expired', 'revoked')),
  leased_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  heartbeat_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at TIMESTAMPTZ NOT NULL,
  released_at TIMESTAMPTZ,
  UNIQUE (render_attempt_id),
  UNIQUE (lease_token_sha256)
);

CREATE UNIQUE INDEX IF NOT EXISTS uniscenario_worker_leases_one_active_job_idx
  ON uniscenario.worker_leases (render_job_id)
  WHERE lease_state = 'active';

CREATE TABLE IF NOT EXISTS uniscenario.artifact_uploads (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  revision_id TEXT REFERENCES uniscenario.revisions(id) ON DELETE CASCADE,
  render_job_id TEXT REFERENCES uniscenario.render_jobs(id) ON DELETE CASCADE,
  render_attempt_id TEXT REFERENCES uniscenario.render_attempts(id) ON DELETE CASCADE,
  artifact_kind TEXT NOT NULL,
  media_type TEXT NOT NULL,
  storage_bucket TEXT NOT NULL,
  storage_key TEXT NOT NULL,
  upload_state TEXT NOT NULL DEFAULT 'reserved'
    CHECK (upload_state IN ('reserved', 'uploaded', 'expired', 'cancelled')),
  completed_artifact_id TEXT REFERENCES uniscenario.artifacts(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at TIMESTAMPTZ NOT NULL,
  completed_at TIMESTAMPTZ,
  CHECK (revision_id IS NOT NULL OR render_job_id IS NOT NULL),
  UNIQUE (storage_bucket, storage_key),
  UNIQUE (render_attempt_id, artifact_kind)
);

CREATE TABLE IF NOT EXISTS uniscenario.job_events (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  render_job_id TEXT NOT NULL REFERENCES uniscenario.render_jobs(id) ON DELETE CASCADE,
  render_attempt_id TEXT REFERENCES uniscenario.render_attempts(id) ON DELETE CASCADE,
  event_ordinal BIGINT NOT NULL CHECK (event_ordinal > 0),
  event_type TEXT NOT NULL,
  event_payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  occurred_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (render_job_id, event_ordinal)
);

CREATE INDEX IF NOT EXISTS uniscenario_job_events_job_idx
  ON uniscenario.job_events (workspace_id, render_job_id, event_ordinal);

CREATE TABLE IF NOT EXISTS uniscenario.artifact_links (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  artifact_id TEXT NOT NULL REFERENCES uniscenario.artifacts(id) ON DELETE CASCADE,
  render_job_id TEXT REFERENCES uniscenario.render_jobs(id) ON DELETE CASCADE,
  render_attempt_id TEXT REFERENCES uniscenario.render_attempts(id) ON DELETE CASCADE,
  relationship TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK (render_job_id IS NOT NULL OR render_attempt_id IS NOT NULL),
  UNIQUE (artifact_id, render_job_id, render_attempt_id, relationship)
);

CREATE TABLE IF NOT EXISTS uniscenario.dataset_items (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  dataset_id TEXT NOT NULL,
  revision_id TEXT NOT NULL REFERENCES uniscenario.revisions(id) ON DELETE RESTRICT,
  render_job_id TEXT REFERENCES uniscenario.render_jobs(id) ON DELETE SET NULL,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_by_user_id TEXT REFERENCES public.ba_user(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (workspace_id, dataset_id, revision_id, render_job_id)
);

COMMIT;
