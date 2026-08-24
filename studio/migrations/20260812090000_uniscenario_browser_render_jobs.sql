BEGIN;

-- Browser (Three.js) renders become first-class render jobs executed by the workstation
-- browser-render worker over the CPU claim lane, replacing the author's-tab recording as the
-- artifact of record. job_mode 'browser_render':
--   * carries a uniscenario.render-spec/v2 render_spec and a frozen execution package like every
--     other render job (same lineage boundary), and none of the postprocess columns;
--   * is claimed through uniscenario.cpu_job_attempts (job_family 'openscenario_render'), never
--     through uniscenario.worker_leases — the GPU lease lane's job_mode filter already excludes it;
--   * succeeds without native-physics parity evidence: its evidence is the succeeded browser
--     recording (video + capture manifest) that the completion path verifies against the job's
--     render_spec_sha256 and binds via origin_recording_job_id.
--
-- Rollback: restore uniscenario_render_jobs_mode_check /
-- uniscenario_render_jobs_postprocess_closure_check to their 20260805016000 definitions,
-- uniscenario_render_jobs_success_requires_accepted_evidence_ck to its 20260810010000 definition,
-- cpu_job_attempts/operational_job_events job_family checks to their 20260809020000 definitions,
-- and uniscenario.reject_render_origin_recording_mutation() to its 20260809028000 definition.
-- browser_render rows must be terminal (or deleted) before rolling back.

-- Widen the mode list. Single authoritative constraint, same policy as 20260805016000.
ALTER TABLE uniscenario.render_jobs
  DROP CONSTRAINT IF EXISTS uniscenario_render_jobs_mode_check,
  ADD CONSTRAINT uniscenario_render_jobs_mode_check
    CHECK (job_mode IN ('interaction_2d', 'full_render', 'browser_render', 'cosmos_augment', 'vlm_annotate'));

-- browser_render joins the simulation side of the per-mode closure: it renders a revision, it
-- does not post-process another job's artifact.
ALTER TABLE uniscenario.render_jobs
  DROP CONSTRAINT IF EXISTS uniscenario_render_jobs_postprocess_closure_check,
  ADD CONSTRAINT uniscenario_render_jobs_postprocess_closure_check
    CHECK (
      (job_mode IN ('interaction_2d', 'full_render', 'browser_render')
        AND parent_render_job_id IS NULL
        AND source_artifact_id IS NULL
        AND model_family IS NULL
        AND model_config IS NULL
        AND model_config_sha256 IS NULL)
      OR
      (job_mode IN ('cosmos_augment', 'vlm_annotate')
        AND parent_render_job_id IS NOT NULL
        AND parent_render_job_id <> id
        AND source_artifact_id IS NOT NULL
        AND char_length(BTRIM(model_family)) > 0
        AND jsonb_typeof(model_config) = 'object'
        AND model_config_sha256 ~ '^[a-f0-9]{64}$')
    );

-- Native-physics parity evidence is a property of the managed CARLA modes, not of every render
-- job. Scoping the success gate per mode also closes a latent contradiction: completeCpuJob marks
-- cosmos_augment/vlm_annotate rows succeeded without parity columns, which the unscoped 20260810
-- constraint rejects on first use. browser_render success is gated instead by the origin-recording
-- binding below plus the completion path's render-spec digest equality check.
ALTER TABLE uniscenario.render_jobs
  DROP CONSTRAINT IF EXISTS uniscenario_render_jobs_success_requires_accepted_evidence_ck,
  ADD CONSTRAINT uniscenario_render_jobs_success_requires_accepted_evidence_ck
    CHECK (
      job_state <> 'succeeded'
      OR job_mode NOT IN ('interaction_2d', 'full_render')
      OR (
        parity_accepted IS TRUE
        AND parity_evidence_schema = 'uniscenario.parity-evidence/v1'
        AND parity_evidence IS NOT NULL
      )
    ) NOT VALID;

-- A succeeded browser_render must reference the succeeded recording that is its evidence.
ALTER TABLE uniscenario.render_jobs
  DROP CONSTRAINT IF EXISTS uniscenario_render_jobs_browser_render_success_origin_ck,
  ADD CONSTRAINT uniscenario_render_jobs_browser_render_success_origin_ck
    CHECK (
      job_mode <> 'browser_render'
      OR job_state <> 'succeeded'
      OR origin_recording_job_id IS NOT NULL
    ) NOT VALID;

-- The CARLA handoff binds its origin recording before execution (the recording pre-exists the
-- render job). A browser_render produces its recording DURING the running attempt, so its binding
-- necessarily happens while running. Everything else stays immutable-once-set, and the
-- enforce_render_origin_recording constraint trigger still requires the bound recording to be a
-- succeeded browser recording of the same workspace + revision.
CREATE OR REPLACE FUNCTION uniscenario.reject_render_origin_recording_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF OLD.origin_recording_job_id IS NOT NULL
     AND NEW.origin_recording_job_id IS DISTINCT FROM OLD.origin_recording_job_id THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      CONSTRAINT = 'render_origin_recording_immutable',
      MESSAGE = 'render origin recording is immutable';
  END IF;
  IF OLD.origin_recording_job_id IS NULL
     AND NEW.origin_recording_job_id IS NOT NULL
     AND NOT (
       OLD.job_state = 'queued'
       OR (OLD.job_mode = 'browser_render' AND OLD.job_state = 'running')
     ) THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      CONSTRAINT = 'render_origin_recording_late_binding_forbidden',
      MESSAGE = 'render origin recording must be bound before execution';
  END IF;
  RETURN NEW;
END;
$$;

-- The CPU claim lane learns the render family: browser_render attempts are fenced through
-- cpu_job_attempts exactly like validation and postprocess attempts.
ALTER TABLE uniscenario.cpu_job_attempts
  DROP CONSTRAINT IF EXISTS cpu_job_attempts_job_family_check,
  ADD CONSTRAINT cpu_job_attempts_job_family_check
    CHECK (job_family IN ('openscenario_validate', 'artifact_postprocess', 'openscenario_render'));

ALTER TABLE uniscenario.operational_job_events
  DROP CONSTRAINT IF EXISTS operational_job_events_job_family_check,
  ADD CONSTRAINT operational_job_events_job_family_check
    CHECK (job_family IN ('openscenario_compile', 'openscenario_validate', 'artifact_postprocess', 'openscenario_render'));

COMMIT;
