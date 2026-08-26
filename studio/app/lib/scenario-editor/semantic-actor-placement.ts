import {
  baseActionForDraft,
  emptyActorBehaviorProgram,
  normalizeActorBaseClip,
  withBaseAction,
  type ScenarioEditorActorDraft,
  type SemanticActorIntent,
} from "@simforge-oss/studio-shared";
import type { SemanticFeatureSelection } from "@/app/lib/editor-map/semantic-overlay";
import {
  buildActorLabel,
  createRandomActorAppearance,
  defaultActorAutopilot,
  defaultActorSpeedKph,
} from "@/app/lib/scenario-editor/actor-utils";
import {
  corridorStationIntentFromSelection,
  type SemanticActorExactPatch,
} from "@/app/lib/scenario-editor/semantic-actor-compile-client";
import {
  PRESET_TRAILING_CAMERA,
  sensorsFromPreset,
} from "@/app/lib/scenario-editor/sensor-rigs";
import type { ActorPaletteItem } from "@/app/lib/scenario-editor/types";

// Pure helpers for semantic road actor authoring (M4 Pass 2B1). A new road
// vehicle exists only as a complete in-memory draft until the semantic
// compiler returns an exact runtime binding; nothing here fabricates runtime
// road/section/lane identifiers from geometry.

/**
 * Placeholder spawn for a draft whose executable anchor may only come from
 * the semantic compiler's exact patch. It carries no runtime identifiers.
 */
export const SEMANTIC_PLACEHOLDER_SPAWN: ScenarioEditorActorDraft["spawn"] = {
  road_id: "",
  s_fraction: 0.5,
  lane_id: null,
  section_id: null,
};

/**
 * Build the complete intended draft for a new semantic road vehicle. Mirrors
 * the runtime-lane placement draft (label, appearance, defaults, subject sensor
 * rig) except that the spawn is a placeholder the exact patch will replace.
 */
export function buildSemanticRoadActorDraft({
  tool,
  actorBlueprints,
  existingDrafts,
}: {
  tool: ActorPaletteItem;
  actorBlueprints: { vehicles: string[]; walkers: string[] };
  existingDrafts: ScenarioEditorActorDraft[];
}): ScenarioEditorActorDraft | null {
  // Semantic placement resolves to a lane anchor, so only a lane-snapping
  // palette entry can drive it.
  if (tool.placement !== "lane_or_free") return null;
  const appearance = createRandomActorAppearance(
    tool.kind,
    actorBlueprints,
    tool.blueprint,
  );
  return normalizeActorBaseClip({
    id: crypto.randomUUID(),
    label: buildActorLabel(
      {
        kind: tool.kind,
        role: tool.role,
        placement_mode: "road",
        is_static: Boolean(tool.isStatic),
      },
      existingDrafts,
    ),
    kind: tool.kind,
    role: tool.role,
    is_static: Boolean(tool.isStatic),
    placement_mode: "road",
    blueprint: appearance.blueprint,
    spawn: { ...SEMANTIC_PLACEHOLDER_SPAWN },
    spawn_point: null,
    route: [],
    route_direction: "forward",
    lane_facing: "with_lane",
    destination: null,
    destination_point: null,
    speed_kph: defaultActorSpeedKph({
      kind: tool.kind,
      is_static: Boolean(tool.isStatic),
    }),
    autopilot: defaultActorAutopilot({
      kind: tool.kind,
      placement_mode: "road",
      is_static: Boolean(tool.isStatic),
    }),
    color: appearance.color,
    notes: null,
    timeline: [],
    // Subject is derived from a configured rig, so the first vehicle into a
    // rig-less scene gets one — mirrors `shouldAutoAttachSensorRig` on the
    // canvas placement path.
    sensors:
      tool.kind === "vehicle" &&
      !existingDrafts.some((draft) => (draft.sensors ?? []).length > 0)
        ? sensorsFromPreset(PRESET_TRAILING_CAMERA)
        : [],
  });
}

/**
 * Map a semantic feature hit to a compilable road actor spawn intent.
 * Spawning is corridor-only: a movement represents a complete junction path,
 * whose exact CARLA spawn is the path entrance rather than the point the user
 * clicked. Treating that click as a spawn would make the marker and worker
 * transform disagree. Junction movements remain available to route authoring.
 */
export function semanticRoadIntentFromSelection(
  selection: SemanticFeatureSelection,
  graphRevision: string,
): SemanticActorIntent | null {
  if (selection.authoringStatus !== "authorable") return null;
  if (selection.kind === "corridor") {
    return corridorStationIntentFromSelection(selection, graphRevision);
  }
  return null;
}

/**
 * Atomically merge an exact compile patch into a complete actor draft. Only
 * the executable fields plus `semantic_authoring` change; the actor id,
 * label, and every other non-executable setting are preserved verbatim.
 *
 * The patch is the one place the compiler — not the author — moves an actor
 * between placement modes, so the base clip is RE-DERIVED from the result
 * rather than preserved. Keeping the old baseline would leave the timeline
 * claiming a motion the actor's compiled placement no longer has.
 */
export function mergeSemanticExactPatch(
  draft: ScenarioEditorActorDraft,
  patch: SemanticActorExactPatch,
): ScenarioEditorActorDraft {
  const patched: ScenarioEditorActorDraft = {
    ...draft,
    placement_mode: patch.placement_mode,
    spawn: patch.spawn,
    route: patch.route,
    destination: patch.destination,
    timed_waypoints: patch.timed_waypoints,
    semantic_authoring: patch.semantic_authoring,
  };
  return {
    ...patched,
    behavior: withBaseAction(
      patched.behavior ?? emptyActorBehaviorProgram(),
      patched,
      baseActionForDraft(patched),
    ),
  };
}
