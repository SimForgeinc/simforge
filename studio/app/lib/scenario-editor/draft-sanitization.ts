import type { PersistedScenarioDraft } from "@/app/lib/scenario-editor/draft-normalization";

const TOP_LEVEL_VOLATILE_KEYS = [
  "savedPreviewTimeline",
  "editorHistory",
  "previewFrameHistory",
  "previewFrames",
  "recording",
  "recordings",
  "artifacts",
  "simulations",
  "created_at",
  "updated_at",
  "createdAt",
  "updatedAt",
  "selectedActorId",
  "selected_actor_id",
  "selectedTrafficCardId",
  "selected_traffic_card_id",
] as const;

const METADATA_VOLATILE_KEYS = [
  "activeScenarioSimulationId",
  "latestScenarioSimulationId",
  "createdAt",
  "updatedAt",
] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function cloneJsonRecord(input: Record<string, unknown>): Record<string, unknown> {
  return JSON.parse(JSON.stringify(input)) as Record<string, unknown>;
}

export function sanitizeScenarioSetupDraft(input: unknown): PersistedScenarioDraft {
  const source = isRecord(input) ? cloneJsonRecord(input) : {};

  for (const key of TOP_LEVEL_VOLATILE_KEYS) {
    delete source[key];
  }

  if (isRecord(source.metadata)) {
    for (const key of METADATA_VOLATILE_KEYS) {
      delete source.metadata[key];
    }
  }

  return source;
}
