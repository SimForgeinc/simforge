import { NextResponse } from "next/server";
import { listUniScenarioMapDescriptors } from "@/app/lib/uniscenario/document-store";
import { requireUniScenarioContext, UNISCENARIO_PRIVATE_CACHE_HEADERS } from "@/app/lib/uniscenario/http";

type Context = { params: Promise<{ mapVersionId: string }> };

export async function GET(_request: Request, route: Context) {
  const auth = await requireUniScenarioContext();
  if (auth.response) return auth.response;
  const { mapVersionId } = await route.params;
  const descriptor = (await listUniScenarioMapDescriptors(auth.context))
    .find((map) => map.mapVersionId === mapVersionId);
  return descriptor
    ? NextResponse.json(descriptor, { headers: UNISCENARIO_PRIVATE_CACHE_HEADERS })
    : NextResponse.json({ error: "map_version_not_found" }, { status: 404 });
}
