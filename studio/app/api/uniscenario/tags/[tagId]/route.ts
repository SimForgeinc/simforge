import { NextResponse } from "next/server";
import { UpdateScenarioTagSchema } from "@/app/lib/scenario/contracts";
import { deleteScenarioTag, updateScenarioTag } from "@/app/lib/scenario/tag-store";
import {
  readJson,
  requireScenarioContext,
  requireScenarioMutationOrigin,
} from "@/app/lib/scenario/http";

type Context = { params: Promise<{ tagId: string }> };

export async function PATCH(request: Request, route: Context) {
  const originError = requireScenarioMutationOrigin(request);
  if (originError) return originError;
  const auth = await requireScenarioContext();
  if (auth.response) return auth.response;
  const parsed = UpdateScenarioTagSchema.safeParse(await readJson(request));
  if (!parsed.success) {
    return NextResponse.json(
      { error: "invalid_tag_update", details: parsed.error.flatten() },
      { status: 400 },
    );
  }
  const { tagId } = await route.params;
  const result = await updateScenarioTag(auth.context, tagId, parsed.data);
  if (result.kind === "not_found") {
    return NextResponse.json({ error: "tag_not_found" }, { status: 404 });
  }
  if (result.kind === "slug_conflict") {
    return NextResponse.json({ error: "tag_label_taken", field: "label" }, { status: 409 });
  }
  return NextResponse.json(result.tag);
}

export async function DELETE(request: Request, route: Context) {
  const originError = requireScenarioMutationOrigin(request);
  if (originError) return originError;
  const auth = await requireScenarioContext();
  if (auth.response) return auth.response;
  const { tagId } = await route.params;
  const result = await deleteScenarioTag(auth.context, tagId);
  return result.kind === "deleted"
    ? NextResponse.json({ ok: true })
    : NextResponse.json({ error: "tag_not_found" }, { status: 404 });
}
