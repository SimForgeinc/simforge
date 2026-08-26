import { AIMessage, HumanMessage, SystemMessage, createAgent } from "langchain";
import { tool } from "@langchain/core/tools";
import { z } from "zod";
import type { BridgedMapBundle } from "@/app/lib/editor-map/types";
import type { AppContext } from "@/app/lib/db/app-context";
import { getBridgedMapBundleByAssetId } from "@/app/lib/editor-map/bridged-map";
import {
  executeEditorTool,
} from "@/app/lib/editor-tools/registry";
import type {
  EditorAssistantToolTrace,
  EditorToolContext,
  EditorToolExecutionResult,
} from "@/app/lib/editor-tools/types";
import type { MapLocation } from "@/app/lib/editor-map/types";
import type { ScenarioEditorActorDraft } from "@simforge-oss/studio-shared";
import {
  PRESET_TRAILING_CAMERA,
  sensorsFromPreset,
} from "@/app/lib/scenario-editor/sensor-rigs";
import { finalizeGeneratedActorBehavior } from "@/app/lib/scenario-generation/generated-actor-behavior";
import {
  buildActorLabel,
  defaultActorAutopilot,
  defaultActorColor,
  defaultActorSpeedKph,
  defaultBlueprints,
} from "@/app/lib/scenario-editor/actor-utils";
import {
  anthropicConfigured,
  createChatModel,
  traceableFunction,
} from "./langchain-support";

export type AssistantMessageParam = {
  role: "user" | "assistant";
  content: string;
};

export type EditorAssistantContext = {
  appContext?: AppContext;
  mapAssetId: string;
  mapLabel: string;
  selectedRoadIds: string[];
  selectedLocation: MapLocation | null;
  actors?: EditorToolContext["actors"];
  actorDrafts?: EditorToolContext["actorDrafts"];
  scenarioId?: string | null;
  mapName?: string | null;
  durationSeconds?: number;
  fixedDeltaSeconds?: number;
  datasetId?: string | null;
  scenarios?: EditorToolContext["scenarios"];
};

const SYSTEM_PROMPT =
  "You are a helpful assistant for editing CARLA driving simulation scenarios. " +
  "Use the available tools when the user asks about locations, selected roads, or adding actors. " +
  "When a tool gives actionable results, explain them briefly and keep your answer concise. " +
  "Tool workflow: first use get_location_catalog to discover valid tag selectors when needed, then use get_location to find a specific location. " +
  "Use get_location selectors in tag:value form from get_location_catalog, for example tag:INTERSECTION or tag:INTERSECTION_SIGNALIZED. " +
  "If the user asks to find or select an intersection, use a tag selector such as tag:INTERSECTION instead of a bare selector like intersection. " +
  "If get_location returns road_ids and the user asked to select that location, call manage_selected_roads with action replace or add, source manual, and manualRoadIds set to those road_ids. " +
  "source current_location refers to the editor-selected location or the most recent get_location result in this assistant run; prefer manualRoadIds when get_location returned explicit road_ids. " +
  "Use manage_actors to inspect, add, or remove scene actors. " +
  "Before any manage_actors add action, you must call inspect_selected_roads for the current selected road set and use its anchors and crossing_pairs to choose roadId and fraction. " +
  "Use SimForge browser playback for deterministic interaction analysis and the OpenSCENARIO render job for managed rendering.";

const EDITOR_ASSISTANT_RECURSION_LIMIT = 500;

type AgentInvokeResult = {
  messages?: unknown[];
};

export type EditorAssistantInvokeOptions = {
  disableTools?: boolean;
  bundle?: BridgedMapBundle | null;
};

export type EditorAssistantStreamHandlers = {
  onTextDelta?: (text: string) => void | Promise<void>;
  onToolStart?: (trace: {
    name: string;
    input?: unknown;
  }) => void | Promise<void>;
  onToolEnd?: (trace: EditorAssistantToolTrace) => void | Promise<void>;
};

function contentToText(content: unknown): string {
  if (typeof content === "string") return content.trim();
  if (Array.isArray(content)) {
    return content
      .map((item) => {
        if (typeof item === "string") return item.trim();
        if (item && typeof item === "object" && "text" in item) {
          return String((item as { text?: unknown }).text ?? "").trim();
        }
        return "";
      })
      .filter(Boolean)
      .join("\n");
  }
  return "";
}

