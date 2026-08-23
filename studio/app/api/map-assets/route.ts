import { connection, NextResponse } from "next/server";
import { getMapAssets } from "@/app/lib/map-assets";
import { MapAssetsListResponse } from "@/app/lib/api-schemas";
void MapAssetsListResponse; // referenced in JSDoc for OpenAPI

/**
 * List map assets
 * @description Returns the map assets catalog (S3 or mock fallback). Same data used by the dashboard maps list and map picker.
 * @response 200:MapAssetsListResponse
 * @responseSet common
 * @tag Map assets
 * @openapi
 */
export async function GET() {
  await connection();
  const assets = await getMapAssets();
  return NextResponse.json(assets);
}
