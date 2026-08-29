import { z } from "zod";
import { RuntimeTopologyProvenanceSchema } from "@simforge-oss/maps/topology";

export const SEMANTIC_ACTOR_AUTHORING_SCHEMA_VERSION =
  "simforge.semantic-actor-authoring.v1" as const;
export const SEMANTIC_RUNTIME_BINDING_COMPILER_VERSION_V1 =
  "semantic-runtime-binding.v1" as const;
export const SEMANTIC_RUNTIME_BINDING_COMPILER_VERSION =
  "semantic-runtime-binding.v2" as const;

export const SemanticLaneRoleSchema = z.enum([
  "single",
  "leftmost",
  "inner",
  "rightmost",
  "unknown",
]);
export type SemanticLaneRole = z.infer<typeof SemanticLaneRoleSchema>;

const SemanticIntentIdentitySchema = z.object({
  graphRevision: z.string().trim().min(1),
  laneRole: SemanticLaneRoleSchema,
});

export const SemanticCorridorStationIntentSchema =
  SemanticIntentIdentitySchema.extend({
    kind: z.literal("corridor_station"),
    corridorId: z.string().trim().min(1),
    stationM: z.number().finite().nonnegative(),
  }).strict();

export const SemanticCorridorRouteIntentSchema =
  SemanticIntentIdentitySchema.extend({
    kind: z.literal("corridor_route"),
    corridorIds: z.array(z.string().trim().min(1)).min(1),
    startStationM: z.number().finite().nonnegative(),
    endStationM: z.number().finite().nonnegative(),
  }).strict();

export const SemanticMovementTrajectoryIntentSchema =
  SemanticIntentIdentitySchema.extend({
    kind: z.literal("movement_trajectory"),
    movementId: z.string().trim().min(1),
    variantId: z.string().trim().min(1).optional(),
  }).strict();

export const SemanticActorIntentSchema = z.discriminatedUnion("kind", [
  SemanticCorridorStationIntentSchema,
  SemanticCorridorRouteIntentSchema,
  SemanticMovementTrajectoryIntentSchema,
]);
export type SemanticActorIntent = z.infer<typeof SemanticActorIntentSchema>;

export const SemanticRuntimeBindingCompilationSchema = z
  .object({
    status: z.literal("exact"),
    graphRevision: z.string().trim().min(1),
    semanticCompilerVersion: z.string().trim().min(1),
    bindingCompilerVersion: z.enum([
      SEMANTIC_RUNTIME_BINDING_COMPILER_VERSION_V1,
      SEMANTIC_RUNTIME_BINDING_COMPILER_VERSION,
    ]),
    runtimeProvenance: RuntimeTopologyProvenanceSchema,
    outputHash: z.string().regex(/^sha256:[a-f0-9]{64}$/),
    runtimeLaneRsls: z.array(z.string().trim().min(1)).min(1),
    runtimeGateIds: z.array(z.string().trim().min(1)),
  })
  .strict();
export type SemanticRuntimeBindingCompilation = z.infer<
  typeof SemanticRuntimeBindingCompilationSchema
>;

export const SemanticActorAuthoringSchema = z
  .object({
    schemaVersion: z.literal(SEMANTIC_ACTOR_AUTHORING_SCHEMA_VERSION),
    intent: SemanticActorIntentSchema,
    compilation: SemanticRuntimeBindingCompilationSchema,
  })
  .strict()
  .superRefine((value, context) => {
    if (value.intent.graphRevision !== value.compilation.graphRevision) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["compilation", "graphRevision"],
        message: "Compilation graph revision must match semantic intent.",
      });
    }
  });
export type SemanticActorAuthoring = z.infer<
  typeof SemanticActorAuthoringSchema
>;

export type SemanticExecutableActorProjection = {
  placement_mode: unknown | null;
  spawn: unknown;
  spawn_point: unknown | null;
  spawn_yaw: unknown | null;
  route: unknown[];
  destination: unknown | null;
  timed_waypoints: unknown[];
  path_placement: unknown[];
  route_direction: unknown | null;
  autopilot: unknown | null;
  is_static: unknown | null;
};

/**
 * The concrete actor fields are the only runtime authority. This projection is
 * deliberately small and always contains the same keys so web and worker can
 * prove that the persisted semantic intent still describes those exact fields.
 */
export function semanticExecutableActorProjection(
  actor: Record<string, unknown>,
): SemanticExecutableActorProjection {
  return {
    placement_mode: actor.placement_mode ?? null,
    spawn: actor.spawn ?? null,
    spawn_point: actor.spawn_point ?? null,
    spawn_yaw: actor.spawn_yaw ?? null,
    route: Array.isArray(actor.route) ? actor.route : [],
    destination: actor.destination ?? null,
    timed_waypoints: Array.isArray(actor.timed_waypoints)
      ? actor.timed_waypoints
      : [],
    path_placement: Array.isArray(actor.path_placement)
      ? actor.path_placement
      : [],
    route_direction: actor.route_direction ?? null,
    autopilot: actor.autopilot ?? null,
    is_static: actor.is_static ?? null,
  };
}

/** v2 proof canonicalization. Runtime geometry survives database and JSON
 * round-trips at micrometer precision; smaller IEEE-754 representation drift
 * must not invalidate an otherwise byte-for-byte semantic execution proof. */
export function quantizeSemanticExecutableProof(value: unknown): unknown {
  if (typeof value === "number") {
    if (!Number.isFinite(value)) return null;
    const quantized = Number(value.toFixed(6));
    return Object.is(quantized, -0) ? 0 : quantized;
  }
  if (Array.isArray(value)) {
    return value.map(quantizeSemanticExecutableProof);
  }
  if (isRecord(value)) {
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [
        key,
        quantizeSemanticExecutableProof(entry),
      ]),
    );
  }
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

/** Stable JSON shared by the TS compiler and the Python worker verifier. */
export function stableSemanticBindingJson(value: unknown): string {
  if (value === null) return "null";
  if (typeof value === "number") {
    if (!Number.isFinite(value)) return "null";
    return JSON.stringify(Object.is(value, -0) ? 0 : value);
  }
  if (typeof value === "string" || typeof value === "boolean") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((entry) => stableSemanticBindingJson(entry)).join(",")}]`;
  }
  if (isRecord(value)) {
    const entries = Object.keys(value)
      .filter((key) => value[key] !== undefined)
      .sort()
      .map(
        (key) =>
          `${JSON.stringify(key)}:${stableSemanticBindingJson(value[key])}`,
      );
    return `{${entries.join(",")}}`;
  }
  return "null";
}
