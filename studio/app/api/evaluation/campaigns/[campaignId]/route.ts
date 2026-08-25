import { NextResponse } from "next/server";
import { getCampaign } from "@/app/lib/evaluation/ledger";
import {
  requireScenarioContext,
  SCENARIO_PRIVATE_CACHE_HEADERS,
} from "@/app/lib/scenario/http";

type Context = { params: Promise<{ campaignId: string }> };

export async function GET(_request: Request, route: Context) {
  const auth = await requireScenarioContext();
  if (auth.response) return auth.response;
  const { campaignId } = await route.params;
  const campaign = await getCampaign(auth.context, campaignId);
  if (!campaign) return NextResponse.json({ error: "campaign_not_found" }, { status: 404 });
  return NextResponse.json(campaign, { headers: SCENARIO_PRIVATE_CACHE_HEADERS });
}
