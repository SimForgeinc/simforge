import { NextResponse } from "next/server";
import { authorizeUniScenarioRenderWorker, authorizeUniScenarioWorker } from "./control-plane-store";

export function rejectUnauthorizedWorker(request: Request) {
  return authorizeUniScenarioWorker(request)
    ? null
    : NextResponse.json({ error: "worker_unauthorized" }, { status: 401 });
}

export async function rejectUnauthorizedRenderWorker(request: Request) {
  return await authorizeUniScenarioRenderWorker(request)
    ? null
    : NextResponse.json({ error: "worker_unauthorized" }, { status: 401 });
}

export function rejectedLeaseResponse() {
  return NextResponse.json({ error: "lease_invalid_or_expired" }, { status: 409 });
}
