/**
 * Conversational LLM-driven candidate-location chat.
 *
 * Wraps the same indexed corpus the keyword path uses (see
 * `searchMapLocations`), but routes the interaction through Claude as a
 * multi-turn conversation. Each request carries the full chat history plus
 * a fresh user turn; the response is a single new assistant turn that may
 * include free-text reply, ranked candidate suggestions, and follow-up
 * prompt chips.
 *
 * Spatial reasoning lives in deterministic code, not in the LLM. The model
 * is given two tools:
 *
 *   - `search_map(structured, limit?)` — runs the deterministic relation
 *     engine on a pre-decomposed structured query. Each result comes back
 *     with `relatedObjectRefs` describing the spatial connection (distance
 *     in meters, the related object's title and subtype, etc.). The model
 *     can issue up to 3 `search_map` calls in a single iteration to fan
 *     out a multi-subject prompt (capped in the system prompt) — the
 *     runtime executes each in turn and appends its result as a
 *     `ToolMessage` before the next round.
 *
 *   - `respond_to_user(reply, candidates, followUps)` — the structured
 *     final answer. The runtime drives the loop with `tool_choice: "any"`,
 *     so each iteration must call at least one of the two tools. The loop
 *     terminates as soon as `respond_to_user` is emitted; the final
 *     iteration forces `tool_choice: "respond_to_user"` to bound runaway
 *     plans.
 *
 * The LLM never invents object ids. Candidates it picks (whether from the
 * fast-path catalog projection or from `search_map` results) are validated
 * against the full corpus before being returned to the client.
 */
import {
  type CollisionFamilyId,
} from "@simcloud/shared";
import type { MapSearchDocument } from "@/app/lib/maps/search/map-search-corpus";
import type { PlannerTrace } from "@/app/lib/llm/scenario-generation/planner/planner-trace";
import type {
  MapSearchResult,
  RelatedObjectRef,
} from "@/app/lib/maps/search/map-search";
import type { GeometryReport } from "@/app/lib/maps/search/server/inspect-location-geometry";
import {
  loadMapSearchCorpus,
  searchMapLocationsStructured,
  type SearchMapLocationsResult,
} from "@/app/lib/maps/search/server/map-search-service";
// Imported as a value-side `import` (not `import type`) so the linter's
// no-unused-vars rule tracks the type usage in `LlmToolCallRecord.structured`
// below. TypeScript erases the import at runtime since
// `StructuredSearchInput` is an interface with no value side; the runtime
// shape comes from `StructuredSearchInputSchema` (Zod) defined in this
// file. Both must stay in sync.
import { StructuredSearchInput } from "@/app/lib/maps/search/relation-ast";
import { anthropicConfigured } from "@/app/lib/llm/langchain-support";
import {
  SEARCH_MAP_DEFAULT_LIMIT,
  SEARCH_MAP_HARD_LIMIT,
} from "./map-search-llm-schemas";
import type {
  SearchMapToolFn,
  SearchMapToolResult,
  ProposeScenarioDraftToolFn,
  InspectLocationGeometryToolInput,
  AssistantTurn,
  LlmRunnerProposeScenarioDraftFn,
  LlmRunnerInspectLocationGeometryFn,
} from "./map-search-llm-schemas";
import { buildSystemPrompt, buildCatalogMessage } from "./map-search-llm-prompts";
import {
  defaultLlmChatRunner,
  LlmToolLoopExceededError,
} from "./map-search-llm-runner";
import type { LlmChatRunner } from "./map-search-llm-runner";

// Re-export everything from the extracted modules so callers that previously
// imported directly from this file continue to work unchanged.
export * from "./map-search-llm-schemas";
export * from "./map-search-llm-prompts";
export * from "./map-search-llm-runner";

/** Hard cap on how many documents we send to Claude in the fast-path catalog. */
const MAX_DOCUMENTS_TO_LLM = 200;

