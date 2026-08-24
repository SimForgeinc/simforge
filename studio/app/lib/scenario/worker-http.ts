import { NextResponse } from "next/server";
import { authorizeScenarioRenderWorker, authorizeScenarioWorker } from "./control-plane-store";

export function rejectUnauthorizedWorker(request: Request) {
  return authorizeScenarioWorker(request)
    ? null
    : NextResponse.json({ error: "worker_unauthorized" }, { status: 401 });
}

export async function rejectUnauthorizedRenderWorker(request: Request) {
  return await authorizeScenarioRenderWorker(request)
    ? null
    : NextResponse.json({ error: "worker_unauthorized" }, { status: 401 });
}

export function rejectedLeaseResponse() {
  return NextResponse.json({ error: "lease_invalid_or_expired" }, { status: 409 });
}