function contentToDeltaText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((item) => {
        if (typeof item === "string") return item;
        if (item && typeof item === "object" && "text" in item) {
          return String((item as { text?: unknown }).text ?? "");
        }
        return "";
      })
      .join("");
  }
  return "";
}

function extractAssistantText(result: AgentInvokeResult): string {
  const messages = Array.isArray(result.messages) ? result.messages : [];
  const lastAssistant = [...messages]
    .reverse()
    .find((message) => message instanceof AIMessage) as AIMessage | undefined;
  if (!lastAssistant) return "";
  return contentToText(lastAssistant.content);
}

function buildSystemPrompt(context: EditorAssistantContext) {
  return `${SYSTEM_PROMPT}

Editor context:
${JSON.stringify(
  {
    map_asset_id: context.mapAssetId,
    map_label: context.mapLabel,
    dataset_id: context.datasetId ?? null,
    scenario_id: context.scenarioId ?? null,
    scenarios: context.scenarios ?? [],
    selected_road_ids: context.selectedRoadIds,
    actors: context.actors ?? [],
    selected_location: context.selectedLocation
      ? {
          id: context.selectedLocation.id,
          label: context.selectedLocation.label,
          road_ids: context.selectedLocation.road_ids,
          kind: context.selectedLocation.kind,
        }
      : null,
  },
  null,
  2,
)}`;
}

function buildHistory(
  messages: AssistantMessageParam[],
  context: EditorAssistantContext,
) {
  return [
    new SystemMessage(buildSystemPrompt(context)),
    ...messages.map((message) =>
      message.role === "assistant"
        ? new AIMessage(message.content)
        : new HumanMessage(message.content),
    ),
  ];
}

export function formatEditorToolResultForModel(
  execution: EditorToolExecutionResult,
) {
  if (execution.tool === "get_location_catalog") {
    return JSON.stringify(execution.result);
  }

  return JSON.stringify({
    ok: execution.ok,
    tool: execution.tool,
    result: execution.result,
    uiActions: execution.uiActions,
    modelSummary: execution.modelSummary,
  });
}

function firstLocationFromToolResult(result: unknown): MapLocation | null {
  if (
    !result ||
    typeof result !== "object" ||
    !("items" in result) ||
    !Array.isArray((result as { items?: unknown }).items)
  ) {
    return null;
  }

  return ((result as { items: unknown[] }).items[0] ?? null) as MapLocation | null;
}

function selectedRoadIdsFromToolResult(result: unknown): string[] | null {
  if (
    !result ||
    typeof result !== "object" ||
    !("selected_road_ids" in result) ||
    !Array.isArray((result as { selected_road_ids?: unknown }).selected_road_ids)
  ) {
    return null;
  }

  return (result as { selected_road_ids: unknown[] }).selected_road_ids.filter(
    (roadId): roadId is string => typeof roadId === "string",
  );
}

function addedActorSummaryFromExecution(
  execution: EditorToolExecutionResult,
): NonNullable<EditorToolContext["actors"]>[number] | null {
  const action = execution.uiActions.find((item) => item.type === "add_actor");
  if (!action || action.type !== "add_actor") return null;
  return {
    id: `pending:${action.input.actorToolId}:${action.input.roadId}:${action.input.fraction}`,
    label: action.input.wantsSensors ? "Sensor Car" : "Car",
    kind: "vehicle",
    role: "traffic",
    roadId: action.input.roadId,
    fraction: action.input.fraction,
  };
}

function addedActorDraftFromExecution(
  context: EditorToolContext,
  execution: EditorToolExecutionResult,
) {
  const action = execution.uiActions.find((item) => item.type === "add_actor");
  if (!action || action.type !== "add_actor") return null;
  const kind = "vehicle" as const;
  // Never authored as "ego": the rig below is what makes a car the ego, and
  // `primaryActor` reads it back out.
  const role: ScenarioEditorActorDraft["role"] = "traffic";
  const actor: ScenarioEditorActorDraft = {
    id: `pending:${action.input.actorToolId}:${action.input.roadId}:${action.input.fraction}`,
    label: buildActorLabel(
      {
        kind,
        role,
        is_static: false,
        placement_mode: "road",
      },
      context.actorDrafts ?? [],
    ),
    kind,
    role,
    is_static: false,
    placement_mode: "road" as const,
    blueprint: defaultBlueprints.vehicles[0] ?? "vehicle.dodge.charger",
    spawn: {
      road_id: action.input.roadId,
      s_fraction: action.input.fraction,
      lane_id: null,
      section_id: null,
    },
    spawn_point: null,
    route: [],
    route_direction: "forward" as const,
    lane_facing: "with_lane" as const,
    destination: null,
    destination_point: null,
    speed_kph: defaultActorSpeedKph({ kind, is_static: false }),
    autopilot: defaultActorAutopilot({
      kind,
      placement_mode: "road",
      is_static: false,
    }),
    color: defaultActorColor({ kind }),
    notes: null,
    timeline: [],
    sensors: action.input.wantsSensors
      ? sensorsFromPreset(PRESET_TRAILING_CAMERA)
      : [],
  };
  return finalizeGeneratedActorBehavior(actor, [actor]);
}

