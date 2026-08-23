import { z } from "zod";
import {
  getLocation,
  getLocationCatalog,
} from "@/app/lib/editor-tools/location-search";
import { runManageSelectedRoads } from "@/app/lib/editor-tools/selected-road-tool";
import type {
  AddActorToolInput,
  EditorToolContext,
  EditorToolExecutionResult,
  EditorToolId,
  EditorToolInput,
  EditorToolUiAction,
  ManageActorsToolInput,
  ManageScenariosToolInput,
} from "./types";

const getLocationInputSchema = z.object({
  location_id: z.string().optional(),
  selectors: z.array(z.string()).optional(),
  limit: z.number().int().positive().max(100).optional(),
});

const manageSelectedRoadsInputSchema = z.object({
  action: z.enum(["add", "remove", "replace", "clear", "inspect"]),
  source: z.enum(["manual", "current_location"]),
  manualRoadIds: z.array(z.string()).optional(),
  currentLocation: z.any().nullable().optional(),
});

const manageActorsInputSchema = z.object({
  action: z.enum(["inspect", "add", "remove", "update"]),
  actorToolId: z.enum(["car"]).optional(),
  wantsSensors: z.boolean().optional(),
  roadId: z.string().optional(),
  fraction: z.number().min(0).max(1).optional(),
  actorId: z.string().optional(),
}).superRefine((input, ctx) => {
  if (input.action === "add") {
    if (!input.actorToolId) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["actorToolId"],
        message: "actorToolId is required when action is add.",
      });
    }
    if (!input.roadId?.trim()) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["roadId"],
        message: "roadId is required when action is add.",
      });
    }
    if (input.fraction == null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["fraction"],
        message: "fraction is required when action is add.",
      });
    }
  }
  if (input.action === "remove" && !input.actorId?.trim()) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["actorId"],
      message: "actorId is required when action is remove.",
    });
  }
  if (input.action === "update") {
    if (!input.actorId?.trim()) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["actorId"],
        message: "actorId is required when action is update.",
      });
    }
    if (input.fraction == null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["fraction"],
        message: "fraction is required when action is update.",
      });
    }
  }
});

const manageScenariosInputSchema = z.object({
  action: z.enum(["inspect", "switch", "create", "duplicate", "rename", "delete"]),
  scenarioId: z.string().optional(),
  displayName: z.string().optional(),
  mapAssetId: z.string().nullable().optional(),
  mapName: z.string().nullable().optional(),
}).superRefine((input, ctx) => {
  if (input.action === "rename" && !input.displayName?.trim()) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["displayName"],
      message: "displayName is required for this action.",
    });
  }
});

function summarizeLocationResult(result: {
  items: Array<{ label: string; kind: string; road_ids: string[] }>;
  total_matches: number;
}) {
  if (result.total_matches === 0) {
    return "No matching locations found.";
  }

  const top = result.items
    .slice(0, 3)
    .map((item) => `${item.label} (${item.kind})`)
    .join(", ");
  return `Found ${result.total_matches} matching location${result.total_matches === 1 ? "" : "s"}: ${top}.`;
}

function summarizeLocationCatalog(selectors: string[]) {
  if (selectors.length === 0) {
    return "No tag selectors are available for this map.";
  }

  return `Available tag selectors (${selectors.length}):\n${selectors.map((selector) => `- ${selector}`).join("\n")}`;
}

function summarizeRoadSelectionResult(result: {
  action: string;
  total_selected: number;
  network_summary: {
    connected_components: number;
    junctions: Array<unknown>;
    warnings: string[];
  };
}) {
  const warningText =
    result.network_summary.warnings.length > 0
      ? ` Warnings: ${result.network_summary.warnings.join(" ")}`
      : "";
  return `${result.action} completed. ${result.total_selected} selected road(s), ${result.network_summary.connected_components} connected component(s), ${result.network_summary.junctions.length} junction group(s).${warningText}`;
}

function validateSelectedRoad(
  context: EditorToolContext,
  input: AddActorToolInput,
) {
  if (!context.selectedRoadIds.includes(input.roadId)) {
    return {
      ok: false,
      message: `Road ${input.roadId} is not in the current selected road set.`,
    };
  }

  const roadExists = (context.bundle.generated?.roads ?? []).some(
    (road) => String(road.id) === input.roadId,
  );
  if (!roadExists) {
    return {
      ok: false,
      message: `Road ${input.roadId} is not available in the loaded map bundle.`,
    };
  }

  return { ok: true as const };
}

