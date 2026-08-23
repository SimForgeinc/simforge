"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { MapSearchResult } from "@/app/lib/maps/search/map-search";

/**
 * Client hook driving the conversational candidate-location chat.
 *
 * State:
 *   - `messages` is the rendered chat thread (user + assistant turns). Each
 *     assistant turn may carry a candidates[] payload that the panel renders
 *     as inline cards beneath the bubble.
 *   - `isLoading` is true while a turn is in flight.
 *   - `unavailable` is true once the server responds with 503 (no
 *     ANTHROPIC_API_KEY configured); the panel should explain the fallback.
 *
 * Submitting calls `sendMessage(text)`, which appends the user turn locally
 * and POSTs the full transcript to the server. The server returns a single
 * new assistant turn, which is appended on success. In-flight requests are
 * aborted when a newer message is sent or when the hook unmounts.
 */

export interface LlmSearchCandidate extends MapSearchResult {
  llmScore: number;
  llmRationale: string;
  llmAffordances: string[];
}

/**
 * Per-turn record of one `search_map` invocation, surfaced by the server
 * so the AI Search panel's debug toggle can show under-the-hood: which
 * structured query the LLM composed for the user's prompt, what came
 * back. Mirrors the server's `LlmToolCallRecord`; kept here as a local
 * type so the hook's consumers don't have to import server-side modules.
 */
export interface LlmToolCallRecord {
  callIndex: number;
  structured: {
    subject: {
      families?: Array<"junction" | "street" | "poi">;
      semantic?: string[];
      freeText?: string[];
    };
    relation?: {
      op:
        | "near"
        | "adjacent_to"
        | "within"
        | "leads_to"
        | "connected_to"
        | "upstream_of"
        | "downstream_of";
      distance_m?: number;
      object: {
        families?: Array<"junction" | "street" | "poi">;
        semantic?: string[];
        freeText?: string[];
      };
    };
  };
  limit?: number;
  result: {
    totalDocuments: number;
    resultCount: number;
    parseHints?: Array<{ code: string; message: string }>;
    topResults: Array<{
      id: string;
      title: string;
      subtype: string;
      family: string;
    }>;
  };
}

export interface ChatUserMessage {
  id: string;
  role: "user";
  content: string;
}

/**
 * Mirror of the server-side `LlmProposedScenarioRecord`. Surfaced on each
 * assistant turn so the panel can render an "Open in editor" affordance
 * for any drafts the LLM created via `propose_scenario_draft`.
 */
export interface LlmProposedScenarioRecord {
  scenarioId: string;
  datasetId: string;
  mapAssetId: string;
  documentId: string;
  candidateId: string | null;
  displayName: string;
  editorHref: string;
  /** Collision family the populated-draft builder instantiated, when the
   *  LLM picked one. Null on legacy / location-only drafts. */
  family: string | null;
  /** Number of actors placed by the populated-draft builder. Null on
   *  legacy / location-only drafts. */
  actorCount: number | null;
  /** Multi-line markdown the panel renders inside the draft-created card.
   *  Null on legacy / location-only drafts. */
  description: string | null;
  /** Inline kinematic-validation summary — lets the panel render a
   *  FAILED draft as a failure instead of an openable success. Null on
   *  legacy / location-only drafts. */
  validation: {
    verdict: "pass" | "fail";
    needsRevision: boolean;
    reason: string | null;
  } | null;
}

export interface ChatAssistantMessage {
  id: string;
  role: "assistant";
  content: string;
  candidates: LlmSearchCandidate[];
  followUps: string[];
  toolCalls: LlmToolCallRecord[];
  proposedScenarios: LlmProposedScenarioRecord[];
  /** Extended-thinking text emitted by the model — one entry per
   *  tool-loop iteration. Populated only when
   *  `ANTHROPIC_THINKING_ENABLED=true` (dev only by default). Surfaced
   *  through the panel's debug toggle. Optional so older test fixtures
   *  and legacy persisted chats deserialize cleanly; consumers should
   *  treat absent as empty array. */
  reasoning?: string[];
}

export type ChatMessage = ChatUserMessage | ChatAssistantMessage;

interface ServerAssistantMessage {
  role: "assistant";
  content: string;
  candidates: LlmSearchCandidate[];
  followUps: string[];
  toolCalls: LlmToolCallRecord[];
  proposedScenarios?: LlmProposedScenarioRecord[];
  reasoning?: string[];
}

interface ServerResponse {
  mapAssetId: string;
  message: ServerAssistantMessage;
  consideredDocuments: number;
  totalDocuments: number;
  corpusTruncated: boolean;
}

