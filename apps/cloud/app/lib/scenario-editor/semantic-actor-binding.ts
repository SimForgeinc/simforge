import "server-only";

import { createHash } from "node:crypto";
import {
  SEMANTIC_ACTOR_AUTHORING_SCHEMA_VERSION,
  SEMANTIC_RUNTIME_BINDING_COMPILER_VERSION,
  SEMANTIC_RUNTIME_BINDING_COMPILER_VERSION_V1,
  parseRsl,
  pointAndYawAtStation,
  quantizeSemanticExecutableProof,
  runtimeBindingAtCorridorStation,
  travelFractionToRoadFraction,
  semanticExecutableActorProjection,
  stableSemanticBindingJson,
  type JunctionMovementVariant,
  type LaneCorridor,
  type ScenarioEditorActorDraft,
  type ScenarioEditorRoadAnchor,
  type SemanticActorAuthoring,
  type SemanticActorIntent,
  type SemanticMapGraph,
} from "@simcloud/shared";
import { semanticMovementRuntimeLaneSet } from "@/app/lib/maps/topology/semantic-movement";

export type SemanticBindingFailureStatus = "ambiguous" | "unbound" | "stale";

export type SemanticBindingSuggestion = {
  entityId: string;
  reason: string;
  confidence: number;
  intent: SemanticActorIntent;
  runtimeLaneRsls: string[];
  runtimeGateIds: string[];
};

export type ExistingActorSemanticClassification =
  | { status: "exact"; suggestions: [SemanticBindingSuggestion] }
  | { status: "ambiguous"; suggestions: SemanticBindingSuggestion[] }
  | { status: "unbound"; suggestions: [] };

export type SemanticActorBindingResult =
  | {
      status: "exact";
      actorPatch: Pick<
        ScenarioEditorActorDraft,
        | "placement_mode"
        | "spawn"
        | "route"
        | "destination"
        | "timed_waypoints"
        | "semantic_authoring"
      >;
      outputHash: string;
      suggestions: [];
    }
  | {
      status: SemanticBindingFailureStatus;
      code:
        | "SEMANTIC_GRAPH_STALE"
        | "SEMANTIC_ENTITY_UNBOUND"
        | "SEMANTIC_SELECTION_AMBIGUOUS";
      message: string;
      suggestions: SemanticBindingSuggestion[];
    };

type ConcreteBinding = {
  spawn: ScenarioEditorRoadAnchor;
  route: ScenarioEditorRoadAnchor[];
  destination: ScenarioEditorRoadAnchor | null;
  timed_waypoints: [];
  runtimeLaneRsls: string[];
  runtimeGateIds: string[];
};

function sha256(value: string): string {
  return `sha256:${createHash("sha256").update(value, "utf8").digest("hex")}`;
}

export function semanticActorOutputHash(
  actor: Record<string, unknown>,
  bindingCompilerVersion: string = SEMANTIC_RUNTIME_BINDING_COMPILER_VERSION,
): string {
  const projection = semanticExecutableActorProjection(actor);
  return sha256(
    stableSemanticBindingJson(
      bindingCompilerVersion === SEMANTIC_RUNTIME_BINDING_COMPILER_VERSION_V1
        ? projection
        : quantizeSemanticExecutableProof(projection),
    ),
  );
}

function anchorForCorridorStation(
  corridor: LaneCorridor,
  stationM: number,
): ScenarioEditorRoadAnchor | null {
  const binding = runtimeBindingAtCorridorStation(corridor, stationM);
  if (!binding) return null;
  const world = pointAndYawAtStation(corridor.polyline, stationM);
  return {
    road_id: binding.roadId,
    section_id: binding.sectionId,
    lane_id: binding.laneId,
    s_fraction: binding.sFraction,
    resolution_mode: "runtime_exact",
    ...(world?.point.z == null
      ? {}
      : {
          world_anchor: {
            x: world.point.x,
            y: world.point.y,
            z: world.point.z,
            yaw: world.yaw,
          },
        }),
  };
}

function anchorAtTravelEnd(rslValue: string): ScenarioEditorRoadAnchor | null {
  const rsl = parseRsl(rslValue);
  if (!rsl) return null;
  return {
    road_id: rsl.roadId,
    section_id: rsl.sectionId,
    lane_id: rsl.laneId,
    s_fraction: travelFractionToRoadFraction(rsl.laneId, 1),
    resolution_mode: "runtime_exact",
  };
}

