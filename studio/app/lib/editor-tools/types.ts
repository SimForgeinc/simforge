import type {
  BridgedMapBundle,
  GetLocationInput,
  MapLocation,
} from "@/app/lib/editor-map/types";
import type { AppContext } from "@/app/lib/db/app-context";
import type {
  ManageSelectedRoadsInput,
  ManageSelectedRoadsResult,
} from "@/app/lib/editor-tools/selected-road-tool";
import type { ScenarioEditorActorDraft } from "@simforge-oss/studio-shared";

export const EDITOR_TOOL_IDS = [
  "get_location_catalog",
  "get_location",
  "manage_selected_roads",
  "inspect_selected_roads",
  "manage_actors",
  "manage_scenarios",
] as const;

export type EditorToolId = (typeof EDITOR_TOOL_IDS)[number];

export type AddActorToolInput = {
  /** One car entry, matching the palette. Ego-ness is not a kind of car. */
  actorToolId: "car";
  /**
   * Ask for a sensor rig. This is how the assistant expresses "the ego" now
   * that ego is derived from a configured rig rather than an authored role.
   */
  wantsSensors?: boolean;
  roadId: string;
  fraction: number;
};

export type ManageActorsToolInput =
  | {
      action: "inspect";
    }
  | ({
      action: "add";
    } & AddActorToolInput)
  | {
      action: "remove";
      actorId: string;
    }
  | {
      action: "update";
      actorId: string;
      fraction: number;
    };

export type ManageScenariosToolInput =
  | { action: "inspect" }
  | {
      action: "switch";
      scenarioId?: string;
    }
  | {
      action: "create";
      displayName?: string;
      mapAssetId?: string | null;
      mapName?: string | null;
    }
  | {
      action: "duplicate";
      scenarioId?: string;
      displayName?: string;
    }
  | {
      action: "rename";
      scenarioId?: string;
      displayName: string;
    }
  | {
      action: "delete";
      scenarioId?: string;
    };

export type EditorToolScenarioSummary = {
  id: string;
  display_name: string | null;
  map_asset_id: string | null;
  map_name: string | null;
  backend_map_name: string | null;
  actor_count: number | null;
  dataset_id: string | null;
  created_at: string;
};

export type EditorToolActorSummary = {
  id: string;
  label: string;
  kind: string;
  role: string;
  roadId?: string | null;
  fraction?: number | null;
};

export type EditorToolInput =
  | GetLocationInput
  | ManageSelectedRoadsInput
  | ManageActorsToolInput
  | ManageScenariosToolInput
  | AddActorToolInput
  | Record<string, unknown>;

export type EditorToolContext = {
  appContext?: AppContext;
  mapAssetId: string;
  bundle: BridgedMapBundle;
  selectedRoadIds: string[];
  selectedLocation: MapLocation | null;
  actors?: EditorToolActorSummary[];
  actorDrafts?: ScenarioEditorActorDraft[];
  scenarioId?: string | null;
  mapName?: string | null;
  durationSeconds?: number;
  fixedDeltaSeconds?: number;
  datasetId?: string | null;
  scenarios?: EditorToolScenarioSummary[];
};

export type EditorToolUiAction =
  | {
      type: "select_location";
      label: string;
      location: MapLocation;
      autoApply?: boolean;
    }
  | {
      type: "set_selected_roads";
      label: string;
      roadIds: string[];
      inspectResult?: ManageSelectedRoadsResult | null;
      autoApply?: boolean;
    }
  | {
      type: "inspect_selected_roads";
      label: string;
      result: ManageSelectedRoadsResult;
      autoApply?: boolean;
    }
  | {
      type: "add_actor";
      label: string;
      input: AddActorToolInput;
      autoApply?: boolean;
    }
  | {
      type: "remove_actor";
      label: string;
      actorId: string;
      autoApply?: boolean;
    }
  | {
      type: "update_actor_spawn_fraction";
      label: string;
      actorId: string;
      fraction: number;
      autoApply?: boolean;
    }
  | {
      type: "manage_scenario";
      label: string;
      input: ManageScenariosToolInput;
      autoApply?: boolean;
    };

export type EditorToolExecutionResult = {
  ok: boolean;
  tool: EditorToolId;
  result: unknown;
  uiActions: EditorToolUiAction[];
  modelSummary: string;
};

export type EditorAssistantToolTrace = {
  name: EditorToolId;
  input?: unknown;
  result?: unknown;
  uiActions?: EditorToolUiAction[];
};
