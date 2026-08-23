import { NextRequest, NextResponse } from "next/server";
import { reverseGeocodeCity } from "@/app/lib/maps/metadata/reverse-geocode";
import { ReverseGeocodeQuery, ReverseGeocodeResponse } from "@/app/lib/api-schemas";
void ReverseGeocodeQuery; void ReverseGeocodeResponse;

/**
 * Reverse geocode a lat/lon to city, state, country.
 * @description Uses the offline GeoNames cities1000 dataset. Returns empty object if no city within 150 km.
 * @queryParams ReverseGeocodeQuery
 * @response 200:ReverseGeocodeResponse
 * @responseSet common
 * @tag Map assets
 * @openapi
 */
export async function GET(req: NextRequest) {
  const lat = Number(req.nextUrl.searchParams.get("lat"));
  const lon = Number(req.nextUrl.searchParams.get("lon"));

  if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
    return NextResponse.json(
      { error: "lat and lon query parameters are required and must be numbers." },
      { status: 400 },
    );
  }

  const result = reverseGeocodeCity(lat, lon);
  return NextResponse.json(result ?? {});
}