function anchorAtTravelStart(rslValue: string): ScenarioEditorRoadAnchor | null {
  const rsl = parseRsl(rslValue);
  if (!rsl) return null;
  return {
    road_id: rsl.roadId,
    section_id: rsl.sectionId,
    lane_id: rsl.laneId,
    s_fraction: travelFractionToRoadFraction(rsl.laneId, 0),
    resolution_mode: "runtime_exact",
  };
}

function uniqueInOrder(values: readonly string[]): string[] {
  const seen = new Set<string>();
  return values.filter((value) => {
    if (seen.has(value)) return false;
    seen.add(value);
    return true;
  });
}

function unbound(message: string): SemanticActorBindingResult {
  return {
    status: "unbound",
    code: "SEMANTIC_ENTITY_UNBOUND",
    message,
    suggestions: [],
  };
}

function compileCorridorStation(
  graph: SemanticMapGraph,
  intent: Extract<SemanticActorIntent, { kind: "corridor_station" }>,
): ConcreteBinding | SemanticActorBindingResult {
  const corridor = graph.corridors.find((row) => row.id === intent.corridorId);
  if (!corridor || corridor.authoringStatus !== "authorable") {
    return unbound("The selected semantic corridor is not authorable on this runtime revision.");
  }
  const spawn = anchorForCorridorStation(corridor, intent.stationM);
  if (!spawn) return unbound("The selected station does not resolve to an exact runtime lane fragment.");
  const runtimeLaneRsls = corridor.runtimeFragments
    .filter(
      (fragment) =>
        intent.stationM >= fragment.startArcM - 1e-6 &&
        intent.stationM <= fragment.endArcM + 1e-6,
    )
    .map((fragment) => fragment.rsl);
  return {
    spawn,
    route: [],
    destination: null,
    timed_waypoints: [],
    runtimeLaneRsls: uniqueInOrder(runtimeLaneRsls),
    runtimeGateIds: [],
  };
}

function compileCorridorRoute(
  graph: SemanticMapGraph,
  intent: Extract<SemanticActorIntent, { kind: "corridor_route" }>,
): ConcreteBinding | SemanticActorBindingResult {
  const corridors: LaneCorridor[] = [];
  for (const corridorId of intent.corridorIds) {
    const corridor = graph.corridors.find((row) => row.id === corridorId);
    if (!corridor || corridor.authoringStatus !== "authorable") {
      return unbound("A corridor in the selected route is not authorable on this runtime revision.");
    }
    corridors.push(corridor);
  }
  for (let index = 1; index < corridors.length; index += 1) {
    if (!corridors[index - 1]!.successorCorridorIds.includes(corridors[index]!.id)) {
      return unbound("The selected corridor route is not continuously connected in travel direction.");
    }
  }
  const first = corridors[0]!;
  const last = corridors[corridors.length - 1]!;
  if (
    intent.startStationM > first.lengthM + 1e-6 ||
    intent.endStationM > last.lengthM + 1e-6 ||
    (first.id === last.id && intent.startStationM > intent.endStationM)
  ) {
    return unbound("The selected route stations fall outside the semantic corridor bounds.");
  }
  const spawn = anchorForCorridorStation(first, intent.startStationM);
  const destination = anchorForCorridorStation(last, intent.endStationM);
  if (!spawn || !destination) {
    return unbound("The selected route does not resolve to exact runtime lane anchors.");
  }
  const route = corridors.flatMap((corridor, index) => {
    const station = index === corridors.length - 1
      ? intent.endStationM
      : corridor.lengthM;
    const anchor = anchorForCorridorStation(corridor, station);
    return anchor ? [anchor] : [];
  });
  if (route.length !== corridors.length) {
    return unbound("A corridor route boundary does not resolve to an exact runtime lane anchor.");
  }
  const runtimeLaneRsls = uniqueInOrder(
    corridors.flatMap((corridor, corridorIndex) =>
      corridor.runtimeFragments
        .filter((fragment) => {
          const lower = corridorIndex === 0 ? intent.startStationM : 0;
          const upper = corridorIndex === corridors.length - 1
            ? intent.endStationM
            : corridor.lengthM;
          return fragment.endArcM >= lower - 1e-6 && fragment.startArcM <= upper + 1e-6;
        })
        .map((fragment) => fragment.rsl)),
  );
  return {
    spawn,
    route,
    destination,
    timed_waypoints: [],
    runtimeLaneRsls,
    runtimeGateIds: [],
  };
}

