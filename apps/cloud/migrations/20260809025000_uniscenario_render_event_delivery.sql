-- Migration 20260809025000: separate worker delivery identity from the
-- monotonically increasing render-job event timeline. Worker sequence numbers
-- restart on every attempt; event ordinals never do.

BEGIN;

ALTER TABLE uniscenario.job_events
  ADD COLUMN IF NOT EXISTS worker_sequence BIGINT;

-- Historical worker events already stored their attempt-local delivery
-- sequence in event_ordinal. Server-authored events have no attempt identity
-- and intentionally remain outside the worker-delivery dedupe key.
UPDATE uniscenario.job_events
SET worker_sequence = event_ordinal
WHERE render_attempt_id IS NOT NULL
  AND worker_sequence IS NULL;

ALTER TABLE uniscenario.job_events
  DROP CONSTRAINT IF EXISTS uniscenario_job_events_worker_sequence_positive,
  ADD CONSTRAINT uniscenario_job_events_worker_sequence_positive
    CHECK (worker_sequence IS NULL OR worker_sequence > 0);

CREATE UNIQUE INDEX IF NOT EXISTS uniscenario_job_events_attempt_worker_sequence_idx
  ON uniscenario.job_events (render_attempt_id, worker_sequence)
  WHERE render_attempt_id IS NOT NULL AND worker_sequence IS NOT NULL;

COMMENT ON COLUMN uniscenario.job_events.event_ordinal IS
  'Globally monotonic ordering within one render job, allocated under its lifecycle lock.';
COMMENT ON COLUMN uniscenario.job_events.worker_sequence IS
  'Attempt-local worker delivery sequence; NULL for server-authored lifecycle events.';

INSERT INTO schema_migrations (id)
VALUES ('20260809025000_uniscenario_render_event_delivery.sql')
ON CONFLICT (id) DO NOTHING;

COMMIT;
