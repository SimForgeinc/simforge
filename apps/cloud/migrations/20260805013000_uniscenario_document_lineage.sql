-- Migration 20260805013000: UniScenario document lineage and portable variation-transfer receipts
-- Rollback: drop uniscenario.variation_transfers, then the derivation_* / derived_from_* columns
--           on uniscenario.documents.
--
-- A variation is a SEPARATE DOCUMENT with a parent pointer, not a revision. A v2 revision is an
-- immutable snapshot of one document's draft: same id, same title, same dataset, with
-- documents.latest_revision_id advancing. A cross-map variation is a different map version, a
-- different title, its own editable draft and its own revision history. Modelled as a revision it
-- could never be edited independently, and creating one would silently move the parent's
-- latest_revision_id.
--
-- EXACTLY ONE SOURCE OF TRUTH for the parent edge. v1 read
--   COALESCE(variation_params->>'sourceScenarioId', parent_scenario_id)
-- which is two sources for one edge. Here the edge is documents.derived_from_document_id and
-- nothing else; variation_transfers.source_document_id is constrained to agree with it via the
-- receipt's own target/source pair, and no unhashed variation_params blob is reintroduced.
--
-- The template's in-document `variants[]` block is unrelated and stays: one document with many
-- conditional renditions is a different concept from many documents on one lineage.

BEGIN;

ALTER TABLE uniscenario.documents
  ADD COLUMN IF NOT EXISTS derivation_kind TEXT,
  ADD COLUMN IF NOT EXISTS derived_from_document_id TEXT,
  ADD COLUMN IF NOT EXISTS derived_from_revision_id TEXT,
  ADD COLUMN IF NOT EXISTS derived_from_map_version_id TEXT,
  ADD COLUMN IF NOT EXISTS derived_by_user_id TEXT REFERENCES public.ba_user(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS derived_at TIMESTAMPTZ;

DO $$
BEGIN
  -- Every lineage pointer is a COMPOSITE reference so a document can never claim a parent,
  -- revision, or map version belonging to another workspace. None of them uses ON DELETE SET NULL:
  -- a multi-column SET NULL would also null workspace_id, which is NOT NULL. Deferring the checks
  -- keeps the workspace-level CASCADE from tripping over rows removed in the same statement, and
  -- documents are soft-deleted (deleted_at), so a parent is never hard-deleted in practice.
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'uniscenario_documents_derived_from_document_fk'
      AND conrelid = 'uniscenario.documents'::regclass
  ) THEN
    ALTER TABLE uniscenario.documents
      ADD CONSTRAINT uniscenario_documents_derived_from_document_fk
      FOREIGN KEY (derived_from_document_id, workspace_id)
      REFERENCES uniscenario.documents(id, workspace_id)
      DEFERRABLE INITIALLY DEFERRED;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'uniscenario_documents_derived_from_revision_fk'
      AND conrelid = 'uniscenario.documents'::regclass
  ) THEN
    ALTER TABLE uniscenario.documents
      ADD CONSTRAINT uniscenario_documents_derived_from_revision_fk
      FOREIGN KEY (derived_from_revision_id, workspace_id)
      REFERENCES uniscenario.revisions(id, workspace_id)
      DEFERRABLE INITIALLY DEFERRED;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'uniscenario_documents_derived_from_map_version_fk'
      AND conrelid = 'uniscenario.documents'::regclass
  ) THEN
    ALTER TABLE uniscenario.documents
      ADD CONSTRAINT uniscenario_documents_derived_from_map_version_fk
      FOREIGN KEY (derived_from_map_version_id, workspace_id)
      REFERENCES uniscenario.map_versions(id, workspace_id)
      DEFERRABLE INITIALLY DEFERRED;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'uniscenario_documents_derivation_closure_check'
      AND conrelid = 'uniscenario.documents'::regclass
  ) THEN
    ALTER TABLE uniscenario.documents
      ADD CONSTRAINT uniscenario_documents_derivation_closure_check
      CHECK (
        -- Authored from scratch: no lineage columns are set at all.
        (derivation_kind IS NULL
          AND derived_from_document_id IS NULL
          AND derived_from_revision_id IS NULL
          AND derived_from_map_version_id IS NULL
          AND derived_by_user_id IS NULL
          AND derived_at IS NULL)
        OR
        -- Brought in from outside: there is no in-schema parent to point at.
        (derivation_kind = 'import'
          AND derived_from_document_id IS NULL
          AND derived_from_revision_id IS NULL
          AND derived_from_map_version_id IS NULL
          AND derived_at IS NOT NULL)
        OR
        -- Same-map derivations: a parent document is mandatory, a source map is meaningless.
        (derivation_kind IN ('copy', 'variation')
          AND derived_from_document_id IS NOT NULL
          AND derived_from_document_id <> id
          AND derived_from_map_version_id IS NULL
          AND derived_at IS NOT NULL)
        OR
        -- Retargeted onto another map: the source map version is the whole point.
        (derivation_kind = 'cross_map_variation'
          AND derived_from_document_id IS NOT NULL
          AND derived_from_document_id <> id
          AND derived_from_map_version_id IS NOT NULL
          AND derived_at IS NOT NULL)
      );
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS uniscenario_documents_derived_from_idx
  ON uniscenario.documents (workspace_id, derived_from_document_id, id)
  WHERE derived_from_document_id IS NOT NULL AND deleted_at IS NULL;

