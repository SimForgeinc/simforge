import "server-only";

import type { getEditorScenarioRecord } from "@/app/lib/scenario-editor/scenario-api-store";
import { serializeEditorScenarioDraft } from "@/app/lib/scenario-editor/serialization";

type EditorScenarioRow = NonNullable<
  Awaited<ReturnType<typeof getEditorScenarioRecord>>
>;

export type ScenarioRuntimeMapCompatibilityDetails = {
  scenarioId: string;
  mapName: string | null;
  runtime: string | null;
  reason: string;
};

export class ScenarioStaleRuntimeMapError extends Error {
  readonly code = "scenario_stale_runtime_map";
  readonly details: ScenarioRuntimeMapCompatibilityDetails;

  constructor(details: ScenarioRuntimeMapCompatibilityDetails) {
    super(details.reason);
    this.name = "ScenarioStaleRuntimeMapError";
    this.details = details;
  }
}

export async function serializeCompatibleEditorScenarioDraft(
  row: EditorScenarioRow,
) {
  // Draft readability is intentionally independent of the central runtime
  // bundle or proof freshness. Strong semantic hash/provenance validation is
  // enforced on mutation and runtime submission; legacy actors remain
  // readable so the editor can classify or repair them explicitly.
  return serializeEditorScenarioDraft(row);
}
