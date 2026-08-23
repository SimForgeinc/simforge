"use client";

import type { CameraPlacementMode } from "@/app/lib/scenario-editor/types";

export type RuntimeAssistMode = "auto" | "pinned_on" | "forced_off";

export type EditorMapPresentationPreferences = {
  showAuthoredMapLayers: boolean;
  runtimeAssistMode: RuntimeAssistMode;
  showRuntimeLaneCenterlines: boolean;
  showRuntimeLaneMarkings: boolean;
  showRuntimeLaneSurfaces: boolean;
};

export type MapInteractionKind =
  | "idle"
  | "choose_actor"
  | "place_actor"
  | "move_actor"
  | "edit_timed_path"
  | "edit_static_distribution"
  | "place_camera"
  | "place_intersection_control";

export type MapInteractionTarget =
  | "none"
  | "lane"
  | "map_point"
  | "traffic_light"
  | "junction";

export type MapInteractionInstructionKey =
  | "none"
  | "choose_actor"
  | "place_on_road"
  | "place_anywhere"
  | "place_on_traffic_light"
  | "place_on_junction"
  | "draw_path";

export type MapInteractionIntent = {
  kind: MapInteractionKind;
  target: MapInteractionTarget;
  subjectLabel: string | null;
  pointCount: number | null;
  copy: {
    instructionKey: MapInteractionInstructionKey;
    subjectLabel: string | null;
    allowHoverDetail: boolean;
  };
  chrome: {
    showYellowFrame: boolean;
    showIntentToolbar: boolean;
    showPill: boolean;
    hideDetailPanel: boolean;
  };
  assist: {
    /**
     * `junction_focus` DIMS, it does not suppress. Street-camera mode hides the
     * authored and runtime overlays outright, so you place a camera blind to
     * what it will watch; placing an intersection control while unable to see
     * the traffic it governs is the same mistake, and the fix is one word.
     */
    mode: "none" | "road_overlay" | "traffic_light_focus" | "junction_focus";
    suppressAuthoredLayers: boolean;
    suppressRuntimeOverlayLayers: boolean;
  };
};

export type MapInteractionIntentInput = {
  activePlacementTool:
    | {
        label: string;
        objectType: "actor" | "prop" | "camera";
        placement: "lane_or_free" | "free";
      }
    | null;
  actorPickerActive?: boolean;
  actorDrag:
    | {
        label: string;
        placementMode: "road" | "timed_path" | "point" | "path";
      }
    | null;
  cameraPlacementMode: CameraPlacementMode | null;
  /** `selectionStore.intersectionControlPlacementActive`. */
  intersectionControlPlacementActive?: boolean;
  timedPathPlacement:
    | {
        actorLabel: string;
        pointCount: number;
        /** Drive-by-points, whose per-point snapping needs lane centerlines
         *  visible to snap to (plan 2026-07-25 section 6.5). */
        drivesByPoints?: boolean;
      }
    | null;
  staticDistributionPlacement:
    | {
        actorLabel: string;
        pointCount: number;
      }
    | null;
};

export type EditorMapPresentationContext = {
  intent: MapInteractionIntent;
  runtimeRoadOverlayAvailable: boolean;
};

export type RuntimeAssistReason =
  | "forced_off"
  | "pinned_on"
  | "auto_interaction"
  | "auto_idle"
  | "traffic_light_focus";

export type EditorMapPresentation = {
  showAuthoredMapLayers: boolean;
  authoredLayersSuppressedByRuntime: boolean;
  showRuntimeOverlay: boolean;
  showRuntimeLaneCenterlines: boolean;
  showRuntimeLaneMarkings: boolean;
  showRuntimeLaneSurfaces: boolean;
  runtimeLaneVisualsVisible: boolean;
  preferRuntimeSelection: boolean;
  runtimeAssistReason: RuntimeAssistReason;
  interactionDemandActive: boolean;
  highlightTrafficLights: boolean;
  /**
   * Armed intersection-control placement: draw the non-candidate chrome faded
   * rather than hidden. Actors, routes and the basemap stay legible, because you
   * place an intersection control while looking at the traffic it will govern.
   */
  dimNonCandidateLayers: boolean;
};

