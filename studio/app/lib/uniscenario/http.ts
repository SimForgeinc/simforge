import { NextResponse } from "next/server";
import { getCurrentSession } from "@/app/lib/auth/session";
import { getAppContext, type AppContext } from "@/app/lib/db/app-context";
import {
  resolveUniScenarioDatasetAccess,
  resolveUniScenarioDocumentDatasetAccess,
  resolveUniScenarioRenderJobDatasetAccess,
  resolveUniScenarioRevisionDatasetAccess,
  type UniScenarioDatasetAccess,
  type UniScenarioDatasetAction,
} from "./dataset-store";

/** Local app mutations are accepted from localhost, desktop shells, and tunnels. */
export function requireUniScenarioMutationOrigin(_request: Request): NextResponse | null {
  return null;
}

export async function requireUniScenarioContext(): Promise<
  { context: AppContext; response?: never } | { context?: never; response: NextResponse }
> {
  const session = await getCurrentSession();
  if (!session) {
    return {
      response: NextResponse.json({ error: "authentication_required" }, { status: 401 }),
    };
  }
  return { context: getAppContext(session) };
}

/**
 * Authorize a mutation against a UniScenario dataset (§5.7 FINDING A).
 *
 * Until `20260805014000` there was no sharing concept in `uniscenario.*`, so a
 * `workspace_id = :workspace_id` predicate was the whole authorization model.
 * That migration adds `visibility`, `is_system_managed`, and `system_slug`, at
 * which point a dataset can be readable by a caller who must not be able to
 * rename it, delete it, or add documents to it. This is the enforcement layer
 * for that, with `assertDatasetAction`-equivalent semantics and the same
 * response shape as `accessErrorToResponse` in
 * `app/lib/scenario-sharing/access-policy.ts`.
 *
 * Mutability is DERIVED, never read from a stored column — see §6.5 and the
 * header of migration `20260805014000`.
 *
 * This is deliberately separate from and additional to
 * `requireUniScenarioMutationOrigin`: that guard answers "did a browser on an
 * allowlisted origin send this?", this one answers "may this caller do this to
 * this dataset?". Every mutation route needs both.
 */
export async function requireUniScenarioMutableContext(
  context: AppContext,
  datasetId: string,
  action: UniScenarioDatasetAction = "mutateContent",
): Promise<{ access: UniScenarioDatasetAccess; response?: never } | { access?: never; response: NextResponse }> {
  const access = await resolveUniScenarioDatasetAccess(context, datasetId);
  if (!access || !access.actions.read) {
    return { response: datasetAccessResponse("Dataset not found", 404, "not_found") };
  }
  if (!access.actions[action]) {
    return {
      response: datasetAccessResponse(
        "Dataset action is not allowed",
        403,
        "dataset_action_denied",
      ),
    };
  }
  return { access };
}

/**
 * Same authorization gate as {@link requireUniScenarioMutableContext}, resolved through the
 * dataset that owns a document. Document-level mutation routes only know a `documentId`.
 */
export async function requireUniScenarioMutableDocumentContext(
  context: AppContext,
  documentId: string,
  action: UniScenarioDatasetAction = "mutateContent",
): Promise<{ access: UniScenarioDatasetAccess; response?: never } | { access?: never; response: NextResponse }> {
  const access = await resolveUniScenarioDocumentDatasetAccess(context, documentId);
  if (!access || !access.actions.read) {
    return { response: datasetAccessResponse("Document not found", 404, "not_found") };
  }
  if (!access.actions[action]) {
    return {
      response: datasetAccessResponse(
        "Dataset action is not allowed",
        403,
        "dataset_action_denied",
      ),
    };
  }
  return { access };
}

/** {@link requireUniScenarioMutableContext} resolved through the revision's owning dataset. */
export async function requireUniScenarioMutableRevisionContext(
  context: AppContext,
  revisionId: string,
  action: UniScenarioDatasetAction = "mutateContent",
) {
  return gate(
    await resolveUniScenarioRevisionDatasetAccess(context, revisionId),
    action,
    "Revision not found",
  );
}

