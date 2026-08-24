import { NextResponse } from "next/server";
import {
  MAX_XOSC_BYTES,
  OpenScenarioImportError,
  analyzeOpenScenarioImport,
  resolveOpenScenarioMap,
  translateOpenScenarioImport,
} from "@simforge/openscenario/import";
import { UNISCENARIO_SCHEMA_VERSION } from "@/app/lib/uniscenario/contracts";
import {
  createUniScenarioDocument,
  listUniScenarioMapDescriptors,
} from "@/app/lib/uniscenario/document-store";
import { storeOpenScenarioSourceArtifact } from "@/app/lib/uniscenario/open-scenario-import-store.server";
import {
  requireUniScenarioContext,
  requireUniScenarioMutableContext,
  requireUniScenarioMutationOrigin,
} from "@/app/lib/uniscenario/http";

const MAX_MULTIPART_BYTES = MAX_XOSC_BYTES + 64 * 1024;

class OpenScenarioMultipartTooLargeError extends Error {}

async function readBoundedMultipartBody(request: Request): Promise<ArrayBuffer> {
  const reader = request.body?.getReader();
  if (!reader) return new ArrayBuffer(0);
  const chunks: Uint8Array[] = [];
  let byteLength = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      byteLength += value.byteLength;
      if (byteLength > MAX_MULTIPART_BYTES) {
        await reader.cancel("OpenSCENARIO multipart body exceeds the bounded intake limit");
        throw new OpenScenarioMultipartTooLargeError();
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const body = new ArrayBuffer(byteLength);
  const bodyBytes = new Uint8Array(body);
  let offset = 0;
  for (const chunk of chunks) {
    bodyBytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return body;
}

function analysisWithResolutionDiagnostic<T extends ReturnType<typeof analyzeOpenScenarioImport>>(
  analysis: T,
  resolution: ReturnType<typeof resolveOpenScenarioMap>,
): T {
  if (!resolution.diagnostic) return analysis;
  return {
    ...analysis,
    diagnostics: [...analysis.diagnostics, resolution.diagnostic],
    capabilities: {
      ...analysis.capabilities,
      [resolution.diagnostic.disposition]: analysis.capabilities[resolution.diagnostic.disposition] + 1,
    },
  };
}

export async function POST(request: Request) {
  const originError = requireUniScenarioMutationOrigin(request);
  if (originError) return originError;
  const auth = await requireUniScenarioContext();
  if (auth.response) return auth.response;

  const contentLength = Number(request.headers.get("content-length") ?? "0");
  if (Number.isFinite(contentLength) && contentLength > MAX_MULTIPART_BYTES) {
    return NextResponse.json({ error: "xosc_file_too_large", maxBytes: MAX_XOSC_BYTES }, { status: 413 });
  }

  try {
    const multipartBody = await readBoundedMultipartBody(request);
    const contentType = request.headers.get("content-type") ?? "";
    const form = await new Response(multipartBody, { headers: { "content-type": contentType } }).formData();
    const file = form.get("file");
    const datasetId = String(form.get("datasetId") ?? "").trim();
    const requestedMode = form.get("mode") === "create" ? "create" : "analyze";
    const explicitMapVersionId = String(form.get("mapVersionId") ?? "").trim() || null;
    if (!(file instanceof File) || !file.name.toLowerCase().endsWith(".xosc")) {
      return NextResponse.json({ error: "invalid_xosc_file" }, { status: 400 });
    }
    if (file.size > MAX_XOSC_BYTES) {
      return NextResponse.json({ error: "xosc_file_too_large", maxBytes: MAX_XOSC_BYTES }, { status: 413 });
    }
    const bytes = new Uint8Array(await file.arrayBuffer());
    const analysis = analyzeOpenScenarioImport(bytes, file.name);
    const maps = (await listUniScenarioMapDescriptors(auth.context)).map((map) => ({
      mapVersionId: map.mapVersionId,
      sourceMapId: map.sourceMapId,
      label: map.label,
      xodrSha256: map.xodr.sha256,
    }));
    const resolution = resolveOpenScenarioMap(analysis, maps, explicitMapVersionId);
    const reportedAnalysis = analysisWithResolutionDiagnostic(analysis, resolution);

    if (requestedMode !== "create") {
      return NextResponse.json({ analysis: reportedAnalysis, resolution });
    }
    if (!datasetId) return NextResponse.json({ error: "dataset_required" }, { status: 400 });
    const access = await requireUniScenarioMutableContext(auth.context, datasetId, "mutateContent");
    if (access.response) return access.response;
    if (resolution.status !== "resolved" || !resolution.selectedMapVersionId) {
      return NextResponse.json({
        error: resolution.diagnostic?.code ?? "map_resolution_required",
        message: resolution.diagnostic?.message ?? "Map resolution is required before import.",
        analysis: reportedAnalysis,
        resolution,
      }, { status: 409 });
    }
    const selectedMap = maps.find((map) => map.mapVersionId === resolution.selectedMapVersionId);
    if (!selectedMap) return NextResponse.json({ error: "map_not_found" }, { status: 404 });
    const sourceArtifact = await storeOpenScenarioSourceArtifact(auth.context, {
      bytes,
      sha256: analysis.source.sha256,
      byteLength: analysis.source.byteLength,
      mediaType: analysis.source.mediaType,
    });
    const content = translateOpenScenarioImport(analysis, sourceArtifact, selectedMap);
    const document = await createUniScenarioDocument(auth.context, {
      title: analysis.title,
      description: analysis.description,
      schemaVersion: UNISCENARIO_SCHEMA_VERSION,
      content,
      mapVersionId: selectedMap.mapVersionId,
      datasetId,
      authoringQualityId: "minimal",
    });
    return NextResponse.json({ document, analysis, resolution }, { status: 201 });
  } catch (error) {
    if (error instanceof OpenScenarioMultipartTooLargeError) {
      return NextResponse.json({ error: "xosc_file_too_large", maxBytes: MAX_XOSC_BYTES }, { status: 413 });
    }
    if (error instanceof OpenScenarioImportError) {
      return NextResponse.json({ error: error.code, message: error.message }, { status: 400 });
    }
    throw error;
  }
}
