/**
 * Zod schemas and inferred types for the LLM map-search service.
 *
 * Extracted from map-search-llm-service.ts. The service re-exports
 * everything via `export * from` so callers that previously imported
 * directly from the service continue to work unchanged.
 */
import { z } from "zod";
import { COLLISION_FAMILY_IDS } from "@simforge/studio-shared";
import type { CollisionFamilyId } from "@simforge/studio-shared";
import type { RelatedObjectRef, SearchFilterChip } from "@/app/lib/maps/search/map-search";
import type { GeometryReport } from "@/app/lib/maps/search/server/inspect-location-geometry";
import type { PlannerTrace } from "@/app/lib/llm/scenario-generation/planner/planner-trace";
import aliasSpec from "@/app/lib/maps/search/map-search-aliases.json";

/** Max search_map results we surface back to the LLM per call. */
export const SEARCH_MAP_DEFAULT_LIMIT = 20;
export const SEARCH_MAP_HARD_LIMIT = 50;

/**
 * Catalog of valid `semantic` ids for the structured tool path. Loaded
 * from `map-search-aliases.json` at module init so the prompt and the
 * Zod validator stay in sync — no risk of the model picking an id that
 * doesn't exist or vice-versa.
 */
export const SEMANTIC_IDS: readonly string[] = (
  (aliasSpec as { semantic_terms?: Array<{ id: string }> }).semantic_terms ?? []
).map((t) => t.id);

export const SEMANTIC_ID_CATALOG = SEMANTIC_IDS.join(", ");

// ── Subject / relation schemas ───────────────────────────────────────────────

const StructuredObjectIntentSchema = z.object({
  featureId: z
    .string()
    .optional()
    .describe(
      "Exact map-element id (verbatim from a confirmed candidate card, a prior search_map result, or inspect_location_geometry — e.g. 'junction:1045'). When set, THIS side resolves to exactly that feature and `families`/`semantic`/`freeText` here are ignored. ALWAYS use this once an exact feature has been identified — never fall back to ambiguous street-name `freeText` to re-describe a junction/street/POI you already have the id for (e.g. streets leading into a confirmed junction: `relation: { op: 'upstream_of', object: { featureId: '<that junction id>' } }`).",
    ),
  families: z
    .array(z.enum(["junction", "street", "poi", "address"]))
    .optional()
    .describe(
      "Object families. 'junction' = intersections; 'street' = road segments; 'poi' = points of interest (schools, parking lots, bus stops, etc.); 'address' = postal addresses (use this when the user types or asks about a street number). Usually empty when `semantic` is specific.",
    ),
  semantic: z
    .array(z.string())
    .optional()
    .describe(
      `Semantic group ids from the map vocabulary. Members of one intent are AND'd. Valid ids: ${SEMANTIC_ID_CATALOG}. Unknown ids are ignored with a parse hint.`,
    ),
  freeText: z
    .array(z.string())
    .optional()
    .describe(
      "Residual tokens to fold into match scoring. Use sparingly — prefer `semantic` ids when an alias exists.",
    ),
});

export const StructuredSearchInputSchema = z.object({
  subject: StructuredObjectIntentSchema.describe(
    "The thing the user wants to find (the left side of a relation, or the whole query when there's no relation).",
  ),
  relation: z
    .object({
      op: z
        .enum([
          "near",
          "adjacent_to",
          "within",
          "leads_to",
          "connected_to",
          "upstream_of",
          "downstream_of",
        ])
        .describe(
          "Spatial relation between subject and object. `within` requires `distance_m`; the rest accept an optional `distance_m` override.",
        ),
      distance_m: z
        .number()
        .positive()
        .optional()
        .describe(
          "Distance in meters. Required when `op` = 'within'; optional override for the others (defaults: near ~50m, adjacent_to ~10m).",
        ),
      object: StructuredObjectIntentSchema.describe(
        "The thing the subject is in relation to.",
      ),
    })
    .optional()
    .describe(
      "Spatial relation. Omit when the user's request is a single subject with no spatial constraint (e.g. 'find a roundabout').",
    ),
});

