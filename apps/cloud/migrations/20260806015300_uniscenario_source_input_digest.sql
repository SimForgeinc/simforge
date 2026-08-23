-- Bind every newly compiled CARLA execution package to the canonical concrete
-- simulation input hash (the browser/runtime `inputHash`). Existing packages
-- remain nullable and are deliberately ineligible for new render jobs/leases;
-- their source input cannot be reconstructed safely from metadata alone.

BEGIN;

ALTER TABLE uniscenario.execution_packages
  ADD COLUMN IF NOT EXISTS source_input_digest TEXT;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'uniscenario_execution_packages_source_input_digest_check'
      AND conrelid = 'uniscenario.execution_packages'::regclass
  ) THEN
    ALTER TABLE uniscenario.execution_packages
      ADD CONSTRAINT uniscenario_execution_packages_source_input_digest_check
      CHECK (source_input_digest IS NULL OR source_input_digest ~ '^[a-f0-9]{64}$');
  END IF;
END $$;

COMMIT;
