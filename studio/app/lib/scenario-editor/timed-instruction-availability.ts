import type {
  ScenarioEditorActorDraft,
  TimedInstructionPrimitiveId,
  TimedInstructions,
} from "@simforge/studio-shared";
import type { RuntimeRoadOverlayCollection } from "@/app/lib/editor-map/types";

export type TimedInstructionPrimitiveAvailability = {
  available: boolean;
  reason?: string;
};

export type TimedInstructionAvailabilityMap = Record<
  TimedInstructionPrimitiveId,
  TimedInstructionPrimitiveAvailability
>;

export type TimedInstructionPreflight = {
  status: "ready" | "blocked";
  reason?: string;
  rowReasons: Record<string, string>;
};

const TIMED_INSTRUCTION_PRIMITIVES: TimedInstructionPrimitiveId[] = [
  "lane_follow",
  "turn_left_at_next_intersection",
  "turn_right_at_next_intersection",
  "go_straight_at_next_intersection",
  "lane_change_left",
  "lane_change_right",
  "set_speed",
  "stop",
  "hold_position",
];

function blockedAll(reason: string): TimedInstructionAvailabilityMap {
  return TIMED_INSTRUCTION_PRIMITIVES.reduce((acc, primitive) => {
    acc[primitive] = { available: false, reason };
    return acc;
  }, {} as TimedInstructionAvailabilityMap);
}

function actorRsl(actor: ScenarioEditorActorDraft): string | null {
  const spawn = actor.spawn;
  if (
    !spawn ||
    spawn.road_id == null ||
    spawn.section_id == null ||
    spawn.lane_id == null
  ) {
    return null;
  }
  return `${spawn.road_id}:${spawn.section_id}:${spawn.lane_id}`;
}

function runtimeInstructionAvailability(
  actor: ScenarioEditorActorDraft,
  overlay: RuntimeRoadOverlayCollection,
): TimedInstructionAvailabilityMap {
  const lanes = new Map(
    overlay.features
      .filter((feature) => feature.properties.feature_kind === "lane_centerline")
      .map((feature) => [
        `${feature.properties.road_id}:${feature.properties.section_id}:${feature.properties.lane_id}`,
        feature,
      ]),
  );
  const startRsl = actorRsl(actor);
  const startLane = startRsl ? lanes.get(startRsl) : null;
  if (!startLane) {
    return blockedAll(
      "The actor is not anchored to an exact CARLA runtime lane in the loaded map.",
    );
  }

  const turnRelations = new Set<string>();
  const visited = new Set<string>();
  let frontier = [startRsl!];
  for (let depth = 0; depth < 64 && frontier.length > 0 && turnRelations.size === 0; depth += 1) {
    const next: string[] = [];
    for (const rsl of frontier) {
      if (visited.has(rsl)) continue;
      visited.add(rsl);
      const lane = lanes.get(rsl);
      if (!lane) continue;
      for (const relation of lane.properties.turn_relations ?? []) {
        turnRelations.add(relation);
      }
      for (const successorRsl of lane.properties.successor_rsls ?? []) {
        if (!visited.has(successorRsl)) next.push(successorRsl);
      }
    }
    frontier = next;
  }
  const turn = (relation: string): TimedInstructionPrimitiveAvailability =>
    turnRelations.has(relation)
      ? { available: true }
      : { available: false, reason: `No ${relation.toLowerCase()} CARLA movement is available at the next intersection.` };
  const laneChange = (side: "left" | "right"): TimedInstructionPrimitiveAvailability => {
    const adjacentRsl =
      side === "left"
        ? startLane.properties.left_lane_rsl
        : startLane.properties.right_lane_rsl;
    return !startLane.properties.is_junction && adjacentRsl && lanes.has(adjacentRsl)
      ? { available: true }
      : { available: false, reason: `No permitted same-direction CARLA lane is available on the ${side}.` };
  };
  return {
    lane_follow: startLane.properties.has_successor
      ? { available: true }
      : {
          available: false,
          reason: "This CARLA lane has no directed continuation.",
        },
    set_speed: { available: true },
    stop: { available: true },
    hold_position: { available: true },
    turn_left_at_next_intersection: turn("Left"),
    turn_right_at_next_intersection: turn("Right"),
    go_straight_at_next_intersection: turn("Straight"),
    lane_change_left: laneChange("left"),
    lane_change_right: laneChange("right"),
  };
}

export function computeTimedInstructionAvailability(input: {
  actor: ScenarioEditorActorDraft;
  runtimeRoadOverlay?: RuntimeRoadOverlayCollection | null;
}): TimedInstructionAvailabilityMap {
  if (input.runtimeRoadOverlay) {
    return runtimeInstructionAvailability(input.actor, input.runtimeRoadOverlay);
  }
  return blockedAll(
    "CARLA runtime lane data is unavailable for this actor and map revision.",
  );
}

export function preflightTimedInstructions(
  timedInstructions: TimedInstructions | undefined,
  availability: TimedInstructionAvailabilityMap | null | undefined,
): TimedInstructionPreflight {
  if (!timedInstructions) return { status: "ready", rowReasons: {} };
  if (!availability) {
    return {
      status: "blocked",
      reason: "Timed instruction availability has not loaded yet.",
      rowReasons: {},
    };
  }
  const rowReasons: Record<string, string> = {};
  for (const row of timedInstructions.intent) {
    if (row.enabled === false) continue;
    const primitive = availability[row.primitiveId];
    if (primitive?.available === false) {
      rowReasons[row.id] = primitive.reason ?? "Instruction is unavailable here.";
    }
  }
  const firstReason = Object.values(rowReasons)[0];
  return firstReason
    ? { status: "blocked", reason: firstReason, rowReasons }
    : { status: "ready", rowReasons };
}
