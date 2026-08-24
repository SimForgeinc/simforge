import { connection, NextResponse } from "next/server";
import { listScenarioBrowserCacheInventory } from "@/app/lib/scenario/document-store";
import {
  requireScenarioContext,
  SCENARIO_PRIVATE_CACHE_HEADERS,
} from "@/app/lib/scenario/http";

export async function GET() {
  await connection();
  const auth = await requireScenarioContext();
  if (auth.response) return auth.response;
  return NextResponse.json(
    await listScenarioBrowserCacheInventory(auth.context),
    { headers: SCENARIO_PRIVATE_CACHE_HEADERS },
  );
}