-- The receipt for the public @uniscenarios/anchor-matcher variation engine. That engine is a
-- complete portable transfer pipeline with no storage behind it; this gives it one. Recording why
-- a transfer was judged behaviourally equivalent is strictly more than v1, which recorded nothing.
CREATE TABLE IF NOT EXISTS uniscenario.variation_transfers (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  contract_version TEXT NOT NULL DEFAULT 'variation-transfer.v1',
  target_document_id TEXT NOT NULL,
  source_document_id TEXT NOT NULL,
  source_revision_id TEXT,
  source_map_version_id TEXT NOT NULL,
  target_map_version_id TEXT NOT NULL,
  pattern_id TEXT NOT NULL,
  pattern_sha256 TEXT NOT NULL CHECK (pattern_sha256 ~ '^[a-f0-9]{64}$'),
  source_site_id TEXT NOT NULL,
  target_site_id TEXT NOT NULL,
  permutation_key TEXT,
  verdict TEXT NOT NULL CHECK (verdict IN ('equivalent', 'review', 'rejected')),
  acceptance TEXT NOT NULL CHECK (acceptance IN ('pending_validation', 'rejected')),
  equivalence_score DOUBLE PRECISION NOT NULL CHECK (equivalence_score BETWEEN 0 AND 1),
  topology_score DOUBLE PRECISION CHECK (topology_score IS NULL OR topology_score BETWEEN 0 AND 1),
  role_binding_score DOUBLE PRECISION
    CHECK (role_binding_score IS NULL OR role_binding_score BETWEEN 0 AND 1),
  intent_preserved BOOLEAN NOT NULL DEFAULT FALSE,
  issues JSONB NOT NULL DEFAULT '[]'::jsonb,
  resume_token TEXT,
  created_by_user_id TEXT REFERENCES public.ba_user(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK (jsonb_typeof(issues) = 'array'),
  CHECK (target_document_id <> source_document_id),
  UNIQUE (workspace_id, target_document_id),
  FOREIGN KEY (target_document_id, workspace_id)
    REFERENCES uniscenario.documents(id, workspace_id) ON DELETE CASCADE,
  FOREIGN KEY (source_document_id, workspace_id)
    REFERENCES uniscenario.documents(id, workspace_id)
    DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY (source_revision_id, workspace_id)
    REFERENCES uniscenario.revisions(id, workspace_id)
    DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY (source_map_version_id, workspace_id)
    REFERENCES uniscenario.map_versions(id, workspace_id)
    DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY (target_map_version_id, workspace_id)
    REFERENCES uniscenario.map_versions(id, workspace_id)
    DEFERRABLE INITIALLY DEFERRED
);

CREATE INDEX IF NOT EXISTS uniscenario_variation_transfers_source_idx
  ON uniscenario.variation_transfers (workspace_id, source_document_id, created_at DESC);

CREATE INDEX IF NOT EXISTS uniscenario_variation_transfers_pattern_idx
  ON uniscenario.variation_transfers (workspace_id, pattern_sha256, target_map_version_id);

COMMIT;
