import { NextResponse } from "next/server";
import { listCampaigns } from "@/app/lib/evaluation/ledger";
import {
  requireScenarioContext,
  SCENARIO_PRIVATE_CACHE_HEADERS,
} from "@/app/lib/scenario/http";

/** Campaign ledgers read from `$SIMFORGE_RUNS_ROOT/<campaignId>/ledger.jsonl`. */
export async function GET() {
  const auth = await requireScenarioContext();
  if (auth.response) return auth.response;
  return NextResponse.json(
    { campaigns: await listCampaigns(auth.context) },
    { headers: SCENARIO_PRIVATE_CACHE_HEADERS },
  );
}
