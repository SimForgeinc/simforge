import { NextResponse } from "next/server";
import { getPolicyDetail } from "@/app/lib/evaluation/ledger";
import {
  requireScenarioContext,
  SCENARIO_PRIVATE_CACHE_HEADERS,
} from "@/app/lib/scenario/http";

type Context = { params: Promise<{ campaignId: string; policyId: string }> };

/** One policy column of a campaign: episode list with per-episode scores. */
export async function GET(_request: Request, route: Context) {
  const auth = await requireScenarioContext();
  if (auth.response) return auth.response;
  const { campaignId, policyId } = await route.params;
  const detail = await getPolicyDetail(auth.context, campaignId, policyId);
  if (!detail) return NextResponse.json({ error: "policy_not_found" }, { status: 404 });
  return NextResponse.json(detail, { headers: SCENARIO_PRIVATE_CACHE_HEADERS });
}
