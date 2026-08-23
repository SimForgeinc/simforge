import { NextResponse } from "next/server";
import { LOCAL_SESSION } from "@/app/lib/auth/session";
import { getAppContext } from "@/app/lib/db/app-context";

export const dynamic = "force-dynamic";

export async function GET(): Promise<NextResponse> {
  const context = getAppContext(LOCAL_SESSION);
  return NextResponse.json({
    authenticated: true,
    user: LOCAL_SESSION,
    workspaceId: context.workspaceId,
  });
}
