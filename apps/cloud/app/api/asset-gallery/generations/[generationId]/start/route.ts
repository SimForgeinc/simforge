import { NextResponse } from "next/server";

export async function POST() {
  return NextResponse.json(
    {
      error: "gallery_generation_disabled",
      message: "Meshy asset generation is unavailable in the local application.",
    },
    { status: 501, headers: { "Cache-Control": "no-store" } },
  );
}
