import { NextResponse } from "next/server";
import { z } from "zod";
import { listPostprocessChildren } from "@/app/lib/scenario/render/gallery-store";
import { createPostprocessJob } from "@/app/lib/scenario/render/postprocess-store";
import {
  readJson,
  requireScenarioContext,
  requireScenarioMutableRenderJobContext,
  requireScenarioMutationOrigin,
  SCENARIO_PRIVATE_CACHE_HEADERS,
} from "@/app/lib/scenario/http";

type Context = { params: Promise<{ jobId: string }> };

const CreatePostprocessSchema = z.object({
  sourceArtifactId: z.string().trim().min(1),
  jobMode: z.enum(["cosmos_augment", "vlm_annotate"]),
  modelFamily: z.string().trim().min(1),
  modelConfig: z.record(z.string(), z.unknown()),
  idempotencyKey: z.string().trim().min(1),
  priority: z.number().int().min(0).max(100).optional(),
});

/**
 * Cosmos (#139, #144) and VLM (#140, #145) postprocess runs against a completed render.
 *
 * A postprocess run is a render job with a different `job_mode`, a parent, an input artifact and a
 * hashed model config — not a parallel table. `20260805016000` chose that shape so the v2 control
 * plane's fenced leases, ordinal job events, checksum-bound uploads and cleanup outbox all apply
 * unchanged rather than being rebuilt as v1's `cosmos_jobs` did.
 *
 * The parent job comes from the PATH, never the body, so a caller cannot pass an id that differs from
 * the one just authorized. `modelConfig` is accepted as an open record because each model family has
 * its own parameters; it is hashed into `model_config_sha256`, which is what the
 * `uniscenario_render_jobs_postprocess_closure_check` constraint validates, and it is never
 * interpolated into SQL.
 *
 * Named store errors are mapped to distinguishable statuses rather than surfacing as a 500, because
 * "your parent has not finished" and "that artifact is not ready" are user-actionable and a check
 * violation is not.
 */
export async function POST(request: Request, route: Context) {
  const originError = requireScenarioMutationOrigin(request);
  if (originError) return originError;
  const auth = await requireScenarioContext();
  if (auth.response) return auth.response;
  const { jobId } = await route.params;

  const parsed = CreatePostprocessSchema.safeParse(await readJson(request));
  if (!parsed.success) {
    return NextResponse.json(
      { error: "invalid_postprocess_request", details: parsed.error.flatten() },
      { status: 400 },
    );
  }

  // Queuing a postprocess run spends this workspace's render capacity, so it is a content mutation
  // against the parent's dataset, not a read.
  const access = await requireScenarioMutableRenderJobContext(
    auth.context,
    jobId,
    "mutateContent",
  );
  if (access.response) return access.response;

  try {
    const created = await createPostprocessJob(auth.context, {
      ...parsed.data,
      parentRenderJobId: jobId,
    });
    return NextResponse.json(created, { status: created.created ? 201 : 200 });
  } catch (error) {
    const code = error instanceof Error ? error.message : "";
    if (code === "uniscenario_postprocess_parent_not_succeeded") {
      return NextResponse.json({ error: code }, { status: 409 });
    }
    if (code === "uniscenario_postprocess_source_artifact_unavailable") {
      return NextResponse.json({ error: code }, { status: 409 });
    }
    if (code.startsWith("uniscenario_postprocess_")) {
      // The remaining named errors are all malformed input the schema cannot express — a blank
      // model family after trimming, a non-object config, a self-referential parent.
      return NextResponse.json({ error: code }, { status: 400 });
    }
    throw error;
  }
}

/**
 * The postprocess children of this render job.
 *
 * Dynamic for the same reason as the gallery: each child's `jobState` and `progressPercent` are
 * worker-advanced. Hidden children are excluded, on the rule that hiding is a gallery concept and a
 * hidden derivative should not reappear merely because it has a parent.
 */
export async function GET(_request: Request, route: Context) {
  const auth = await requireScenarioContext();
  if (auth.response) return auth.response;
  const { jobId } = await route.params;

  const access = await requireScenarioMutableRenderJobContext(auth.context, jobId, "read");
  if (access.response) return access.response;

  return NextResponse.json(
    { items: await listPostprocessChildren(auth.context, jobId) },
    { headers: SCENARIO_PRIVATE_CACHE_HEADERS },
  );
}
