import type { AppContext } from "@/app/lib/db/app-context";
import { withTransaction } from "@/app/lib/db/data-api";
import { canonicalJsonSha256, uniscenarioId } from "@/app/lib/uniscenario/core";
import type { UniScenarioPostprocessInput } from "./contracts";

/**
 * Creating Cosmos (#139, #144) and VLM (#140, #145) postprocess jobs.
 *
 * A postprocess run is a render job with a different `job_mode`, a parent job, an input artifact, and a
 * hashed model config — not a parallel table. 20260805016000 chose that shape so the v2 control plane's
 * fenced leases, ordinal job events, checksum-bound uploads, and artifact cleanup outbox all apply
 * unchanged, instead of v1's `cosmos_jobs` rebuilding every one of them.
 *
 * Uncached: this is a write.
 */

/**
 * `uniscenario_render_jobs_postprocess_closure_check` requires, for these two modes, that
 * `parent_render_job_id` is present and not self-referential, `source_artifact_id` is present,
 * `model_family` is non-blank, `model_config` is a JSON object, and `model_config_sha256` is 64 hex
 * characters. Every one of those is established here before the insert so a violation surfaces as a
 * named error rather than an opaque check violation.
 */
function validatePostprocessInput(input: UniScenarioPostprocessInput) {
  if (input.jobMode !== "cosmos_augment" && input.jobMode !== "vlm_annotate") {
    throw new Error("uniscenario_postprocess_mode_invalid");
  }
  if (!input.parentRenderJobId) throw new Error("uniscenario_postprocess_parent_required");
  if (!input.sourceArtifactId) throw new Error("uniscenario_postprocess_source_artifact_required");
  if (!input.modelFamily?.trim()) throw new Error("uniscenario_postprocess_model_family_required");
  if (!input.modelConfig || typeof input.modelConfig !== "object" || Array.isArray(input.modelConfig)) {
    throw new Error("uniscenario_postprocess_model_config_invalid");
  }
  if (!input.idempotencyKey?.trim()) throw new Error("uniscenario_postprocess_idempotency_required");
}

/**
 * Queue a postprocess job against a completed render's artifact.
 *
 * Tenancy and lineage are established by the `INSERT ... SELECT`, not by trusting the caller: the
 * parent job, its revision, its execution package, and the source artifact are all joined on
 * `workspace_id`, so a caller cannot postprocess another workspace's render or feed in another
 * workspace's artifact. This is the same shape as the `render_profile_id` fix in
 * `control-plane-store.ts`, and for the same reason — a bare bind parameter from caller input is not
 * tenancy.
 *
 * Guarded before the insert as well, so a cross-tenant or not-yet-ready input produces a named error
 * instead of the silent `null` a non-matching `INSERT ... SELECT` returns. That failure mode is the one
 * the render-profile fix existed to remove; it must not be reintroduced here.
 *
 * `billing_mode` is pinned to `'free'` with zero cost because `uniscenario_render_jobs_free_check` from
 * 20260804020000 is unconditional — `CHECK (billing_mode = 'free' AND estimated_cost_cents = 0)`. A
 * paid postprocess provider cannot be represented until that check is relaxed, which 20260805016000
 * deliberately left open as a billing decision. Do not pass a real cost here expecting it to persist.
 */
type PostprocessActor = Pick<AppContext, "workspaceId" | "userId">;

