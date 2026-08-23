import { NextResponse } from "next/server";
import { TemplateDocument } from "@uniscenarios/scenario-model";
import {
  DEFAULT_UNISCENARIO_AUTHORING_QUALITY_ID,
  UNISCENARIO_SCHEMA_VERSION,
} from "@/app/lib/uniscenario/contracts";
import {
  createUniScenarioDocument,
  listUniScenarioMapDescriptors,
} from "@/app/lib/uniscenario/document-store";
import { ensureDefaultUniScenarioDataset } from "@/app/lib/uniscenario/dataset-store";
import {
  requireUniScenarioContext,
  requireUniScenarioMutationOrigin,
  UNISCENARIO_PRIVATE_CACHE_HEADERS,
} from "@/app/lib/uniscenario/http";
import { withSceneMinutes } from "@/app/dashboard/uniscenario/editor/scene-time";

const EDITOR_APP_VERSION = "0.1.0-editor";

export async function POST(
  request: Request,
  { params }: { params: Promise<{ mapVersionId: string }> },
) {
  const originError = requireUniScenarioMutationOrigin(request);
  if (originError) return originError;

  const auth = await requireUniScenarioContext();
  if (auth.response) return auth.response;

  const { mapVersionId } = await params;
  const map = (await listUniScenarioMapDescriptors(auth.context)).find(
    (candidate) => candidate.mapVersionId === mapVersionId,
  );
  if (!map) {
    return NextResponse.json(
      { error: "map_not_found" },
      { status: 404, headers: UNISCENARIO_PRIVATE_CACHE_HEADERS },
    );
  }

  const dataset = await ensureDefaultUniScenarioDataset(auth.context);
  const template = TemplateDocument.create({
    name: `${map.label} scenario`,
    sourceMap: { mapId: map.sourceMapId, mapName: map.label },
    anchor: { features: [], pin: { mapId: map.sourceMapId } },
    appVersion: EDITOR_APP_VERSION,
  });
  // The same `setClip` the editor and the scenario list apply to a fresh template, so all three
  // creation paths agree byte for byte. The schema's warmup default is 5 seconds of settling before
  // recording; a 20-second scenario should be 20 seconds.
  template.setClip(undefined, 0);
  const localMinutesHeader = request.headers.get("x-simforge-local-minutes");
  const localMinutes = localMinutesHeader === null ? null : Number(localMinutesHeader);
  const content = localMinutes !== null && Number.isFinite(localMinutes)
    ? {
        ...template.data,
        environment: withSceneMinutes(template.data.environment, localMinutes),
      }
    : template.data;
  const document = await createUniScenarioDocument(auth.context, {
    title: template.data.meta.name,
    schemaVersion: UNISCENARIO_SCHEMA_VERSION,
    content,
    mapVersionId: map.mapVersionId,
    datasetId: dataset.id,
    authoringQualityId: DEFAULT_UNISCENARIO_AUTHORING_QUALITY_ID,
  });

  return NextResponse.json(
    { document },
    { status: 201, headers: UNISCENARIO_PRIVATE_CACHE_HEADERS },
  );
}