/** Default number of ranked candidates returned per assistant turn. */
const DEFAULT_MAX_CANDIDATES = 6;

/** Hard ceiling on returned candidates regardless of caller request. */
const HARD_MAX_CANDIDATES = 20;

// PER_TOOL_CALL_CAPS lives in map-search-llm-schemas.ts and is re-exported
// via `export * from "./map-search-llm-schemas"` above.

// normalizeReplyWhitespace, looksLikePhantomDraft, LlmToolLoopExceededError,
// LlmChatRunner, LlmChatRunnerResult, and defaultLlmChatRunner live in
// map-search-llm-runner.ts and are re-exported via
// `export * from "./map-search-llm-runner"` above.

// isViableGeometryReport lives in map-search-llm-schemas.ts and is
// re-exported via `export * from "./map-search-llm-schemas"` above.

export interface LlmSearchCandidate extends MapSearchResult {
  llmScore: number;
  llmRationale: string;
  llmAffordances: string[];
}

export interface LlmSearchInputMessage {
  role: "user" | "assistant";
  content: string;
}

/**
 * Per-turn record of a single `search_map` invocation. Surfaced on the
 * assistant message so the UI's debug panel can show exactly what
 * structured query the LLM constructed for a given prompt — what subject
 * + relation it picked, how many results came back, what hints fired.
 */
export interface LlmToolCallRecord {
  /** 0-indexed order of this call within the assistant turn. */
  callIndex: number;
  /** Structured query the LLM submitted (the only input shape). */
  structured: StructuredSearchInput;
  /** Optional limit override the LLM passed; absent when defaulting. */
  limit?: number;
  /** Summary of the executor's response. */
  result: {
    totalDocuments: number;
    resultCount: number;
    parseHints?: Array<{ code: string; message: string }>;
    /**
     * Top-5 result ids + display info. Enough for a debug panel to show
     * "what came back without re-running the query"; the full result set
     * isn't kept around to avoid bloating the wire response.
     */
    topResults: Array<{
      id: string;
      title: string;
      subtype: string;
      family: string;
    }>;
  };
}

/**
 * Scenario draft created during this turn via the `propose_scenario_draft`
 * tool. Mirrors the public `MapSearchLlmProposedScenarioSchema` in
 * `api-schemas.ts`. Empty when the turn was discovery-only.
 */
export interface LlmProposedScenarioRecord {
  scenarioId: string;
  datasetId: string;
  mapAssetId: string;
  /** Document id the LLM picked from the corpus / search results. */
  documentId: string;
  /** Backing CandidateLocation.id when present; null for road-network docs. */
  candidateId: string | null;
  displayName: string;
  editorHref: string;
  /** Collision family the builder instantiated. Null when the legacy
   *  location-only path is used (no `family` arg passed). */
  family: CollisionFamilyId | null;
  /** Number of actors placed in the populated draft. Null on the legacy
   *  location-only path. */
  actorCount: number | null;
  /** Multi-line markdown summary the panel renders inside the
   *  draft-created card. Null on the legacy location-only path. */
  description: string | null;
  /** Inline kinematic-validation summary so the panel can render a
   *  FAILED draft as a failure (no inviting "Open in editor") rather
   *  than a success. Null on the legacy location-only path. */
  validation: {
    verdict: "pass" | "fail";
    needsRevision: boolean;
    /** First machine-then-human fail reason; null on pass. */
    reason: string | null;
  } | null;
  /** Structured trace of the deterministic pedestrian-crossing topology
   *  planner, when that path produced the draft. Null on the heuristic ped
   *  fallback and for every non-ped family. Surfaced for logs /
   *  observability — not rendered in the panel. */
  plannerDebug?: PlannerTrace | null;
}