function variantSuggestion(
  variant: JunctionMovementVariant,
  intent: Extract<SemanticActorIntent, { kind: "movement_trajectory" }>,
): SemanticBindingSuggestion {
  return {
    entityId: variant.id,
    reason: "Choose the exact runtime lane variant for this semantic movement.",
    confidence: 1,
    intent: { ...intent, variantId: variant.id },
    runtimeLaneRsls: [...variant.runtimeLaneRsls],
    runtimeGateIds: [variant.gateId],
  };
}

function compileMovement(
  graph: SemanticMapGraph,
  intent: Extract<SemanticActorIntent, { kind: "movement_trajectory" }>,
): ConcreteBinding | SemanticActorBindingResult {
  const movement = graph.movements.find((row) => row.id === intent.movementId);
  if (!movement || movement.authoringStatus !== "authorable") {
    return unbound("The selected junction movement is not authorable on this runtime revision.");
  }
  const authorableVariants = movement.variantIds
    .map((variantId) => graph.movementVariants.find((row) => row.id === variantId))
    .filter(
      (variant): variant is JunctionMovementVariant =>
        Boolean(variant && variant.authoringStatus === "authorable"),
    );
  const selected = intent.variantId
    ? authorableVariants.find((variant) => variant.id === intent.variantId)
    : authorableVariants.length === 1
      ? authorableVariants[0]
      : null;
  if (!selected && !intent.variantId && authorableVariants.length > 1) {
    return {
      status: "ambiguous",
      code: "SEMANTIC_SELECTION_AMBIGUOUS",
      message: "This movement has multiple exact runtime lane variants; explicit confirmation is required.",
      suggestions: authorableVariants.map((variant) => variantSuggestion(variant, intent)),
    };
  }
  if (!selected) {
    return unbound("The requested movement variant is not exactly bound to this runtime revision.");
  }
  const spawn = anchorAtTravelStart(selected.runtimeLaneRsls[0]!);
  const route = selected.runtimeLaneRsls
    .map(anchorAtTravelEnd)
    .filter((anchor): anchor is ScenarioEditorRoadAnchor => Boolean(anchor));
  const destination = route[route.length - 1] ?? null;
  if (!spawn || !destination || route.length !== selected.runtimeLaneRsls.length) {
    return unbound("The movement variant contains an invalid runtime lane binding.");
  }
  return {
    spawn,
    route,
    destination,
    timed_waypoints: [],
    runtimeLaneRsls: uniqueInOrder(selected.runtimeLaneRsls),
    runtimeGateIds: [selected.gateId],
  };
}

function isFailure(
  value: ConcreteBinding | SemanticActorBindingResult,
): value is SemanticActorBindingResult {
  return "status" in value;
}

