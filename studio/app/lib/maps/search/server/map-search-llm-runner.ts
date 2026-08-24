/**
 * Default LLM chat runner for the map-search LLM service.
 *
 * Extracted from map-search-llm-service.ts. Contains the full
 * `defaultLlmChatRunner` implementation — the bind-tools loop that drives
 * Claude through successive `search_map` / `propose_scenario_draft` /
 * `inspect_location_geometry` calls until `respond_to_user` is emitted —
 * plus its private helpers (`extractThinkingFromAi`, `PHANTOM_DRAFT_MARKERS`).
 *
 * Also exports `normalizeReplyWhitespace` and `looksLikePhantomDraft` because
 * the service re-exports them for unit tests; keeping the definitions here
 * avoids a circular import while preserving the public API.
 *
 * The service file re-exports everything via `export * from` so callers that
 * previously imported directly from the service continue to work unchanged.
 */
import {
  AIMessage,
  HumanMessage,
  SystemMessage,
  ToolMessage,
  type BaseMessage,
} from "@langchain/core/messages";
import { tool } from "@langchain/core/tools";
import {
  createChatModel,
  isAnthropicThinkingEnabled,
} from "@/app/lib/llm/langchain-support";
import {
  SearchMapToolArgsSchema,
  AssistantTurnSchema,
  ProposeScenarioDraftToolArgsSchema,
  InspectLocationGeometryToolArgsSchema,
  SEARCH_MAP_DEFAULT_LIMIT,
  SEARCH_MAP_HARD_LIMIT,
} from "./map-search-llm-schemas";
import type {
  SearchMapToolInput,
  SearchMapToolFn,
  ProposeScenarioDraftToolInput,
  AssistantTurn,
  LlmRunnerProposeScenarioDraftFn,
  LlmRunnerInspectLocationGeometryFn,
} from "./map-search-llm-schemas";
import { dispatchToolCall } from "./map-search-llm-tools";

/**
 * Tool-loop iteration cap so a malformed plan can't run away. The final
 * iteration forces `tool_choice: respond_to_user` (see the loop below), so
 * the practical budget is `MAX_TOOL_ITERATIONS - 1` `search_map` rounds
 * before we make the model commit to a structured answer.
 */
const MAX_TOOL_ITERATIONS = 8;

/**
 * Phrases that, in combination, suggest the model is *describing a
 * scenario draft in prose* — placing actors, narrating a collision,
 * specifying spawn lanes — rather than asking a clarifying question.
 * When `respond_to_user` ships with two-plus of these markers AND no
 * successful `propose_scenario_draft` call happened this turn, we treat
 * the reply as a phantom draft and force a re-prompt (see runner).
 *
 * The set is intentionally tight: every phrase is something a real
 * draft summary would emit but a neutral "here are some options" reply
 * would not. Two-marker threshold further suppresses false positives.
 */
const PHANTOM_DRAFT_MARKERS = [
  "scenario draft",
  "scenario summary",
  "scenario build",
  "actor placement",
  "🚗 scenario",
  "🚗 actor",
  "ego vehicle",
  "adversary vehicle",
  "conflict point",
  "spawns on",
  "spawn on the",
  "spawn lane",
  "suggested trigger",
  "collision point",
  "oncoming adversary",
  "oncoming threat",
  "pass condition",
  "fail condition",
  "ego waits",
  "ego turns",
] as const;

/**
 * Models filling the `reply` JSON string field via a tool call frequently
 * emit the literal two-character escape `\n` (or `\t`) instead of a real
 * line break — the schema asks for newlines and the model "escapes" them
 * into the JSON value. ReactMarkdown then renders the literal `\n` as the
 * visible text "\n". Convert the common whitespace escapes back to real
 * characters at the service boundary. Conservative: only whitespace
 * escapes, leaving every other backslash sequence untouched.
 *
 * @internal Exported for unit tests.
 */
export function normalizeReplyWhitespace(reply: string): string {
  return reply
    .replace(/\\r\\n/g, "\n")
    .replace(/\\n/g, "\n")
    .replace(/\\r/g, "\n")
    .replace(/\\t/g, "\t");
}