const IDLE_INTENT: MapInteractionIntent = {
  kind: "idle",
  target: "none",
  subjectLabel: null,
  pointCount: null,
  copy: {
    instructionKey: "none",
    subjectLabel: null,
    allowHoverDetail: false,
  },
  chrome: {
    showYellowFrame: false,
    showIntentToolbar: false,
    showPill: false,
    hideDetailPanel: false,
  },
  assist: {
    mode: "none",
    suppressAuthoredLayers: false,
    suppressRuntimeOverlayLayers: false,
  },
};

function actorPlacementRule(tool: NonNullable<MapInteractionIntentInput["activePlacementTool"]>) {
  // A `lane_or_free` tool still lights the lane overlay and reads as a lane
  // placement: snapping is what it does when it can. Dropping off-road is the
  // documented fallback, not a second mode to advertise up front.
  if (tool.placement === "lane_or_free") {
    return {
      target: "lane" as const,
      instructionKey: "place_on_road" as const,
      assistMode: "road_overlay" as const,
      allowHoverDetail: true,
    };
  }

  return {
    target: "map_point" as const,
    instructionKey: "place_anywhere" as const,
    assistMode: "none" as const,
    allowHoverDetail: false,
  };
}

function actorMoveRule(actor: NonNullable<MapInteractionIntentInput["actorDrag"]>) {
  if (actor.placementMode === "road") {
    return {
      target: "lane" as const,
      instructionKey: "place_on_road" as const,
      assistMode: "road_overlay" as const,
      allowHoverDetail: true,
    };
  }

  return {
    target: "map_point" as const,
    instructionKey: "place_anywhere" as const,
    assistMode: "none" as const,
    allowHoverDetail: false,
  };
}

function cameraPlacementRule(mode: CameraPlacementMode) {
  if (mode === "street") {
    return {
      target: "traffic_light" as const,
      instructionKey: "place_on_traffic_light" as const,
      assistMode: "traffic_light_focus" as const,
      allowHoverDetail: true,
    };
  }
  return {
    target: "map_point" as const,
    instructionKey: "place_anywhere" as const,
    assistMode: "none" as const,
    allowHoverDetail: false,
  };
}

function activeChrome(kind: Exclude<MapInteractionKind, "idle">) {
  return {
    showYellowFrame: true,
    showIntentToolbar: true,
    showPill: false,
    hideDetailPanel: kind === "choose_actor",
  };
}

