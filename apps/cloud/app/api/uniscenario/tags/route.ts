import { NextResponse } from "next/server";
import { CreateUniScenarioTagSchema } from "@/app/lib/uniscenario/contracts";
import { createUniScenarioTag, listUniScenarioTags } from "@/app/lib/uniscenario/tag-store";
import {
  readJson,
  requireUniScenarioContext,
  requireUniScenarioMutationOrigin,
  UNISCENARIO_PRIVATE_CACHE_HEADERS,
} from "@/app/lib/uniscenario/http";

/**
 * The workspace tag catalog.
 *
 * Deliberately uncached. `documentCount` moves whenever anybody tags anything, and the catalog is
 * the surface an operator edits and immediately re-reads — the same reason
 * `listUniScenarioDatasets` stays dynamic (§2.5.4).
 *
 * No per-dataset access gate: the catalog is workspace-scoped, and `listUniScenarioTags` filters on
 * `workspace_id = :workspace_id`.
 */
export async function GET() {
  const auth = await requireUniScenarioContext();
  if (auth.response) return auth.response;
  return NextResponse.json(
    { tags: await listUniScenarioTags(auth.context) },
    { headers: UNISCENARIO_PRIVATE_CACHE_HEADERS },
  );
}

export async function POST(request: Request) {
  const originError = requireUniScenarioMutationOrigin(request);
  if (originError) return originError;
  const auth = await requireUniScenarioContext();
  if (auth.response) return auth.response;
  const parsed = CreateUniScenarioTagSchema.safeParse(await readJson(request));
  if (!parsed.success) {
    return NextResponse.json(
      { error: "invalid_tag", details: parsed.error.flatten() },
      { status: 400 },
    );
  }
  const result = await createUniScenarioTag(auth.context, parsed.data);
  if (result.kind === "slug_conflict") {
    return NextResponse.json({ error: "tag_label_taken", field: "label" }, { status: 409 });
  }
  if (result.kind === "not_found") {
    return NextResponse.json({ error: "tag_not_found" }, { status: 404 });
  }
  return NextResponse.json(result.tag, { status: 201 });
}
