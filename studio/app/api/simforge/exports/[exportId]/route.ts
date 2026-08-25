import { NextResponse } from "next/server";
import { getExport } from "@/app/lib/scenario/control-plane-store";
import { requireScenarioContext } from "@/app/lib/scenario/http";

type Context = { params: Promise<{ exportId: string }> };

export async function GET(_request: Request, route: Context) {
  const auth = await requireScenarioContext();
  if (auth.response) return auth.response;
  const { exportId } = await route.params;
  const result = await getExport(auth.context, exportId);
  return result
    ? NextResponse.json(result, { headers: { "Cache-Control": "private, no-store" } })
    : NextResponse.json({ error: "export_not_found" }, { status: 404 });
}
