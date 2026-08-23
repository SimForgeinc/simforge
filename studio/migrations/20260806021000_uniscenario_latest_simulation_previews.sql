BEGIN;
CREATE TABLE IF NOT EXISTS uniscenario.simulation_previews (
  document_id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  source_draft_version BIGINT NOT NULL CHECK (source_draft_version > 0),
  source_content_sha256 TEXT NOT NULL CHECK (source_content_sha256 ~ '^[a-f0-9]{64}$'),
  map_version_id TEXT NOT NULL,
  artifact_id TEXT NOT NULL,
  created_by_user_id TEXT REFERENCES public.ba_user(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  FOREIGN KEY (document_id, workspace_id) REFERENCES uniscenario.documents(id, workspace_id) ON DELETE CASCADE,
  FOREIGN KEY (artifact_id, workspace_id) REFERENCES uniscenario.artifacts(id, workspace_id) ON DELETE RESTRICT,
  FOREIGN KEY (map_version_id, workspace_id) REFERENCES uniscenario.map_versions(id, workspace_id) ON DELETE RESTRICT
);
CREATE INDEX IF NOT EXISTS uniscenario_simulation_previews_workspace_created_idx
  ON uniscenario.simulation_previews (workspace_id, created_at DESC);
COMMIT;
