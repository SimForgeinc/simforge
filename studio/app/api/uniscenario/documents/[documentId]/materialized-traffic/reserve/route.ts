import { NextResponse } from "next/server";
import { ReserveUniScenarioMaterializedTrafficSchema } from "@/app/lib/uniscenario/contracts";
import { readJson, requireUniScenarioContext, requireUniScenarioMutableDocumentContext, requireUniScenarioMutationOrigin } from "@/app/lib/uniscenario/http";
import { reserveMaterializedTraffic } from "@/app/lib/uniscenario/materialized-traffic-store";

type Context = { params: Promise<{ documentId: string }> };
export async function POST(request: Request, route: Context) {
  const origin = requireUniScenarioMutationOrigin(request);
  if (origin) return origin;
  const auth = await requireUniScenarioContext();
  if (auth.response) return auth.response;
  const parsed = ReserveUniScenarioMaterializedTrafficSchema.safeParse(await readJson(request));
  if (!parsed.success) return NextResponse.json({ error: "invalid_materialized_traffic" }, { status: 400 });
  const { documentId } = await route.params;
  const access = await requireUniScenarioMutableDocumentContext(auth.context, documentId, "mutateContent");
  if (access.response) return access.response;
  const result = await reserveMaterializedTraffic(auth.context, documentId, parsed.data);
  return result ? NextResponse.json(result) : NextResponse.json({ error: "stale_materialized_traffic" }, { status: 409 });
}