export async function createPostprocessJobForActor(actor: PostprocessActor, input: UniScenarioPostprocessInput) {
  validatePostprocessInput(input);
  const modelConfigSha256 = canonicalJsonSha256(input.modelConfig);

  return withTransaction(async (tx) => {
    const existing = await tx.queryOne<{ id: string }>(
      `SELECT id FROM uniscenario.render_jobs
        WHERE workspace_id = :workspace_id AND idempotency_key = :idempotency_key
        LIMIT 1`,
      {
        workspace_id: actor.workspaceId,
        idempotency_key: input.idempotencyKey,
      },
    );
    if (existing) return { id: existing.id, created: false };

    // The parent must be a finished render in this workspace, and the source artifact must be one of
    // its own available outputs. Checked explicitly so each failure is nameable.
    const parent = await tx.queryOne<{
      id: string;
      revision_id: string;
      execution_package_id: string;
    }>(
      `SELECT rj.id, rj.revision_id, rj.execution_package_id
         FROM uniscenario.render_jobs rj
        WHERE rj.workspace_id = :workspace_id
          AND rj.id = :parent_id
          AND rj.job_state = 'succeeded'
        LIMIT 1`,
      { workspace_id: actor.workspaceId, parent_id: input.parentRenderJobId },
    );
    if (!parent) throw new Error("uniscenario_postprocess_parent_not_succeeded");

    const source = await tx.queryOne<{ id: string }>(
      `SELECT a.id
         FROM uniscenario.artifact_links al
         JOIN uniscenario.artifacts a
           ON a.id = al.artifact_id AND a.workspace_id = al.workspace_id
        WHERE al.workspace_id = :workspace_id
          AND al.render_job_id = :parent_id
          AND a.id = :artifact_id
          AND a.artifact_state = 'available'
          AND a.deleted_at IS NULL
        LIMIT 1`,
      {
        workspace_id: actor.workspaceId,
        parent_id: input.parentRenderJobId,
        artifact_id: input.sourceArtifactId,
      },
    );
    if (!source) throw new Error("uniscenario_postprocess_source_artifact_unavailable");

    const jobId = uniscenarioId("usrj");
    const row = await tx.queryOne<{ id: string }>(
      `INSERT INTO uniscenario.render_jobs (
         id, workspace_id, revision_id, execution_package_id,
         render_spec, render_spec_sha256, request_contract_version,
         job_mode, billing_mode, estimated_cost_cents,
         priority, idempotency_key, requested_by_user_id,
         parent_render_job_id, source_artifact_id, model_family, model_config, model_config_sha256
       )
       SELECT :id, rj.workspace_id, rj.revision_id, rj.execution_package_id,
         CAST(:model_config AS jsonb), :model_config_sha256, :contract_version,
         :job_mode, 'free', 0,
         :priority, :idempotency_key, :user_id,
         rj.id, a.id, :model_family, CAST(:model_config AS jsonb), :model_config_sha256
       FROM uniscenario.render_jobs rj
       JOIN uniscenario.artifact_links al
         ON al.render_job_id = rj.id AND al.workspace_id = rj.workspace_id
       JOIN uniscenario.artifacts a
         ON a.id = al.artifact_id AND a.workspace_id = al.workspace_id
       WHERE rj.workspace_id = :workspace_id
         AND rj.id = :parent_id
         AND a.id = :artifact_id
         AND a.artifact_state = 'available'
         AND a.deleted_at IS NULL
       LIMIT 1
       ON CONFLICT (workspace_id, idempotency_key)
       DO UPDATE SET idempotency_key = EXCLUDED.idempotency_key
       RETURNING id`,
      {
        id: jobId,
        workspace_id: actor.workspaceId,
        parent_id: input.parentRenderJobId,
        artifact_id: input.sourceArtifactId,
        // The model config doubles as the render spec: for a postprocess run it IS the spec, and
        // duplicating it keeps render_spec NOT NULL satisfied without inventing a second shape.
        model_config: input.modelConfig,
        model_config_sha256: modelConfigSha256,
        model_family: input.modelFamily.trim(),
        contract_version: "uniscenario.postprocess/v1",
        job_mode: input.jobMode,
        priority: input.priority ?? 0,
        idempotency_key: input.idempotencyKey,
        user_id: actor.userId,
      },
    );
    // Belt to the pre-checks' braces: if the statement still matched nothing, fail loudly rather than
    // returning a null the caller will read as success.
    if (!row) throw new Error("uniscenario_postprocess_insert_matched_nothing");
    return { id: row.id, created: true };
  });
}

export async function createPostprocessJob(context: AppContext, input: UniScenarioPostprocessInput) {
  return createPostprocessJobForActor(context, input);
}
