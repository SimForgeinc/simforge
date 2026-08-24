import { connection, NextResponse, type NextRequest } from "next/server";
import {
  SCENARIO_REVIEW_QUEUE_MAX_PAGE_SIZE,
  SCENARIO_REVIEW_QUEUE_PAGE_SIZE,
} from "@/app/lib/scenario/review-contracts";
import { listScenarioReviewQueue } from "@/app/lib/scenario/review-store";
import {
  requireScenarioContext,
  SCENARIO_PRIVATE_CACHE_HEADERS,
} from "@/app/lib/scenario/http";

/**
 * Operator review queue: pending documents, oldest first (manifest #42).
 *
 * `connection()` and no cache headers beyond `private, no-store`: the worker control plane advances
 * `document_review_state_v` underneath this, so a cached page would hand out documents that were
 * rated seconds ago. See the background-writer rule at the top of §2.5.
 */
export async function GET(request: NextRequest) {
  await connection();
  const auth = await requireScenarioContext();
  if (auth.response) return auth.response;

  const params = request.nextUrl.searchParams;
  const rawLimit = Number(params.get("limit"));
  // `Number.isInteger` rather than a truthiness check: a `limit=0` must fall back to the default
  // rather than be treated as "no limit", and NaN must not reach the clamp.
  const limit = Number.isInteger(rawLimit) && rawLimit > 0
    ? Math.min(rawLimit, SCENARIO_REVIEW_QUEUE_MAX_PAGE_SIZE)
    : SCENARIO_REVIEW_QUEUE_PAGE_SIZE;

  const page = await listScenarioReviewQueue(auth.context, {
    limit,
    cursor: params.get("cursor"),
    // `datasetId` is intentionally not read yet — the store accepts it so per-dataset scoping is a
    // query parameter away rather than a route reshape.
  });

  return NextResponse.json(page, { headers: SCENARIO_PRIVATE_CACHE_HEADERS });
}
