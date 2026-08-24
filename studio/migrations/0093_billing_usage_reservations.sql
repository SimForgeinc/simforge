-- Reservation-aware usage ledger for in-flight credit accounting.
ALTER TABLE billing_ledger
  ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'settled',
  ADD COLUMN IF NOT EXISTS reserved_cents INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS settled_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS released_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW();

UPDATE billing_ledger
   SET status = COALESCE(NULLIF(status, ''), 'settled'),
       settled_at = CASE
         WHEN COALESCE(NULLIF(status, ''), 'settled') = 'settled'
           THEN COALESCE(settled_at, created_at)
         ELSE settled_at
       END,
       updated_at = NOW()
 WHERE status IS NULL
    OR status = ''
    OR (status = 'settled' AND settled_at IS NULL);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'billing_ledger_status_check'
  ) THEN
    ALTER TABLE billing_ledger
      ADD CONSTRAINT billing_ledger_status_check
      CHECK (status IN ('pending', 'settled', 'released'));
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'billing_ledger_amounts_non_negative'
  ) THEN
    ALTER TABLE billing_ledger
      ADD CONSTRAINT billing_ledger_amounts_non_negative
      CHECK (amount_cents >= 0 AND reserved_cents >= 0);
  END IF;
END $$;

DROP INDEX IF EXISTS idx_billing_ledger_job;

CREATE INDEX IF NOT EXISTS idx_billing_ledger_workspace_pending
  ON billing_ledger(workspace_id, created_at DESC)
  WHERE status = 'pending';

CREATE INDEX IF NOT EXISTS idx_billing_ledger_workspace_status_created
  ON billing_ledger(workspace_id, status, created_at DESC);

ALTER TABLE workspaces
  DROP CONSTRAINT IF EXISTS credits_balance_non_negative;

ALTER TABLE workspaces
  ADD CONSTRAINT credits_balance_non_negative
  CHECK (credits_balance >= 0)
  NOT VALID;

ALTER TABLE workspaces
  VALIDATE CONSTRAINT credits_balance_non_negative;

INSERT INTO schema_migrations (id) VALUES ('0093_billing_usage_reservations.sql')
  ON CONFLICT (id) DO NOTHING;
