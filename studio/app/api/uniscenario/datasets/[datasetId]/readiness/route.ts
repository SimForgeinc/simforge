import { NextResponse } from "next/server";
import { getScenarioDatasetReadiness } from "@/app/lib/scenario/dataset-store";
import {
  requireScenarioContext,
  requireScenarioMutableContext,
  SCENARIO_PRIVATE_CACHE_HEADERS,
} from "@/app/lib/scenario/http";

type Context = { params: Promise<{ datasetId: string }> };

/**
 * Readiness counters for the dataset row badges, shaped exactly for
 * `useDatasetCrudController.applyDatasetReadiness`.
 */
export async function GET(_request: Request, route: Context) {
  const auth = await requireScenarioContext();
  if (auth.response) return auth.response;
  const { datasetId } = await route.params;
  const access = await requireScenarioMutableContext(auth.context, datasetId, "read");
  if (access.response) return access.response;
  const readiness = await getScenarioDatasetReadiness(auth.context, datasetId);
  return readiness
    ? NextResponse.json(readiness, { headers: SCENARIO_PRIVATE_CACHE_HEADERS })
    : NextResponse.json({ error: "dataset_not_found" }, { status: 404 });
}
