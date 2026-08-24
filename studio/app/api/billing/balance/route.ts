import { NextResponse } from "next/server";

export async function GET(): Promise<NextResponse> {
  return NextResponse.json({
    plan: "local",
    free: true,
    unlimited: true,
    creditsBalance: null,
    pendingCreditsCents: 0,
  });
}