export function compileSemanticActorBinding(input: {
  graph: SemanticMapGraph;
  actor: ScenarioEditorActorDraft;
  intent: SemanticActorIntent;
}): SemanticActorBindingResult {
  const { graph, actor, intent } = input;
  if (intent.graphRevision !== graph.graphRevision) {
    const classified = classifyExistingActorSemanticAnchor(graph, actor);
    return {
      status: "stale",
      code: "SEMANTIC_GRAPH_STALE",
      message: "The semantic selection was authored against a different graph revision and must be revalidated.",
      suggestions: classified.suggestions,
    };
  }
  if (graph.authority !== "runtime_verified") {
    return unbound("This semantic graph is diagnostic-only and cannot emit runtime actor bindings.");
  }
  const concrete = intent.kind === "corridor_station"
    ? compileCorridorStation(graph, intent)
    : intent.kind === "corridor_route"
      ? compileCorridorRoute(graph, intent)
      : compileMovement(graph, intent);
  if (isFailure(concrete)) return concrete;

  const executable = {
    ...actor,
    placement_mode: "road" as const,
    spawn: concrete.spawn,
    route: concrete.route,
    destination: concrete.destination,
    timed_waypoints: concrete.timed_waypoints,
  };
  const outputHash = semanticActorOutputHash(executable);
  const semanticAuthoring: SemanticActorAuthoring = {
    schemaVersion: SEMANTIC_ACTOR_AUTHORING_SCHEMA_VERSION,
    intent,
    compilation: {
      status: "exact",
      graphRevision: graph.graphRevision,
      semanticCompilerVersion: graph.compilerVersion,
      bindingCompilerVersion: SEMANTIC_RUNTIME_BINDING_COMPILER_VERSION,
      runtimeProvenance: graph.source.runtimeProvenance,
      outputHash,
      runtimeLaneRsls: concrete.runtimeLaneRsls,
      runtimeGateIds: concrete.runtimeGateIds,
    },
  };
  return {
    status: "exact",
    actorPatch: {
      placement_mode: "road",
      spawn: concrete.spawn,
      route: concrete.route,
      destination: concrete.destination,
      timed_waypoints: concrete.timed_waypoints,
      semantic_authoring: semanticAuthoring,
    },
    outputHash,
    suggestions: [],
  };
}

/**
 * Classify a historical concrete spawn without modifying it. Suggestions are
 * evidence only; callers must submit the returned intent to the compiler and
 * explicitly apply the resulting exact patch.
 */
export function classifyExistingActorSemanticAnchor(
  graph: SemanticMapGraph,
  actor: ScenarioEditorActorDraft,
): ExistingActorSemanticClassification {
  if (graph.authority !== "runtime_verified") {
    return { status: "unbound", suggestions: [] };
  }
  const roadId = actor.spawn.road_id;
  const sectionId = actor.spawn.section_id;
  const laneId = actor.spawn.lane_id;
  if (
    !roadId ||
    !Number.isInteger(sectionId) ||
    !Number.isInteger(laneId)
  ) {
    return { status: "unbound", suggestions: [] };
  }
  const rsl = `${roadId}:${sectionId}:${laneId}`;
  const sFraction = Math.min(1, Math.max(0, actor.spawn.s_fraction ?? 0.5));
  const travelFraction = laneId! < 0 ? sFraction : 1 - sFraction;
  const suggestions = graph.corridors.flatMap((corridor) => {
    if (corridor.authoringStatus !== "authorable") return [];
    const fragment = corridor.runtimeFragments.find((row) => row.rsl === rsl);
    if (!fragment) return [];
    const stationM =
      fragment.startArcM +
      (fragment.endArcM - fragment.startArcM) * travelFraction;
    const roles = graph.approaches
      .flatMap((approach) => approach.laneSlots)
      .filter((slot) => slot.corridorId === corridor.id)
      .map((slot) => slot.role);
    const laneRole = roles.length === 1 ? roles[0]! : "unknown";
    const intent: SemanticActorIntent = {
      kind: "corridor_station",
      graphRevision: graph.graphRevision,
      corridorId: corridor.id,
      stationM,
      laneRole,
    };
    return [{
      entityId: corridor.id,
      reason: "The existing concrete spawn references an exact bound runtime lane fragment.",
      confidence: 1,
      intent,
      runtimeLaneRsls: [rsl],
      runtimeGateIds: [],
    } satisfies SemanticBindingSuggestion];
  });
  if (suggestions.length === 0) return { status: "unbound", suggestions: [] };
  if (suggestions.length === 1) {
    return { status: "exact", suggestions: [suggestions[0]!] };
  }
  return { status: "ambiguous", suggestions };
}

