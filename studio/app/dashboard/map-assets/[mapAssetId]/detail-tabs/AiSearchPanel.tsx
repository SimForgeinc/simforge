"use client";

import { useEffect, useRef, useState, type ComponentProps } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeSanitize from "rehype-sanitize";
import {
  ArrowRight,
  Bot,
  Bug,
  Check,
  Loader2,
  MapPin,
  Play,
  Send,
  Sparkles,
  Target,
  User,
  X,
} from "lucide-react";
import { Badge } from "@/app/components/ui/badge";
import { Button } from "@/app/components/ui/button";
import { cn } from "@/app/lib/utils";
import type { ScenarioValidationState } from "@/app/lib/maps/frontend/use-scenario-validation";
import type {
  ChatAssistantMessage,
  ChatMessage,
  LlmSearchCandidate,
  UseMapSearchLlmResult,
} from "@/app/lib/maps/frontend/use-map-search-llm";
import {
  formatFamilyLabel,
  formatRelation,
  HighlightToggleButton,
  iconForSubtype,
} from "./SearchResultsTab";
import { CopyJsonButton } from "./CopyJsonButton";
import { ReasoningDebug, ToolCallsDebug } from "./AiSearchDebugPanels";
import {
  ProposedScenariosBlock,
  subtypeToFriendlyNoun,
} from "./AiSearchScenarioDrafts";

interface AiSearchPanelProps {
  /** Hook state passed in from the parent so result selection can drive the map. */
  search: UseMapSearchLlmResult;
  selectedResultId: string | null;
  /**
   * Object id of the related ref the user has pinned for emphasized
   * rendering on the map / digital twin. Mirrors the keyword search
   * panel — only one target is highlighted at a time and it's scoped to
   * `selectedResultId`.
   */
  highlightedRelatedObjectId?: string | null;
  onSelectResult: (id: string) => void;
  onZoomToResult: (id: string) => void;
  onUseInScenario: (id: string) => void;
  onHoverResult?: (id: string | null) => void;
  /**
   * Toggle the on-map highlight for a related-ref. The first arg is the
   * parent candidate so the parent can promote it to selected when the
   * user picks a target on a card that wasn't already focused. Pass
   * `null` for `objectId` to clear.
   */
  onToggleHighlightRelated?: (resultId: string, objectId: string | null) => void;
  /** Currently-highlighted proposed-scenario draft id. The matching card
   *  in `ProposedScenariosBlock` gets a selected-state ring; the parent
   *  uses the same id to drive the on-map trajectory / spawn-marker /
   *  collision-X overlays. `null` means nothing is currently highlighted. */
  selectedScenarioId?: string | null;
  /** Toggle the highlight for a proposed-scenario draft. Clicking the
   *  same id again deselects (the parent will route `null` overlays);
   *  clicking a different id swaps the selection. */
  onSelectScenario?: (scenarioId: string) => void;
  /** esmini validation state for the highlighted scenario (decisions D1/D2),
   *  rendered as a verdict card under the matching draft. */
  validation?: ScenarioValidationState | null;
  /** When true, the prompt input auto-focuses on mount. */
  autoFocus?: boolean;
}

/**
 * Markdown component overrides for the assistant bubble. The LLM emits
 * GFM-flavored markdown (bullets, bold, occasional code spans); without
 * a renderer the panel surfaces literal `**bold**` and `- bullet`
 * characters which read terribly. Mirrors the styling in
 * `AssistantChat.tsx` so the two LLM surfaces feel consistent.
 *
 * `rehype-sanitize` strips any HTML the model might emit, so this is
 * safe to point at untrusted LLM output.
 */
const ASSISTANT_MD_COMPONENTS: ComponentProps<typeof ReactMarkdown>["components"] = {
  pre({ children }) {
    return <>{children}</>;
  },
  code({ className, children, ...props }) {
    const isBlock = /language-/.test(className ?? "");
    return isBlock ? (
      <pre className="my-1.5 overflow-x-auto rounded-md bg-background/80 p-2.5 text-[11px]">
        <code className={cn("font-mono", className)} {...props}>
          {children}
        </code>
      </pre>
    ) : (
      <code className="rounded bg-background/80 px-1 py-0.5 font-mono text-[11px]" {...props}>
        {children}
      </code>
    );
  },
  a({ href, children }) {
    return (
      <a
        href={href}
        target="_blank"
        rel="noreferrer"
        className="text-primary underline hover:opacity-80"
      >
        {children}
      </a>
    );
  },
  ul({ children }) {
    return <ul className="my-1 ml-4 list-disc space-y-0.5">{children}</ul>;
  },
  ol({ children }) {
    return <ol className="my-1 ml-4 list-decimal space-y-0.5">{children}</ol>;
  },
  li({ children }) {
    return <li className="leading-snug">{children}</li>;
  },
  p({ children }) {
    return <p className="mt-1 leading-relaxed first:mt-0">{children}</p>;
  },
  strong({ children }) {
    return <strong className="font-semibold text-foreground">{children}</strong>;
  },
  em({ children }) {
    return <em className="italic">{children}</em>;
  },
};

