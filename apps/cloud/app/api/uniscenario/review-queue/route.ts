import { connection, NextResponse, type NextRequest } from "next/server";
import {
  UNISCENARIO_REVIEW_QUEUE_MAX_PAGE_SIZE,
  UNISCENARIO_REVIEW_QUEUE_PAGE_SIZE,
} from "@/app/lib/uniscenario/review-contracts";
import { listUniScenarioReviewQueue } from "@/app/lib/uniscenario/review-store";
import {
  requireUniScenarioContext,
  UNISCENARIO_PRIVATE_CACHE_HEADERS,
} from "@/app/lib/uniscenario/http";

/**
 * Operator review queue: pending documents, oldest first (manifest #42).
 *
 * `connection()` and no cache headers beyond `private, no-store`: the worker control plane advances
 * `document_review_state_v` underneath this, so a cached page would hand out documents that were
 * rated seconds ago. See the background-writer rule at the top of §2.5.
 */
export async function GET(request: NextRequest) {
  await connection();
  const auth = await requireUniScenarioContext();
  if (auth.response) return auth.response;

  const params = request.nextUrl.searchParams;
  const rawLimit = Number(params.get("limit"));
  // `Number.isInteger` rather than a truthiness check: a `limit=0` must fall back to the default
  // rather than be treated as "no limit", and NaN must not reach the clamp.
  const limit = Number.isInteger(rawLimit) && rawLimit > 0
    ? Math.min(rawLimit, UNISCENARIO_REVIEW_QUEUE_MAX_PAGE_SIZE)
    : UNISCENARIO_REVIEW_QUEUE_PAGE_SIZE;

  const page = await listUniScenarioReviewQueue(auth.context, {
    limit,
    cursor: params.get("cursor"),
    // `datasetId` is intentionally not read yet — the store accepts it so per-dataset scoping is a
    // query parameter away rather than a route reshape.
  });

  return NextResponse.json(page, { headers: UNISCENARIO_PRIVATE_CACHE_HEADERS });
}
