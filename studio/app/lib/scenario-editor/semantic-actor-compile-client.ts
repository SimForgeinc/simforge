"use client";

import {
  z } from "zod";
import {
  ScenarioEditorRoadAnchorSchema,
  SemanticActorAuthoringSchema,
  SemanticActorIntentSchema,
  type ScenarioEditorActorDraft,
  type SemanticActorIntent,
  type SemanticLaneRole,
} from "@simforge-oss/studio-shared";
import {
  type RuntimeTopologyFamily,
} from "@simforge-oss/maps/topology";
import type { SemanticFeatureSelection } from "@/app/lib/editor-map/semantic-overlay";

// Typed client for POST /api/map-assets/:mapAssetId/semantic-bindings/compile.
// Every response body is structurally validated before it can reach editor
// state, and an actor patch exists ONLY on the `exact` outcome — ambiguous,
// stale, unbound, and transport failures can never leak a partial patch.
// Intents carry server-issued semantic ids verbatim; nothing here fabricates
// runtime road/section/lane identifiers from geometry.

export const SemanticBindingSuggestionSchema = z.object({
  entityId: z.string().min(1),
  reason: z.string(),
  confidence: z.number(),
  /** Server-issued intent; resubmit verbatim to confirm this suggestion. */
  intent: SemanticActorIntentSchema,
  runtimeLaneRsls: z.array(z.string()),
  runtimeGateIds: z.array(z.string()),
});
export type SemanticBindingSuggestion = z.infer<
  typeof SemanticBindingSuggestionSchema
>;

/** The compile endpoint always emits these exact keys and nothing else. */
const SemanticActorExactPatchSchema = z
  .object({
    placement_mode: z.literal("road"),
    spawn: ScenarioEditorRoadAnchorSchema,
    route: z.array(ScenarioEditorRoadAnchorSchema),
    destination: ScenarioEditorRoadAnchorSchema.nullable(),
    // The binding compiler never emits timed waypoints for a semantic patch.
    timed_waypoints: z.array(z.unknown()).max(0),
    semantic_authoring: SemanticActorAuthoringSchema,
  })
  .strict();

export type SemanticActorExactPatch = Pick<
  ScenarioEditorActorDraft,
  | "placement_mode"
  | "spawn"
  | "route"
  | "destination"
  | "timed_waypoints"
  | "semantic_authoring"
>;

const OUTPUT_HASH_PATTERN = /^sha256:[a-f0-9]{64}$/;

const ExactCompileResponseSchema = z.object({
  status: z.literal("exact"),
  actorPatch: SemanticActorExactPatchSchema,
  outputHash: z.string().regex(OUTPUT_HASH_PATTERN),
  suggestions: z.array(z.unknown()).max(0),
});

const FailureCompileResponseSchema = z.object({
  status: z.enum(["ambiguous", "stale", "unbound"]),
  code: z.enum([
    "SEMANTIC_GRAPH_STALE",
    "SEMANTIC_ENTITY_UNBOUND",
    "SEMANTIC_SELECTION_AMBIGUOUS",
  ]),
  message: z.string().min(1),
  suggestions: z.array(SemanticBindingSuggestionSchema),
});

export type SemanticActorCompileOutcome =
  | {
      kind: "exact";
      actorPatch: SemanticActorExactPatch;
      outputHash: string;
    }
  | {
      kind: "ambiguous";
      message: string;
      suggestions: SemanticBindingSuggestion[];
    }
  | { kind: "stale"; message: string; suggestions: SemanticBindingSuggestion[] }
  | { kind: "unbound"; message: string }
  | { kind: "http_error"; httpStatus: number; message: string }
  | { kind: "schema_error"; message: string }
  | { kind: "network_error"; message: string }
  | { kind: "aborted" };

export type SemanticActorCompileRequest = {
  mapAssetId: string;
  runtime: RuntimeTopologyFamily;
  /** The complete live actor draft the compiled patch will describe. */
  actor: ScenarioEditorActorDraft;
  intent: SemanticActorIntent;
};

function errorMessage(body: unknown, fallback: string): string {
  const record =
    body && typeof body === "object" ? (body as Record<string, unknown>) : {};
  return typeof record.error === "string" && record.error.trim()
    ? record.error
    : fallback;
}

const SCHEMA_ERROR: SemanticActorCompileOutcome = {
  kind: "schema_error",
  message: "The semantic compile response failed schema validation.",
};

