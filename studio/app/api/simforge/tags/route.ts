import { NextResponse } from "next/server";
import { CreateScenarioTagSchema } from "@/app/lib/scenario/contracts";
import { createScenarioTag, listScenarioTags } from "@/app/lib/scenario/tag-store";
import {
  readJson,
  requireScenarioContext,
  requireScenarioMutationOrigin,
  SCENARIO_PRIVATE_CACHE_HEADERS,
} from "@/app/lib/scenario/http";

/**
 * The workspace tag catalog.
 *
 * Deliberately uncached. `documentCount` moves whenever anybody tags anything, and the catalog is
 * the surface an operator edits and immediately re-reads — the same reason
 * `listScenarioDatasets` stays dynamic (§2.5.4).
 *
 * No per-dataset access gate: the catalog is workspace-scoped, and `listScenarioTags` filters on
 * `workspace_id = :workspace_id`.
 */
export async function GET() {
  const auth = await requireScenarioContext();
  if (auth.response) return auth.response;
  return NextResponse.json(
    { tags: await listScenarioTags(auth.context) },
    { headers: SCENARIO_PRIVATE_CACHE_HEADERS },
  );
}

export async function POST(request: Request) {
  const originError = requireScenarioMutationOrigin(request);
  if (originError) return originError;
  const auth = await requireScenarioContext();
  if (auth.response) return auth.response;
  const parsed = CreateScenarioTagSchema.safeParse(await readJson(request));
  if (!parsed.success) {
    return NextResponse.json(
      { error: "invalid_tag", details: parsed.error.flatten() },
      { status: 400 },
    );
  }
  const result = await createScenarioTag(auth.context, parsed.data);
  if (result.kind === "slug_conflict") {
    return NextResponse.json({ error: "tag_label_taken", field: "label" }, { status: 409 });
  }
  if (result.kind === "not_found") {
    return NextResponse.json({ error: "tag_not_found" }, { status: 404 });
  }
  return NextResponse.json(result.tag, { status: 201 });
}
