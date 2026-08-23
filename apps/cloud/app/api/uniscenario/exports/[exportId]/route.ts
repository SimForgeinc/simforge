import { NextResponse } from "next/server";
import { getExport } from "@/app/lib/uniscenario/control-plane-store";
import { requireUniScenarioContext } from "@/app/lib/uniscenario/http";

type Context = { params: Promise<{ exportId: string }> };

export async function GET(_request: Request, route: Context) {
  const auth = await requireUniScenarioContext();
  if (auth.response) return auth.response;
  const { exportId } = await route.params;
  const result = await getExport(auth.context, exportId);
  return result
    ? NextResponse.json(result, { headers: { "Cache-Control": "private, no-store" } })
    : NextResponse.json({ error: "export_not_found" }, { status: 404 });
}
