-- Ledger-backed compute billing and starter credit balance.
ALTER TABLE workspaces
  ALTER COLUMN credits_balance SET DEFAULT 50000;

ALTER TABLE workspaces
  DROP CONSTRAINT IF EXISTS credits_balance_non_negative;

UPDATE workspaces
SET credits_balance = 50000
WHERE credits_balance IS NULL
   OR credits_balance = 0;

CREATE TABLE IF NOT EXISTS billing_ledger (
  id TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  job_family TEXT NOT NULL,
  job_id TEXT NOT NULL,
  amount_cents INTEGER NOT NULL,
  metadata_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (job_family, job_id)
);

CREATE INDEX IF NOT EXISTS idx_billing_ledger_workspace_created
  ON billing_ledger(workspace_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_billing_ledger_job
  ON billing_ledger(job_family, job_id);
