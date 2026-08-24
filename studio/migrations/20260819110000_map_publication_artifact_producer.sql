-- Migration 20260819110000: let a map publication own the artifacts it produces.
--
-- `uniscenario.artifacts` accepts a row only with an immutable revision id or a
-- producer job family that resolves to a real job row. A published map version
-- has neither: it is not a scenario revision, and it is not produced by a
-- compile, a validation, a render or a postprocess job.
--
-- 20260809022000 gave historical map artifacts a synthetic
-- `artifact_postprocess` / `historical-artifact:<id>` provenance, and 20260809023000
-- then added a constraint trigger requiring every non-null producer family to
-- resolve. Existing rows were grandfathered because triggers only fire on write,
-- so the gap went unnoticed: since that migration, inserting a map artifact has
-- been impossible. `scripts/publish-uniscenario-browser-bundle.mjs` would fail the
-- same way today.
--
-- This adds `map_publication` as a producer family that resolves against
-- `uniscenario.map_upload_drafts`. Nothing is loosened — an unresolvable draft id
-- still raises — and the draft row always exists before the publish transaction
-- opens, so the immediate constraint trigger can see it.
--
-- migration-impact: contract
-- migration-window: Re-adds a validated CHECK on uniscenario.artifacts, so the
-- statement takes a brief ACCESS EXCLUSIVE lock and validates existing rows.
-- Apply outside peak render hours; the table is provenance metadata, not
-- artifact bytes, and every existing row already satisfies the widened predicate.

BEGIN;

ALTER TABLE uniscenario.artifacts
  DROP CONSTRAINT IF EXISTS uniscenario_artifacts_producer_closure_check,
  ADD CONSTRAINT uniscenario_artifacts_producer_closure_check CHECK (
    revision_id IS NOT NULL
    OR (
      producer_job_family IN (
        'openscenario_compile',
        'openscenario_validate',
        'openscenario_render',
        'artifact_postprocess',
        'map_publication'
      )
      AND NULLIF(BTRIM(producer_job_id), '') IS NOT NULL
    )
  ) NOT VALID;

ALTER TABLE uniscenario.artifacts
  VALIDATE CONSTRAINT uniscenario_artifacts_producer_closure_check;

CREATE OR REPLACE FUNCTION uniscenario.enforce_artifact_producer_resolvable()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.producer_job_family IS NULL THEN
    RETURN NEW;
  END IF;
  IF NEW.producer_job_family = 'openscenario_compile' AND NOT EXISTS (
    SELECT 1 FROM uniscenario.exports j
    WHERE j.id = NEW.producer_job_id AND j.workspace_id = NEW.workspace_id
  ) THEN
    RAISE EXCEPTION 'artifact compile producer does not resolve in workspace';
  ELSIF NEW.producer_job_family = 'openscenario_validate' AND NOT EXISTS (
    SELECT 1 FROM uniscenario.validation_runs j
    WHERE j.id = NEW.producer_job_id AND j.workspace_id = NEW.workspace_id
  ) THEN
    RAISE EXCEPTION 'artifact validation producer does not resolve in workspace';
  ELSIF NEW.producer_job_family = 'openscenario_render' AND NOT EXISTS (
    SELECT 1 FROM uniscenario.render_jobs j
    WHERE j.id = NEW.producer_job_id AND j.workspace_id = NEW.workspace_id
  ) THEN
    RAISE EXCEPTION 'artifact render producer does not resolve in workspace';
  ELSIF NEW.producer_job_family = 'artifact_postprocess'
    AND NOT EXISTS (
      SELECT 1 FROM uniscenario.render_jobs j
      WHERE j.id = NEW.producer_job_id AND j.workspace_id = NEW.workspace_id
        AND j.job_mode IN ('cosmos_augment', 'vlm_annotate')
    )
    AND NOT EXISTS (
      SELECT 1 FROM uniscenario.artifact_postprocess_jobs j
      WHERE j.id = NEW.producer_job_id AND j.workspace_id = NEW.workspace_id
    ) THEN
    RAISE EXCEPTION 'artifact postprocess producer does not resolve in workspace';
  ELSIF NEW.producer_job_family = 'map_publication' AND NOT EXISTS (
    SELECT 1 FROM uniscenario.map_upload_drafts d
    WHERE d.id = NEW.producer_job_id AND d.workspace_id = NEW.workspace_id
  ) THEN
    RAISE EXCEPTION 'artifact map publication producer does not resolve in workspace';
  END IF;
  RETURN NEW;
END;
$$;

COMMIT;
