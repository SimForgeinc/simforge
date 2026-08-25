import { NextResponse } from "next/server";
import { comparePolicies } from "@/app/lib/evaluation/ledger";
import {
  requireScenarioContext,
  SCENARIO_PRIVATE_CACHE_HEADERS,
} from "@/app/lib/scenario/http";

type Context = { params: Promise<{ campaignId: string }> };

/** A/B comparison of two policy columns: `?a=<policyId>&b=<policyId>`. */
export async function GET(request: Request, route: Context) {
  const auth = await requireScenarioContext();
  if (auth.response) return auth.response;
  const { campaignId } = await route.params;
  const search = new URL(request.url).searchParams;
  const a = search.get("a");
  const b = search.get("b");
  if (!a || !b) {
    return NextResponse.json({ error: "compare_requires_a_and_b" }, { status: 400 });
  }
  const comparison = await comparePolicies(auth.context, campaignId, a, b);
  if (!comparison) return NextResponse.json({ error: "policy_not_found" }, { status: 404 });
  return NextResponse.json(comparison, { headers: SCENARIO_PRIVATE_CACHE_HEADERS });
}