export function looksLikePhantomDraft(reply: string): boolean {
  const lower = reply.toLowerCase();
  let hits = 0;
  for (const marker of PHANTOM_DRAFT_MARKERS) {
    if (lower.includes(marker)) {
      hits++;
      if (hits >= 2) return true;
    }
  }
  return false;
}

/**
 * Runner return shape. The required `turn` carries the parsed
 * `respond_to_user` args. The optional `reasoning` is one entry per
 * tool-loop iteration containing the model's extended-thinking text
 * (only populated when ANTHROPIC_THINKING_ENABLED=true; absent or
 * empty for test stubs and disabled-thinking runs). Surfaced via the
 * panel's debug toggle so a developer can see what the model was
 * thinking between tool calls.
 */
export interface LlmChatRunnerResult {
  turn: AssistantTurn;
  reasoning?: string[];
}

export type LlmChatRunner = (args: {
  systemPrompt: string;
  catalogMessage: string;
  history: Array<{ role: "user" | "assistant"; content: string }>;
  searchMap: SearchMapToolFn;
  proposeScenarioDraft?: LlmRunnerProposeScenarioDraftFn;
  inspectLocationGeometry?: LlmRunnerInspectLocationGeometryFn;
}) => Promise<AssistantTurn | LlmChatRunnerResult>;

/**
 * Thrown by the runner when the tool-use loop runs out of iterations
 * without the model emitting a `respond_to_user` call. Caught by
 * `searchMapLocationsLlm` and translated into a graceful empty assistant
 * turn so the user sees a recoverable message instead of a 500.
 */
export class LlmToolLoopExceededError extends Error {
  /** Partial reasoning captured up to the point of exhaustion. The
   *  graceful-empty-turn fallback in `searchMapLocationsLlm` reads
   *  this so the debug toggle still shows what the model was thinking
   *  before the iteration cap was hit. Empty when extended thinking
   *  is disabled. */
  readonly reasoning: readonly string[];
  constructor(reasoning: readonly string[] = []) {
    super("Tool-use loop exceeded max iterations");
    this.name = "LlmToolLoopExceededError";
    this.reasoning = reasoning;
  }
}

/** Extract extended-thinking text from a LangChain `AIMessage`.
 *
 * When `thinking` is enabled on `ChatAnthropic`, the model's reasoning
 * arrives as content blocks of `type: "thinking"` (or `redacted_thinking`
 * for tool-output sanitisation) on the AIMessage. Plain string content
 * means thinking was disabled (or the SDK collapsed text-only output).
 * This helper is defensive about LangChain's content shape — it accepts
 * string content (returns null), an array of unknown blocks, or null.
 */
function extractThinkingFromAi(ai: { content: unknown }): string | null {
  const content = ai.content;
  if (typeof content === "string") return null;
  if (!Array.isArray(content)) return null;
  const parts: string[] = [];
  for (const block of content) {
    if (block == null || typeof block !== "object") continue;
    const b = block as { type?: unknown; thinking?: unknown };
    if (b.type !== "thinking") continue;
    if (typeof b.thinking !== "string") continue;
    const trimmed = b.thinking.trim();
    if (trimmed.length > 0) parts.push(trimmed);
  }
  if (parts.length === 0) return null;
  return parts.join("\n\n");
}

interface ToolCall {
  id?: string;
  name: string;
  args: Record<string, unknown>;
}

/**
 * Default runner — runs the bind-tools loop against Claude. The model is
 * required to call exactly one tool per turn (`tool_choice: "any"`); the
 * loop terminates when it picks `respond_to_user` and forwards that tool's
 * args as the final assistant turn.
 */
