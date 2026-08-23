-- Migration 20260805014000: UniScenario dataset visibility and system-managed ownership
-- Rollback: drop the visibility / is_system_managed / system_slug / is_default columns and their
--           indexes after resolveUniScenarioDatasetAccess stops reading them.
--
-- This keeps v1's sharing MECHANISM while dropping three columns v1 never actually used as stored
-- state. Reading v1's own usage settles it:
--
--   * 0066_public_dataset_rename.sql seeds the one global row with mutability='editable', and
--     effectiveDatasetMutability() in app/lib/scenario-sharing/access-policy.ts ignores the stored
--     value entirely — public datasets are 'editable' for a platform admin and 'read_only' for
--     everyone else. So `read_only` is DERIVED, never stored. There is no mutability column here.
--   * copy_policy='blocked' is written by no code path in the tree, so `copy_policy` is not added.
--     Copyability is derived from readability.
--   * scope='global' is redundant with is_system, which is what datasetActions.delete actually
--     reads. `visibility` + `is_system_managed` replace both.
--
-- IMPORTANT: immutable revisions do NOT make read-only datasets unnecessary. Revision immutability
-- protects HISTORY. It does nothing to stop workspace B renaming or deleting a dataset shared with
-- it. The enforcement layer is requireUniScenarioMutableContext() in app/lib/uniscenario/http.ts,
-- which is what closes §5.7 FINDING A. Dropping the columns is not dropping the feature.

BEGIN;

ALTER TABLE uniscenario.datasets
  ADD COLUMN IF NOT EXISTS visibility TEXT NOT NULL DEFAULT 'workspace',
  ADD COLUMN IF NOT EXISTS is_system_managed BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS system_slug TEXT,
  ADD COLUMN IF NOT EXISTS is_default BOOLEAN NOT NULL DEFAULT FALSE;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'uniscenario_datasets_visibility_check'
      AND conrelid = 'uniscenario.datasets'::regclass
  ) THEN
    ALTER TABLE uniscenario.datasets
      ADD CONSTRAINT uniscenario_datasets_visibility_check
      CHECK (visibility IN ('workspace', 'organization', 'public'));
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'uniscenario_datasets_system_slug_format_check'
      AND conrelid = 'uniscenario.datasets'::regclass
  ) THEN
    ALTER TABLE uniscenario.datasets
      ADD CONSTRAINT uniscenario_datasets_system_slug_format_check
      CHECK (system_slug IS NULL OR system_slug ~ '^[a-z0-9][a-z0-9-]{0,62}$');
  END IF;
  -- A system-managed dataset is exactly one that carries a slug. Keeping the two in lockstep means
  -- the delete rule ("owner workspace, and not system-managed") can never be bypassed by writing
  -- one of the pair without the other.
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'uniscenario_datasets_system_closure_check'
      AND conrelid = 'uniscenario.datasets'::regclass
  ) THEN
    ALTER TABLE uniscenario.datasets
      ADD CONSTRAINT uniscenario_datasets_system_closure_check
      CHECK (is_system_managed = (system_slug IS NOT NULL));
  END IF;
END $$;

-- One global identity per system slug, and one default dataset per live workspace.
CREATE UNIQUE INDEX IF NOT EXISTS uniscenario_datasets_system_slug_idx
  ON uniscenario.datasets (system_slug)
  WHERE system_slug IS NOT NULL AND deleted_at IS NULL;

CREATE UNIQUE INDEX IF NOT EXISTS uniscenario_datasets_workspace_default_idx
  ON uniscenario.datasets (workspace_id)
  WHERE is_default AND deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS uniscenario_datasets_shared_idx
  ON uniscenario.datasets (visibility, updated_at DESC, id)
  WHERE visibility <> 'workspace' AND deleted_at IS NULL;

COMMIT;