/** Re-prove an already compiled same-map interaction without changing its timing trace. */
export function compileRelocatedInteractionSemanticProof(input: {
  graph: SemanticMapGraph;
  actor: ScenarioEditorActorDraft;
  movementId?: string;
  variantId?: string;
}): SemanticActorBindingResult {
  const relocation = input.actor.interaction_relocation;
  if (!relocation || input.graph.authority !== "runtime_verified") {
    return unbound("The relocated actor does not have current same-map movement provenance.");
  }
  const variants = input.graph.movementVariants.filter(
    (variant) =>
      variant.gateId === relocation.targetGateId &&
      (!input.variantId || variant.id === input.variantId) &&
      (!input.movementId || variant.movementId === input.movementId) &&
      variant.authoringStatus === "authorable",
  );
  if (variants.length > 1) {
    return {
      status: "ambiguous",
      code: "SEMANTIC_SELECTION_AMBIGUOUS",
      message: "The relocated gate maps to more than one semantic movement variant.",
      suggestions: variants.flatMap((variant) => {
        const movement = input.graph.movements.find(
          (row) => row.id === variant.movementId,
        );
        if (!movement) return [];
        return [variantSuggestion(variant, {
          kind: "movement_trajectory",
          graphRevision: input.graph.graphRevision,
          movementId: movement.id,
          variantId: variant.id,
          laneRole: "unknown",
        })];
      }),
    };
  }
  const variant = variants[0];
  const movement = variant
    ? input.graph.movements.find((row) => row.id === variant.movementId)
    : null;
  if (!variant || !movement || movement.authoringStatus !== "authorable") {
    return unbound("The relocated gate is not exactly bound to an authorable semantic movement.");
  }
  const allowedRsls = semanticMovementRuntimeLaneSet(input.graph, variant);
  const exactAnchor = (
    anchor: ScenarioEditorRoadAnchor,
  ): ScenarioEditorRoadAnchor | null => {
    const sectionId = anchor.section_id;
    const laneId = anchor.lane_id;
    if (!Number.isInteger(sectionId) || !Number.isInteger(laneId)) return null;
    const rsl = `${anchor.road_id}:${sectionId}:${laneId}`;
    return allowedRsls.has(rsl)
      ? { ...anchor, resolution_mode: "runtime_exact" }
      : null;
  };
  const spawn = exactAnchor(input.actor.spawn);
  const route = input.actor.route
    .map(exactAnchor)
    .filter((anchor): anchor is ScenarioEditorRoadAnchor => Boolean(anchor));
  const destination = input.actor.destination
    ? exactAnchor(input.actor.destination)
    : null;
  if (
    !spawn ||
    route.length !== input.actor.route.length ||
    (input.actor.destination && !destination)
  ) {
    return unbound("The relocated concrete route leaves the selected semantic movement corridor.");
  }
  const matchingLaneRoles = input.graph.approaches
    .flatMap((approach) => approach.laneSlots)
    .filter((slot) => slot.corridorId === variant.incomingCorridorId)
    .map((slot) => slot.role);
  const laneRole = matchingLaneRoles.length === 1
    ? matchingLaneRoles[0]!
    : "unknown";
  const intent: SemanticActorIntent = {
    kind: "movement_trajectory",
    graphRevision: input.graph.graphRevision,
    movementId: movement.id,
    variantId: variant.id,
    laneRole,
  };
  const executable = {
    ...input.actor,
    spawn,
    route,
    destination,
  };
  const outputHash = semanticActorOutputHash(executable);
  const runtimeLaneRsls = uniqueInOrder([
    ...[spawn, ...route, ...(destination ? [destination] : [])]
      .map((anchor) => `${anchor.road_id}:${anchor.section_id}:${anchor.lane_id}`),
    ...variant.runtimeLaneRsls,
  ]);
  return {
    status: "exact",
    actorPatch: {
      placement_mode: input.actor.placement_mode,
      spawn,
      route,
      destination,
      timed_waypoints: input.actor.timed_waypoints ?? [],
      semantic_authoring: {
        schemaVersion: SEMANTIC_ACTOR_AUTHORING_SCHEMA_VERSION,
        intent,
        compilation: {
          status: "exact",
          graphRevision: input.graph.graphRevision,
          semanticCompilerVersion: input.graph.compilerVersion,
          bindingCompilerVersion: SEMANTIC_RUNTIME_BINDING_COMPILER_VERSION,
          runtimeProvenance: input.graph.source.runtimeProvenance,
          outputHash,
          runtimeLaneRsls,
          runtimeGateIds: [variant.gateId],
        },
      },
    },
    outputHash,
    suggestions: [],
  };
}

export function applyExactSemanticActorBinding(
  actor: ScenarioEditorActorDraft,
  result: Extract<SemanticActorBindingResult, { status: "exact" }>,
): ScenarioEditorActorDraft {
  return { ...actor, ...result.actorPatch };
}