export async function defaultLlmChatRunner(args: {
  systemPrompt: string;
  catalogMessage: string;
  history: Array<{ role: "user" | "assistant"; content: string }>;
  searchMap: SearchMapToolFn;
  proposeScenarioDraft?: LlmRunnerProposeScenarioDraftFn;
  inspectLocationGeometry?: LlmRunnerInspectLocationGeometryFn;
}): Promise<LlmChatRunnerResult> {
  const model = createChatModel();

  const searchMapTool = tool(
    async (input: SearchMapToolInput) => {
      const result = await args.searchMap(input);
      return JSON.stringify(result);
    },
    {
      name: "search_map",
      description:
        "Run the deterministic map-search engine. Handles spatial relations and subject filters. Use for any prompt with a spatial dimension.",
      schema: SearchMapToolArgsSchema,
    },
  );

  const respondTool = tool(
    async () => "ok",
    {
      name: "respond_to_user",
      description:
        "Emit the final structured turn (reply text, ranked candidates, follow-up chips). Call this when you have everything you need.",
      schema: AssistantTurnSchema,
    },
  );

  const proposeScenarioDraft = args.proposeScenarioDraft;
  const proposeScenarioDraftTool = proposeScenarioDraft
    ? tool(
        async (input: ProposeScenarioDraftToolInput) => {
          const result = await proposeScenarioDraft(input);
          return JSON.stringify(result);
        },
        {
          name: "propose_scenario_draft",
          description:
            "Create a populated collision-scenario draft anchored to a previously found map document. Use when the user asks to create, draft, build, or simulate a collision scenario. Requires a documentId from the catalog/search_map and a captured `inspect_location_geometry` report for that same documentId earlier in this turn.",
          schema: ProposeScenarioDraftToolArgsSchema,
        },
      )
    : null;

  const inspectLocationGeometry = args.inspectLocationGeometry;
  const inspectLocationGeometryTool = inspectLocationGeometry
    ? tool(
        async (input) => {
          const result = await inspectLocationGeometry(input);
          return JSON.stringify(result);
        },
        {
          name: "inspect_location_geometry",
          description:
            "Read the runtime road network around a previously found map document. Returns nearby drivable/sidewalk lanes plus placement hints (drivable, sidewalks, opposite-direction lanes, adjacent lanes). Call this once before propose_scenario_draft for the same documentId.",
          schema: InspectLocationGeometryToolArgsSchema,
        },
      )
    : null;

  const tools = [
    searchMapTool,
    respondTool,
    ...(proposeScenarioDraftTool ? [proposeScenarioDraftTool] : []),
    ...(inspectLocationGeometryTool ? [inspectLocationGeometryTool] : []),
  ];

  // Anthropic's extended-thinking API rejects ANY forced `tool_choice`
  // (the error reads `Thinking may not be enabled when tool_choice
  // forces tool use`). Both `"any"` (force *some* tool) and
  // `"respond_to_user"` (force a specific tool) count as forcing — the
  // only thinking-compatible value is `"auto"`. When thinking is on we
  // therefore omit `tool_choice` entirely on every iteration; the system
  // prompt is strong enough that Sonnet still picks a tool almost every
  // turn, and the no-tool-call branch in the loop below catches the
  // rare exceptions gracefully.
  //
  // With thinking off we keep the original behavior: `"any"` for normal
  // iterations and `"respond_to_user"` on the final iteration to
  // guarantee the loop terminates.
  const thinkingEnabled = isAnthropicThinkingEnabled();
  const boundAny = thinkingEnabled
    ? model.bindTools(tools)
    : model.bindTools(tools, { tool_choice: "any" });
  const boundRespond = thinkingEnabled
    ? boundAny
    : model.bindTools(tools, { tool_choice: "respond_to_user" });

  // Prompt-caching: the system prompt and the catalog projection are the
  // two largest stable chunks of every request. By marking them with
  // `cache_control: { type: "ephemeral" }` we let Anthropic cache the
  // tokenized prefix for 5 minutes, so subsequent tool-loop iterations
  // (and follow-up user turns within the same session) read the prefix
  // from cache at ~10% of the normal input rate. On a typical 5-iter
  // draft turn this cuts the per-turn cost roughly in half.
  //
  // Two breakpoints (one per cached message) — Anthropic allows up to 4
  // per request. We don't cache the chat history because it changes
  // every turn AND its content is short relative to the prefix; the
  // prefix-cache hit is what matters.
  const messages: BaseMessage[] = [
    new SystemMessage({
      content: [
        {
          type: "text",
          text: args.systemPrompt,
          cache_control: { type: "ephemeral" },
        },
      ],
    }),
    new HumanMessage({
      content: [
        {
          type: "text",
          text: args.catalogMessage,
          cache_control: { type: "ephemeral" },
        },
      ],
    }),
    new AIMessage("Got it — ready to help find locations."),
    ...args.history.map((m) =>
      m.role === "user"
        ? new HumanMessage(m.content)
        : new AIMessage(m.content),
    ),
  ];

  // Per-tool runtime counters. The system prompt asks the model to stay
  // within budget but a prompt-only constraint is advisory — model drift
  // or a prompt-injected user message could still flood the loop with
  // expensive calls. Caps from `PER_TOOL_CALL_CAPS`. When exceeded we
  // short-circuit with a `tool_call_limit_exceeded` error so the model
  // can pivot to `respond_to_user` rather than burning iterations on
  // refused calls.
  const toolCallCounts: Record<string, number> = {
    search_map: 0,
    inspect_location_geometry: 0,
    propose_scenario_draft: 0,
  };
  // Count only SUCCESSFUL propose calls (no error thrown). The phantom-
  // draft guard below uses this to decide whether a `respond_to_user`
  // reply that "describes a scenario draft" is honest (we actually
  // drafted) or hallucinated (we didn't).
  let successfulProposeCount = 0;
  // Count inspect calls whose result satisfies the draftability bar
  // (centerResolved + hasDrivableSegments). The options-only guard
  // below uses this to detect the "present options" escape hatch — the
  // agent inspected a draftable location but ended the turn at a
  // candidate list instead of committing. Captures the most recent
  // viable doc id so the synthetic re-prompt can name it.
  let viableInspectCount = 0;
  let lastViableInspectDocumentId: string | null = null;

  // Per-iteration extended-thinking text. Populated only when the model
  // emits `thinking` content blocks (i.e. ANTHROPIC_THINKING_ENABLED is
  // true). Surfaced through the runner result so the panel's debug
  // toggle can render the model's reasoning between tool calls.
  const reasoningPerIteration: string[] = [];

  for (let iter = 0; iter < MAX_TOOL_ITERATIONS; iter++) {
    const isFinal = iter === MAX_TOOL_ITERATIONS - 1;
    const bound = isFinal ? boundRespond : boundAny;
    const ai = (await bound.invoke(messages)) as AIMessage;
    messages.push(ai);

    // Capture this iteration's reasoning before we branch on tool
    // calls. Even iterations that produce only a respond_to_user call
    // may carry useful thinking text describing why the model decided
    // to finalize.
    const thinkingText = extractThinkingFromAi(ai);
    if (thinkingText) {
      reasoningPerIteration.push(thinkingText);
    }

    const toolCalls = (ai.tool_calls ?? []) as ToolCall[];
    if (toolCalls.length === 0) {
      // With thinking enabled the model is allowed to emit text-only
      // (no tool calls) on any iteration because `tool_choice` cannot
      // be forced. Treat the text content as an implicit
      // `respond_to_user` so the user gets a coherent reply instead of
      // a 500. Best-effort extraction: prefer a string `content`, fall
      // back to concatenating `text` blocks from a content-block array.
      if (thinkingEnabled) {
        const textContent = (() => {
          if (typeof ai.content === "string") return ai.content;
          if (Array.isArray(ai.content)) {
            const parts: string[] = [];
            for (const block of ai.content) {
              if (block != null && typeof block === "object") {
                const b = block as { type?: unknown; text?: unknown };
                if (b.type === "text" && typeof b.text === "string") {
                  parts.push(b.text);
                }
              }
            }
            return parts.join("\n\n");
          }
          return "";
        })();
        console.warn(
          `[map-search-llm] iter=${iter} produced no tool call under thinking-mode auto-choice; treating text content as respond_to_user.`,
        );
        return {
          turn: {
            reply: normalizeReplyWhitespace(textContent.trim()) ||
              "I had a thought but didn't produce a structured answer — try rephrasing your request.",
            candidates: [],
            followUps: [],
          },
          reasoning: reasoningPerIteration,
        };
      }
      throw new Error(
        "Model produced no tool call; expected search_map or respond_to_user",
      );
    }

    const respondCall = toolCalls.find((c) => c.name === "respond_to_user");
    if (respondCall) {
      // The system prompt instructs the model to call exactly one of the
      // two tools per iteration. If it slipped a `search_map` call in
      // alongside `respond_to_user`, prefer the final answer (the loop
      // would terminate anyway) but surface the prompt drift so we can
      // notice it in logs.
      if (toolCalls.length > 1) {
        const otherNames = toolCalls
          .filter((c) => c !== respondCall)
          .map((c) => c.name);
        console.warn(
          `[map-search-llm] iteration ${iter} mixed respond_to_user with ${otherNames.length} other tool call(s) (${otherNames.join(", ")}); dropping the others`,
        );
      }
      const parsedTurn = AssistantTurnSchema.parse(respondCall.args);
      parsedTurn.reply = normalizeReplyWhitespace(parsedTurn.reply);

      // Phantom-draft guard. If the model produced a reply that reads
      // like a scenario draft summary (multiple PHANTOM_DRAFT_MARKERS)
      // but it never actually called `propose_scenario_draft`, the
      // user would see a fictional draft with no editor link. Force a
      // re-prompt by pushing a synthetic tool-response that explains
      // the gap so the model self-corrects on the next iteration.
      // Conditions to fire:
      //   1. propose tool is wired this turn (otherwise the model
      //      can't draft, so prose is the only option).
      //   2. no successful propose call has happened yet this turn.
      //   3. the reply hits the marker threshold.
      //   4. we're not on the forced-final iteration — burning the
      //      iteration budget on a re-prompt the model can't satisfy
      //      makes things worse, so accept the prose and move on.
      const shouldGuardPhantom =
        proposeScenarioDraft != null &&
        successfulProposeCount === 0 &&
        !isFinal &&
        looksLikePhantomDraft(parsedTurn.reply);
      if (shouldGuardPhantom) {
        console.warn(
          `[map-search-llm] phantom-draft reply detected at iter=${iter}; forcing re-prompt to call propose_scenario_draft`,
        );
        const respondId = respondCall.id ?? `synthetic-respond-${iter}`;
        messages.push(
          new ToolMessage({
            tool_call_id: respondId,
            content: JSON.stringify({
              error:
                "phantom_draft_rejected: Your reply describes a scenario draft (ego/adversary/conflict point/actor placement/pass-fail conditions) but you did not call `propose_scenario_draft` this turn — so no editor draft exists for the user to open. " +
                "**Required recovery:** call `inspect_location_geometry({ documentId: '<chosen_doc_id>' })` then `propose_scenario_draft({ documentId, family, intent })` right now. " +
                "**`approachStreetIds` is OPTIONAL** — if your earlier `upstream_of` search returned 0 results, DO NOT retry it and DO NOT block the draft on it. Just pass `documentId` to `inspect_location_geometry` and to `propose_scenario_draft`; the builder places ego on the closest legal approach lane when `approachStreetIds` is absent. " +
                "Do not respond with prose again until the draft is actually created.",
            }),
          }),
        );
        continue;
      }

      // Options-only guard. The phantom-draft guard catches the case
      // where the model NARRATES a draft in prose; this one catches the
      // sibling failure on Tier-1 families where the model presents a
      // ranked candidate list and stops — exactly the "[NO-DRAFT]"
      // pattern the pass-rate eval flagged for rear_end / sideswipe /
      // unsafe_cut_in / pedestrian_crossing. Conditions to fire:
      //   1. propose tool is wired this turn (otherwise drafting is
      //      not an option).
      //   2. no `propose_scenario_draft` call has been attempted yet
      //      (toolCallCounts, not successfulProposeCount: a tried-and-
      //      failed propose is a legitimate reason to end with a
      //      discovery-style reply pointing at alternatives).
      //   3. at least one inspect call this turn returned a viable
      //      geometry report (centerResolved + hasDrivableSegments) —
      //      the strong signal that the model already picked a
      //      draftable location and just needs to commit.
      //   4. the reply ships ≥1 candidate (discovery-mode shape).
      //   5. we're not on the forced-final iteration (re-prompting on
      //      the last iteration only consumes budget; better to ship
      //      the reply we have).
      const shouldGuardOptionsOnly =
        proposeScenarioDraft != null &&
        toolCallCounts.propose_scenario_draft === 0 &&
        viableInspectCount >= 1 &&
        parsedTurn.candidates.length >= 1 &&
        !isFinal;
      if (shouldGuardOptionsOnly) {
        console.warn(
          `[map-search-llm] options-only reply detected at iter=${iter}; ` +
            `viable inspects=${viableInspectCount} candidates=${parsedTurn.candidates.length}; ` +
            "forcing re-prompt to call propose_scenario_draft",
        );
        const respondId = respondCall.id ?? `synthetic-respond-options-${iter}`;
        const targetId = lastViableInspectDocumentId ?? "<inspected_doc_id>";
        messages.push(
          new ToolMessage({
            tool_call_id: respondId,
            content: JSON.stringify({
              error:
                "options_only_rejected: You inspected viable geometry for at least one location this turn " +
                `(most recently '${targetId}') but ended the turn with a ranked candidate list instead of calling ` +
                "`propose_scenario_draft`. The user gave a complete scenario specification — naming a family AND a viable location class — so the right action is to DRAFT on the top inspected candidate now, not enumerate alternatives. " +
                `**Required recovery:** call \`propose_scenario_draft({ documentId: '${targetId}', family: <pick from the user's prompt>, intent: <short summary> })\` right now. ` +
                "Pass `approachStreetIds` only if you already inspected approach streets this turn; otherwise omit it (the builder picks the closest legal approach lane). " +
                "If you genuinely cannot draft because the user's prompt is ambiguous (e.g. 'something dangerous here' with no family verb), drop the candidates from your reply and ask ONE clarifying question with commit-ready followUp chips instead. " +
                "Do not respond with a candidate list again on this turn.",
            }),
          }),
        );
        continue;
      }
      return { turn: parsedTurn, reasoning: reasoningPerIteration };
    }

    // On the forced-final iteration the model is required to call
    // `respond_to_user`; if it didn't, treat that as a malformed plan and
    // fall through to the runaway-loop error rather than burning more turns.
    if (isFinal) break;

    // Mutable ref boxes so dispatchToolCall can update the runner's counters.
    const successfulProposeCountRef = { value: successfulProposeCount };
    const viableInspectCountRef = { value: viableInspectCount };
    const lastViableInspectDocumentIdRef: { value: string | null } = { value: lastViableInspectDocumentId };

    for (const [idx, call] of toolCalls.entries()) {
      await dispatchToolCall(call, idx, messages, {
        iter,
        toolCallCounts,
        successfulProposeCountRef,
        viableInspectCountRef,
        lastViableInspectDocumentIdRef,
        searchMap: args.searchMap,
        proposeScenarioDraft: args.proposeScenarioDraft,
        inspectLocationGeometry: args.inspectLocationGeometry,
      });
    }

    // Write updated counter values back from the ref boxes.
    successfulProposeCount = successfulProposeCountRef.value;
    viableInspectCount = viableInspectCountRef.value;
    lastViableInspectDocumentId = lastViableInspectDocumentIdRef.value;
  }

  throw new LlmToolLoopExceededError(reasoningPerIteration);
}

// Re-export SEARCH_MAP_DEFAULT_LIMIT / SEARCH_MAP_HARD_LIMIT so callers
// that imported them from the service (via its re-export of schemas) are
// unaffected. The runner needs them only for the tool-definition description
// strings; the real enforcement lives in makeDefaultSearchMap in the service.
export { SEARCH_MAP_DEFAULT_LIMIT, SEARCH_MAP_HARD_LIMIT };
