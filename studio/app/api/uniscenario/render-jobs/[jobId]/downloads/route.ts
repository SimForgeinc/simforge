import { NextResponse } from "next/server";
import {
  listRenderJobArtifacts,
  presignArtifactsForContext,
} from "@/app/lib/uniscenario/render/artifact-store";
import {
  requireUniScenarioContext,
  requireUniScenarioMutableRenderJobContext,
  UNISCENARIO_PRIVATE_CACHE_HEADERS,
} from "@/app/lib/uniscenario/http";

type Context = { params: Promise<{ jobId: string }> };

/**
 * One render job's artifacts, each with a freshly minted download URL (manifest #146, #148).
 *
 * NEVER CACHED, AND THE HEADER IS NOT THE ONLY REASON. Plan §2.5.3: `MEDIA_URL_TTL_SECONDS` is 3600s
 * pinned at the IAM role session ceiling, `cacheLife('minutes')` expires at exactly that, and every
 * longer profile serves already-dead links — so no built-in profile is correct. A cache would also sit
 * a layer *beneath* the `private, no-store` header this route sets, which is why the header alone is
 * not sufficient protection. Signing happens per request inside `presignArtifactsForContext`.
 *
 * `storageKey` and `storageBucket` never appear in the response. The DTO does not carry them, the
 * presign helper loads them separately and drops them, and a unit test asserts the contract file
 * mentions neither — a storage key in a client payload is an invitation to construct URLs client-side
 * and bypass this route entirely.
 *
 * URL AVAILABILITY IS EXPLICIT, so a client renders a state rather than a broken player. Only
 * `artifactState === 'available'` gets a URL:
 *
 *   available    -> `url` is a signed string, `expiresInSeconds` is 3600
 *   pending      -> `url: null`  — upload not finalised, there is no complete object yet
 *   quarantined  -> `url: null`  — failed checksum verification; serving it would serve untrusted bytes
 *   deleted      -> `url: null`  — object removed by the cleanup outbox, or vanished mid-request
 *
 * Every item therefore always has a `url` key (possibly null) and an `artifactState`. A client should
 * branch on `artifactState`, not on the presence of `url`, because a future state would also arrive
 * with `url: null` and should render as "not ready" rather than as an error.
 */
export async function GET(_request: Request, route: Context) {
  const auth = await requireUniScenarioContext();
  if (auth.response) return auth.response;
  const { jobId } = await route.params;

  // A render job's artifacts are readable by whoever may read its dataset, which is not the same as
  // "whoever shares its workspace" now that 20260805014000 added sharing.
  const access = await requireUniScenarioMutableRenderJobContext(auth.context, jobId, "read");
  if (access.response) return access.response;

  const artifacts = await listRenderJobArtifacts(auth.context, jobId);
  const items = await presignArtifactsForContext(auth.context, artifacts);

  return NextResponse.json(
    { items, urlTtlSeconds: 3600 },
    { headers: UNISCENARIO_PRIVATE_CACHE_HEADERS },
  );
}
