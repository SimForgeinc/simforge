import { NextResponse } from "next/server";
import { listScenarioMapDescriptors } from "@/app/lib/scenario/document-store";
import { requireScenarioContext, SCENARIO_PRIVATE_CACHE_HEADERS } from "@/app/lib/scenario/http";

type Context = { params: Promise<{ mapVersionId: string }> };

export async function GET(_request: Request, route: Context) {
  const auth = await requireScenarioContext();
  if (auth.response) return auth.response;
  const { mapVersionId } = await route.params;
  const descriptor = (await listScenarioMapDescriptors(auth.context))
    .find((map) => map.mapVersionId === mapVersionId);
  return descriptor
    ? NextResponse.json(descriptor, { headers: SCENARIO_PRIVATE_CACHE_HEADERS })
    : NextResponse.json({ error: "map_version_not_found" }, { status: 404 });
}
