import type { getEditorScenarioRecord } from "@/app/lib/scenario-editor/scenario-api-store";
import {
  parseScenarioDraftJson,
  resolveScenarioMapReference,
} from "@/app/lib/scenario-editor/scenario-api-store";
import {
  normalizeScenarioDraft,
  toPersistedScenarioDraft,
  toPersistedScenarioSetupDraft,
} from "@/app/lib/scenario-editor/draft-normalization";

type EditorScenarioRow = NonNullable<
  Awaited<ReturnType<typeof getEditorScenarioRecord>>
>;

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function trimToNull(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function explicitDraftBackendMapName(rawDraft: unknown): string | null {
  const draft = asRecord(rawDraft);
  const metadata = asRecord(draft.metadata);
  const setup = asRecord(draft.setup);
  const setupMap = asRecord(setup.map);
  return (
    trimToNull(setupMap.backendMapName) ??
    trimToNull(draft.backendMapName) ??
    trimToNull(draft.backend_map_name) ??
    trimToNull(metadata.backendMapName)
  );
}

export async function serializeEditorScenarioDraft(row: EditorScenarioRow) {
  const mapReference = await resolveScenarioMapReference({
    mapAssetId: row.map_asset_id,
    mapName: row.map_name,
    runtime: row.runtime,
  });
  const rawDraft = parseScenarioDraftJson(row.draft_json);
  const backendMapName =
    explicitDraftBackendMapName(rawDraft) ?? mapReference.backendMapName;
  const normalized = normalizeScenarioDraft(rawDraft, {
    fallbackMapName: mapReference.mapName,
    scenarioId: row.id,
    mapAssetId: mapReference.mapAssetId,
    backendMapName,
    latestScenarioSimulationId: row.latest_simulation_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  });
  const serializationOptions = {
    scenarioId: row.id,
    fallbackMapName: mapReference.mapName,
    mapAssetId: mapReference.mapAssetId,
    backendMapName,
    latestScenarioSimulationId: row.latest_simulation_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };

  return {
    rawDraft,
    normalized,
    compatibilityDraft: toPersistedScenarioDraft(
      normalized,
      null,
      serializationOptions,
    ),
    persistedDraft: toPersistedScenarioSetupDraft(normalized, rawDraft, {
      ...serializationOptions,
    }),
    mapReference,
  };
}

export async function serializeEditorScenarioDetail(row: EditorScenarioRow) {
  const serializedDraft = await serializeEditorScenarioDraft(row);

  return {
    id: row.id,
    display_name: row.display_name,
    displayName: row.display_name,
    dataset_id: row.dataset_id,
    datasetId: row.dataset_id,
    status: row.status,
    runtime: row.runtime,
    map_asset_id: serializedDraft.mapReference.mapAssetId,
    mapAssetId: serializedDraft.mapReference.mapAssetId,
    backend_map_name:
      serializedDraft.normalized.metadata.backendMapName ??
      serializedDraft.mapReference.backendMapName ??
      null,
    backendMapName:
      serializedDraft.normalized.metadata.backendMapName ??
      serializedDraft.mapReference.backendMapName ??
      null,
    map_name:
      serializedDraft.mapReference.mapName ??
      serializedDraft.normalized.mapName ??
      null,
    mapName:
      serializedDraft.mapReference.mapName ??
      serializedDraft.normalized.mapName ??
      null,
    created_at: row.created_at,
    createdAt: row.created_at,
    updated_at: row.updated_at,
    updatedAt: row.updated_at,
    draft: serializedDraft.persistedDraft,
  };
}
