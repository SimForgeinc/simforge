-- migration-impact: constraint-cutover
-- Browser render intents use the current resource-request/v2 admission contract.
BEGIN;

ALTER TABLE uniscenario.render_jobs
  DROP CONSTRAINT IF EXISTS uniscenario_render_jobs_resource_request_ck,
  ADD CONSTRAINT uniscenario_render_jobs_resource_request_ck CHECK (
    resource_request IS NULL OR (
      jsonb_typeof(resource_request) = 'object'
      AND resource_request->>'schema' IN (
        'uniscenario.render-resource-request/v1',
        'uniscenario.render-resource-request/v2'
      )
    )
  ) NOT VALID;

COMMIT;