const CONVERSATION_STARTERS = [
  "Find a busy four-leg signalized intersection",
  "Build an unprotected left-turn collision at a 4-way signalized intersection",
  "Build a cut-in collision on a multi-lane arterial",
  "Build a pedestrian-crossing scenario near a school",
];

export function AiSearchPanel({
  search,
  selectedResultId,
  highlightedRelatedObjectId = null,
  onSelectResult,
  onZoomToResult,
  // Accepted for backward compat with SearchPanelTabs/MapDetailPageClient.
  // The AI panel routes "Use in scenario" through `search.sendMessage` so
  // the LLM bridge (propose_scenario_draft) handles the action — see
  // handleUseAiCandidateInScenario below. The prop is intentionally
  // unreferenced here to avoid double-firing the legacy tab-switch
  // behavior the keyword panel still uses.
  onUseInScenario: _onUseInScenarioLegacy,
  onHoverResult,
  onToggleHighlightRelated,
  selectedScenarioId = null,
  onSelectScenario,
  validation = null,
  autoFocus = false,
}: AiSearchPanelProps) {
  const [draft, setDraft] = useState("");
  // Debug mode mirrors the keyword search panel's `Bug` toggle: shows the
  // structured search_map calls the LLM made + their result summaries
  // beneath each assistant turn. Off by default; the toggle persists for
  // the panel session (resets on a fresh chat / map switch).
  const [showDebug, setShowDebug] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const threadRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (autoFocus) textareaRef.current?.focus();
  }, [autoFocus]);

  // Keep the thread pinned to the bottom so the most recent assistant turn
  // is visible after each round-trip. jsdom doesn't implement scrollTo, so
  // guard the call — there's nothing to scroll in tests anyway.
  useEffect(() => {
    const node = threadRef.current;
    if (!node || typeof node.scrollTo !== "function") return;
    node.scrollTo({ top: node.scrollHeight, behavior: "smooth" });
  }, [search.messages.length, search.isLoading]);

  function send(text: string) {
    const trimmed = text.trim();
    if (trimmed.length < 2) return;
    search.sendMessage(trimmed);
    setDraft("");
    textareaRef.current?.focus();
  }

  /**
   * AI-search "Use in scenario" → routes through the LLM bridge instead of
   * the legacy tab-switch.
   *
   * The synthesized prompt is intentionally neutral ("Use this … for the
   * scenario") instead of directive ("Let's build a collision scenario
   * at this …"). The neutral phrasing works in BOTH conversation states:
   *
   *   - Fresh / first pick — the LLM reads it as "user picked candidate
   *     X, proceed to inspect + propose."
   *   - Mid-conversation pick — when the LLM has just asked a clarifying
   *     question (e.g. "which approach should the subject use?"), the same
   *     message is interpreted as the user's *answer* to that question,
   *     not as a request to start over.
   *
   * The doc id is included so the LLM unambiguously resolves the
   * candidate — without it, the matcher has to scan recent search
   * results by title, which fails when the LLM is now offering
   * approach-street candidates whose titles weren't searched for in the
   * immediately-preceding turn.
   *
   * Also calls onSelectResult so the chosen candidate highlights on the
   * map for visual confirmation — the card's outer onClick that normally
   * handles selection is suppressed by the button's stopPropagation.
   */
  function handleUseAiCandidateInScenario(candidateId: string) {
    let candidate: LlmSearchCandidate | null = null;
    for (const message of search.messages) {
      if (message.role !== "assistant") continue;
      const found = message.candidates.find((c) => c.id === candidateId);
      if (found) {
        candidate = found;
        break;
      }
    }
    if (!candidate) return;

    onSelectResult(candidateId);
    const noun = subtypeToFriendlyNoun(candidate.subtype);
    search.sendMessage(
      `Use this ${noun} for the scenario: "${candidate.title}" (id: ${candidate.id}). Propose the draft when ready, or use this as my answer if you asked a clarifying question.`,
    );
  }

  const showStarterScreen =
    search.messages.length === 0 && !search.isLoading && !search.error && !search.unavailable;

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex shrink-0 items-center justify-between gap-2 border-b border-border bg-background/60 px-4 py-2">
        <p className="flex items-center gap-1.5 text-xs font-semibold text-foreground">
          <Sparkles className="size-3.5 text-primary" aria-hidden="true" />
          Find locations by chat
        </p>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => setShowDebug((prev) => !prev)}
            aria-label={showDebug ? "Hide debug info" : "Show debug info"}
            aria-pressed={showDebug}
            title={showDebug ? "Hide debug info" : "Show debug info"}
            className={cn(
              "inline-flex size-5 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-secondary/40 hover:text-foreground",
              showDebug && "bg-secondary/60 text-foreground",
            )}
          >
            <Bug className="size-3" />
          </button>
          {search.messages.length > 0 ? (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => search.reset()}
              aria-label="Clear AI search results and conversation"
              className="h-7 gap-1 px-2 text-[11px]"
            >
              <X className="size-3" aria-hidden="true" />
              Clear
            </Button>
          ) : null}
        </div>
      </div>

      <div ref={threadRef} className="min-h-0 flex-1 overflow-y-auto px-4 py-3">
        {showStarterScreen ? (
          <StarterScreen onPick={send} />
        ) : (
          <div className="space-y-3">
            {search.messages.map((message) => (
              <ThreadMessage
                key={message.id}
                message={message}
                selectedResultId={selectedResultId}
                highlightedRelatedObjectId={highlightedRelatedObjectId}
                showDebug={showDebug}
                onSelectResult={onSelectResult}
                onZoomToResult={onZoomToResult}
                onUseInScenario={handleUseAiCandidateInScenario}
                onHoverResult={onHoverResult}
                onToggleHighlightRelated={onToggleHighlightRelated}
                onPickFollowUp={send}
                selectedScenarioId={selectedScenarioId}
                onSelectScenario={onSelectScenario}
                validation={validation}
              />
            ))}

            {search.isLoading ? (
              <div className="flex items-center gap-2 px-1 text-xs text-muted-foreground">
                <Bot className="size-3.5" aria-hidden="true" />
                <Loader2 className="size-3 animate-spin" aria-hidden="true" />
                Thinking…
              </div>
            ) : null}

            {search.lastTurnStats ? (
              <p className="px-1 pt-1 text-[10px] text-muted-foreground">
                Considered {search.lastTurnStats.consideredDocuments} of{" "}
                {search.lastTurnStats.totalDocuments} indexed objects
                {search.lastTurnStats.corpusTruncated ? " (truncated)" : ""}.
              </p>
            ) : null}
          </div>
        )}

        {search.unavailable ? (
          <div className="mt-3 rounded-md border border-amber-500/30 bg-amber-500/10 p-3 text-xs text-amber-200">
            AI chat isn&apos;t configured for this environment. Switch to
            <span className="mx-1 font-mono">Search</span>
            mode to keep working.
          </div>
        ) : null}

        {search.error ? (
          <div className="mt-3 rounded-md border border-red-500/30 bg-red-500/10 p-3 text-xs text-red-200">
            {search.error}
          </div>
        ) : null}
      </div>

      <div className="shrink-0 border-t border-border bg-background/60 p-3">
        <div className="flex items-end gap-2">
          <textarea
            ref={textareaRef}
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && !event.shiftKey) {
                event.preventDefault();
                send(draft);
              }
            }}
            placeholder={
              search.messages.length === 0
                ? "Describe the kind of location you're looking for…"
                : "Refine, narrow, or ask a follow-up…"
            }
            rows={2}
            disabled={search.unavailable}
            className="flex-1 resize-none rounded-md border border-border bg-muted/30 px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-primary disabled:opacity-50"
            aria-label="Send a message to the AI search assistant"
          />
          <Button
            type="button"
            size="sm"
            onClick={() => send(draft)}
            disabled={search.isLoading || draft.trim().length < 2 || search.unavailable}
            className="h-9 gap-1"
            aria-label="Send message"
          >
            {search.isLoading ? (
              <Loader2 className="size-3.5 animate-spin" aria-hidden="true" />
            ) : (
              <Send className="size-3.5" aria-hidden="true" />
            )}
            Send
          </Button>
        </div>
        <p className="mt-1 text-[10px] text-muted-foreground">
          Enter to send • Shift+Enter for newline
        </p>
      </div>
    </div>
  );
}

