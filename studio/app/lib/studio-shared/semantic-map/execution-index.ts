import { z } from "zod";
import { RuntimeTopologyProvenanceSchema, TurnRelationSchema } from "@simforge-oss/maps/topology";
import { SemanticMapAuthoringStatusSchema, SemanticMapGraphSchema, type SemanticMapGraph } from "./types";

export const SEMANTIC_EXECUTION_INDEX_SCHEMA_VERSION = "simforge.semantic-execution-index.v1" as const;
export const LEGACY_SEMANTIC_EXECUTION_INDEX_COMPILER_VERSION = "semantic-execution-index.compiler.v1" as const;
export const SEMANTIC_EXECUTION_INDEX_COMPILER_VERSION = "semantic-execution-index.compiler.v2" as const;

export type SemanticExecutionRuntimeControls = {
  trafficLights?: Array<{
    actor_id?: number | null;
    opendrive_id?: string | number | null;
    affected_lane_waypoints?: Array<{ rsl?: string | null }>;
    stop_waypoints?: Array<{ rsl?: string | null }>;
  }>;
  landmarks?: Array<{
    id?: string | number | null;
    name?: string | null;
    type?: string | null;
    sub_type?: string | null;
    text?: string | null;
    waypoint?: { rsl?: string | null } | null;
  }>;
};

const RuntimeFragmentSchema = z.object({
  rsl: z.string().trim().min(1),
  startArcM: z.number().nonnegative(),
  endArcM: z.number().nonnegative(),
});

const PermissionIntervalSchema = z.object({
  startM: z.number().nonnegative(),
  endM: z.number().nonnegative(),
  allowed: z.boolean(),
  marking: z.string().nullable(),
  source: z.enum(["xodr_lane_link", "derived_same_section", "unknown"]),
});

export const SemanticExecutionIndexSchema = z.object({
  schemaVersion: z.literal(SEMANTIC_EXECUTION_INDEX_SCHEMA_VERSION),
  compilerVersion: z.enum([
    LEGACY_SEMANTIC_EXECUTION_INDEX_COMPILER_VERSION,
    SEMANTIC_EXECUTION_INDEX_COMPILER_VERSION,
  ]),
  indexRevision: z.string().trim().min(1),
  semanticMapGraphRevision: z.string().trim().min(1),
  runtimeProvenance: RuntimeTopologyProvenanceSchema,
  corridors: z.array(z.object({
    id: z.string().trim().min(1),
    authoringStatus: SemanticMapAuthoringStatusSchema,
    laneRole: z.enum(["single", "leftmost", "inner", "rightmost", "unknown"]),
    lengthM: z.number().nonnegative(),
    runtimeFragments: z.array(RuntimeFragmentSchema).min(1),
    predecessorCorridorIds: z.array(z.string()),
    successorCorridorIds: z.array(z.string()),
    junctionExclusionIntervals: z.array(z.object({
      startM: z.number().nonnegative(),
      endM: z.number().nonnegative(),
    })),
    lateralAdjacencies: z.array(z.object({
      side: z.enum(["left", "right"]),
      targetCorridorId: z.string().trim().min(1),
      sameDirection: z.boolean(),
      permissionIntervals: z.array(PermissionIntervalSchema),
    })),
  })),
  movements: z.array(z.object({
    id: z.string().trim().min(1),
    authoringStatus: SemanticMapAuthoringStatusSchema,
    turnRelation: TurnRelationSchema,
    incomingCorridorIds: z.array(z.string()).min(1),
    representativeVariantId: z.string().trim().min(1),
    variants: z.array(z.object({
      id: z.string().trim().min(1),
      gateId: z.string().trim().min(1),
      incomingCorridorId: z.string().trim().min(1),
      outgoingCorridorId: z.string().trim().min(1),
      runtimeLaneRsls: z.array(z.string().trim().min(1)).min(3),
      authoringStatus: SemanticMapAuthoringStatusSchema,
    })).min(1),
  })),
  controlBindings: z.array(z.object({
    semanticId: z.string().trim().min(1),
    runtimeIds: z.array(z.string().trim().min(1)).min(1),
    laneRsls: z.array(z.string().trim().min(1)).default([]),
    kind: z.enum(["traffic_light", "stop_sign", "yield_sign"]),
  })),
}).strict();

