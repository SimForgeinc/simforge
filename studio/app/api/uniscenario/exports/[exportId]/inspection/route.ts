import { NextResponse } from "next/server";
import { requireUniScenarioContext, UNISCENARIO_PRIVATE_CACHE_HEADERS } from "@/app/lib/uniscenario/http";
import { inspectCompletedExport } from "@/app/lib/uniscenario/render/export-inspection-store";

type Context = { params: Promise<{ exportId: string }> };

export async function GET(_request: Request, route: Context) {
  const auth = await requireUniScenarioContext();
  if (auth.response) return auth.response;
  const { exportId } = await route.params;
  const inspection = await inspectCompletedExport(auth.context, exportId);
  return inspection
    ? NextResponse.json(inspection, { headers: UNISCENARIO_PRIVATE_CACHE_HEADERS })
    : NextResponse.json({ error: "completed_export_not_found" }, { status: 404 });
}