function StarterScreen({ onPick }: { onPick: (text: string) => void }) {
  return (
    <div className="flex h-full min-h-0 flex-col gap-3">
      <div className="rounded-md border border-primary/20 bg-primary/5 p-3">
        <p className="flex items-center gap-1.5 text-xs font-semibold text-foreground">
          <Sparkles className="size-3.5 text-primary" aria-hidden="true" />
          Chat with the map
        </p>
        <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
          Tell the assistant what you&apos;re looking for. It will suggest indexed
          locations on this map and you can refine the conversation until you
          land on the right ones.
        </p>
      </div>
      <div className="space-y-1.5">
        <p className="text-[11px] uppercase tracking-wider text-muted-foreground">
          Try a starter
        </p>
        <div className="flex flex-col gap-1.5">
          {CONVERSATION_STARTERS.map((starter) => (
            <button
              key={starter}
              type="button"
              onClick={() => onPick(starter)}
              className="rounded-md border border-dashed border-border/70 bg-secondary/20 px-2.5 py-1.5 text-left text-xs text-foreground transition-colors hover:bg-secondary/40"
            >
              {starter}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}

function ThreadMessage({
  message,
  selectedResultId,
  highlightedRelatedObjectId,
  showDebug,
  onSelectResult,
  onZoomToResult,
  onUseInScenario,
  onHoverResult,
  onToggleHighlightRelated,
  onPickFollowUp,
  selectedScenarioId,
  onSelectScenario,
  validation,
}: {
  message: ChatMessage;
  selectedResultId: string | null;
  highlightedRelatedObjectId: string | null;
  showDebug: boolean;
  onSelectResult: (id: string) => void;
  onZoomToResult: (id: string) => void;
  onUseInScenario: (id: string) => void;
  onHoverResult?: (id: string | null) => void;
  onToggleHighlightRelated?: (resultId: string, objectId: string | null) => void;
  onPickFollowUp: (text: string) => void;
  selectedScenarioId: string | null;
  onSelectScenario?: (scenarioId: string) => void;
  validation?: ScenarioValidationState | null;
}) {
  if (message.role === "user") {
    return (
      <div className="flex items-start gap-2">
        <div className="mt-0.5 flex size-6 shrink-0 items-center justify-center rounded-full bg-secondary/60 text-muted-foreground">
          <User className="size-3" aria-hidden="true" />
        </div>
        <div className="flex-1 rounded-lg bg-secondary/40 px-3 py-2 text-sm text-foreground">
          {message.content}
        </div>
      </div>
    );
  }

  return (
    <AssistantBubble
      message={message}
      selectedResultId={selectedResultId}
      highlightedRelatedObjectId={highlightedRelatedObjectId}
      showDebug={showDebug}
      onSelectResult={onSelectResult}
      onZoomToResult={onZoomToResult}
      onUseInScenario={onUseInScenario}
      onHoverResult={onHoverResult}
      onToggleHighlightRelated={onToggleHighlightRelated}
      onPickFollowUp={onPickFollowUp}
      selectedScenarioId={selectedScenarioId}
      onSelectScenario={onSelectScenario}
      validation={validation}
    />
  );
}

function AssistantBubble({
  message,
  selectedResultId,
  highlightedRelatedObjectId,
  showDebug,
  onSelectResult,
  onZoomToResult,
  onUseInScenario,
  onHoverResult,
  onToggleHighlightRelated,
  onPickFollowUp,
  selectedScenarioId,
  onSelectScenario,
  validation,
}: {
  message: ChatAssistantMessage;
  selectedResultId: string | null;
  highlightedRelatedObjectId: string | null;
  showDebug: boolean;
  onSelectResult: (id: string) => void;
  onZoomToResult: (id: string) => void;
  onUseInScenario: (id: string) => void;
  onHoverResult?: (id: string | null) => void;
  onToggleHighlightRelated?: (resultId: string, objectId: string | null) => void;
  onPickFollowUp: (text: string) => void;
  selectedScenarioId: string | null;
  onSelectScenario?: (scenarioId: string) => void;
  validation?: ScenarioValidationState | null;
}) {
  return (
    <div className="flex items-start gap-2">
      <div className="mt-0.5 flex size-6 shrink-0 items-center justify-center rounded-full bg-primary/15 text-primary">
        <Bot className="size-3" aria-hidden="true" />
      </div>
      <div className="min-w-0 flex-1 space-y-2">
        <div className="group/bubble relative rounded-lg border border-primary/10 bg-primary/5 px-3 py-2 pr-8 text-sm leading-relaxed text-foreground">
          <ReactMarkdown
            remarkPlugins={[remarkGfm]}
            rehypePlugins={[rehypeSanitize]}
            components={ASSISTANT_MD_COMPONENTS}
          >
            {message.content}
          </ReactMarkdown>
          <div className="absolute right-1 top-1 opacity-0 transition-opacity group-hover/bubble:opacity-100 focus-within:opacity-100">
            <CopyJsonButton
              payload={{
                role: message.role,
                content: message.content,
                candidates: message.candidates,
                followUps: message.followUps,
                toolCalls: message.toolCalls,
                proposedScenarios: message.proposedScenarios,
                reasoning: message.reasoning ?? [],
              }}
              label="Copy turn as JSON"
            />
          </div>
        </div>
        {showDebug ? (
          <>
            <ReasoningDebug reasoning={message.reasoning ?? []} />
            <ToolCallsDebug toolCalls={message.toolCalls} />
          </>
        ) : null}
        {message.proposedScenarios.length > 0 ? (
          <ProposedScenariosBlock
            messageId={message.id}
            drafts={message.proposedScenarios}
            showDebug={showDebug}
            selectedScenarioId={selectedScenarioId}
            onSelectScenario={onSelectScenario}
            validation={validation}
          />
        ) : null}
        {message.candidates.length > 0 ? (
          <div className="space-y-2">
            {message.candidates.map((candidate) => (
              <CandidateCard
                key={`${message.id}-${candidate.id}`}
                candidate={candidate}
                selected={candidate.id === selectedResultId}
                highlightedRelatedObjectId={highlightedRelatedObjectId}
                onSelectResult={onSelectResult}
                onZoomToResult={onZoomToResult}
                onUseInScenario={onUseInScenario}
                onHoverResult={onHoverResult}
                onToggleHighlightRelated={onToggleHighlightRelated}
              />
            ))}
          </div>
        ) : null}
        {message.followUps.length > 0 ? (
          <div className="flex flex-wrap gap-1.5 pt-1">
            {message.followUps.map((followUp) => (
              <button
                key={`${message.id}-${followUp}`}
                type="button"
                onClick={() => onPickFollowUp(followUp)}
                className="rounded-full border border-primary/30 bg-primary/5 px-2.5 py-1 text-[11px] text-primary transition-colors hover:bg-primary/15"
              >
                {followUp}
              </button>
            ))}
          </div>
        ) : null}
      </div>
    </div>
  );
}

function CandidateCard({
  candidate,
  selected,
  highlightedRelatedObjectId,
  onSelectResult,
  onZoomToResult,
  onUseInScenario,
  onHoverResult,
  onToggleHighlightRelated,
}: {
  candidate: LlmSearchCandidate;
  selected: boolean;
  highlightedRelatedObjectId: string | null;
  onSelectResult: (id: string) => void;
  onZoomToResult: (id: string) => void;
  onUseInScenario: (id: string) => void;
  onHoverResult?: (id: string | null) => void;
  onToggleHighlightRelated?: (resultId: string, objectId: string | null) => void;
}) {
  const ResultIcon = iconForSubtype(candidate.subtype);
  const scorePct = Math.round(candidate.llmScore * 100);
  return (
    <div
      role="button"
      tabIndex={0}
      aria-pressed={selected}
      onClick={() => onSelectResult(candidate.id)}
      onKeyDown={(event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          onSelectResult(candidate.id);
        }
      }}
      onMouseEnter={() => onHoverResult?.(candidate.id)}
      onMouseLeave={() => onHoverResult?.(null)}
      onFocus={() => onHoverResult?.(candidate.id)}
      onBlur={() => onHoverResult?.(null)}
      className={cn(
        "w-full cursor-pointer rounded-lg border px-3 py-2 text-left transition-all",
        selected
          ? "border-primary/50 bg-primary/10"
          : "border-border bg-background/60 hover:bg-secondary/30",
      )}
    >
      <div className="flex items-center gap-2">
        <ResultIcon
          className="size-3.5 shrink-0 text-muted-foreground"
          aria-label={`${candidate.subtype} icon`}
        />
        <p className="min-w-0 flex-1 truncate text-sm font-semibold text-foreground">
          {candidate.title}
        </p>
        <Badge
          variant="secondary"
          className="shrink-0 border-transparent bg-emerald-500/15 px-1.5 py-0 font-mono text-[10px] text-emerald-400"
          title="LLM fit score"
        >
          {scorePct}%
        </Badge>
        {selected ? (
          <Check className="size-4 shrink-0 text-primary" aria-hidden="true" />
        ) : null}
      </div>

      <div className="mt-1.5 grid grid-cols-2 gap-2 text-[11px]">
        <div className="min-w-0">
          <p className="truncate text-muted-foreground">Type</p>
          <p className="truncate font-medium text-foreground">
            {formatFamilyLabel(candidate.objectFamily)}
          </p>
        </div>
        <div className="min-w-0">
          <p className="truncate text-muted-foreground">Subtype</p>
          <p className="truncate font-medium text-foreground">
            {candidate.subtype}
          </p>
        </div>
      </div>

      <p className="mt-1.5 text-[11px] leading-snug text-muted-foreground">
        {candidate.llmRationale}
      </p>

      {candidate.relatedObjectRefs && candidate.relatedObjectRefs.length > 0 ? (
        <div className="mt-1.5 space-y-1">
          {candidate.relatedObjectRefs.slice(0, 2).map((ref) => {
            const RefIcon = ref.subtype ? iconForSubtype(ref.subtype) : MapPin;
            const refHighlighted =
              highlightedRelatedObjectId === ref.objectId;
            return (
              <div
                key={`${candidate.id}-rel-${ref.objectId}`}
                className={cn(
                  "flex items-center gap-1.5 rounded-md border px-2 py-1 text-[11px] transition-colors",
                  refHighlighted
                    ? "border-primary/60 bg-primary/15"
                    : "border-border/60 bg-secondary/30",
                )}
                title={`${formatRelation(ref.relation)} ${ref.title ?? ref.objectId}${ref.distance_m != null ? ` (${ref.distance_m} m)` : ""}`}
              >
                <span className="flex items-center gap-1 text-muted-foreground">
                  <ArrowRight className="size-3" aria-hidden="true" />
                  <span className="font-medium">{formatRelation(ref.relation)}</span>
                </span>
                <RefIcon
                  className="size-3 shrink-0 text-muted-foreground"
                  aria-hidden="true"
                />
                <span className="min-w-0 flex-1 truncate text-foreground">
                  {ref.title ?? ref.objectId}
                </span>
                {ref.distance_m != null ? (
                  <span className="shrink-0 text-muted-foreground">
                    {ref.distance_m} m
                  </span>
                ) : null}
                {onToggleHighlightRelated ? (
                  <HighlightToggleButton
                    active={refHighlighted}
                    label={
                      refHighlighted
                        ? `Stop highlighting ${ref.title ?? ref.objectId} on the map`
                        : `Highlight ${ref.title ?? ref.objectId} on the map`
                    }
                    onClick={() =>
                      onToggleHighlightRelated(
                        candidate.id,
                        refHighlighted ? null : ref.objectId,
                      )
                    }
                  />
                ) : null}
              </div>
            );
          })}
        </div>
      ) : null}

      {candidate.llmAffordances.length > 0 ? (
        <div className="mt-1.5 flex flex-wrap gap-1">
          {candidate.llmAffordances.map((tag) => (
            <Badge
              key={`${candidate.id}-${tag}`}
              variant="secondary"
              className="border-transparent bg-secondary/50 px-1.5 py-0 text-[10px] text-foreground"
            >
              {tag}
            </Badge>
          ))}
        </div>
      ) : null}

      <div className="mt-1.5 flex items-center justify-end gap-1.5">
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="h-7 gap-1 px-2 text-[11px]"
          onClick={(event) => {
            event.stopPropagation();
            onZoomToResult(candidate.id);
          }}
        >
          <Target className="size-3" aria-hidden="true" />
          Zoom
        </Button>
        <Button
          type="button"
          variant="default"
          size="sm"
          className="h-7 gap-1 px-2 text-[11px]"
          onClick={(event) => {
            event.stopPropagation();
            onUseInScenario(candidate.id);
          }}
        >
          <Play className="size-3" aria-hidden="true" />
          Use in scenario
        </Button>
      </div>
    </div>
  );
}