export interface LlmSearchAssistantMessage {
  role: "assistant";
  content: string;
  candidates: LlmSearchCandidate[];
  followUps: string[];
  /**
   * Per-turn structured queries the LLM made + their result summaries.
   * Empty when the turn made no `search_map` calls (catalog fast-path,
   * graceful empty turn, or unavailable). The UI's debug toggle reads
   * this to render an under-the-hood view of the model's plan.
   */
  toolCalls: LlmToolCallRecord[];
  /**
   * Scenario drafts created this turn via the `propose_scenario_draft`
   * tool. The panel renders an "Open in editor" affordance per entry.
   */
  proposedScenarios: LlmProposedScenarioRecord[];
  /**
   * Extended-thinking text emitted by the model, one entry per
   * tool-loop iteration. Populated only when
   * `ANTHROPIC_THINKING_ENABLED=true` (dev only by default).
   * Empty array on the graceful-empty-turn and runner-exhausted paths
   * since the model never finished reasoning. Surfaced through the
   * panel's debug toggle so developers can see the model's reasoning
   * between tool calls.
   */
  reasoning: string[];
}

export interface LlmSearchResult {
  mapAssetId: string;
  message: LlmSearchAssistantMessage;
  consideredDocuments: number;
  totalDocuments: number;
  corpusTruncated: boolean;
}

export interface SearchMapLocationsLlmArgs {
  mapAssetId: string;
  messages: LlmSearchInputMessage[];
  maxCandidates?: number;
  /**
   * Optional callable enabling the `propose_scenario_draft` tool. When
   * absent the tool is unregistered and the LLM has only discovery tools.
   * Production callers wire a closure that creates a populated draft via
   * `buildCollisionScenarioDraft`; tests stub it directly.
   */
  proposeScenarioDraft?: ProposeScenarioDraftToolFn;
  /**
   * Optional callable enabling the `inspect_location_geometry` tool. Must
   * be present whenever `proposeScenarioDraft` is present — the system
   * prompt requires an inspect-then-propose sequence, and the service
   * refuses propose calls that lack a captured geometry report. The route
   * wires this whenever the session can also propose; tests inject
   * canned reports.
   */
  inspectLocationGeometry?: (input: InspectLocationGeometryToolInput) => Promise<GeometryReport>;
}

export class LlmSearchUnavailableError extends Error {
  constructor() {
    super("Anthropic API is not configured for this environment");
    this.name = "LlmSearchUnavailableError";
  }
}

/**
 * Compact projection of a corpus document used as the LLM's catalog. We strip
 * fields the model doesn't need (geometry, raw search text, internal rank)
 * and trim long arrays so a single call can comfortably fit ~200 documents.
 */
interface CatalogEntry {
  id: string;
  family: string;
  subtype: string;
  title: string;
  description: string;
  facts: string[];
  scenarioTags: string[];
}

const RANK_TOP_N_FACTS = 12;
const RANK_TOP_N_TAGS = 12;

function projectCatalog(documents: MapSearchDocument[]): CatalogEntry[] {
  return documents.map((doc) => ({
    id: doc.id,
    family: doc.objectFamily,
    subtype: doc.subtype,
    title: doc.label,
    description: doc.description,
    facts: doc.exactMapAttributes.slice(0, RANK_TOP_N_FACTS),
    scenarioTags: doc.scenarioTags.slice(0, RANK_TOP_N_TAGS),
  }));
}

function projectSearchResultsForLlm(
  parsed: SearchMapLocationsResult,
): SearchMapToolResult {
  return {
    query: parsed.query,
    totalDocuments: parsed.totalDocuments,
    chips: parsed.chips.map((chip) => ({
      id: chip.id,
      label: chip.label,
      kind: chip.kind,
      operatorLabel: chip.operatorLabel,
      objectLabel: chip.objectLabel,
    })),
    results: parsed.results.map((result) => ({
      id: result.id,
      family: result.objectFamily,
      subtype: result.subtype,
      title: result.title,
      description: result.description,
      facts: result.exactMapAttributes.slice(0, RANK_TOP_N_FACTS),
      scenarioTags: result.scenarioTags.slice(0, RANK_TOP_N_TAGS),
      matchReasons: result.matchReasons,
      relatedObjectRefs:
        result.relatedObjectRefs && result.relatedObjectRefs.length > 0
          ? result.relatedObjectRefs
          : undefined,
    })),
    freeText: parsed.freeText,
    parseHints: parsed.parseHints,
  };
}

