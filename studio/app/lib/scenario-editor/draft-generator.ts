/**
 * Bridge from AI search → scenario editor.
 *
 * The map-search LLM agent calls this when the user asks to *create* (not
 * just find) a scenario at a chosen candidate location. It composes a human-
 * readable display name from the user's intent + the picked location, then
 * delegates to the same `createDatasetScenario` path the manual "Create
 * blank scenario" header button uses. Output is a draft a human opens in
 * the editor — refinement (actor placement, timeline, sensors) is left to
 * the existing scenario editor assistant.
 *
 * Intentionally light: new drafts are persisted empty. Once opened, the
 * editor seeds its starter subject from exact CARLA runtime geometry. Candidate
 * GeoJSON/search geometry stays a display and discovery input; semantic
 * topology is reserved for transfer and never becomes an editor hit target.
 */
import type { AppContext } from "@/app/lib/db/app-context";
import { ensureDefaultDatasetForWorkspace } from "@/app/lib/db/dataset-store";
import { createDatasetScenario } from "@/app/lib/db/scenario-query-store";
import { buildDashboardScenarioEditorHref } from "@/app/lib/uniscenario/routes";

export interface ScenarioDraftMapAsset {
  map_asset_id: string;
  name: string;
  carla_map_name: string | null;
}

export interface CreateScenarioDraftFromCandidateArgs {
  context: AppContext;
  mapAsset: ScenarioDraftMapAsset;
  /** MapSearchDocument.id the LLM picked. */
  documentId: string;
  /** Display label of the chosen object. */
  documentLabel: string;
  /** Backing CandidateLocation.id when present (null for road-network docs). */
  candidateId?: string | null;
  /** Brief natural-language scenario description from the user / LLM. */
  intent: string;
}

export interface ProposedScenarioDraft {
  scenarioId: string;
  datasetId: string;
  mapAssetId: string;
  documentId: string;
  candidateId: string | null;
  displayName: string;
  editorHref: string;
}

export class ScenarioDraftBridgeError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "ScenarioDraftBridgeError";
    this.code = code;
  }
}

const MAX_INTENT_DISPLAY_LENGTH = 80;

function trimIntent(intent: string): string {
  const collapsed = intent.replace(/\s+/g, " ").trim();
  if (collapsed.length <= MAX_INTENT_DISPLAY_LENGTH) return collapsed;
  return `${collapsed.slice(0, MAX_INTENT_DISPLAY_LENGTH - 1).trimEnd()}…`;
}

function composeDisplayName(intent: string, locationLabel: string): string {
  const trimmedIntent = trimIntent(intent);
  const trimmedLocation = locationLabel.trim();
  if (trimmedIntent.length === 0 && trimmedLocation.length === 0) {
    return "AI scenario";
  }
  if (trimmedIntent.length === 0) return `AI: ${trimmedLocation}`;
  if (trimmedLocation.length === 0) return `AI: ${trimmedIntent}`;
  return `AI: ${trimmedIntent} @ ${trimmedLocation}`;
}

/**
 * Create a scenario draft anchored to a chosen map asset and (optionally)
 * a candidate location. Returns the new scenario id, dataset id, and the
 * editor href the panel uses for its "Open in editor" link.
 *
 * Throws `ScenarioDraftBridgeError` with `code='map_unavailable'` when the
 * map has no `carla_map_name` (CARLA can't run a scenario on it). Other
 * failures bubble up unchanged so the route can return its existing
 * 500-class response.
 */
export async function createScenarioDraftFromCandidate(
  args: CreateScenarioDraftFromCandidateArgs,
): Promise<ProposedScenarioDraft> {
  const backendMapName = args.mapAsset.carla_map_name?.trim() ?? "";
  if (backendMapName.length === 0) {
    throw new ScenarioDraftBridgeError(
      "map_unavailable",
      "Map asset is not available in CARLA yet.",
    );
  }

  const dataset = await ensureDefaultDatasetForWorkspace(
    args.context.workspaceId,
    args.context.userId,
  );

  const displayName = composeDisplayName(args.intent, args.documentLabel);

  const scenario = await createDatasetScenario(args.context, dataset.id, {
    mapAssetId: args.mapAsset.map_asset_id,
    mapName: backendMapName,
    displayName,
  });

  const editorHref = buildDashboardScenarioEditorHref({
    scenarioId: scenario.id,
    datasetId: dataset.id,
  });

  return {
    scenarioId: scenario.id,
    datasetId: dataset.id,
    mapAssetId: args.mapAsset.map_asset_id,
    documentId: args.documentId,
    candidateId: args.candidateId ?? null,
    displayName,
    editorHref,
  };
}