export const SearchMapToolArgsSchema = z.object({
  structured: StructuredSearchInputSchema.describe(
    "Pre-decomposed structured query. The only input shape — there is no free-text fallback. You're responsible for the natural-language understanding (synonym expansion, polite-framing strip, intent detection); compose the resulting subject + optional relation here and the executor handles the rest.",
  ),
  limit: z
    .number()
    .int()
    .positive()
    .max(SEARCH_MAP_HARD_LIMIT)
    .optional()
    .describe(`Max results (default ${SEARCH_MAP_DEFAULT_LIMIT}).`),
});

export type SearchMapToolInput = z.infer<typeof SearchMapToolArgsSchema>;

export interface SearchMapToolResultEntry {
  id: string;
  family: string;
  subtype: string;
  title: string;
  description: string;
  facts: string[];
  scenarioTags: string[];
  matchReasons: string[];
  /**
   * Spatial neighbors that satisfied the relation operator. The full
   * `RelatedObjectRef` shape is preserved (not projected) so the server can
   * attach these directly to the final candidate when the LLM picks the
   * subject id — the candidate then carries the relation as metadata,
   * exactly the way keyword-search results do.
   */
  relatedObjectRefs?: RelatedObjectRef[];
}

export interface SearchMapToolResult {
  query: string;
  totalDocuments: number;
  chips: Array<Pick<SearchFilterChip, "id" | "label" | "kind" | "operatorLabel" | "objectLabel">>;
  results: SearchMapToolResultEntry[];
  freeText: string[];
  parseHints?: Array<{ code: string; message: string }>;
}

export type SearchMapToolFn = (
  input: SearchMapToolInput,
) => Promise<SearchMapToolResult>;

// ── propose_scenario_draft schemas ──────────────────────────────────────────

const COLLISION_FAMILY_ENUM = z.enum(COLLISION_FAMILY_IDS);

export const ProposeScenarioDraftToolArgsSchema = z.object({
  documentId: z
    .string()
    .min(1)
    .describe(
      "MapSearchDocument id from the catalog or a recent search_map result. Must appear verbatim in either source — invented ids are rejected.",
    ),
  family: COLLISION_FAMILY_ENUM.describe(
    `Collision family. Valid ids: ${COLLISION_FAMILY_IDS.join(", ")}. Pick the family whose promptCue best matches the user's intent.`,
  ),
  intent: z
    .string()
    .min(1)
    .max(280)
    .describe(
      "Brief natural-language description of the scenario the user wants. Used as the scenario's display name.",
    ),
  aggressivenessLabel: z
    .string()
    .max(80)
    .optional()
    .describe(
      "Optional aggressiveness for the conflicting NPC (e.g. 'Aggressive — speeds up'). When omitted, the family default is used. Used by `unprotected_left_turn` and `unsafe_cut_in`.",
    ),
  npcVehicleType: z
    .enum(["car", "bicycle", "motorcycle"])
    .optional()
    .describe(
      "Type of the conflicting NPC vehicle. Applies to `unprotected_left_turn` and `unsafe_cut_in` (the NPC is always a walker for `pedestrian_crossing`). Pick 'bicycle' when the user says cyclist / bike / cyclist cuts in / bicycle in the bike lane — the builder swaps the NPC blueprint to a CARLA bike model and drops the NPC's base speed to ~18 kph. Pick 'motorcycle' for motorbike / scooter / biker; the builder swaps to a motorcycle blueprint at ~60 kph. Default 'car'.",
    ),
  approachStreetIds: z
    .array(z.string().min(1))
    .max(4)
    .optional()
    .describe(
      "MapSearchDocument ids for streets that lead INTO `documentId` (typically found via search_map with `relation.op = 'upstream_of'` or `'leads_to'`). Each id must have a captured `inspect_location_geometry` report this turn. The builder uses these to place the ego on an approach lane with runway toward the target instead of on whatever lane happens to be euclidean-closest to the target. Pass 1–2 streets for v1; the closest one whose lane heading faces the target wins.",
    ),
});

export type ProposeScenarioDraftToolInput = z.infer<
  typeof ProposeScenarioDraftToolArgsSchema
>;