export function applyEditorToolExecutionToContext(
  context: EditorToolContext,
  execution: EditorToolExecutionResult,
) {
  if (execution.tool === "get_location") {
    const location = firstLocationFromToolResult(execution.result);
    if (location) {
      context.selectedLocation = location;
    }
    return;
  }

  if (
    execution.tool === "manage_selected_roads" ||
    execution.tool === "inspect_selected_roads"
  ) {
    const selectedRoadIds = selectedRoadIdsFromToolResult(execution.result);
    if (selectedRoadIds) {
      context.selectedRoadIds = selectedRoadIds;
    }
    return;
  }

  if (execution.tool === "manage_actors") {
    const addedActor = addedActorSummaryFromExecution(execution);
    if (addedActor) {
      context.actors = [...(context.actors ?? []), addedActor];
      const addedDraft = addedActorDraftFromExecution(context, execution);
      if (addedDraft) {
        context.actorDrafts = [...(context.actorDrafts ?? []), addedDraft];
      }
      return;
    }
    const removeAction = execution.uiActions.find((item) => item.type === "remove_actor");
    if (removeAction && removeAction.type === "remove_actor") {
      context.actors = (context.actors ?? []).filter(
        (actor) => actor.id !== removeAction.actorId,
      );
      context.actorDrafts = (context.actorDrafts ?? []).filter(
        (actor) => actor.id !== removeAction.actorId,
      );
      return;
    }
    const updateAction = execution.uiActions.find(
      (item) => item.type === "update_actor_spawn_fraction",
    );
    if (updateAction && updateAction.type === "update_actor_spawn_fraction") {
      context.actors = (context.actors ?? []).map((actor) =>
        actor.id === updateAction.actorId
          ? { ...actor, fraction: updateAction.fraction }
          : actor,
      );
      context.actorDrafts = (context.actorDrafts ?? []).map((actor) =>
        actor.id === updateAction.actorId
          ? {
              ...actor,
              spawn: { ...actor.spawn, s_fraction: updateAction.fraction },
            }
          : actor,
      );
    }
  }
}