function buildAddActorResult(
  toolId: EditorToolId,
  input: AddActorToolInput,
  context: EditorToolContext,
): EditorToolExecutionResult {
  const actorInput: AddActorToolInput = {
    actorToolId: input.actorToolId,
    roadId: input.roadId,
    fraction: input.fraction,
  };
  const validation = validateSelectedRoad(context, actorInput);
  if (!validation.ok) {
    return {
      ok: false,
      tool: toolId,
      result: { ok: false, message: validation.message },
      uiActions: [],
      modelSummary: validation.message,
    };
  }

  const actorLabel = actorInput.wantsSensors ? "sensor car" : "car";
  return {
    ok: true,
    tool: toolId,
    result: {
      ok: true,
      action: "add",
      message: `Prepared ${actorLabel} placement on road ${actorInput.roadId} at fraction ${actorInput.fraction.toFixed(2)}.`,
    },
    uiActions: [
      {
        type: "add_actor",
        label: `Add ${actorLabel}`,
        input: actorInput,
        autoApply: true,
      },
    ],
    modelSummary: `Prepared ${actorLabel} placement on road ${actorInput.roadId} at fraction ${actorInput.fraction.toFixed(2)}.`,
  };
}

function buildManageActorsResult(
  input: ManageActorsToolInput,
  context: EditorToolContext,
): EditorToolExecutionResult {
  if (input.action === "inspect") {
    const actors = context.actors ?? [];
    return {
      ok: true,
      tool: "manage_actors",
      result: {
        action: "inspect",
        total_actors: actors.length,
        actors,
      },
      uiActions: [],
      modelSummary:
        actors.length === 0
          ? "No actors are currently in the scene."
          : `Scene has ${actors.length} actor(s): ${actors.map((actor) => `${actor.label} (${actor.id})`).join(", ")}.`,
    };
  }

  if (input.action === "add") {
    return buildAddActorResult("manage_actors", input, context);
  }

  const actor = (context.actors ?? []).find((item) => item.id === input.actorId);
  if (!actor) {
    return {
      ok: false,
      tool: "manage_actors",
      result: {
        ok: false,
        action: "remove",
        message: `Actor ${input.actorId} is not in the current scene.`,
      },
      uiActions: [],
      modelSummary: `Actor ${input.actorId} is not in the current scene.`,
    };
  }

  if (input.action === "update") {
    return {
      ok: true,
      tool: "manage_actors",
      result: {
        ok: true,
        action: "update",
        actor_id: actor.id,
        fraction: input.fraction,
        message: `Prepared ${actor.label} move to fraction ${input.fraction.toFixed(2)}.`,
      },
      uiActions: [
        {
          type: "update_actor_spawn_fraction",
          label: `Move ${actor.label}`,
          actorId: actor.id,
          fraction: input.fraction,
          autoApply: true,
        },
      ],
      modelSummary: `Prepared ${actor.label} move to fraction ${input.fraction.toFixed(2)}.`,
    };
  }

  return {
    ok: true,
    tool: "manage_actors",
    result: {
      ok: true,
      action: "remove",
      actor_id: actor.id,
      message: `Prepared removal for ${actor.label}.`,
    },
    uiActions: [
      {
        type: "remove_actor",
        label: `Remove ${actor.label}`,
        actorId: actor.id,
        autoApply: true,
      },
    ],
    modelSummary: `Prepared removal for ${actor.label}.`,
  };
}

