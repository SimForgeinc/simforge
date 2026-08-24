import { NextResponse } from "next/server";
import { requireScenarioContext, SCENARIO_PRIVATE_CACHE_HEADERS } from "@/app/lib/scenario/http";
import { inspectCompletedExport } from "@/app/lib/scenario/render/export-inspection-store";

type Context = { params: Promise<{ exportId: string }> };

export async function GET(_request: Request, route: Context) {
  const auth = await requireScenarioContext();
  if (auth.response) return auth.response;
  const { exportId } = await route.params;
  const inspection = await inspectCompletedExport(auth.context, exportId);
  return inspection
    ? NextResponse.json(inspection, { headers: SCENARIO_PRIVATE_CACHE_HEADERS })
    : NextResponse.json({ error: "completed_export_not_found" }, { status: 404 });
}