function buildAssistantTools(
  context: EditorToolContext,
  traces: EditorAssistantToolTrace[],
  handlers: EditorAssistantStreamHandlers = {},
) {
  const toolContext: EditorToolContext = {
    appContext: context.appContext,
    ...context,
    selectedRoadIds: [...context.selectedRoadIds],
    selectedLocation: context.selectedLocation,
    actors: context.actors,
    actorDrafts: context.actorDrafts,
    scenarioId: context.scenarioId,
    mapName: context.mapName,
    durationSeconds: context.durationSeconds,
    fixedDeltaSeconds: context.fixedDeltaSeconds,
    datasetId: context.datasetId,
    scenarios: context.scenarios,
  };
  let selectedRoadsInspected = false;

  return [
    tool(
      async () => {
        await handlers.onToolStart?.({ name: "get_location_catalog" });
        const execution = await executeEditorTool(
          "get_location_catalog",
          {},
          toolContext,
        );
        const trace = {
          name: execution.tool,
          result: execution.result,
          uiActions: execution.uiActions,
        };
        traces.push(trace);
        await handlers.onToolEnd?.(trace);
        return formatEditorToolResultForModel(execution);
      },
      {
        name: "get_location_catalog",
        description:
          "Return a JSON array of available tag selectors for the loaded map, for example [\"tag:INTERSECTION\", \"tag:INTERSECTION_SIGNALIZED\"]. Use one of these selector strings with get_location.",
        schema: z.object({}),
      },
    ),
    tool(
      async (input) => {
        await handlers.onToolStart?.({ name: "manage_scenarios", input });
        const execution = await executeEditorTool("manage_scenarios", input, toolContext);
        const trace = {
          name: execution.tool,
          input,
          result: execution.result,
          uiActions: execution.uiActions,
        };
        traces.push(trace);
        await handlers.onToolEnd?.(trace);
        return formatEditorToolResultForModel(execution);
      },
      {
        name: "manage_scenarios",
        description:
          "Inspect, switch, create, duplicate, rename, or delete dataset scenarios. Use inspect to list scenarios. Use switch to change the active UX scenario. Use create for a new blank scenario, duplicate to create a variation from the current or specified scenario, rename to update displayName, and delete to remove a scenario.",
        schema: z.object({
          action: z.enum(["inspect", "switch", "create", "duplicate", "rename", "delete"]),
          scenarioId: z.string().optional(),
          displayName: z.string().optional(),
          mapAssetId: z.string().nullable().optional(),
          mapName: z.string().nullable().optional(),
        }),
      },
    ),
    tool(
      async (input) => {
        await handlers.onToolStart?.({ name: "manage_actors", input });
        const shouldBlockAdd =
          input &&
          typeof input === "object" &&
          "action" in input &&
          (input as { action?: unknown }).action === "add" &&
          !selectedRoadsInspected;
        const execution = shouldBlockAdd
          ? {
              ok: false,
              tool: "manage_actors" as const,
              result: {
                ok: false,
                action: "add",
                message:
                  "Call inspect_selected_roads before adding actors so placement can use anchors and crossing geometry.",
              },
              uiActions: [],
              modelSummary:
                "Call inspect_selected_roads before adding actors so placement can use anchors and crossing geometry.",
            }
          : await executeEditorTool("manage_actors", input, toolContext);
        applyEditorToolExecutionToContext(toolContext, execution);
        const trace = {
          name: execution.tool,
          input,
          result: execution.result,
          uiActions: execution.uiActions,
        };
        traces.push(trace);
        await handlers.onToolEnd?.(trace);
        return formatEditorToolResultForModel(execution);
      },
      {
        name: "manage_actors",
        description:
          "Inspect, add, update, or remove scene actors. Use action inspect to list current actors. Use action add with actorToolId, roadId, and fraction after inspect_selected_roads. Use action update with actorId and fraction to move an actor backward or forward along its current road. Use action remove with actorId from inspect.",
        schema: z.object({
          action: z.enum(["inspect", "add", "remove", "update"]),
          actorToolId: z.enum(["car"]).optional(),
          wantsSensors: z.boolean().optional(),
          roadId: z.string().optional(),
          fraction: z.number().min(0).max(1).optional(),
          actorId: z.string().optional(),
        }),
      },
    ),
    tool(
      async (input) => {
        await handlers.onToolStart?.({ name: "get_location", input });
        const execution = await executeEditorTool("get_location", input, toolContext);
        applyEditorToolExecutionToContext(toolContext, execution);
        const trace = {
          name: execution.tool,
          input,
          result: execution.result,
          uiActions: execution.uiActions,
        };
        traces.push(trace);
        await handlers.onToolEnd?.(trace);
        return formatEditorToolResultForModel(execution);
      },
      {
        name: "get_location",
        description:
          "Find matching map locations by selectors or exact location id. Prefer tag:value selectors from get_location_catalog, for example tag:INTERSECTION or tag:INTERSECTION_SIGNALIZED. Do not pass a bare selector like intersection; use a tag selector from the catalog instead.",
        schema: z.object({
          location_id: z.string().optional(),
          selectors: z.array(z.string()).optional(),
          limit: z.number().int().positive().max(100).optional(),
        }),
      },
    ),
    tool(
      async (input) => {
        await handlers.onToolStart?.({ name: "manage_selected_roads", input });
        const execution = await executeEditorTool(
          "manage_selected_roads",
          input,
          toolContext,
        );
        applyEditorToolExecutionToContext(toolContext, execution);
        selectedRoadsInspected = false;
        const trace = {
          name: execution.tool,
          input,
          result: execution.result,
          uiActions: execution.uiActions,
        };
        traces.push(trace);
        await handlers.onToolEnd?.(trace);
        return formatEditorToolResultForModel(execution);
      },
      {
        name: "manage_selected_roads",
        description:
          "Add, remove, replace, clear, or inspect the current selected road set. Use source manual with manualRoadIds from get_location road_ids when selecting a newly found location. source current_location uses the editor's already-selected location or the most recent get_location result in this assistant run. To satisfy a request like 'find and select an intersection', call get_location first, then call manage_selected_roads with action replace, source manual, and manualRoadIds from the chosen location.",
        schema: z.object({
          action: z.enum(["add", "remove", "replace", "clear", "inspect"]),
          source: z.enum(["manual", "current_location"]),
          manualRoadIds: z.array(z.string()).optional(),
        }),
      },
    ),
    tool(
      async () => {
        await handlers.onToolStart?.({ name: "inspect_selected_roads" });
        const execution = await executeEditorTool(
          "inspect_selected_roads",
          {},
          toolContext,
        );
        applyEditorToolExecutionToContext(toolContext, execution);
        selectedRoadsInspected = true;
        const trace = {
          name: execution.tool,
          result: execution.result,
          uiActions: execution.uiActions,
        };
        traces.push(trace);
        await handlers.onToolEnd?.(trace);
        return formatEditorToolResultForModel(execution);
      },
      {
        name: "inspect_selected_roads",
        description:
          "Inspect the currently selected roads and derive placement anchors and network constraints.",
        schema: z.object({}),
      },
    ),
  ];
}