/**
 * Build the default `searchMap` callable for a specific map. Always
 * dispatches to `searchMapLocationsStructured` — the LLM tool args only
 * accept the structured shape, by design. Free-text search is still
 * available via `searchMapLocations` for the keyword search panel; the
 * LLM tier just doesn't use it (the model handles natural-language
 * understanding upstream and emits structured directly). Production
 * callers omit the override; tests inject their own to avoid hitting
 * the corpus loader.
 */
function makeDefaultSearchMap(mapAssetId: string): SearchMapToolFn {
  return async (input) => {
    const limit = Math.min(
      input.limit ?? SEARCH_MAP_DEFAULT_LIMIT,
      SEARCH_MAP_HARD_LIMIT,
    );
    const parsed = await searchMapLocationsStructured({
      mapAssetId,
      structured: input.structured,
      limit,
    });
    return projectSearchResultsForLlm(parsed);
  };
}

function documentToCandidate(
  doc: MapSearchDocument,
  ranked: { score: number; rationale: string; affordances: string[] },
  relatedObjectRefs?: RelatedObjectRef[],
): LlmSearchCandidate {
  return {
    id: doc.id,
    candidateId: doc.candidateId ?? doc.id,
    objectFamily: doc.objectFamily,
    subtype: doc.subtype,
    title: doc.label,
    description: doc.description,
    exactMapAttributes: doc.exactMapAttributes,
    relatedObjects: doc.relatedObjects,
    relatedObjectRefs:
      relatedObjectRefs && relatedObjectRefs.length > 0
        ? relatedObjectRefs
        : undefined,
    scenarioTags: doc.scenarioTags,
    candidateConfidence: doc.candidateConfidence,
    matchReasons: ranked.affordances.length > 0 ? ranked.affordances : ["llm match"],
    geometryReference: doc.geometryReference,
    llmScore: ranked.score,
    llmRationale: ranked.rationale,
    llmAffordances: ranked.affordances,
  };
}

function emptyTurn(
  reply: string,
  toolCalls: LlmToolCallRecord[] = [],
  proposedScenarios: LlmProposedScenarioRecord[] = [],
  reasoning: string[] = [],
): LlmSearchAssistantMessage {
  return {
    role: "assistant",
    content: reply,
    candidates: [],
    followUps: [],
    toolCalls,
    proposedScenarios,
    reasoning,
  };
}

/**
 * Run a conversational turn against the LLM-ranked candidate-location chat.
 *
 * Throws `LlmSearchUnavailableError` when the Anthropic API key isn't
 * configured. Callers should translate this to a 503 so the UI can fall
 * back to keyword search instead of failing opaquely.
 *
 * `injectedRunner` and `injectedSearchMap` are test seams — production
 * callers omit them. The default runner runs the full LangChain bind-tools
 * loop; the default searchMap wraps `searchMapLocations` for this asset.
 *
 * `args.proposeScenarioDraft`, when provided, enables the optional
 * `propose_scenario_draft` tool. The route wires it from the session +
 * map-asset context; tests inject a stub.
 */
