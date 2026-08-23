import { NextResponse } from "next/server";

const disabled = () =>
  NextResponse.json(
    {
      error: "gallery_generation_disabled",
      message: "Meshy asset generation is unavailable in the local application.",
    },
    { status: 501, headers: { "Cache-Control": "no-store" } },
  );

export const GET = disabled;
export const POST = disabled;