export type SemanticExecutionIndex = z.infer<typeof SemanticExecutionIndexSchema>;

function junctionExclusions(corridor: SemanticMapGraph["corridors"][number]) {
  const intervals: Array<{ startM: number; endM: number }> = [];
  const guardM = Math.min(10, corridor.lengthM);
  if (corridor.start.kind === "junction") {
    intervals.push({ startM: 0, endM: guardM });
  }
  if (corridor.end.kind === "junction") {
    intervals.push({
      startM: Math.max(0, corridor.lengthM - guardM),
      endM: corridor.lengthM,
    });
  }
  return intervals;
}

type ControlBinding = SemanticExecutionIndex["controlBindings"][number];

function clean(value: unknown): string | null {
  if (typeof value !== "string" && typeof value !== "number") return null;
  const result = String(value).trim();
  return result.length > 0 ? result : null;
}

function laneRsls(waypoints: Array<{ rsl?: string | null }> | undefined): string[] {
  return [
    ...new Set((waypoints ?? []).map((row) => clean(row.rsl)).filter((value): value is string => value != null)),
  ].sort();
}

function landmarkKind(
  landmark: NonNullable<SemanticExecutionRuntimeControls["landmarks"]>[number],
): ControlBinding["kind"] | null {
  const type = clean(landmark.type)?.toLowerCase() ?? "";
  const blob = [landmark.name, landmark.sub_type, landmark.text]
    .map((value) => clean(value)?.toLowerCase() ?? "")
    .join(" ");
  if (
    type === "206" ||
    type === "1000001" ||
    /(?:^|[^a-z0-9])r1[-_ ]?1(?:[^a-z0-9]|$)/.test(blob) ||
    /stop[ _-]?(?:sign|line)/.test(blob)
  )
    return "stop_sign";
  if (type === "205" || /(?:^|[^a-z0-9])r1[-_ ]?2(?:[^a-z0-9]|$)/.test(blob) || /yield/.test(blob)) return "yield_sign";
  return null;
}

function mergeControlBindings(bindings: ControlBinding[]): ControlBinding[] {
  const merged = new Map<string, ControlBinding>();
  for (const binding of bindings) {
    const key = `${binding.kind}:${binding.semanticId}`;
    const existing = merged.get(key);
    merged.set(
      key,
      existing
        ? {
            ...existing,
            runtimeIds: [...new Set([...existing.runtimeIds, ...binding.runtimeIds])].sort(),
            laneRsls: [...new Set([...existing.laneRsls, ...binding.laneRsls])].sort(),
          }
        : {
            ...binding,
            runtimeIds: [...new Set(binding.runtimeIds)].sort(),
            laneRsls: [...new Set(binding.laneRsls)].sort(),
          },
    );
  }
  return [...merged.values()].sort(
    (left, right) => left.kind.localeCompare(right.kind) || left.semanticId.localeCompare(right.semanticId),
  );
}

function buildControlBindings(controls: SemanticExecutionRuntimeControls | undefined): ControlBinding[] {
  const bindings: ControlBinding[] = [];
  for (const light of controls?.trafficLights ?? []) {
    const openDriveId = clean(light.opendrive_id);
    const actorId = clean(light.actor_id);
    if (!openDriveId && !actorId) continue;
    bindings.push({
      semanticId: `control:traffic_light:${openDriveId ? `opendrive:${openDriveId}` : `actor:${actorId}`}`,
      runtimeIds: [...(openDriveId ? [`opendrive:${openDriveId}`] : []), ...(actorId ? [`actor:${actorId}`] : [])],
      laneRsls: [...new Set([...laneRsls(light.affected_lane_waypoints), ...laneRsls(light.stop_waypoints)])].sort(),
      kind: "traffic_light",
    });
  }
  for (const landmark of controls?.landmarks ?? []) {
    const kind = landmarkKind(landmark);
    const id = clean(landmark.id);
    if (!kind || !id) continue;
    const rsl = clean(landmark.waypoint?.rsl);
    bindings.push({
      semanticId: `control:${kind}:landmark:${id}`,
      runtimeIds: [`landmark:${id}`],
      laneRsls: rsl ? [rsl] : [],
      kind,
    });
  }
  return mergeControlBindings(bindings);
}

