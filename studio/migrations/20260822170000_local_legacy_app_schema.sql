BEGIN;

-- Copied from upstream 0000_auth_workspace_baseline.sql.
CREATE TABLE IF NOT EXISTS public.ba_invitation (
  id TEXT PRIMARY KEY,
  "organizationId" TEXT NOT NULL REFERENCES public.ba_organization(id) ON DELETE CASCADE,
  email TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'member',
  status TEXT NOT NULL DEFAULT 'pending',
  "expiresAt" TIMESTAMPTZ NOT NULL,
  "createdAt" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  "inviterId" TEXT NOT NULL REFERENCES public.ba_user(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_ba_invitation_email_status
  ON public.ba_invitation (lower(email), status);
CREATE INDEX IF NOT EXISTS idx_ba_invitation_organization_status
  ON public.ba_invitation ("organizationId", status, "createdAt" DESC);
CREATE UNIQUE INDEX IF NOT EXISTS idx_ba_invitation_pending_email
  ON public.ba_invitation ("organizationId", lower(email)) WHERE status = 'pending';

-- Copied from upstream .archive/0010_workspace_projects.sql.
CREATE TABLE IF NOT EXISTS public.projects (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  description TEXT,
  icon TEXT,
  color TEXT,
  is_default BOOLEAN NOT NULL DEFAULT FALSE,
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_by_user_id TEXT REFERENCES public.ba_user(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (workspace_id, name),
  UNIQUE (id, workspace_id)
);
CREATE INDEX IF NOT EXISTS idx_projects_workspace ON public.projects(workspace_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_projects_default_per_workspace
  ON public.projects(workspace_id) WHERE is_default;

-- local-synthesized: no tracked DDL upstream
-- The upstream history starts by renaming an already-live simulation_runs table.
CREATE TABLE IF NOT EXISTS public.scenarios (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  project_id TEXT,
  dataset_id TEXT,
  parent_scenario_id TEXT,
  map_asset_id TEXT REFERENCES public.map_assets(id) ON DELETE SET NULL,
  runtime TEXT NOT NULL DEFAULT 'carla',
  display_name TEXT NOT NULL DEFAULT 'Untitled Scenario',
  description TEXT,
  status TEXT NOT NULL DEFAULT 'draft',
  draft_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  variation_params JSONB,
  mutability TEXT NOT NULL DEFAULT 'editable',
  copy_policy TEXT NOT NULL DEFAULT 'allowed',
  source_scenario_id TEXT,
  source_dataset_id TEXT,
  source_workspace_id TEXT,
  copy_kind TEXT,
  copied_by_user_id TEXT REFERENCES public.ba_user(id) ON DELETE SET NULL,
  copied_at TIMESTAMPTZ,
  source_kind TEXT NOT NULL DEFAULT 'native',
  scenario_source_id TEXT,
  ego_selector JSONB,
  created_by_user_id TEXT REFERENCES public.ba_user(id) ON DELETE SET NULL,
  updated_by_user_id TEXT REFERENCES public.ba_user(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  summary_map_name TEXT GENERATED ALWAYS AS (
    COALESCE(NULLIF(BTRIM(draft_json->'setup'->'map'->>'mapName'), ''),
             NULLIF(BTRIM(draft_json->'metadata'->>'mapName'), ''),
             NULLIF(BTRIM(draft_json->>'map_name'), ''))
  ) STORED,
  summary_backend_map_name TEXT GENERATED ALWAYS AS (
    COALESCE(NULLIF(BTRIM(draft_json->'setup'->'map'->>'backendMapName'), ''),
             NULLIF(BTRIM(draft_json->'metadata'->>'backendMapName'), ''),
             NULLIF(BTRIM(draft_json->>'backend_map_name'), ''),
             NULLIF(BTRIM(draft_json->>'map_name'), ''))
  ) STORED,
  summary_actor_count INTEGER GENERATED ALWAYS AS (
    CASE WHEN jsonb_typeof(COALESCE(draft_json->'setup'->'scene'->'actors', draft_json->'actors', '[]'::jsonb)) = 'array'
      THEN jsonb_array_length(COALESCE(draft_json->'setup'->'scene'->'actors', draft_json->'actors', '[]'::jsonb))
      ELSE 0 END
  ) STORED,
  scenario_metadata JSONB GENERATED ALWAYS AS (
    COALESCE(draft_json #> '{setup,metadata,scenarioMetadata}', draft_json #> '{metadata,scenarioMetadata}')
  ) STORED,
  UNIQUE (id, workspace_id),
  FOREIGN KEY (project_id, workspace_id) REFERENCES public.projects(id, workspace_id) ON DELETE SET NULL,
  FOREIGN KEY (parent_scenario_id) REFERENCES public.scenarios(id) ON DELETE SET NULL,
  FOREIGN KEY (source_scenario_id) REFERENCES public.scenarios(id) ON DELETE SET NULL
);
CREATE INDEX IF NOT EXISTS idx_scenarios_workspace_created ON public.scenarios(workspace_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_scenarios_map_asset ON public.scenarios(map_asset_id);
CREATE INDEX IF NOT EXISTS idx_scenarios_parent ON public.scenarios(workspace_id, parent_scenario_id) WHERE parent_scenario_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_scenarios_metadata_tags ON public.scenarios USING GIN ((scenario_metadata -> 'tags')) WHERE scenario_metadata IS NOT NULL;

-- Copied from upstream .archive/0026_datasets.sql plus the tracked sharing,
-- governance, and browse-stat columns consumed by the current app.
CREATE TABLE IF NOT EXISTS public.datasets (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  description TEXT,
  base_scenario_id TEXT REFERENCES public.scenarios(id) ON DELETE SET NULL,
  variation_config JSONB,
  status TEXT NOT NULL DEFAULT 'pending',
  total_variations INTEGER NOT NULL DEFAULT 0,
  completed_variations INTEGER NOT NULL DEFAULT 0,
  failed_variations INTEGER NOT NULL DEFAULT 0,
  created_by_user_id TEXT REFERENCES public.ba_user(id) ON DELETE SET NULL,
  scope TEXT NOT NULL DEFAULT 'workspace',
  mutability TEXT NOT NULL DEFAULT 'editable',
  copy_policy TEXT NOT NULL DEFAULT 'allowed',
  system_slug TEXT,
  is_system BOOLEAN NOT NULL DEFAULT FALSE,
  is_default BOOLEAN NOT NULL DEFAULT FALSE,
  sensitivity TEXT NOT NULL DEFAULT 'internal',
  pii_types JSONB NOT NULL DEFAULT '[]'::jsonb,
  use_restrictions JSONB NOT NULL DEFAULT '[]'::jsonb,
  retention_policy TEXT NOT NULL DEFAULT 'standard',
  retention_expires_at TIMESTAMPTZ,
  training_allowed BOOLEAN NOT NULL DEFAULT TRUE,
  export_allowed BOOLEAN NOT NULL DEFAULT TRUE,
  snapshot_allowed BOOLEAN NOT NULL DEFAULT TRUE,
  policy_notes TEXT,
  stats_scenario_count INTEGER NOT NULL DEFAULT 0,
  stats_render_submitted_count INTEGER NOT NULL DEFAULT 0,
  stats_render_completed_count INTEGER NOT NULL DEFAULT 0,
  stats_cosmos_submitted_count INTEGER NOT NULL DEFAULT 0,
  stats_cosmos_completed_count INTEGER NOT NULL DEFAULT 0,
  stats_model_submitted_count INTEGER NOT NULL DEFAULT 0,
  stats_model_completed_count INTEGER NOT NULL DEFAULT 0,
  stats_export_completed_count INTEGER NOT NULL DEFAULT 0,
  stats_updated_at TIMESTAMPTZ,
  stats_repair_state TEXT NOT NULL DEFAULT 'healthy',
  stats_version INTEGER NOT NULL DEFAULT 1,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (id, workspace_id),
  CHECK (jsonb_typeof(pii_types) = 'array' AND jsonb_typeof(use_restrictions) = 'array')
);
ALTER TABLE public.scenarios
  ADD CONSTRAINT scenarios_dataset_fk FOREIGN KEY (dataset_id) REFERENCES public.datasets(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS idx_datasets_workspace ON public.datasets(workspace_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_datasets_workspace_default
  ON public.datasets(workspace_id) WHERE is_default;
CREATE INDEX IF NOT EXISTS idx_scenarios_dataset ON public.scenarios(dataset_id);

-- Copied from upstream 0067_editor_documents_dataset_scenarios.sql and
-- 20260529030000_dataset_scenarios_updated_by_user.sql.
CREATE TABLE IF NOT EXISTS public.dataset_scenarios (
  workspace_id TEXT NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  dataset_id TEXT NOT NULL REFERENCES public.datasets(id) ON DELETE CASCADE,
  scenario_id TEXT NOT NULL REFERENCES public.scenarios(id) ON DELETE CASCADE,
  role TEXT NOT NULL DEFAULT 'source',
  sort_order INTEGER NOT NULL DEFAULT 0,
  added_by_user_id TEXT REFERENCES public.ba_user(id) ON DELETE SET NULL,
  updated_by_user_id TEXT REFERENCES public.ba_user(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (dataset_id, scenario_id),
  CHECK (BTRIM(role) <> '')
);
CREATE INDEX IF NOT EXISTS idx_dataset_scenarios_dataset
  ON public.dataset_scenarios(workspace_id, dataset_id, sort_order, created_at);
CREATE INDEX IF NOT EXISTS idx_dataset_scenarios_scenario
  ON public.dataset_scenarios(workspace_id, scenario_id, created_at DESC);

-- Copied from upstream .archive/0044_canonical_artifacts_and_dataset_snapshots.sql
-- and 0075_dataset_governance_policy.sql.
CREATE TABLE IF NOT EXISTS public.dataset_snapshots (
  id TEXT PRIMARY KEY,
  dataset_id TEXT NOT NULL REFERENCES public.datasets(id) ON DELETE CASCADE,
  workspace_id TEXT NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  source_query_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  summary_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  policy_snapshot_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_by_job_family TEXT,
  created_by_job_id TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_dataset_snapshots_dataset_created
  ON public.dataset_snapshots(workspace_id, dataset_id, created_at DESC);

-- Copied from upstream .archive/0044_canonical_artifacts_and_dataset_snapshots.sql.
CREATE TABLE IF NOT EXISTS public.artifacts (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  artifact_family TEXT NOT NULL,
  artifact_type TEXT NOT NULL,
  modality TEXT,
  producer_job_family TEXT,
  producer_job_id TEXT,
  source_artifact_id TEXT REFERENCES public.artifacts(id) ON DELETE SET NULL,
  scenario_id TEXT REFERENCES public.scenarios(id) ON DELETE SET NULL,
  simulation_id TEXT,
  sensor_id TEXT,
  sensor_label TEXT,
  sensor_category TEXT,
  output_modality TEXT,
  sequence_id TEXT,
  frame_index INTEGER,
  timestamp_seconds DOUBLE PRECISION,
  dataset_snapshot_id TEXT REFERENCES public.dataset_snapshots(id) ON DELETE SET NULL,
  s3_bucket TEXT NOT NULL,
  s3_key TEXT,
  s3_prefix TEXT,
  content_type TEXT,
  size_bytes BIGINT,
  checksum_sha256 TEXT,
  is_raw BOOLEAN NOT NULL DEFAULT TRUE,
  status TEXT NOT NULL DEFAULT 'ready',
  retention_class TEXT NOT NULL DEFAULT 'raw_source',
  encoding_lossless BOOLEAN,
  lossy_reason TEXT,
  metadata_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK (s3_key IS NOT NULL OR s3_prefix IS NOT NULL)
);
CREATE INDEX IF NOT EXISTS idx_artifacts_workspace_created ON public.artifacts(workspace_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_artifacts_scenario ON public.artifacts(workspace_id, scenario_id);

-- Copied from upstream 0052_pipeline_runs.sql and 0082_pipeline_run_item_output_refs.sql.
CREATE TABLE IF NOT EXISTS public.pipeline_runs (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  dataset_id TEXT NOT NULL REFERENCES public.datasets(id) ON DELETE CASCADE,
  name TEXT,
  scope_scenario_ids JSONB NOT NULL DEFAULT '[]'::jsonb,
  stages_enabled JSONB NOT NULL DEFAULT '[]'::jsonb,
  config_snapshot JSONB NOT NULL DEFAULT '{}'::jsonb,
  estimated_cost_cents INTEGER NOT NULL DEFAULT 0,
  credits_held INTEGER NOT NULL DEFAULT 0,
  credits_settled_cents INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'dispatching',
  cancel_requested_at TIMESTAMPTZ,
  created_by_user_id TEXT REFERENCES public.ba_user(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE TABLE IF NOT EXISTS public.pipeline_run_items (
  id TEXT PRIMARY KEY,
  pipeline_run_id TEXT NOT NULL REFERENCES public.pipeline_runs(id) ON DELETE CASCADE,
  workspace_id TEXT NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  scenario_id TEXT NOT NULL REFERENCES public.scenarios(id) ON DELETE CASCADE,
  stage TEXT NOT NULL,
  stage_status TEXT NOT NULL DEFAULT 'pending',
  job_family TEXT,
  job_id TEXT,
  reused_from_simulation_id TEXT,
  credit_cost_cents INTEGER NOT NULL DEFAULT 0,
  output_refs_json JSONB NOT NULL DEFAULT '[]'::jsonb,
  error_code TEXT,
  error_message TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (pipeline_run_id, scenario_id, stage),
  CHECK (jsonb_typeof(output_refs_json) = 'array')
);
CREATE INDEX IF NOT EXISTS idx_pipeline_run_items_run
  ON public.pipeline_run_items(pipeline_run_id, stage, stage_status);
CREATE INDEX IF NOT EXISTS idx_pipeline_run_items_job
  ON public.pipeline_run_items(job_family, job_id) WHERE job_id IS NOT NULL;

-- Copied from upstream 20260809023000_canonical_artifact_postprocess_jobs.sql
-- and 20260809026000_pipeline_reconciliation_generation_fence.sql.
CREATE TABLE IF NOT EXISTS public.pipeline_reconciliation_requests (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  pipeline_run_id TEXT NOT NULL REFERENCES public.pipeline_runs(id) ON DELETE CASCADE,
  source_job_family TEXT NOT NULL,
  source_job_id TEXT NOT NULL,
  terminal_status TEXT NOT NULL CHECK (terminal_status IN ('completed', 'failed')),
  generation BIGINT NOT NULL DEFAULT 1 CHECK (generation > 0),
  processing_generation BIGINT,
  processing_token TEXT,
  requested_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  processing_started_at TIMESTAMPTZ,
  processed_at TIMESTAMPTZ,
  last_error TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS pipeline_reconciliation_requests_pending_run_idx
  ON public.pipeline_reconciliation_requests(pipeline_run_id) WHERE processed_at IS NULL;

-- Copied from upstream .archive/0046_dataset_export_jobs_tasks_publications.sql,
-- with the tracked canonical-job/artifact cutover from 20260809023000.
CREATE TABLE IF NOT EXISTS public.dataset_export_tasks (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  dataset_export_job_id TEXT NOT NULL,
  stage TEXT NOT NULL,
  partition_key TEXT,
  status TEXT NOT NULL DEFAULT 'queued',
  lease_owner TEXT,
  lease_token TEXT,
  lease_expires_at TIMESTAMPTZ,
  last_heartbeat_at TIMESTAMPTZ,
  attempt_count INTEGER NOT NULL DEFAULT 0,
  max_attempts INTEGER NOT NULL DEFAULT 3,
  input_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  output_json JSONB,
  error_code TEXT,
  error_message TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  started_at TIMESTAMPTZ,
  finished_at TIMESTAMPTZ,
  FOREIGN KEY (dataset_export_job_id, workspace_id)
    REFERENCES uniscenario.artifact_postprocess_jobs(id, workspace_id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_dataset_export_tasks_job
  ON public.dataset_export_tasks(dataset_export_job_id, created_at);
CREATE INDEX IF NOT EXISTS idx_dataset_export_tasks_claim
  ON public.dataset_export_tasks(stage, status, created_at) WHERE status = 'queued';

CREATE TABLE IF NOT EXISTS public.dataset_export_task_attempts (
  id TEXT PRIMARY KEY,
  dataset_export_task_id TEXT NOT NULL REFERENCES public.dataset_export_tasks(id) ON DELETE CASCADE,
  attempt_number INTEGER NOT NULL,
  lease_owner TEXT,
  lease_token TEXT,
  status TEXT NOT NULL DEFAULT 'running',
  started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  finished_at TIMESTAMPTZ,
  error_code TEXT,
  error_message TEXT,
  metadata_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  UNIQUE (dataset_export_task_id, attempt_number)
);

CREATE TABLE IF NOT EXISTS public.dataset_export_publications (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  dataset_export_job_id TEXT NOT NULL,
  dataset_snapshot_id TEXT REFERENCES public.dataset_snapshots(id) ON DELETE SET NULL,
  kind TEXT NOT NULL,
  artifact_id TEXT REFERENCES public.artifacts(id) ON DELETE RESTRICT,
  uniscenario_artifact_id TEXT REFERENCES uniscenario.artifacts(id) ON DELETE RESTRICT,
  status TEXT NOT NULL DEFAULT 'pending',
  is_default BOOLEAN NOT NULL DEFAULT FALSE,
  published_at TIMESTAMPTZ,
  expires_at TIMESTAMPTZ,
  metadata_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  FOREIGN KEY (dataset_export_job_id, workspace_id)
    REFERENCES uniscenario.artifact_postprocess_jobs(id, workspace_id) ON DELETE CASCADE,
  CHECK ((artifact_id IS NOT NULL) <> (uniscenario_artifact_id IS NOT NULL))
);
CREATE INDEX IF NOT EXISTS idx_dataset_export_publications_job
  ON public.dataset_export_publications(dataset_export_job_id, kind, created_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS idx_dataset_export_publications_default
  ON public.dataset_export_publications(dataset_export_job_id, kind) WHERE is_default;

-- Copied from upstream 20260526090000_dataset_compile_readiness_cache.sql.
CREATE TABLE IF NOT EXISTS public.dataset_compile_readiness_cache (
  workspace_id TEXT NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  dataset_id TEXT NOT NULL REFERENCES public.datasets(id) ON DELETE CASCADE,
  response_json JSONB NOT NULL,
  generated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at TIMESTAMPTZ NOT NULL,
  last_refresh_reason TEXT NOT NULL DEFAULT 'miss' CHECK (last_refresh_reason IN ('miss', 'refresh')),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (workspace_id, dataset_id)
);
CREATE INDEX IF NOT EXISTS idx_dataset_compile_readiness_cache_expiry
  ON public.dataset_compile_readiness_cache(expires_at);

-- Copied from upstream 20260504120000_map_asset_addresses_and_buildings.sql
-- and 20260505130000_address_road_access_and_building_address.sql.
CREATE TABLE IF NOT EXISTS public.map_asset_buildings (
  id TEXT PRIMARY KEY,
  map_asset_id TEXT NOT NULL REFERENCES public.map_assets(id) ON DELETE CASCADE,
  name TEXT,
  class TEXT,
  subtype TEXT,
  centroid_lat DOUBLE PRECISION NOT NULL,
  centroid_lng DOUBLE PRECISION NOT NULL,
  height DOUBLE PRECISION,
  num_floors INTEGER,
  address_count INTEGER NOT NULL DEFAULT 0,
  primary_address TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE TABLE IF NOT EXISTS public.map_asset_addresses (
  id TEXT PRIMARY KEY,
  map_asset_id TEXT NOT NULL REFERENCES public.map_assets(id) ON DELETE CASCADE,
  building_id TEXT REFERENCES public.map_asset_buildings(id) ON DELETE SET NULL,
  number TEXT,
  street TEXT,
  postcode TEXT,
  formatted TEXT NOT NULL,
  normalized TEXT NOT NULL,
  lat DOUBLE PRECISION NOT NULL,
  lng DOUBLE PRECISION NOT NULL,
  road_access_lat DOUBLE PRECISION,
  road_access_lng DOUBLE PRECISION,
  road_access_distance_m DOUBLE PRECISION,
  road_access_road_name TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_map_asset_addresses_map_asset ON public.map_asset_addresses(map_asset_id);
CREATE INDEX IF NOT EXISTS idx_map_asset_addresses_building
  ON public.map_asset_addresses(building_id) WHERE building_id IS NOT NULL;

-- Copied from upstream 0058_map_asset_enrichment_jobs.sql.
DO $$ BEGIN
  CREATE TYPE map_asset_enrichment_job_type AS ENUM ('third_party_enrichment', 'street_name_resolution');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  CREATE TYPE map_asset_enrichment_job_status AS ENUM ('pending', 'running', 'succeeded', 'failed', 'timeout');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
CREATE TABLE IF NOT EXISTS public.map_asset_enrichment_jobs (
  id TEXT PRIMARY KEY,
  map_asset_id TEXT NOT NULL REFERENCES public.map_assets(id) ON DELETE CASCADE,
  job_type map_asset_enrichment_job_type NOT NULL,
  status map_asset_enrichment_job_status NOT NULL DEFAULT 'pending',
  provider_release TEXT,
  requested_by TEXT,
  sqs_message_id TEXT,
  enqueued_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  started_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  error_message TEXT,
  attempt_count INTEGER NOT NULL DEFAULT 0,
  result_json JSONB
);
CREATE INDEX IF NOT EXISTS idx_mae_jobs_asset_type_enqueued
  ON public.map_asset_enrichment_jobs(map_asset_id, job_type, enqueued_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS idx_mae_jobs_active_unique
  ON public.map_asset_enrichment_jobs(map_asset_id, job_type) WHERE status IN ('pending', 'running');

-- Copied from upstream .archive/0016_map_candidate_locations.sql.
CREATE TABLE IF NOT EXISTS public.map_candidate_locations (
  id TEXT PRIMARY KEY,
  map_asset_id TEXT NOT NULL REFERENCES public.map_assets(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,
  source TEXT NOT NULL,
  label TEXT NOT NULL,
  description TEXT,
  reason TEXT NOT NULL,
  confidence REAL NOT NULL DEFAULT 1,
  tags JSONB NOT NULL DEFAULT '[]'::jsonb,
  evidence JSONB NOT NULL DEFAULT '[]'::jsonb,
  geometry JSONB NOT NULL,
  center_lat DOUBLE PRECISION NOT NULL,
  center_lng DOUBLE PRECISION NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_mcl_map_asset ON public.map_candidate_locations(map_asset_id);
CREATE INDEX IF NOT EXISTS idx_mcl_source ON public.map_candidate_locations(source);

-- Copied from upstream 0074_workspace_audit_logs.sql.
CREATE TABLE IF NOT EXISTS public.workspace_audit_logs (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  actor_user_id TEXT REFERENCES public.ba_user(id) ON DELETE SET NULL,
  action TEXT NOT NULL,
  target_type TEXT NOT NULL,
  target_id TEXT,
  metadata_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_workspace_audit_logs_workspace_created
  ON public.workspace_audit_logs(workspace_id, created_at DESC);

-- Copied from upstream 0092_admin_rbac_and_audit_hardening.sql.
CREATE TABLE IF NOT EXISTS public.admin_role_assignments (
  id TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  user_id TEXT NOT NULL REFERENCES public.ba_user(id) ON DELETE CASCADE,
  role TEXT NOT NULL,
  environment TEXT,
  created_by_user_id TEXT REFERENCES public.ba_user(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at TIMESTAMPTZ,
  revoked_at TIMESTAMPTZ,
  revoked_by_user_id TEXT REFERENCES public.ba_user(id) ON DELETE SET NULL,
  revoke_reason TEXT
);
CREATE INDEX IF NOT EXISTS idx_admin_role_assignments_user_active
  ON public.admin_role_assignments(user_id, role, environment) WHERE revoked_at IS NULL;

-- Copied from upstream 0092_admin_rbac_and_audit_hardening.sql and
-- 0094_admin_impersonation_sessions_hardening.sql.
CREATE TABLE IF NOT EXISTS public.admin_impersonation_sessions (
  id TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  admin_user_id TEXT NOT NULL REFERENCES public.ba_user(id) ON DELETE CASCADE,
  target_user_id TEXT NOT NULL REFERENCES public.ba_user(id) ON DELETE CASCADE,
  session_id TEXT,
  session_token_hash TEXT,
  reason TEXT NOT NULL,
  ticket_url TEXT,
  ip_address TEXT,
  user_agent TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at TIMESTAMPTZ NOT NULL,
  ended_at TIMESTAMPTZ,
  ended_by_user_id TEXT REFERENCES public.ba_user(id) ON DELETE SET NULL,
  end_reason TEXT,
  status TEXT NOT NULL DEFAULT 'active',
  return_token_hash TEXT,
  original_admin_session_id TEXT,
  original_admin_session_token_hash TEXT,
  target_session_id TEXT,
  target_session_token_hash TEXT,
  returned_at TIMESTAMPTZ,
  revoked_at TIMESTAMPTZ,
  expired_at TIMESTAMPTZ,
  failed_return_count INTEGER NOT NULL DEFAULT 0,
  last_failed_return_at TIMESTAMPTZ,
  audit_log_id TEXT
);
CREATE INDEX IF NOT EXISTS idx_admin_impersonation_active_target_session
  ON public.admin_impersonation_sessions(target_session_token_hash)
  WHERE status = 'active' AND target_session_token_hash IS NOT NULL;

COMMIT;
