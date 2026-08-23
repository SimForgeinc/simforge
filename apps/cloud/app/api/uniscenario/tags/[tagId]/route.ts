import { NextResponse } from "next/server";
import { UpdateUniScenarioTagSchema } from "@/app/lib/uniscenario/contracts";
import { deleteUniScenarioTag, updateUniScenarioTag } from "@/app/lib/uniscenario/tag-store";
import {
  readJson,
  requireUniScenarioContext,
  requireUniScenarioMutationOrigin,
} from "@/app/lib/uniscenario/http";

type Context = { params: Promise<{ tagId: string }> };

export async function PATCH(request: Request, route: Context) {
  const originError = requireUniScenarioMutationOrigin(request);
  if (originError) return originError;
  const auth = await requireUniScenarioContext();
  if (auth.response) return auth.response;
  const parsed = UpdateUniScenarioTagSchema.safeParse(await readJson(request));
  if (!parsed.success) {
    return NextResponse.json(
      { error: "invalid_tag_update", details: parsed.error.flatten() },
      { status: 400 },
    );
  }
  const { tagId } = await route.params;
  const result = await updateUniScenarioTag(auth.context, tagId, parsed.data);
  if (result.kind === "not_found") {
    return NextResponse.json({ error: "tag_not_found" }, { status: 404 });
  }
  if (result.kind === "slug_conflict") {
    return NextResponse.json({ error: "tag_label_taken", field: "label" }, { status: 409 });
  }
  return NextResponse.json(result.tag);
}

export async function DELETE(request: Request, route: Context) {
  const originError = requireUniScenarioMutationOrigin(request);
  if (originError) return originError;
  const auth = await requireUniScenarioContext();
  if (auth.response) return auth.response;
  const { tagId } = await route.params;
  const result = await deleteUniScenarioTag(auth.context, tagId);
  return result.kind === "deleted"
    ? NextResponse.json({ ok: true })
    : NextResponse.json({ error: "tag_not_found" }, { status: 404 });
}
