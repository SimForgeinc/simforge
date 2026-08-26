import { parseTemplate, type ScenarioTemplateV2 } from "@simforge-oss/scenario";

/**
 * Download and import a document as JSON.
 *
 * v1's equivalent guessed a display name and a map out of eight candidate spellings each
 * (`mapAssetId`, `map_asset_id`, `setup.map.mapName`, …) because its `draft_json` had no schema. v2
 * has one: `parseTemplate` either returns a valid `ScenarioTemplateV2` or throws, so the import path
 * is a validation, not an excavation.
 *
 * OpenSCENARIO import is NOT here and is not coming — it is an explicit drop (§0.5 D1). This is
 * `ScenarioTemplateV2` in and out only.
 */

export type ScenarioDocumentTransferFile = {
  /** Marks the file as ours and pins the shape a future reader should expect. */
  simforgeScenarioExport: 1;
  title: string;
  /** Advisory: the exporting workspace's map version. Import re-picks a map the target can see. */
  mapVersionId: string | null;
  exportedAt: string;
  content: ScenarioTemplateV2;
};

export class ScenarioImportError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ScenarioImportError";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export function documentJsonFilename(title: string) {
  const base =
    title
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "") || "scenario";
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  return `${base}-${timestamp}.json`;
}

export function buildDocumentTransferFile(document: {
  title: string;
  mapVersionId: string | null;
  content: ScenarioTemplateV2;
}): ScenarioDocumentTransferFile {
  return {
    simforgeScenarioExport: 1,
    title: document.title,
    mapVersionId: document.mapVersionId,
    exportedAt: new Date().toISOString(),
    content: document.content,
  };
}

export function downloadDocumentJson(payload: unknown, filename: string) {
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  link.click();
  URL.revokeObjectURL(url);
}

/**
 * Read an import file into a create payload.
 *
 * Accepts both our wrapper and a bare `ScenarioTemplateV2` for validation. Only
 * the wrapper can name an exact `mapVersionId`; a bare template's canonical
 * source map may have multiple derivative versions and is never treated as a
 * version selector. The caller must verify the declared version is visible in
 * the target workspace.
 */
export function readDocumentTransferFile(input: unknown): {
  title: string;
  content: ScenarioTemplateV2;
  mapVersionId: string | null;
} {
  if (!isRecord(input)) {
    throw new ScenarioImportError("Scenario JSON must be a JSON object.");
  }
  const wrapped = isRecord(input.content) ? input.content : input;
  let content: ScenarioTemplateV2;
  try {
    content = parseTemplate(wrapped);
  } catch (parseError) {
    throw new ScenarioImportError(
      `That file is not a valid Scenario template: ${
        parseError instanceof Error ? parseError.message : String(parseError)
      }`,
    );
  }
  const declaredTitle = typeof input.title === "string" ? input.title.trim() : "";
  const title = declaredTitle || content.meta.name?.trim() || "Imported Scenario";
  const mapVersionId =
    typeof input.mapVersionId === "string" && input.mapVersionId.trim()
      ? input.mapVersionId.trim()
      : null;
  return { title: title.slice(0, 200), content, mapVersionId };
}
