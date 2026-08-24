import { NextResponse } from "next/server";
import { ClaimCompilerExportSchema } from "@/app/lib/scenario/compiler-contracts";
import { claimCompilerExport } from "@/app/lib/scenario/compiler-control-store";
import { readJson } from "@/app/lib/scenario/http";
import { rejectUnauthorizedWorker } from "@/app/lib/scenario/worker-http";

export async function POST(request: Request) {
  const unauthorized = rejectUnauthorizedWorker(request);
  if (unauthorized) return unauthorized;
  const parsed = ClaimCompilerExportSchema.safeParse(await readJson(request));
  if (!parsed.success) return NextResponse.json({ error: "invalid_compiler_claim", details: parsed.error.flatten() }, { status: 400 });
  const claim = await claimCompilerExport(parsed.data);
  return claim ? NextResponse.json(claim) : new NextResponse(null, { status: 204 });
}
