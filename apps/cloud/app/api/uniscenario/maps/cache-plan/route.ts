import { connection, NextResponse } from "next/server";
import { listUniScenarioBrowserCacheInventory } from "@/app/lib/uniscenario/document-store";
import {
  requireUniScenarioContext,
  UNISCENARIO_PRIVATE_CACHE_HEADERS,
} from "@/app/lib/uniscenario/http";

export async function GET() {
  await connection();
  const auth = await requireUniScenarioContext();
  if (auth.response) return auth.response;
  return NextResponse.json(
    await listUniScenarioBrowserCacheInventory(auth.context),
    { headers: UNISCENARIO_PRIVATE_CACHE_HEADERS },
  );
}