export interface ProposeScenarioDraftToolResult {
  scenarioId: string;
  datasetId: string;
  mapAssetId: string;
  documentId: string;
  candidateId: string | null;
  displayName: string;
  editorHref: string;
  family: CollisionFamilyId | null;
  actorCount: number | null;
  /** Multi-line markdown — what the LLM committed to (family, intent,
   *  aggressiveness, planner rationale, success condition). Surfaced
   *  inside the draft-created card so the user can verify the plan
   *  without opening the editor. Null on the legacy location-only path. */
  description: string | null;
  /** Inline kinematic-validation summary of the assembled draft. Lets the
   *  agent self-assess and revise within the loop, and the panel render a
   *  pass/fail badge. Null on the legacy location-only path. */
  validation: {
    verdict: "pass" | "fail";
    /** Machine-then-human fail reasons; empty on pass. */
    reasons: string[];
    repairAttempted: boolean;
    repairSucceeded: boolean;
    /** True when the verdict is fail — the agent should revise (adjust
     *  family / aggressiveness / npc vehicle / anchor) and try again. */
    needsRevision: boolean;
    /** One-line actionable hint when revision is needed. */
    revisionHint: string | null;
  } | null;
  /** Structured trace of the deterministic pedestrian-crossing topology
   *  planner, when that path produced the draft. Null otherwise. Threaded
   *  through to `LlmProposedScenarioRecord.plannerDebug` for logs /
   *  observability. */
  plannerDebug?: PlannerTrace | null;
}

/**
 * Server callable for the `propose_scenario_draft` tool. The default
 * production wiring builds this from the route's session + map-asset
 * context and delegates to `buildCollisionScenarioDraft`. Tests inject
 * their own to assert the LLM's tool input without touching the scenario
 * store.
 *
 * `documentLabel` is forwarded by the service from the resolved corpus
 * document, and `geometry` from the most recent `inspect_location_geometry`
 * call for that documentId — so the callable doesn't have to re-query
 * either the corpus or the runtime bundle.
 */
export type ProposeScenarioDraftToolFn = (input: {
  documentId: string;
  documentLabel: string;
  candidateId: string | null;
  family: CollisionFamilyId;
  intent: string;
  aggressivenessLabel: string | null;
  /** Optional NPC vehicle override (car / bicycle / motorcycle). Applies
   *  to vehicle-NPC families only — the walker recipe is unaffected. */
  npcVehicleType: "car" | "bicycle" | "motorcycle" | null;
  geometry: GeometryReport;
  /** Geometry reports for streets that lead INTO `documentId`, captured
   *  earlier this turn via `inspect_location_geometry`. Empty when the
   *  LLM didn't run the upstream-of search. */
  approachGeometries: GeometryReport[];
}) => Promise<ProposeScenarioDraftToolResult>;

// ── inspect_location_geometry schemas ───────────────────────────────────────

export const InspectLocationGeometryToolArgsSchema = z.object({
  documentId: z
    .string()
    .min(1)
    .describe(
      "MapSearchDocument id from the catalog or a recent search_map result. Must appear verbatim in either source.",
    ),
  radius_m: z
    .number()
    .positive()
    .max(250)
    .optional()
    .describe(
      "Search radius in meters for nearby drivable / sidewalk lane segments. Defaults to ~60m (covers a typical 4-leg intersection's approach roads).",
    ),
});

export type InspectLocationGeometryToolInput = z.infer<
  typeof InspectLocationGeometryToolArgsSchema
>;

/**
 * Server callable for `inspect_location_geometry`. The route wires this
 * to the production `inspectLocationGeometry` against the current map
 * asset; tests inject their own to return canned reports.
 */
export type InspectLocationGeometryToolFn = (
  input: InspectLocationGeometryToolInput,
) => Promise<GeometryReport>;

// ── respond_to_user schemas ──────────────────────────────────────────────────

