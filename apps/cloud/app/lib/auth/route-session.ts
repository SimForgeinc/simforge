import { NextResponse, type NextRequest } from "next/server";
import { LOCAL_SESSION, type AuthenticatedUser } from "./session";

type RouteSessionSuccess = {
  ok: true;
  session: AuthenticatedUser;
  apply<T extends NextResponse>(response: T): T;
};

type RouteSessionFailure = {
  ok: false;
  response: NextResponse;
};

export type RouteSessionResult = RouteSessionSuccess | RouteSessionFailure;

export async function requireRouteSession(_request: NextRequest): Promise<RouteSessionResult> {
  return {
    ok: true,
    session: LOCAL_SESSION,
    apply<T extends NextResponse>(response: T): T {
      return response;
    },
  };
}