export function deriveMapInteractionIntent(
  input: MapInteractionIntentInput,
): MapInteractionIntent {
  if (input.timedPathPlacement) {
    return {
      kind: "edit_timed_path",
      target: "map_point",
      subjectLabel: input.timedPathPlacement.actorLabel,
      pointCount: input.timedPathPlacement.pointCount,
      copy: {
        instructionKey: "draw_path",
        subjectLabel: input.timedPathPlacement.actorLabel,
        allowHoverDetail: false,
      },
      chrome: activeChrome("edit_timed_path"),
      assist: {
        // Drive-by-points snaps each point to a lane by default, so the lane
        // centerlines have to be on screen to aim at — the same force-show
        // route placement gets. A legacy ordering path snaps to nothing and
        // keeps the uncluttered map it has always had.
        mode: input.timedPathPlacement.drivesByPoints ? "road_overlay" : "none",
        suppressAuthoredLayers: false,
        suppressRuntimeOverlayLayers: false,
      },
    };
  }

  if (input.staticDistributionPlacement) {
    return {
      kind: "edit_static_distribution",
      target: "map_point",
      subjectLabel: input.staticDistributionPlacement.actorLabel,
      pointCount: input.staticDistributionPlacement.pointCount,
      copy: {
        instructionKey: "draw_path",
        subjectLabel: input.staticDistributionPlacement.actorLabel,
        allowHoverDetail: false,
      },
      chrome: activeChrome("edit_static_distribution"),
      assist: {
        mode: "none",
        suppressAuthoredLayers: false,
        suppressRuntimeOverlayLayers: false,
      },
    };
  }

  if (input.intersectionControlPlacementActive) {
    const subjectLabel = "Intersection Control";
    return {
      kind: "place_intersection_control",
      target: "junction",
      subjectLabel,
      pointCount: null,
      copy: {
        instructionKey: "place_on_junction",
        subjectLabel,
        // The candidate's own hover card carries the junction's identity, so
        // hover detail is what makes the armed map answer "which one is this?".
        allowHoverDetail: true,
      },
      chrome: activeChrome("place_intersection_control"),
      assist: {
        mode: "junction_focus",
        suppressAuthoredLayers: false,
        suppressRuntimeOverlayLayers: false,
      },
    };
  }

  if (input.cameraPlacementMode) {
    const rule = cameraPlacementRule(input.cameraPlacementMode);
    const subjectLabel =
      input.cameraPlacementMode === "street"
        ? "Street Camera"
        : "Overhead Camera";
    return {
      kind: "place_camera",
      target: rule.target,
      subjectLabel,
      pointCount: null,
      copy: {
        instructionKey: rule.instructionKey,
        subjectLabel,
        allowHoverDetail: false,
      },
      chrome: activeChrome("place_camera"),
      assist: {
        mode: rule.assistMode,
        suppressAuthoredLayers: rule.assistMode === "traffic_light_focus",
        suppressRuntimeOverlayLayers: rule.assistMode === "traffic_light_focus",
      },
    };
  }

  if (input.actorDrag) {
    const rule = actorMoveRule(input.actorDrag);
    return {
      kind: "move_actor",
      target: rule.target,
      subjectLabel: input.actorDrag.label,
      pointCount: null,
      copy: {
        instructionKey: rule.instructionKey,
        subjectLabel: input.actorDrag.label,
        allowHoverDetail: rule.allowHoverDetail,
      },
      chrome: activeChrome("move_actor"),
      assist: {
        mode: rule.assistMode,
        suppressAuthoredLayers: false,
        suppressRuntimeOverlayLayers: false,
      },
    };
  }

  if (input.activePlacementTool) {
    const rule = actorPlacementRule(input.activePlacementTool);
    return {
      kind: "place_actor",
      target: rule.target,
      subjectLabel: input.activePlacementTool.label,
      pointCount: null,
      copy: {
        instructionKey: rule.instructionKey,
        subjectLabel: input.activePlacementTool.label,
        allowHoverDetail: rule.allowHoverDetail,
      },
      chrome: activeChrome("place_actor"),
      assist: {
        mode: rule.assistMode,
        suppressAuthoredLayers: false,
        suppressRuntimeOverlayLayers: false,
      },
    };
  }

  if (input.actorPickerActive) {
    return {
      kind: "choose_actor",
      target: "none",
      subjectLabel: null,
      pointCount: null,
      copy: {
        instructionKey: "choose_actor",
        subjectLabel: null,
        allowHoverDetail: false,
      },
      chrome: activeChrome("choose_actor"),
      assist: {
        mode: "none",
        suppressAuthoredLayers: false,
        suppressRuntimeOverlayLayers: false,
      },
    };
  }

  return IDLE_INTENT;
}

function formatInstructionSubject(subjectLabel: string | null) {
  return subjectLabel?.trim() || "item";
}