export const RankedCandidateSchema = z.object({
  id: z.string().describe("Object id taken verbatim from the catalog or from a search_map result"),
  score: z
    .number()
    .min(0)
    .max(1)
    .describe("Fit score 0–1; 1 means a perfect match for the conversation so far"),
  rationale: z
    .string()
    .min(1)
    .describe(
      "One or two sentences explaining why this object fits the user's intent. When the pick comes from a search_map result, cite the spatial relation (relation + distance + related object title) reported by the engine.",
    ),
  affordances: z
    .array(z.string())
    .describe(
      "Subset of the object's scenarioTags or facts the conversation keys on. For spatial picks, include the related-object subtype (e.g. 'school', 'bus_stop'). May be empty.",
    ),
});

export const AssistantTurnSchema = z.object({
  reply: z
    .string()
    .min(1)
    .describe(
      "Conversational reply text. The UI renders this as GitHub-flavored markdown (lists, bold, italics, inline code). For multi-line messages — especially scenario-draft summaries with several attributes — insert ACTUAL line breaks in this string (press enter / emit a real newline character). Do NOT write the literal two characters backslash-n; that renders as visible \"\\n\" text, not a line break. Markdown lists require a real blank line before the first '- ' or '1. ' or they don't render as a list. Avoid putting multiple bullets on one line. Acknowledge what you're doing, explain picks briefly, or ask a clarifying question when the request is ambiguous. Do not duplicate the per-card rationale here.",
    ),
  candidates: z
    .array(RankedCandidateSchema)
    .describe(
      "Ranked highest-fit-first. Empty when the turn is a clarifying question or no entry fits.",
    ),
  followUps: z
    .array(z.string())
    .max(4)
    .describe(
      "Up to 4 short user follow-up prompts (≤ 60 chars each). Help the user narrow the conversation. Empty array is allowed.",
    ),
});

export type AssistantTurn = z.infer<typeof AssistantTurnSchema>;

// ── Runner-level type aliases ────────────────────────────────────────────────

/**
 * Runner-level callable for the `propose_scenario_draft` tool. Distinct
 * from the public `ProposeScenarioDraftToolFn` (which the route wires) —
 * the runner sees the raw LLM input shape and never resolves corpus
 * documents itself; the service wraps the route-supplied callable to
 * inject `documentLabel`, `candidateId`, and the captured `geometry`
 * report from the matching `inspect_location_geometry` call.
 */
export type LlmRunnerProposeScenarioDraftFn = (
  input: ProposeScenarioDraftToolInput,
) => Promise<ProposeScenarioDraftToolResult>;

/**
 * Runner-level callable for the `inspect_location_geometry` tool. The
 * route binds this to the production `inspectLocationGeometry` against
 * the current map asset; tests inject canned reports.
 */
export type LlmRunnerInspectLocationGeometryFn = (
  input: InspectLocationGeometryToolInput,
) => Promise<GeometryReport>;

// ── Runtime caps and predicates ──────────────────────────────────────────────

/**
 * Per-turn per-tool runtime caps. The system prompt asks the model to stay
 * within similar budgets, but a prompt-text constraint is advisory — model
 * drift or a prompt-injected user message could still emit dozens of
 * `search_map` calls in a single turn, blowing latency budgets and (for
 * the write tool) duplicating database rows. These caps are enforced
 * inside the runner: when a tool's count exceeds the cap, the call is
 * short-circuited with a `tool_call_limit_exceeded` error so the model
 * can pivot to `respond_to_user` instead of consuming the iteration
 * budget on no-ops.
 */
export const PER_TOOL_CALL_CAPS = {
  search_map: 5,
  inspect_location_geometry: 5,
  propose_scenario_draft: 3,
} as const;

/**
 * Predicate: did this `inspect_location_geometry` response give the model
 * enough to draft on? "Viable" means the same bar the prompt directs the
 * model to clear before calling `propose_scenario_draft`: the center
 * resolved AND there is at least one drivable segment in range.
 *
 * @internal Exported for unit tests.
 */
export function isViableGeometryReport(report: unknown): boolean {
  if (report == null || typeof report !== "object") return false;
  const r = report as {
    centerResolved?: unknown;
    placementHints?: { hasDrivableSegments?: unknown };
  };
  if (r.centerResolved !== true) return false;
  if (r.placementHints == null || typeof r.placementHints !== "object") return false;
  return r.placementHints.hasDrivableSegments === true;
}
