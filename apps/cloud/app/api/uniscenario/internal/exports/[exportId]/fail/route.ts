import { NextResponse } from "next/server";
import { FailCompilerExportSchema } from "@/app/lib/uniscenario/compiler-contracts";
import { failCompilerExport } from "@/app/lib/uniscenario/compiler-control-store";
import { readJson } from "@/app/lib/uniscenario/http";
import { rejectUnauthorizedWorker } from "@/app/lib/uniscenario/worker-http";

type Context = { params: Promise<{ exportId: string }> };
export async function POST(request: Request, context: Context) {
  const unauthorized = rejectUnauthorizedWorker(request);
  if (unauthorized) return unauthorized;
  const parsed = FailCompilerExportSchema.safeParse(await readJson(request));
  if (!parsed.success) return NextResponse.json({ error: "invalid_compiler_failure" }, { status: 400 });
  const { exportId } = await context.params;
  const result = await failCompilerExport(exportId, parsed.data);
  return result ? NextResponse.json(result) : NextResponse.json({ error: "stale_compiler_fence" }, { status: 409 });
}
