import { NextResponse } from "next/server";
import { UpdateScenarioDatasetSchema } from "@/app/lib/scenario/contracts";
import {
  getScenarioDataset,
  softDeleteScenarioDataset,
  updateScenarioDataset,
} from "@/app/lib/scenario/dataset-store";
import {
  readJson,
  requireScenarioContext,
  requireScenarioMutableContext,
  requireScenarioMutationOrigin,
  scenarioJsonWithEtag,
} from "@/app/lib/scenario/http";

type Context = { params: Promise<{ datasetId: string }> };

export async function GET(request: Request, route: Context) {
  const auth = await requireScenarioContext();
  if (auth.response) return auth.response;
  const { datasetId } = await route.params;
  const access = await requireScenarioMutableContext(auth.context, datasetId, "read");
  if (access.response) return access.response;
  const dataset = await getScenarioDataset(auth.context, datasetId);
  return dataset
    ? await scenarioJsonWithEtag(request, dataset)
    : NextResponse.json({ error: "dataset_not_found" }, { status: 404 });
}

export async function PATCH(request: Request, route: Context) {
  const originError = requireScenarioMutationOrigin(request);
  if (originError) return originError;
  const auth = await requireScenarioContext();
  if (auth.response) return auth.response;
  const { datasetId } = await route.params;
  const access = await requireScenarioMutableContext(auth.context, datasetId, "updateMetadata");
  if (access.response) return access.response;
  const parsed = UpdateScenarioDatasetSchema.safeParse(await readJson(request));
  if (!parsed.success) {
    return NextResponse.json(
      { error: "invalid_dataset_update", details: parsed.error.flatten() },
      { status: 400 },
    );
  }
  const result = await updateScenarioDataset(auth.context, datasetId, parsed.data);
  if (result.kind === "not_found") {
    return NextResponse.json({ error: "dataset_not_found" }, { status: 404 });
  }
  if (result.kind === "name_conflict") {
    // v1's "Name (copy)" duplicate flow never had to handle this, because it had no unique index.
    return NextResponse.json(
      { error: "dataset_name_taken", field: "name" },
      { status: 409 },
    );
  }
  return NextResponse.json(result.dataset);
}

export const PUT = PATCH;

export async function DELETE(request: Request, route: Context) {
  const originError = requireScenarioMutationOrigin(request);
  if (originError) return originError;
  const auth = await requireScenarioContext();
  if (auth.response) return auth.response;
  const { datasetId } = await route.params;
  const access = await requireScenarioMutableContext(auth.context, datasetId, "delete");
  if (access.response) return access.response;
  const result = await softDeleteScenarioDataset(auth.context, datasetId);
  return result.kind === "deleted"
    ? NextResponse.json({ ok: true, deletedDocumentCount: result.deletedDocumentCount })
    : NextResponse.json({ error: "dataset_not_found" }, { status: 404 });
}
