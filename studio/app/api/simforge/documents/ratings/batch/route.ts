import { NextResponse } from "next/server";
import { ScenarioRatingBatchSchema } from "@/app/lib/scenario/contracts";
import { listScenarioRatingAggregates } from "@/app/lib/scenario/rating-store";
import {
  readJson,
  requireScenarioContext,
  requireScenarioMutationOrigin,
  SCENARIO_PRIVATE_CACHE_HEADERS,
} from "@/app/lib/scenario/http";

/**
 * Batch rating aggregates for a page of list rows: one query instead of one per row.
 *
 * POST rather than GET only because the id list would not fit comfortably in a query string; it
 * reads no state and writes none. No per-dataset authorization gate is needed because
 * `listScenarioRatingAggregates` reads `document_review_state_v` filtered on
 * `workspace_id = :workspace_id`, so ids outside the caller's workspace simply return nothing.
 */
export async function POST(request: Request) {
  const originError = requireScenarioMutationOrigin(request);
  if (originError) return originError;
  const auth = await requireScenarioContext();
  if (auth.response) return auth.response;
  const parsed = ScenarioRatingBatchSchema.safeParse(await readJson(request));
  if (!parsed.success) {
    return NextResponse.json(
      { error: "invalid_rating_batch", details: parsed.error.flatten() },
      { status: 400 },
    );
  }
  const aggregates = await listScenarioRatingAggregates(auth.context, parsed.data.documentIds);
  return NextResponse.json({ aggregates }, { headers: SCENARIO_PRIVATE_CACHE_HEADERS });
}