function controlFingerprint(bindings: ControlBinding[]): string {
  // A deterministic content discriminator; publication artifacts retain SHA-256
  // descriptors, while this keeps the shared compiler browser-safe.
  const input = JSON.stringify(bindings);
  let hash = 0x811c9dc5;
  for (let index = 0; index < input.length; index += 1) {
    hash ^= input.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

export function buildSemanticExecutionIndex(
  rawGraph: SemanticMapGraph,
  runtimeControls?: SemanticExecutionRuntimeControls,
): SemanticExecutionIndex {
  const graph = SemanticMapGraphSchema.parse(rawGraph);
  const controlBindings = buildControlBindings(runtimeControls);
  const laneRoleByCorridor = new Map<string, SemanticExecutionIndex["corridors"][number]["laneRole"]>();
  for (const approach of graph.approaches) {
    for (const slot of approach.laneSlots) {
      const existing = laneRoleByCorridor.get(slot.corridorId);
      laneRoleByCorridor.set(
        slot.corridorId,
        existing && existing !== slot.role ? "unknown" : slot.role,
      );
    }
  }
  const variantsByMovement = new Map<string, typeof graph.movementVariants>();
  for (const variant of graph.movementVariants) {
    variantsByMovement.set(variant.movementId, [
      ...(variantsByMovement.get(variant.movementId) ?? []),
      variant,
    ]);
  }
  return SemanticExecutionIndexSchema.parse({
    schemaVersion: SEMANTIC_EXECUTION_INDEX_SCHEMA_VERSION,
    compilerVersion: SEMANTIC_EXECUTION_INDEX_COMPILER_VERSION,
    indexRevision: `${SEMANTIC_EXECUTION_INDEX_COMPILER_VERSION}:${graph.graphRevision}:controls:${controlFingerprint(controlBindings)}`,
    semanticMapGraphRevision: graph.graphRevision,
    runtimeProvenance: graph.source.runtimeProvenance,
    corridors: [...graph.corridors]
      .sort((left, right) => left.id.localeCompare(right.id))
      .map((corridor) => ({
        id: corridor.id,
        authoringStatus: corridor.authoringStatus,
        laneRole: laneRoleByCorridor.get(corridor.id) ?? "unknown",
        lengthM: corridor.lengthM,
        runtimeFragments: corridor.runtimeFragments,
        predecessorCorridorIds: corridor.predecessorCorridorIds,
        successorCorridorIds: corridor.successorCorridorIds,
        junctionExclusionIntervals: junctionExclusions(corridor),
        lateralAdjacencies: corridor.lateralAdjacencies,
      })),
    movements: [...graph.movements]
      .sort((left, right) => left.id.localeCompare(right.id))
      .map((movement) => {
        const variants = (variantsByMovement.get(movement.id) ?? [])
          .sort((left, right) => left.id.localeCompare(right.id));
        return {
          id: movement.id,
          authoringStatus: movement.authoringStatus,
          turnRelation: movement.turnRelation,
          incomingCorridorIds: [...new Set(variants.map((row) => row.incomingCorridorId))].sort(),
          representativeVariantId: movement.representativeVariantId,
          variants: variants.map((variant) => ({
            id: variant.id,
            gateId: variant.gateId,
            incomingCorridorId: variant.incomingCorridorId,
            outgoingCorridorId: variant.outgoingCorridorId,
            runtimeLaneRsls: variant.runtimeLaneRsls,
            authoringStatus: variant.authoringStatus,
          })),
        };
      }),
    controlBindings,
  });
}