function buildManageScenariosResult(
  input: ManageScenariosToolInput,
  context: EditorToolContext,
): EditorToolExecutionResult {
  if (input.action === "inspect") {
    const scenarios = context.scenarios ?? [];
    return {
      ok: true,
      tool: "manage_scenarios",
      result: {
        action: "inspect",
        dataset_id: context.datasetId ?? null,
        current_scenario_id: context.scenarioId ?? null,
        total_scenarios: scenarios.length,
        scenarios,
      },
      uiActions: [],
      modelSummary:
        scenarios.length === 0
          ? "No dataset scenarios are available in context."
          : `Dataset has ${scenarios.length} scenario(s). Current scenario: ${context.scenarioId ?? "none"}.`,
    };
  }

  const scenarioId =
    "scenarioId" in input ? (input.scenarioId ?? context.scenarioId ?? undefined) : undefined;
  if (
    (input.action === "switch" ||
      input.action === "duplicate" ||
      input.action === "rename" ||
      input.action === "delete") &&
    !scenarioId
  ) {
    return {
      ok: false,
      tool: "manage_scenarios",
      result: {
        ok: false,
        action: input.action,
        message: "scenarioId is required for this scenario action.",
      },
      uiActions: [],
      modelSummary: "scenarioId is required for this scenario action.",
    };
  }

  return {
    ok: true,
    tool: "manage_scenarios",
    result: {
      ok: true,
      action: input.action,
      scenario_id: scenarioId ?? null,
      message: `Prepared scenario ${input.action}.`,
    },
    uiActions: [
      {
        type: "manage_scenario",
        label: `Apply scenario ${input.action}`,
        input:
          input.action === "create"
            ? input
            : { ...input, scenarioId },
        autoApply: true,
      },
    ],
    modelSummary:
      input.action === "duplicate"
        ? `Prepared scenario variation from ${scenarioId}.`
        : `Prepared scenario ${input.action}.`,
  };
}

function buildLocationActions(
  result: {
    items: Array<{
      id: string;
      label: string;
    }>;
  },
): EditorToolUiAction[] {
  return result.items.slice(0, 8).map((location) => ({
    type: "select_location",
    label: `Select ${location.label}`,
    location,
    autoApply: false,
  })) as EditorToolUiAction[];
}

export async function executeEditorTool(
  toolId: EditorToolId,
  input: EditorToolInput,
  context: EditorToolContext,
): Promise<EditorToolExecutionResult> {
  if (toolId === "get_location_catalog") {
    const result = getLocationCatalog(context.bundle).options
      .filter((option) => option.selector_type === "tag")
      .map((option) => option.selector);
    return {
      ok: true,
      tool: toolId,
      result,
      uiActions: [],
      modelSummary: summarizeLocationCatalog(result),
    };
  }

  if (toolId === "get_location") {
    const parsedInput = getLocationInputSchema.parse(input);
    const result = getLocation(context.bundle, parsedInput);
    return {
      ok: true,
      tool: toolId,
      result,
      uiActions: buildLocationActions(result),
      modelSummary: summarizeLocationResult(result),
    };
  }

  if (toolId === "manage_selected_roads") {
    const parsedInput = manageSelectedRoadsInputSchema.parse({
      ...input,
      currentLocation:
        (input as { currentLocation?: unknown }).currentLocation ??
        context.selectedLocation,
    });
    const result = runManageSelectedRoads(
      context.selectedRoadIds,
      parsedInput,
      context.bundle.generated?.roads ?? [],
      context.bundle.runtime?.road_summaries ?? [],
    );
    const uiActions: EditorToolUiAction[] =
      parsedInput.action === "inspect"
        ? [
            {
              type: "inspect_selected_roads",
              label: "Show placement anchors",
              result,
              autoApply: true,
            },
          ]
        : [
            {
              type: "set_selected_roads",
              label: `Apply ${parsedInput.action} road selection`,
              roadIds: result.selected_road_ids,
              inspectResult: result,
              autoApply: true,
            },
          ];
    return {
      ok: true,
      tool: toolId,
      result,
      uiActions,
      modelSummary: summarizeRoadSelectionResult(result),
    };
  }

  if (toolId === "inspect_selected_roads") {
    const result = runManageSelectedRoads(
      context.selectedRoadIds,
      {
        action: "inspect",
        source: "current_location",
        currentLocation: context.selectedLocation,
      },
      context.bundle.generated?.roads ?? [],
      context.bundle.runtime?.road_summaries ?? [],
    );
    return {
      ok: true,
      tool: toolId,
      result,
      uiActions: [
        {
          type: "inspect_selected_roads",
          label: "Show placement anchors",
          result,
          autoApply: true,
        },
      ],
      modelSummary: summarizeRoadSelectionResult(result),
    };
  }

  if (toolId === "manage_actors") {
    const parsedInput = manageActorsInputSchema.parse(input) as ManageActorsToolInput;
    return buildManageActorsResult(parsedInput, context);
  }

  if (toolId === "manage_scenarios") {
    const parsedInput = manageScenariosInputSchema.parse(input) as ManageScenariosToolInput;
    return buildManageScenariosResult(parsedInput, context);
  }

  const exhaustiveCheck: never = toolId;
  throw new Error(`Unsupported tool: ${exhaustiveCheck}`);
}