export function describeMapInteractionCopy(
  intent: MapInteractionIntent,
  options: {
    surface: "toolbar" | "status";
    hoveredLaneLabel?: string | null;
  },
): string | null {
  const subject = formatInstructionSubject(intent.copy.subjectLabel);
  const hoveredLaneLabel = options.hoveredLaneLabel?.trim() || null;

  switch (intent.copy.instructionKey) {
    case "none":
      return null;
    case "choose_actor":
      return "Click an actor on the left, then drag onto the map.";
    case "place_on_road":
      if (options.surface === "status" && intent.copy.allowHoverDetail) {
        return hoveredLaneLabel
          ? `Drop ${subject} on ${hoveredLaneLabel}`
          : `Drag ${subject} onto a road`;
      }
      return `Place ${subject} on a road.`;
    case "place_anywhere":
      if (options.surface === "status") {
        return `Drop ${subject} anywhere on the map`;
      }
      return `Place ${subject} anywhere on the map.`;
    case "place_on_traffic_light":
      if (options.surface === "status") {
        return "Drop on a highlighted traffic light location";
      }
      return `Place ${subject} on a traffic light location.`;
    case "place_on_junction":
      if (options.surface === "status") {
        return "Click a highlighted intersection";
      }
      return "Pick an intersection to control.";
    case "draw_path":
      if (options.surface === "status") {
        return `Click on the map to add path points for ${subject}`;
      }
      return `Click on the map to draw a path for ${subject}.`;
  }
}

export function shouldCollapseSidebarForMapInteraction(
  intent: MapInteractionIntent,
) {
  return intent.chrome.showYellowFrame && intent.kind !== "choose_actor";
}

export function computeEditorMapPresentation(
  preferences: EditorMapPresentationPreferences,
  context: EditorMapPresentationContext,
): EditorMapPresentation {
  const trafficLightFocus = context.intent.assist.mode === "traffic_light_focus";
  const junctionFocus = context.intent.assist.mode === "junction_focus";
  const laneOverlayRequested = context.intent.assist.mode === "road_overlay";
  const interactionDemandActive = context.intent.kind !== "idle";

  const runtimeAssistReason: RuntimeAssistReason = trafficLightFocus
    ? "traffic_light_focus"
    : laneOverlayRequested
      ? "auto_interaction"
      : preferences.runtimeAssistMode === "forced_off"
        ? "forced_off"
        : preferences.runtimeAssistMode === "pinned_on"
          ? "pinned_on"
          : "auto_idle";

  const showRuntimeOverlay =
    context.runtimeRoadOverlayAvailable &&
    !trafficLightFocus &&
    (laneOverlayRequested || preferences.runtimeAssistMode === "pinned_on");

  const showRuntimeLaneCenterlines =
    showRuntimeOverlay &&
    (laneOverlayRequested || preferences.showRuntimeLaneCenterlines);
  const showRuntimeLaneMarkings =
    showRuntimeOverlay && preferences.showRuntimeLaneMarkings;
  const showRuntimeLaneSurfaces =
    showRuntimeOverlay &&
    (laneOverlayRequested || preferences.showRuntimeLaneSurfaces);
  const authoredLayersSuppressedByRuntime =
    showRuntimeOverlay ||
    laneOverlayRequested ||
    context.intent.assist.suppressAuthoredLayers;

  return {
    showAuthoredMapLayers:
      preferences.showAuthoredMapLayers && !authoredLayersSuppressedByRuntime,
    authoredLayersSuppressedByRuntime,
    showRuntimeOverlay,
    showRuntimeLaneCenterlines,
    showRuntimeLaneMarkings,
    showRuntimeLaneSurfaces,
    runtimeLaneVisualsVisible:
      showRuntimeLaneCenterlines ||
      showRuntimeLaneMarkings ||
      showRuntimeLaneSurfaces,
    preferRuntimeSelection: showRuntimeOverlay,
    runtimeAssistReason,
    interactionDemandActive,
    highlightTrafficLights: trafficLightFocus,
    dimNonCandidateLayers: junctionFocus,
  };
}

export function describeRuntimeAssistReason(reason: RuntimeAssistReason) {
  switch (reason) {
    case "forced_off":
      return "Forced off";
    case "pinned_on":
      return "Pinned on";
    case "auto_interaction":
      return "Visible during actor interaction";
    case "auto_idle":
      return "Hidden until actor interaction";
    case "traffic_light_focus":
      return "Focused on traffic light placement";
  }
}