export interface UseMapSearchLlmResult {
  messages: ChatMessage[];
  isLoading: boolean;
  /** Plain-text error message for display. */
  error: string | null;
  /** True when the server reports the LLM is not configured (503). */
  unavailable: boolean;
  /** Last server-side considered/total counts; null until the first reply. */
  lastTurnStats: {
    consideredDocuments: number;
    totalDocuments: number;
    corpusTruncated: boolean;
  } | null;
  sendMessage: (content: string) => void;
  reset: () => void;
}

let messageIdCounter = 0;
function nextMessageId(role: "user" | "assistant"): string {
  messageIdCounter += 1;
  return `${role}-${Date.now().toString(36)}-${messageIdCounter}`;
}

export function useMapSearchLlm(mapAssetId: string): UseMapSearchLlmResult {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [unavailable, setUnavailable] = useState(false);
  const [lastTurnStats, setLastTurnStats] = useState<
    UseMapSearchLlmResult["lastTurnStats"]
  >(null);
  // Mirror messages in a ref so sendMessage can read the latest history
  // without depending on it (which would re-create sendMessage every turn
  // and invalidate the abort controller mid-flight).
  const messagesRef = useRef<ChatMessage[]>([]);
  useEffect(() => {
    messagesRef.current = messages;
  }, [messages]);
  const abortRef = useRef<AbortController | null>(null);

  const reset = useCallback(() => {
    abortRef.current?.abort();
    setMessages([]);
    setIsLoading(false);
    setError(null);
    setUnavailable(false);
    setLastTurnStats(null);
  }, []);

  const sendMessage = useCallback(
    (content: string) => {
      const trimmed = content.trim();
      if (!mapAssetId || trimmed.length < 2) return;

      const userMessage: ChatUserMessage = {
        id: nextMessageId("user"),
        role: "user",
        content: trimmed,
      };
      const nextMessages = [...messagesRef.current, userMessage];
      setMessages(nextMessages);

      abortRef.current?.abort();
      const controller = new AbortController();
      abortRef.current = controller;

      setIsLoading(true);
      setError(null);
      setUnavailable(false);

      const payload = {
        messages: nextMessages.map((m) => ({ role: m.role, content: m.content })),
      };

      fetch(`/api/map-assets/${encodeURIComponent(mapAssetId)}/search/llm`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
        signal: controller.signal,
      })
        .then(async (res) => {
          if (res.status === 503) {
            setUnavailable(true);
            setIsLoading(false);
            return;
          }
          if (!res.ok) {
            const text = await res.text().catch(() => "");
            throw new Error(
              `AI chat failed (${res.status})${text ? `: ${text}` : ""}`,
            );
          }
          const parsed = (await res.json()) as ServerResponse;
          if (controller.signal.aborted) return;
          setMessages((prev) => [
            ...prev,
            {
              id: nextMessageId("assistant"),
              role: "assistant",
              content: parsed.message.content,
              candidates: parsed.message.candidates,
              followUps: parsed.message.followUps,
              toolCalls: parsed.message.toolCalls ?? [],
              proposedScenarios: parsed.message.proposedScenarios ?? [],
              reasoning: parsed.message.reasoning ?? [],
            },
          ]);
          setLastTurnStats({
            consideredDocuments: parsed.consideredDocuments,
            totalDocuments: parsed.totalDocuments,
            corpusTruncated: parsed.corpusTruncated,
          });
          setIsLoading(false);
        })
        .catch((err: unknown) => {
          if ((err as { name?: string })?.name === "AbortError") return;
          setError(err instanceof Error ? err.message : String(err));
          setIsLoading(false);
        });
    },
    [mapAssetId],
  );

  useEffect(
    () => () => {
      abortRef.current?.abort();
    },
    [],
  );

  // Switching maps must wipe the chat — candidate ids reference the old map's
  // corpus, and the prior conversation is meaningless against a new map. The
  // page client switches maps in-place via setCurrentAsset, so the hook keeps
  // running with a new mapAssetId; without this effect, the old transcript
  // would persist and any send would post the stale history to the new map.
  // We also clear `messagesRef` synchronously so a `sendMessage` fired in the
  // same render as the map switch can't read the stale transcript before the
  // commit-phase effect that mirrors `messages` runs.
  useEffect(() => {
    abortRef.current?.abort();
    messagesRef.current = [];
    setMessages([]);
    setIsLoading(false);
    setError(null);
    setUnavailable(false);
    setLastTurnStats(null);
  }, [mapAssetId]);

  return {
    messages,
    isLoading,
    error,
    unavailable,
    lastTurnStats,
    sendMessage,
    reset,
  };
}