export const invokeEditorAssistant = traceableFunction(
  async (
    messages: AssistantMessageParam[],
    context: EditorAssistantContext,
    options: EditorAssistantInvokeOptions = {},
  ) => {
    const bundle =
      options.disableTools
        ? null
        : (options.bundle ??
            (await getBridgedMapBundleByAssetId(context.mapAssetId)));
    const traces: EditorAssistantToolTrace[] = [];
    const agent = createAgent({
      model: createChatModel(),
      tools: bundle
        ? buildAssistantTools(
            {
              mapAssetId: context.mapAssetId,
              bundle,
              selectedRoadIds: context.selectedRoadIds,
              selectedLocation: context.selectedLocation,
              actors: context.actors,
              actorDrafts: context.actorDrafts,
              scenarioId: context.scenarioId,
              mapName: context.mapName,
              durationSeconds: context.durationSeconds,
              fixedDeltaSeconds: context.fixedDeltaSeconds,
              datasetId: context.datasetId,
              scenarios: context.scenarios,
            },
            traces,
          )
        : [],
    });

    const result = (await agent.invoke({
      messages: buildHistory(messages, context),
    }, {
      recursionLimit: EDITOR_ASSISTANT_RECURSION_LIMIT,
    })) as AgentInvokeResult;

    return {
      text: extractAssistantText(result),
      raw: result,
      toolTraces: traces,
    };
  },
  {
    name: "web_editor_assistant",
    metadata: {
      source: "apps/web",
      feature: "dataset_assistant_stream",
    },
  },
);

export const streamEditorAssistant = traceableFunction(
  async (
    messages: AssistantMessageParam[],
    context: EditorAssistantContext,
    handlers: EditorAssistantStreamHandlers,
    options: EditorAssistantInvokeOptions = {},
  ) => {
    const bundle =
      options.disableTools
        ? null
        : (options.bundle ??
            (await getBridgedMapBundleByAssetId(context.mapAssetId)));
    const traces: EditorAssistantToolTrace[] = [];
    const agent = createAgent({
      model: createChatModel(),
      tools: bundle
        ? buildAssistantTools(
            {
              mapAssetId: context.mapAssetId,
              bundle,
              selectedRoadIds: context.selectedRoadIds,
              selectedLocation: context.selectedLocation,
              actors: context.actors,
              actorDrafts: context.actorDrafts,
              scenarioId: context.scenarioId,
              mapName: context.mapName,
              durationSeconds: context.durationSeconds,
              fixedDeltaSeconds: context.fixedDeltaSeconds,
              datasetId: context.datasetId,
              scenarios: context.scenarios,
            },
            traces,
            handlers,
          )
        : [],
    });

    const eventStream = agent.streamEvents(
      {
        messages: buildHistory(messages, context),
      },
      {
        version: "v2",
        recursionLimit: EDITOR_ASSISTANT_RECURSION_LIMIT,
      },
    );

    for await (const event of eventStream) {
      if (event.event !== "on_chat_model_stream") continue;
      const chunk = (event.data as { chunk?: { content?: unknown } } | undefined)?.chunk;
      const text = contentToDeltaText(chunk?.content);
      if (text) await handlers.onTextDelta?.(text);
    }

    return {
      toolTraces: traces,
    };
  },
  {
    name: "web_editor_assistant_stream",
    metadata: {
      source: "apps/web",
      feature: "dataset_assistant_stream",
    },
  },
);

export function editorAssistantAvailable() {
  return anthropicConfigured();
}
