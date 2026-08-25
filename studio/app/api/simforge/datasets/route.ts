import { connection, NextResponse } from "next/server";
import { CreateScenarioDatasetSchema } from "@/app/lib/scenario/contracts";
import { createScenarioDataset, listScenarioDatasets } from "@/app/lib/scenario/dataset-store";
import {
  readJson,
  requireScenarioContext,
  requireScenarioMutationOrigin,
  scenarioJsonWithEtag,
} from "@/app/lib/scenario/http";

/**
 * The dataset list.
 *
 * Revalidated rather than `no-store`: `ScenarioDatasetDto` is names, counts
 * and timestamps — it carries no URL field at all, so the §2.5 presigned-URL
 * rule does not apply. This is the first request the editor makes and the
 * largest JSON body on the boot path, and an unchanged list now costs a 304
 * instead of the whole thing.
 */
export async function GET(request: Request) {
  await connection();
  const auth = await requireScenarioContext();
  if (auth.response) return auth.response;
  return await scenarioJsonWithEtag(request, {
    datasets: await listScenarioDatasets(auth.context),
  });
}

export async function POST(request: Request) {
  const originError = requireScenarioMutationOrigin(request);
  if (originError) return originError;
  const auth = await requireScenarioContext();
  if (auth.response) return auth.response;
  const parsed = CreateScenarioDatasetSchema.safeParse(await readJson(request));
  if (!parsed.success) return NextResponse.json({ error: "invalid_dataset", details: parsed.error.flatten() }, { status: 400 });
  const result = await createScenarioDataset(auth.context, parsed.data);
  if (result.kind === "name_conflict") {
    return NextResponse.json({ error: "dataset_name_taken", field: "name" }, { status: 409 });
  }
  if (result.kind === "not_found") {
    return NextResponse.json({ error: "dataset_not_found" }, { status: 404 });
  }
  return NextResponse.json(result.dataset, { status: 201 });
}
