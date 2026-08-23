import { NextResponse } from "next/server";
import { CreateUniScenarioDatasetItemSchema } from "@/app/lib/uniscenario/contracts";
import { addUniScenarioDatasetItem } from "@/app/lib/uniscenario/dataset-store";
import {
  readJson,
  requireUniScenarioContext,
  requireUniScenarioMutableContext,
  requireUniScenarioMutationOrigin,
} from "@/app/lib/uniscenario/http";

type Context = { params: Promise<{ datasetId: string }> };

export async function POST(request: Request, route: Context) {
  const originError = requireUniScenarioMutationOrigin(request);
  if (originError) return originError;
  const auth = await requireUniScenarioContext();
  if (auth.response) return auth.response;
  const parsed = CreateUniScenarioDatasetItemSchema.safeParse(await readJson(request));
  if (!parsed.success) return NextResponse.json({ error: "invalid_dataset_item", details: parsed.error.flatten() }, { status: 400 });
  const { datasetId } = await route.params;
  const access = await requireUniScenarioMutableContext(auth.context, datasetId, "mutateContent");
  if (access.response) return access.response;
  const created = await addUniScenarioDatasetItem(auth.context, datasetId, parsed.data);
  return created ? NextResponse.json(created, { status: 201 }) : NextResponse.json({ error: "dataset_revision_or_job_not_found" }, { status: 404 });
}
