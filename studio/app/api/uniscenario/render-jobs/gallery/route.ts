import { NextResponse } from "next/server";
import {
  countHiddenRenderJobs,
  countHiddenRenderJobsForDocument,
  listDocumentRenderGallery,
  listRenderGallery,
  listRevisionRenderGallery,
} from "@/app/lib/uniscenario/render/gallery-store";
import {
  requireUniScenarioContext,
  requireUniScenarioMutableDocumentContext,
  requireUniScenarioMutableRevisionContext,
  UNISCENARIO_PRIVATE_CACHE_HEADERS,
} from "@/app/lib/uniscenario/http";

/**
 * The render gallery (manifest #147, and the tile strip of #134).
 *
 * DYNAMIC, never cached. Every field on a tile — `jobState`, `progressPercent`, `attemptCount`,
 * `failureCode`, `artifactCount` — is advanced by the worker control plane while the user watches, so
 * per plan §2.5 this read's freshness requirement is set by a background writer. `use cache` would
 * freeze render progress with nothing able to clear it. The route carries
 * `UNISCENARIO_PRIVATE_CACHE_HEADERS` (`private, no-store`) because the payload is workspace-scoped.
 *
 * `?revisionId=` narrows to one revision; it also switches the query onto
 * `uniscenario_render_jobs_revision_gallery_idx`.
 *
 * `?documentId=` narrows to one document across every revision, which is what the render tab of an
 * open document wants: a render freezes its own snapshot at submit time, so an actively edited
 * scenario accumulates renders under several revisions and a revision-scoped tab would hide its own
 * history the moment the author changed anything. `revisionId` wins when both are supplied, being
 * the narrower of the two. Omitting both lists the whole workspace.
 *
 * `hiddenCount` ships alongside so the client can offer "show N hidden" without a second round-trip.
 * Hidden jobs are never in `items` — that is the point of the hide — but they remain reachable
 * individually through `[jobId]/detail`.
 */
export async function GET(request: Request) {
  const auth = await requireUniScenarioContext();
  if (auth.response) return auth.response;

  const url = new URL(request.url);
  const revisionId = url.searchParams.get("revisionId");
  const documentId = url.searchParams.get("documentId");
  const limitParam = url.searchParams.get("limit");
  // Parsed permissively and clamped in the store; a bad value must not 400 a read-only list.
  const limit = limitParam === null ? undefined : Number(limitParam);
  const jobMode = url.searchParams.get("jobMode");

  if (revisionId) {
    // §5.7 FINDING A: a revision can live in a dataset shared into this workspace, so reading its
    // renders is a dataset-authorized action rather than a workspace-predicate one.
    const access = await requireUniScenarioMutableRevisionContext(auth.context, revisionId, "read");
    if (access.response) return access.response;
    const [items, hiddenCount] = await Promise.all([
      listRevisionRenderGallery(auth.context, revisionId, { limit }),
      countHiddenRenderJobs(auth.context, revisionId),
    ]);
    return NextResponse.json({ items, hiddenCount }, { headers: UNISCENARIO_PRIVATE_CACHE_HEADERS });
  }

  if (documentId) {
    // Same reasoning as the revision branch: a document can live in a dataset shared into this
    // workspace, so reading its renders is a dataset-authorized action.
    const access = await requireUniScenarioMutableDocumentContext(auth.context, documentId, "read");
    if (access.response) return access.response;
    const [items, hiddenCount] = await Promise.all([
      listDocumentRenderGallery(auth.context, documentId, { limit }),
      countHiddenRenderJobsForDocument(auth.context, documentId),
    ]);
    return NextResponse.json({ items, hiddenCount }, { headers: UNISCENARIO_PRIVATE_CACHE_HEADERS });
  }

  const [items, hiddenCount] = await Promise.all([
    listRenderGallery(auth.context, {
      limit,
      jobMode: isJobMode(jobMode) ? jobMode : null,
    }),
    countHiddenRenderJobs(auth.context),
  ]);
  return NextResponse.json({ items, hiddenCount }, { headers: UNISCENARIO_PRIVATE_CACHE_HEADERS });
}

const JOB_MODES = ["interaction_2d", "full_render", "cosmos_augment", "vlm_annotate"] as const;

/**
 * An unrecognised `jobMode` is dropped rather than rejected, so the filter degrades to "no filter"
 * instead of 400ing a gallery. The store parameterises the value either way, so this is a
 * normalisation, not a safety boundary.
 */
function isJobMode(value: string | null): value is (typeof JOB_MODES)[number] {
  return value !== null && (JOB_MODES as readonly string[]).includes(value);
}
