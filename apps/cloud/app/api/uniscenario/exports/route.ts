import { NextResponse } from "next/server";
import { CreateExportSchema } from "@/app/lib/uniscenario/contracts";
import { createExport, listExports } from "@/app/lib/uniscenario/control-plane-store";
import {
  readJson,
  requireUniScenarioContext,
  requireUniScenarioMutableRevisionContext,
  requireUniScenarioMutationOrigin,
  UNISCENARIO_PRIVATE_CACHE_HEADERS,
} from "@/app/lib/uniscenario/http";

export async function GET(request: Request) {
  const auth = await requireUniScenarioContext();
  if (auth.response) return auth.response;
  const revisionId = new URL(request.url).searchParams.get("revisionId");
  return NextResponse.json(
    { exports: await listExports(auth.context, revisionId) },
    { headers: UNISCENARIO_PRIVATE_CACHE_HEADERS },
  );
}

export async function POST(request: Request) {
  const originError = requireUniScenarioMutationOrigin(request);
  if (originError) return originError;
  const auth = await requireUniScenarioContext();
  if (auth.response) return auth.response;
  const parsed = CreateExportSchema.safeParse(await readJson(request));
  if (!parsed.success) {
    return NextResponse.json({ error: "invalid_export", details: parsed.error.flatten() }, { status: 400 });
  }
  // Exporting is derived work over content the caller may already read, so `read` is the
  // required action -- it does not mutate the dataset (§6.5 action table).
  const access = await requireUniScenarioMutableRevisionContext(
    auth.context,
    parsed.data.revisionId,
    "read",
  );
  if (access.response) return access.response;
  const created = await createExport(auth.context, parsed.data);
  return created
    ? NextResponse.json(created, { status: 201 })
    : NextResponse.json({ error: "revision_not_found" }, { status: 404 });
}
