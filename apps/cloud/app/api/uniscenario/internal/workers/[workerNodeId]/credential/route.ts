import { NextResponse } from "next/server";
import {
  ProvisionRenderWorkerCredentialSchema,
  RevokeRenderWorkerCredentialSchema,
} from "@/app/lib/uniscenario/contracts";
import {
  provisionRenderWorkerCredential,
  revokeRenderWorkerCredential,
} from "@/app/lib/uniscenario/control-plane-store";
import { readJson } from "@/app/lib/uniscenario/http";
import { rejectUnauthorizedWorker } from "@/app/lib/uniscenario/worker-http";

type Context = { params: Promise<{ workerNodeId: string }> };

async function nodeId(route: Context) {
  const { workerNodeId } = await route.params;
  return workerNodeId && workerNodeId.length <= 200 ? workerNodeId : null;
}

export async function POST(request: Request, route: Context) {
  const unauthorized = rejectUnauthorizedWorker(request);
  if (unauthorized) return unauthorized;
  const parsed = ProvisionRenderWorkerCredentialSchema.safeParse(await readJson(request));
  if (!parsed.success) {
    return NextResponse.json(
      { error: "invalid_worker_credential", details: parsed.error.flatten() },
      { status: 400 },
    );
  }
  const workerNodeId = await nodeId(route);
  if (!workerNodeId) return NextResponse.json({ error: "invalid_worker_node_id" }, { status: 400 });
  try {
    const result = await provisionRenderWorkerCredential(workerNodeId, parsed.data);
    return result
      ? NextResponse.json(result, { status: 201 })
      : NextResponse.json({ error: "worker_not_found" }, { status: 404 });
  } catch (error) {
    if (error instanceof Error && error.message === "worker_has_active_lease") {
      return NextResponse.json({ error: error.message }, { status: 409 });
    }
    throw error;
  }
}

export async function DELETE(request: Request, route: Context) {
  const unauthorized = rejectUnauthorizedWorker(request);
  if (unauthorized) return unauthorized;
  const parsed = RevokeRenderWorkerCredentialSchema.safeParse(await readJson(request));
  if (!parsed.success) {
    return NextResponse.json(
      { error: "invalid_worker_credential_revocation", details: parsed.error.flatten() },
      { status: 400 },
    );
  }
  const workerNodeId = await nodeId(route);
  if (!workerNodeId) return NextResponse.json({ error: "invalid_worker_node_id" }, { status: 400 });
  try {
    const result = await revokeRenderWorkerCredential(workerNodeId, parsed.data.reason);
    return result
      ? NextResponse.json(result)
      : NextResponse.json({ error: "active_worker_credential_not_found" }, { status: 404 });
  } catch (error) {
    if (error instanceof Error && error.message === "worker_has_active_lease") {
      return NextResponse.json({ error: error.message }, { status: 409 });
    }
    throw error;
  }
}
