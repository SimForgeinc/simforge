import "server-only";

import {
  SemanticActorAuthoringSchema,
  type RuntimeTopologyProvenance,
  type ScenarioEditorActorDraft,
} from "@simforge/studio-shared";
import { semanticActorOutputHash } from "./semantic-actor-binding";

export type SemanticActorIntegrityCode =
  | "invalid_actor_array"
  | "invalid_semantic_authoring"
  | "semantic_binding_hash_mismatch"
  | "semantic_binding_anchor_not_exact"
  | "semantic_binding_lane_mismatch"
  | "semantic_authoring_removed"
  | "semantic_runtime_identity_conflict"
  | "semantic_runtime_identity_mismatch";

export class SemanticActorIntegrityError extends Error {
  constructor(
    readonly code: SemanticActorIntegrityCode,
    message: string,
    readonly details: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = "SemanticActorIntegrityError";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function own(record: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(record, key);
}

function explicitActorValue(rawDraft: unknown): {
  present: boolean;
  value: unknown;
} {
  const raw = isRecord(rawDraft) ? rawDraft : {};
  const actorValues: unknown[] = [];
  if (own(raw, "actors")) actorValues.push(raw.actors);
  const setup = isRecord(raw.setup) ? raw.setup : raw;
  const scene = isRecord(setup.scene) ? setup.scene : null;
  if (scene && own(scene, "actors")) {
    actorValues.push(scene.actors);
  }
  if (actorValues.length > 1) {
    throw new SemanticActorIntegrityError(
      "invalid_actor_array",
      "A scenario draft must contain exactly one canonical actor array.",
    );
  }
  return actorValues.length === 1
    ? { present: true, value: actorValues[0] }
    : { present: false, value: undefined };
}

function anchorRsl(value: unknown): string | null {
  if (!isRecord(value)) return null;
  const roadId = value.road_id;
  const sectionId = value.section_id;
  const laneId = value.lane_id;
  if (
    (typeof roadId !== "string" && typeof roadId !== "number") ||
    !Number.isInteger(sectionId) ||
    !Number.isInteger(laneId)
  ) {
    return null;
  }
  return `${String(roadId)}:${String(sectionId)}:${String(laneId)}`;
}

function executableAnchors(actor: Record<string, unknown>): unknown[] {
  return [
    actor.spawn,
    ...(Array.isArray(actor.route) ? actor.route : []),
    ...(actor.destination == null ? [] : [actor.destination]),
  ];
}

export function assertSemanticActorBindings(
  actors: readonly unknown[],
  expected: {
    mapAssetId?: string | null;
    runtimeMapName?: string | null;
  } = {},
): RuntimeTopologyProvenance | null {
  let provenance: RuntimeTopologyProvenance | null = null;
  for (const rawActor of actors) {
    if (!isRecord(rawActor) || rawActor.semantic_authoring == null) continue;
    const parsed = SemanticActorAuthoringSchema.safeParse(
      rawActor.semantic_authoring,
    );
    const actorId = typeof rawActor.id === "string" ? rawActor.id : null;
    if (!parsed.success) {
      throw new SemanticActorIntegrityError(
        "invalid_semantic_authoring",
        "Semantic actor authoring metadata is malformed.",
        { actorId, issues: parsed.error.flatten() },
      );
    }
    const semantic = parsed.data;
    const actualHash = semanticActorOutputHash(
      rawActor,
      semantic.compilation.bindingCompilerVersion,
    );
    if (actualHash !== semantic.compilation.outputHash) {
      throw new SemanticActorIntegrityError(
        "semantic_binding_hash_mismatch",
        "Semantic actor runtime fields changed without recompiling the semantic selection.",
        {
          actorId,
          expectedOutputHash: semantic.compilation.outputHash,
          actualOutputHash: actualHash,
        },
      );
    }
    const laneSet = new Set(semantic.compilation.runtimeLaneRsls);
    for (const anchor of executableAnchors(rawActor)) {
      if (!isRecord(anchor) || anchor.resolution_mode !== "runtime_exact") {
        throw new SemanticActorIntegrityError(
          "semantic_binding_anchor_not_exact",
          "Every semantic actor road anchor must use runtime-exact resolution.",
          { actorId },
        );
      }
      const rsl = anchorRsl(anchor);
      if (!rsl || !laneSet.has(rsl)) {
        throw new SemanticActorIntegrityError(
          "semantic_binding_lane_mismatch",
          "A semantic actor road anchor is missing from its compiled runtime lane proof.",
          { actorId, rsl },
        );
      }
    }
    const candidate = semantic.compilation.runtimeProvenance;
    if (
      provenance &&
      JSON.stringify(provenance) !== JSON.stringify(candidate)
    ) {
      throw new SemanticActorIntegrityError(
        "semantic_runtime_identity_conflict",
        "Semantic actors reference more than one runtime map revision.",
        { actorId },
      );
    }
    provenance = candidate;
  }
  if (
    provenance &&
    expected.mapAssetId &&
    provenance.mapAssetId !== expected.mapAssetId
  ) {
    throw new SemanticActorIntegrityError(
      "semantic_runtime_identity_mismatch",
      "Semantic actors were compiled for a different map asset and must be revalidated.",
      {
        expectedMapAssetId: expected.mapAssetId,
        compiledMapAssetId: provenance.mapAssetId,
      },
    );
  }
  if (
    provenance &&
    expected.runtimeMapName &&
    provenance.runtimeMapName !== expected.runtimeMapName
  ) {
    throw new SemanticActorIntegrityError(
      "semantic_runtime_identity_mismatch",
      "Semantic actors were compiled for a different runtime map and must be revalidated.",
      {
        expectedRuntimeMapName: expected.runtimeMapName,
        compiledRuntimeMapName: provenance.runtimeMapName,
      },
    );
  }
  return provenance;
}

export function assertExplicitScenarioActorsValid(input: {
  rawDraft: unknown;
  previousActors?: readonly ScenarioEditorActorDraft[];
}): readonly unknown[] | null {
  const explicit = explicitActorValue(input.rawDraft);
  if (!explicit.present) return null;
  if (!Array.isArray(explicit.value)) {
    throw new SemanticActorIntegrityError(
      "invalid_actor_array",
      "Scenario actors must be an array.",
    );
  }
  // This guard owns semantic-proof integrity only. The normal draft
  // normalization path remains authoritative for validating legacy actor
  // shapes, some of which are intentionally accepted during compatibility
  // migrations before they are normalized to the current actor schema.
  const nextById = new Map(
    explicit.value.flatMap((actor) =>
      isRecord(actor) && typeof actor.id === "string"
        ? [[actor.id, actor] as const]
        : [],
    ),
  );
  for (const previous of input.previousActors ?? []) {
    if (!previous.semantic_authoring) continue;
    const next = nextById.get(previous.id);
    if (next && !next.semantic_authoring) {
      throw new SemanticActorIntegrityError(
        "semantic_authoring_removed",
        "Semantic authoring metadata cannot be removed from a surviving actor; delete the actor or recompile it.",
        { actorId: previous.id },
      );
    }
  }
  assertSemanticActorBindings(explicit.value);
  return explicit.value;
}
