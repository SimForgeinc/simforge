-- Migration 20260809022000: close and freeze UniScenarios artifact provenance.
-- Every artifact is attributable to either a canonical operational producer or
-- an immutable revision. Historical rows receive deterministic provenance.

BEGIN;

WITH first_render_producer AS (
  SELECT DISTINCT ON (l.artifact_id)
    l.artifact_id,
    l.render_job_id AS producer_job_id,
    l.render_attempt_id AS producer_attempt_id,
    j.revision_id
  FROM uniscenario.artifact_links l
  JOIN uniscenario.render_jobs j
    ON j.id = l.render_job_id AND j.workspace_id = l.workspace_id
  ORDER BY l.artifact_id, l.created_at, l.id
)
UPDATE uniscenario.artifacts a
SET revision_id = COALESCE(a.revision_id, p.revision_id),
    producer_job_family = 'openscenario_render',
    producer_job_id = p.producer_job_id,
    producer_attempt_id = p.producer_attempt_id
FROM first_render_producer p
WHERE a.id = p.artifact_id
  AND a.producer_job_id IS NULL;

WITH first_operational_producer AS (
  SELECT DISTINCT ON (l.artifact_id)
    l.artifact_id, l.job_family, l.job_id, l.attempt_id
  FROM uniscenario.operational_job_artifact_links l
  ORDER BY l.artifact_id, l.created_at, l.id
)
UPDATE uniscenario.artifacts a
SET producer_job_family = p.job_family,
    producer_job_id = p.job_id,
    producer_attempt_id = p.attempt_id
FROM first_operational_producer p
WHERE a.id = p.artifact_id
  AND a.producer_job_id IS NULL;

UPDATE uniscenario.artifacts
SET producer_job_family = 'artifact_postprocess',
    producer_job_id = 'historical-artifact:' || id
WHERE revision_id IS NULL
  AND producer_job_id IS NULL;

UPDATE uniscenario.artifacts
SET provenance = CASE
  WHEN producer_job_id IS NOT NULL THEN jsonb_strip_nulls(
    provenance || jsonb_build_object(
      'contract', 'uniscenario.artifact-provenance/v1',
      'producerJobFamily', producer_job_family,
      'producerJobId', producer_job_id,
      'producerAttemptId', producer_attempt_id,
      'revisionId', revision_id
    )
  )
  ELSE provenance || jsonb_build_object(
    'contract', 'uniscenario.artifact-provenance/v1',
    'producerRevisionId', revision_id
  )
END;

ALTER TABLE uniscenario.artifacts
  DROP CONSTRAINT IF EXISTS uniscenario_artifacts_producer_closure_check,
  ADD CONSTRAINT uniscenario_artifacts_producer_closure_check CHECK (
    revision_id IS NOT NULL
    OR (
      producer_job_family IN (
        'openscenario_compile', 'openscenario_validate', 'openscenario_render', 'artifact_postprocess'
      )
      AND NULLIF(BTRIM(producer_job_id), '') IS NOT NULL
    )
  ) NOT VALID,
  DROP CONSTRAINT IF EXISTS uniscenario_artifacts_provenance_object_check,
  ADD CONSTRAINT uniscenario_artifacts_provenance_object_check CHECK (
    jsonb_typeof(provenance) = 'object'
    AND provenance->>'contract' = 'uniscenario.artifact-provenance/v1'
    AND (
      (
        producer_job_id IS NOT NULL
        AND provenance->>'producerJobFamily' = producer_job_family
        AND provenance->>'producerJobId' = producer_job_id
      )
      OR (
        producer_job_id IS NULL
        AND revision_id IS NOT NULL
        AND provenance->>'producerRevisionId' = revision_id
      )
    )
  ) NOT VALID;

ALTER TABLE uniscenario.artifacts
  VALIDATE CONSTRAINT uniscenario_artifacts_producer_closure_check;
ALTER TABLE uniscenario.artifacts
  VALIDATE CONSTRAINT uniscenario_artifacts_provenance_object_check;

CREATE OR REPLACE FUNCTION uniscenario.reject_finalized_artifact_provenance_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF OLD.artifact_state <> 'pending'
     AND (
       NEW.revision_id IS DISTINCT FROM OLD.revision_id
       OR NEW.producer_job_family IS DISTINCT FROM OLD.producer_job_family
       OR NEW.producer_job_id IS DISTINCT FROM OLD.producer_job_id
       OR NEW.producer_attempt_id IS DISTINCT FROM OLD.producer_attempt_id
       OR NEW.provenance IS DISTINCT FROM OLD.provenance
     ) THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      CONSTRAINT = 'uniscenario_artifacts_finalized_provenance_immutable',
      MESSAGE = 'finalized UniScenarios artifact provenance is immutable';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS uniscenario_artifacts_finalized_provenance_immutable
  ON uniscenario.artifacts;
CREATE TRIGGER uniscenario_artifacts_finalized_provenance_immutable
BEFORE UPDATE OF revision_id, producer_job_family, producer_job_id,
  producer_attempt_id, provenance
ON uniscenario.artifacts
FOR EACH ROW
EXECUTE FUNCTION uniscenario.reject_finalized_artifact_provenance_mutation();

INSERT INTO schema_migrations (id)
VALUES ('20260809022000_uniscenario_artifact_provenance_enforcement.sql')
ON CONFLICT (id) DO NOTHING;

COMMIT;
