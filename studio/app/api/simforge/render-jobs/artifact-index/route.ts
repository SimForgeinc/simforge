import { NextResponse } from "next/server";
import { listWorkspaceRenderArtifacts } from "@/app/lib/scenario/render/artifact-store";
import {
  requireScenarioContext,
  SCENARIO_PRIVATE_CACHE_HEADERS,
} from "@/app/lib/scenario/http";

/**
 * Every artifact in the workspace reachable from a render job (manifest #146, the artifacts workspace).
 *
 * PLACED UNDER `render-jobs/` ON PURPOSE, and it is worth saying why so it can be moved deliberately
 * rather than by accident. `app/api/uniscenario/artifacts/` already exists and belongs to the upload
 * and finalisation surface; this is a render-scoped browse read that joins through `artifact_links` to
 * `render_jobs` and filters on render visibility. Putting it there would mix a browse view into an
 * upload API and would cross a directory this lane does not own. If the artifacts route owner would
 * rather host it, moving it is a rename — nothing here depends on the path.
 *
 * METADATA ONLY, NO URLs. Signing a whole workspace of artifacts on a browse request would mint
 * hundreds of 3600s credentials for rows the user never opens. The client calls
 * `render-jobs/[jobId]/artifacts` for the job it actually opens, which signs just that job's outputs.
 * That keeps the presign boundary narrow and is the reason this route can exist without a per-artifact
 * authorization pass.
 *
 * Dynamic: `artifactState` and `verifiedAt` are advanced by the verification outbox, so per §2.5 this
 * read is not cacheable despite the immutable-looking `sha256` / `byteLength` beside them.
 *
 * Artifacts of HIDDEN render jobs are excluded, so hiding a render hides its outputs from the browse
 * surface too — otherwise "hidden" would mean nothing here. They stay reachable through
 * `render-jobs/[jobId]/artifacts` by id, so nothing becomes unrecoverable.
 *
 * Workspace-scoped by the store's predicate rather than by a dataset gate: this is a list across many
 * datasets, so there is no single dataset to authorize against. Rows from datasets merely *shared* into
 * this workspace are not included, because the join requires `artifact_links.workspace_id` to match.
 */
export async function GET(request: Request) {
  const auth = await requireScenarioContext();
  if (auth.response) return auth.response;

  const url = new URL(request.url);
  const limitParam = url.searchParams.get("limit");
  const artifactKind = url.searchParams.get("artifactKind");

  const items = await listWorkspaceRenderArtifacts(auth.context, {
    limit: limitParam === null ? undefined : Number(limitParam),
    artifactKind: artifactKind && artifactKind.trim() ? artifactKind.trim() : null,
  });

  return NextResponse.json({ items }, { headers: SCENARIO_PRIVATE_CACHE_HEADERS });
}