export async function searchMapLocationsLlm(
  args: SearchMapLocationsLlmArgs,
  injectedRunner?: LlmChatRunner,
  injectedSearchMap?: SearchMapToolFn,
): Promise<LlmSearchResult> {
  const runner = injectedRunner ?? defaultLlmChatRunner;
  if (!injectedRunner && !anthropicConfigured()) {
    throw new LlmSearchUnavailableError();
  }

  if (args.messages.length === 0) {
    throw new Error("messages must include at least the latest user turn");
  }
  const last = args.messages[args.messages.length - 1]!;
  if (last.role !== "user") {
    throw new Error("the last message must be from the user");
  }

  // Contract: the geometry-inspection tool only makes sense paired with
  // the scenario-draft tool. `inspect_location_geometry` exists to feed
  // a geometry report into `propose_scenario_draft`; exposing it alone
  // gives the model a tool it can't act on, and exposing propose without
  // inspect would let the model call propose without a captured
  // geometry report (the wrapper rejects, but we'd waste the call).
  // Fail fast at the service boundary so a misconfigured caller can't
  // silently degrade the LLM's tool surface.
  const proposePresent = args.proposeScenarioDraft != null;
  const inspectPresent = args.inspectLocationGeometry != null;
  if (proposePresent !== inspectPresent) {
    throw new Error(
      "searchMapLocationsLlm: proposeScenarioDraft and inspectLocationGeometry must be provided together (or both omitted). " +
        `Got proposeScenarioDraft=${proposePresent ? "present" : "missing"}, inspectLocationGeometry=${inspectPresent ? "present" : "missing"}.`,
    );
  }

  const corpus = await loadMapSearchCorpus(args.mapAssetId);
  if (!corpus) {
    return {
      mapAssetId: args.mapAssetId,
      message: emptyTurn("No indexed objects are available for this map yet."),
      consideredDocuments: 0,
      totalDocuments: 0,
      corpusTruncated: false,
    };
  }
  const proposeScenarioDraftBase = args.proposeScenarioDraft;

  const totalDocuments = corpus.totalDocuments;
  const corpusTruncated = corpus.documents.length > MAX_DOCUMENTS_TO_LLM;
  const consideredDocs = corpusTruncated
    ? corpus.documents.slice(0, MAX_DOCUMENTS_TO_LLM)
    : corpus.documents;

  if (consideredDocs.length === 0) {
    return {
      mapAssetId: args.mapAssetId,
      message: emptyTurn("This map has no indexed objects to rank yet."),
      consideredDocuments: 0,
      totalDocuments,
      corpusTruncated: false,
    };
  }

  // Index the FULL corpus, not just the catalog projection — search_map
  // can surface ids that aren't in the truncated catalog, and they must
  // still resolve to a candidate for the UI.
  const docsById = new Map<string, MapSearchDocument>();
  for (const doc of corpus.documents) docsById.set(doc.id, doc);

  const maxCandidates = Math.min(
    args.maxCandidates ?? DEFAULT_MAX_CANDIDATES,
    HARD_MAX_CANDIDATES,
  );

  const baseSearchMap =
    injectedSearchMap ?? makeDefaultSearchMap(args.mapAssetId);

  // Capture relation neighbors per result id across every search_map call
  // the runner makes. When the LLM picks a subject id whose row had
  // relatedObjectRefs, we attach those refs to the final candidate so the
  // UI can render the relation as a chip — exactly the way keyword-search
  // results carry their relation. Last write wins on id collision; that's
  // fine because the same id from the same corpus produces the same neighbors.
  const capturedRelatedRefs = new Map<string, RelatedObjectRef[]>();

  // Tool-call diagnostics: every search_map invocation is recorded here
  // (input + result summary) and surfaced on the assistant message so the
  // AI search panel's debug toggle can show what structured query the LLM
  // actually composed for the user's prompt. Mutated in-place from the
  // searchMap wrapper below; partial history is preserved on the
  // tool-loop-exceeded fallback.
  const toolCallRecords: LlmToolCallRecord[] = [];

  const searchMap: SearchMapToolFn = async (input) => {
    const result = await baseSearchMap(input);
    for (const entry of result.results) {
      if (entry.relatedObjectRefs && entry.relatedObjectRefs.length > 0) {
        capturedRelatedRefs.set(entry.id, entry.relatedObjectRefs);
      }
    }
    toolCallRecords.push({
      callIndex: toolCallRecords.length,
      structured: input.structured,
      ...(input.limit != null ? { limit: input.limit } : {}),
      result: {
        totalDocuments: result.totalDocuments,
        resultCount: result.results.length,
        ...(result.parseHints && result.parseHints.length > 0
          ? { parseHints: result.parseHints }
          : {}),
        topResults: result.results.slice(0, 5).map((r) => ({
          id: r.id,
          title: r.title,
          subtype: r.subtype,
          family: r.family,
        })),
      },
    });
    return result;
  };

  // Geometry reports captured across `inspect_location_geometry` tool
  // calls this turn. Keyed by documentId so the propose wrapper can pull
  // the matching report at draft time without re-fetching. Last write
  // wins on id collision; that's intentional — if the model inspected the
  // same document with different radii it usually means it's trying to
  // narrow down placement, and the last call carries the freshest view.
  const capturedGeometry = new Map<string, GeometryReport>();
  const inspectLocationGeometryBase = args.inspectLocationGeometry;
  const inspectLocationGeometry: LlmRunnerInspectLocationGeometryFn | undefined =
    inspectLocationGeometryBase
      ? async (input) => {
          const doc = docsById.get(input.documentId);
          if (!doc) {
            throw new Error(
              `Unknown document id '${input.documentId}'. Pick an id from the catalog or a recent search_map result.`,
            );
          }
          const report = await inspectLocationGeometryBase(input);
          capturedGeometry.set(input.documentId, report);
          return report;
        }
      : undefined;

  // Captured per-turn so we can attach proposed scenarios to the assistant
  // message even after a tool-loop-exceeded fallback. Wrapper resolves the
  // LLM's documentId against the corpus AND looks up the matching geometry
  // report before delegating to the route's callable so that callable
  // doesn't need a corpus reference or to re-fetch the runtime bundle.
  const proposedScenarioRecords: LlmProposedScenarioRecord[] = [];
  const proposeScenarioDraft: LlmRunnerProposeScenarioDraftFn | undefined =
    proposeScenarioDraftBase
      ? async (input) => {
          const doc = docsById.get(input.documentId);
          if (!doc) {
            throw new Error(
              `Unknown document id '${input.documentId}'. Pick an id from the catalog or a recent search_map result.`,
            );
          }
          const geometry = capturedGeometry.get(input.documentId);
          if (!geometry) {
            throw new Error(
              `No geometry report captured for documentId '${input.documentId}'. Call inspect_location_geometry({ documentId }) for the same document before propose_scenario_draft.`,
            );
          }
          // Resolve approach-street geometries. Each id the LLM passes
          // must also have been inspected earlier this turn — same
          // contract as `documentId`. We surface a specific error per
          // missing id so the model can fix one inspect call rather
          // than re-running the whole plan.
          const approachIds = input.approachStreetIds ?? [];
          const approachGeometries: GeometryReport[] = [];
          for (const approachId of approachIds) {
            const approachDoc = docsById.get(approachId);
            if (!approachDoc) {
              throw new Error(
                `Unknown approachStreetId '${approachId}'. Pick ids from the catalog or a recent search_map result.`,
              );
            }
            const approachGeom = capturedGeometry.get(approachId);
            if (!approachGeom) {
              throw new Error(
                `No geometry report captured for approachStreetId '${approachId}'. Call inspect_location_geometry({ documentId: '${approachId}' }) before propose_scenario_draft.`,
              );
            }
            approachGeometries.push(approachGeom);
          }
          const result = await proposeScenarioDraftBase({
            documentId: input.documentId,
            documentLabel: doc.label,
            candidateId: doc.candidateId ?? null,
            family: input.family,
            intent: input.intent,
            aggressivenessLabel: input.aggressivenessLabel ?? null,
            npcVehicleType: input.npcVehicleType ?? null,
            geometry,
            approachGeometries,
          });
          proposedScenarioRecords.push({
            scenarioId: result.scenarioId,
            datasetId: result.datasetId,
            mapAssetId: result.mapAssetId,
            documentId: result.documentId,
            candidateId: result.candidateId,
            displayName: result.displayName,
            editorHref: result.editorHref,
            family: result.family,
            actorCount: result.actorCount,
            description: result.description,
            validation: result.validation
              ? {
                  verdict: result.validation.verdict,
                  needsRevision: result.validation.needsRevision,
                  reason: result.validation.reasons?.[0] ?? null,
                }
              : null,
            plannerDebug: result.plannerDebug ?? null,
          });
          return result;
        }
      : undefined;

  let turn: AssistantTurn;
  let reasoning: string[] = [];
  try {
    const runnerResult = await runner({
      systemPrompt: buildSystemPrompt(proposeScenarioDraft != null),
      catalogMessage: buildCatalogMessage({
        catalog: projectCatalog(consideredDocs),
        maxCandidates,
        totalDocuments,
        corpusTruncated,
      }),
      history: args.messages,
      searchMap,
      ...(proposeScenarioDraft ? { proposeScenarioDraft } : {}),
      ...(inspectLocationGeometry ? { inspectLocationGeometry } : {}),
    });
    // Backward-compat: production runner returns { turn, reasoning };
    // test stubs commonly resolve with just the assistant turn shape.
    // Treat the absence of a `turn` key as the legacy bare-turn shape.
    if (runnerResult != null && typeof runnerResult === "object" && "turn" in runnerResult) {
      turn = runnerResult.turn;
      reasoning = runnerResult.reasoning ?? [];
    } else {
      turn = runnerResult as AssistantTurn;
    }
  } catch (err) {
    // A runaway tool plan (model never emits `respond_to_user` even on
    // the forced-final iteration) shouldn't surface as a 500. Hand back
    // a graceful assistant turn so the chat thread stays usable and the
    // user can refine their prompt. All other errors (auth, schema, etc.)
    // bubble up unchanged so the route can return its existing failure
    // codes. The partial tool-call history we captured before the loop
    // blew up is preserved so the debug panel can show the user exactly
    // which queries the model was running when it ran out of iterations.
    if (err instanceof LlmToolLoopExceededError) {
      console.warn("[map-search-llm] tool loop exceeded max iterations");
      // Pull reasoning off the error if the runner attached it.
      // The default runner stashes the partial reasoning before
      // throwing so the debug toggle still shows what the model
      // was thinking before it ran out of iterations.
      const partialReasoning =
        err instanceof LlmToolLoopExceededError && Array.isArray(err.reasoning)
          ? err.reasoning
          : [];
      return {
        mapAssetId: args.mapAssetId,
        message: emptyTurn(
          "I couldn't narrow this down in the time I had — try splitting it into a couple of simpler asks (e.g. 'parking lot near a school' first, then 'crosswalks near the school').",
          toolCallRecords,
          proposedScenarioRecords,
          partialReasoning,
        ),
        consideredDocuments: consideredDocs.length,
        totalDocuments,
        corpusTruncated,
      };
    }
    throw err;
  }

  // Drop any hallucinated ids and dedupe while preserving the LLM's order.
  const seen = new Set<string>();
  const candidates: LlmSearchCandidate[] = [];
  for (const item of turn.candidates) {
    if (candidates.length >= maxCandidates) break;
    if (seen.has(item.id)) continue;
    const doc = docsById.get(item.id);
    if (!doc) continue;
    seen.add(item.id);
    candidates.push(
      documentToCandidate(
        doc,
        {
          score: item.score,
          rationale: item.rationale,
          affordances: item.affordances,
        },
        capturedRelatedRefs.get(item.id),
      ),
    );
  }

  return {
    mapAssetId: args.mapAssetId,
    message: {
      role: "assistant",
      content: turn.reply,
      candidates,
      followUps: turn.followUps.slice(0, 4),
      toolCalls: toolCallRecords,
      proposedScenarios: proposedScenarioRecords,
      reasoning,
    },
    consideredDocuments: consideredDocs.length,
    totalDocuments,
    corpusTruncated,
  };
}
