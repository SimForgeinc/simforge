import { NextResponse } from "next/server";
import { CompleteUniScenarioMaterializedTrafficSchema } from "@/app/lib/uniscenario/contracts";
import { readJson, requireUniScenarioContext, requireUniScenarioMutableDocumentContext, requireUniScenarioMutationOrigin } from "@/app/lib/uniscenario/http";
import { completeMaterializedTraffic } from "@/app/lib/uniscenario/materialized-traffic-store";

type Context = { params: Promise<{ documentId: string }> };
export async function POST(request: Request, route: Context) {
  const origin = requireUniScenarioMutationOrigin(request);
  if (origin) return origin;
  const auth = await requireUniScenarioContext();
  if (auth.response) return auth.response;
  const parsed = CompleteUniScenarioMaterializedTrafficSchema.safeParse(await readJson(request));
  if (!parsed.success) return NextResponse.json({ error: "invalid_materialized_traffic" }, { status: 400 });
  const { documentId } = await route.params;
  const access = await requireUniScenarioMutableDocumentContext(auth.context, documentId, "mutateContent");
  if (access.response) return access.response;
  const result = await completeMaterializedTraffic(auth.context, documentId, parsed.data);
  return result ? NextResponse.json(result) : NextResponse.json({ error: "materialized_traffic_not_found" }, { status: 404 });
}
