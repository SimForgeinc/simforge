-- Migration 20260825090000: SimForge on-demand high-fidelity preview queue.
--
-- `simforge` schema (deliberately OUTSIDE the frozen `uniscenario.*` wire
-- surface — see docs/engineering/simcloud-sync.md): a small request queue for
-- the `hifi_preview` worker family. The editor POSTs one frame's worth of
-- state (scene-state tick + contract camera report), the worker renders it
-- through native-render-service on the published map payloads and attaches a
-- PNG artifact plus provenance.
--
-- Previews are ephemeral products (one frame, replayable from the request),
-- so unlike the model-run ledger there are no immutability triggers.
--
-- Rollback: DROP TABLE simforge.hifi_preview_requests;

BEGIN;

CREATE SCHEMA IF NOT EXISTS simforge;

CREATE TABLE simforge.hifi_preview_requests (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  -- Editor document the preview was requested from (provenance only; the
  -- request body carries the full scene snapshot).
  document_id TEXT,
  map_version_id TEXT NOT NULL CHECK (BTRIM(map_version_id) <> ''),
  profile TEXT NOT NULL CHECK (profile IN ('cinematic', 'sensor')),
  tick INTEGER NOT NULL DEFAULT 0 CHECK (tick >= 0),
  -- Full validated request: contract CameraStateReport + scene-state tick
  -- document + output dimensions (simforge.hifi-preview-request/v1).
  request_json JSONB NOT NULL CHECK (jsonb_typeof(request_json) = 'object'),
  status TEXT NOT NULL DEFAULT 'queued'
    CHECK (status IN ('queued', 'running', 'succeeded', 'failed')),
  worker_id TEXT,
  error_code TEXT,
  error_detail JSONB CHECK (error_detail IS NULL OR jsonb_typeof(error_detail) = 'object'),
  artifact_bucket TEXT,
  artifact_key TEXT,
  -- simforge.hifi-preview-provenance/v1: renderer, profile, tick, digests,
  -- echoed contract camera, timings.
  provenance_json JSONB CHECK (provenance_json IS NULL OR jsonb_typeof(provenance_json) = 'object'),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  started_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  CONSTRAINT simforge_hifi_preview_terminal_shape_check CHECK (
    (status IN ('queued', 'running') AND completed_at IS NULL)
    OR (status = 'succeeded' AND artifact_bucket IS NOT NULL AND artifact_key IS NOT NULL
        AND provenance_json IS NOT NULL AND completed_at IS NOT NULL)
    OR (status = 'failed' AND error_code IS NOT NULL AND completed_at IS NOT NULL)
  )
);

CREATE INDEX simforge_hifi_preview_claim_idx
  ON simforge.hifi_preview_requests (created_at, id)
  WHERE status = 'queued';

CREATE INDEX simforge_hifi_preview_document_idx
  ON simforge.hifi_preview_requests (workspace_id, document_id, created_at DESC);

COMMIT;
