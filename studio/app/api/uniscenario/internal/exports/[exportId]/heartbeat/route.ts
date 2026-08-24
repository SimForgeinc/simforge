import { NextResponse } from "next/server";
import { HeartbeatCompilerExportSchema } from "@/app/lib/scenario/compiler-contracts";
import { heartbeatCompilerExport } from "@/app/lib/scenario/compiler-control-store";
import { readJson } from "@/app/lib/scenario/http";
import { rejectUnauthorizedWorker } from "@/app/lib/scenario/worker-http";

type Context = { params: Promise<{ exportId: string }> };
export async function POST(request: Request, context: Context) {
  const unauthorized = rejectUnauthorizedWorker(request);
  if (unauthorized) return unauthorized;
  const parsed = HeartbeatCompilerExportSchema.safeParse(await readJson(request));
  if (!parsed.success) return NextResponse.json({ error: "invalid_compiler_heartbeat" }, { status: 400 });
  const { exportId } = await context.params;
  const result = await heartbeatCompilerExport(exportId, parsed.data);
  return result ? NextResponse.json(result) : NextResponse.json({ error: "stale_compiler_fence" }, { status: 409 });
}
