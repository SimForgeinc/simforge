import { NextResponse } from "next/server";
import { getUniScenarioDatasetReadiness } from "@/app/lib/uniscenario/dataset-store";
import {
  requireUniScenarioContext,
  requireUniScenarioMutableContext,
  UNISCENARIO_PRIVATE_CACHE_HEADERS,
} from "@/app/lib/uniscenario/http";

type Context = { params: Promise<{ datasetId: string }> };

/**
 * Readiness counters for the dataset row badges, shaped exactly for
 * `useDatasetCrudController.applyDatasetReadiness`.
 */
export async function GET(_request: Request, route: Context) {
  const auth = await requireUniScenarioContext();
  if (auth.response) return auth.response;
  const { datasetId } = await route.params;
  const access = await requireUniScenarioMutableContext(auth.context, datasetId, "read");
  if (access.response) return access.response;
  const readiness = await getUniScenarioDatasetReadiness(auth.context, datasetId);
  return readiness
    ? NextResponse.json(readiness, { headers: UNISCENARIO_PRIVATE_CACHE_HEADERS })
    : NextResponse.json({ error: "dataset_not_found" }, { status: 404 });
}