/** {@link requireUniScenarioMutableContext} resolved through the render job's owning dataset. */
export async function requireUniScenarioMutableRenderJobContext(
  context: AppContext,
  renderJobId: string,
  action: UniScenarioDatasetAction = "mutateContent",
) {
  return gate(
    await resolveUniScenarioRenderJobDatasetAccess(context, renderJobId),
    action,
    "Render job not found",
  );
}

function gate(
  access: UniScenarioDatasetAccess | null,
  action: UniScenarioDatasetAction,
  missingMessage: string,
): { access: UniScenarioDatasetAccess; response?: never } | { access?: never; response: NextResponse } {
  if (!access || !access.actions.read) {
    return { response: datasetAccessResponse(missingMessage, 404, "not_found") };
  }
  if (!access.actions[action]) {
    return {
      response: datasetAccessResponse(
        "Dataset action is not allowed",
        403,
        "dataset_action_denied",
      ),
    };
  }
  return { access };
}

function datasetAccessResponse(message: string, status: number, code: string) {
  return NextResponse.json(
    { error: message, code, status },
    { status, headers: { "Cache-Control": "no-store" } },
  );
}

/**
 * `Cache-Control` for authenticated, workspace-scoped GETs (§5.7 FINDING C).
 *
 * Keep this on any response that carries a presigned URL. §2.5 of the parity
 * plan is explicit that no caching profile is correct for one: a stored
 * presigned URL outlives the request it was minted for, and the store sits
 * beneath the header that would otherwise protect it.
 */
export const UNISCENARIO_PRIVATE_CACHE_HEADERS = { "Cache-Control": "private, no-store" } as const;

/**
 * `Cache-Control` for authenticated GETs that carry no presigned URL.
 *
 * `no-cache` is not "do not cache" — it stores the body and requires
 * revalidation before every reuse. Paired with an `ETag` that means an
 * unchanged read costs a 304 with no body instead of the full payload, and
 * there is no stale window at all: nothing is ever served without the server
 * agreeing first. That is what makes read-after-write safe here without any
 * invalidation step — the editor saving and immediately re-reading revalidates
 * like any other read and sees its own write.
 *
 * FINDING C asked for `private` on workspace-scoped responses so a shared CDN
 * never holds one. This keeps it.
 */
export const UNISCENARIO_REVALIDATE_CACHE_HEADERS = { "Cache-Control": "private, no-cache" } as const;

/**
 * `Cache-Control` for authenticated GETs whose body can never change.
 *
 * Only for resources addressed by something immutable — a revision id names a
 * row that is written once and never edited. Reusing this anywhere the body
 * can change would create exactly the stale window the header above avoids.
 */
export const UNISCENARIO_IMMUTABLE_CACHE_HEADERS = {
  "Cache-Control": "private, max-age=31536000, immutable",
} as const;

async function weakEtag(body: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(body));
  const hex = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
  return `"${hex.slice(0, 32)}"`;
}

/**
 * JSON response that a client can revalidate instead of re-downloading.
 *
 * The validator is a digest of the body rather than a version column, so it is
 * correct for every payload shape — a list whose members changed, a computed
 * summary, a document whose `draftVersion` did not move but whose title did.
 * Deriving it from one field would silently miss those.
 */
export async function uniScenarioJsonWithEtag(
  request: Request,
  payload: unknown,
  headers: Record<string, string> = UNISCENARIO_REVALIDATE_CACHE_HEADERS,
): Promise<Response> {
  const body = JSON.stringify(payload);
  const etag = await weakEtag(body);
  const inm = request.headers.get("if-none-match");
  // A client may echo several validators; a match on any of them is unchanged.
  if (inm && inm.split(",").some((candidate) => candidate.trim() === etag)) {
    return new Response(null, { status: 304, headers: { ...headers, ETag: etag } });
  }
  return new Response(body, {
    status: 200,
    headers: { ...headers, ETag: etag, "content-type": "application/json" },
  });
}

export async function readJson(request: Request) {
  return request.json().catch(() => null) as Promise<unknown>;
}