/**
 * Submit one compile request and classify the outcome. The server returns 200
 * only for `exact` and 409 for typed ambiguous/stale/unbound results; every
 * other HTTP status (auth, missing map, unavailable graph) is an `http_error`.
 */
export async function requestSemanticActorCompile(
  request: SemanticActorCompileRequest,
  signal?: AbortSignal,
): Promise<SemanticActorCompileOutcome> {
  let response: Response;
  let body: unknown = null;
  try {
    response = await fetch(
      `/api/map-assets/${encodeURIComponent(request.mapAssetId)}/semantic-bindings/compile`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          runtime: request.runtime,
          actor: request.actor,
          intent: request.intent,
        }),
        ...(signal ? { signal } : {}),
      },
    );
    body = await response.json().catch(() => null);
  } catch {
    if (signal?.aborted) return { kind: "aborted" };
    return {
      kind: "network_error",
      message: "The semantic compile request failed to reach the server.",
    };
  }
  if (signal?.aborted) return { kind: "aborted" };
  if (response.status === 200) {
    const parsed = ExactCompileResponseSchema.safeParse(body);
    if (!parsed.success) return SCHEMA_ERROR;
    return {
      kind: "exact",
      actorPatch: { ...parsed.data.actorPatch, timed_waypoints: [] },
      outputHash: parsed.data.outputHash,
    };
  }
  if (response.status === 409) {
    const parsed = FailureCompileResponseSchema.safeParse(body);
    if (!parsed.success) return SCHEMA_ERROR;
    if (parsed.data.status === "ambiguous") {
      return {
        kind: "ambiguous",
        message: parsed.data.message,
        suggestions: parsed.data.suggestions,
      };
    }
    if (parsed.data.status === "stale") {
      return {
        kind: "stale",
        message: parsed.data.message,
        suggestions: parsed.data.suggestions,
      };
    }
    return { kind: "unbound", message: parsed.data.message };
  }
  return {
    kind: "http_error",
    httpStatus: response.status,
    message: errorMessage(
      body,
      `The semantic compile request failed (HTTP ${response.status}).`,
    ),
  };
}

export type SemanticActorCompileRequester = {
  /** Submit a compile; any prior in-flight request is aborted (latest wins). */
  compile: (
    request: SemanticActorCompileRequest,
  ) => Promise<SemanticActorCompileOutcome>;
  /** Abort the in-flight request, if any. */
  cancel: () => void;
};

/**
 * Latest-wins request funnel: overlapping compiles abort the older request so
 * a stale response can never land after a newer submission (or after cancel).
 */
export function createSemanticActorCompileRequester(): SemanticActorCompileRequester {
  let current: AbortController | null = null;
  return {
    async compile(request) {
      current?.abort();
      const own = new AbortController();
      current = own;
      const outcome = await requestSemanticActorCompile(request, own.signal);
      // A newer compile or a cancel superseded this request while in flight.
      if (current !== own || own.signal.aborted) return { kind: "aborted" };
      return outcome;
    },
    cancel() {
      current?.abort();
      current = null;
    },
  };
}

/**
 * Build a corridor-station intent from a semantic corridor hit. The station
 * comes from the selection (exact server corridor length × nearest-point
 * fraction); a selection without a server-derived station cannot author.
 */
export function corridorStationIntentFromSelection(
  selection: SemanticFeatureSelection,
  graphRevision: string,
  laneRole: SemanticLaneRole = "unknown",
): Extract<SemanticActorIntent, { kind: "corridor_station" }> | null {
  if (selection.kind !== "corridor") return null;
  if (
    selection.stationM == null ||
    !Number.isFinite(selection.stationM) ||
    selection.stationM < 0
  ) {
    return null;
  }
  return {
    kind: "corridor_station",
    graphRevision,
    corridorId: selection.id,
    stationM: selection.stationM,
    laneRole,
  };
}

/**
 * Build a movement-trajectory intent from a semantic movement hit, carrying
 * the exact variant polyline that was hit when the map reported one.
 */
export function movementTrajectoryIntentFromSelection(
  selection: SemanticFeatureSelection,
  graphRevision: string,
  laneRole: SemanticLaneRole = "unknown",
): Extract<SemanticActorIntent, { kind: "movement_trajectory" }> | null {
  if (selection.kind !== "movement") return null;
  return {
    kind: "movement_trajectory",
    graphRevision,
    movementId: selection.id,
    ...(selection.variantId ? { variantId: selection.variantId } : {}),
    laneRole,
  };
}
