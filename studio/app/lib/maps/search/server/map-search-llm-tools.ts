/**
 * Tool-dispatch helper for the LLM map-search runner.
 *
 * Extracted from the for-loop inside `defaultLlmChatRunner` in
 * map-search-llm-service.ts. The runner's control flow (ordering, guards,
 * error paths) is unchanged — this file only moves the per-call dispatch
 * block into a named helper so the runner stays under 1 000 lines.
 */
import { ToolMessage } from "@langchain/core/messages";
import type { BaseMessage } from "@langchain/core/messages";
import {
  SearchMapToolArgsSchema,
  ProposeScenarioDraftToolArgsSchema,
  InspectLocationGeometryToolArgsSchema,
  PER_TOOL_CALL_CAPS,
  isViableGeometryReport,
} from "./map-search-llm-schemas";
import type {
  SearchMapToolFn,
  LlmRunnerProposeScenarioDraftFn,
  LlmRunnerInspectLocationGeometryFn,
} from "./map-search-llm-schemas";

interface ToolCall {
  id?: string;
  name: string;
  args: Record<string, unknown>;
}

export interface DispatchToolCallContext {
  iter: number;
  toolCallCounts: Record<string, number>;
  /** Mutated in-place: incremented on a successful propose call. */
  successfulProposeCountRef: { value: number };
  /** Mutated in-place: incremented when inspect returns viable geometry. */
  viableInspectCountRef: { value: number };
  /** Mutated in-place: set to the most recently inspected viable documentId. */
  lastViableInspectDocumentIdRef: { value: string | null };
  searchMap: SearchMapToolFn;
  proposeScenarioDraft?: LlmRunnerProposeScenarioDraftFn;
  inspectLocationGeometry?: LlmRunnerInspectLocationGeometryFn;
}

/**
 * Dispatch a single tool call emitted by the model, append the result as a
 * `ToolMessage` to `messages`, and update the mutable counters on `ctx`.
 *
 * Returns early (with a cap-error ToolMessage) when the per-tool runtime cap
 * is exceeded. Unknown tool names get an error ToolMessage so the model can
 * self-correct.
 */
export async function dispatchToolCall(
  call: ToolCall,
  idx: number,
  messages: BaseMessage[],
  ctx: DispatchToolCallContext,
): Promise<void> {
  const { iter } = ctx;

  // Some providers emit tool calls without a stable `id`. An empty
  // string is accepted by some routers but rejected by others; a
  // synthesized-but-stable id keeps the conversation linkage intact
  // either way. We log when this falls back so a brittle provider
  // can be diagnosed without re-instrumenting the loop.
  let toolCallId = call.id;
  if (!toolCallId) {
    toolCallId = `synthetic-${iter}-${idx}`;
    console.warn(
      `[map-search-llm] tool call (${call.name}) emitted without id at iter=${iter} idx=${idx}; using synthetic id`,
    );
  }

  // Enforce the per-tool runtime cap BEFORE we count the call so the
  // first over-cap invocation gets the error and the model can
  // observe the rejection on the next iteration. The error message
  // names both the tool and the cap so the model can decide whether
  // to retry differently or pivot to respond_to_user.
  const cap = PER_TOOL_CALL_CAPS[call.name as keyof typeof PER_TOOL_CALL_CAPS];
  if (cap != null && (ctx.toolCallCounts[call.name] ?? 0) >= cap) {
    console.warn(
      `[map-search-llm] tool '${call.name}' exceeded per-turn cap of ${cap} at iter=${iter}; short-circuiting with error`,
    );
    messages.push(
      new ToolMessage({
        tool_call_id: toolCallId,
        content: JSON.stringify({
          error: `tool_call_limit_exceeded: '${call.name}' may be called at most ${cap} time(s) per turn. Call respond_to_user with what you have so far.`,
        }),
      }),
    );
    return;
  }
  if (cap != null) {
    ctx.toolCallCounts[call.name] = (ctx.toolCallCounts[call.name] ?? 0) + 1;
  }

  if (call.name === "search_map") {
    const input = SearchMapToolArgsSchema.parse(call.args);
    let toolContent: string;
    try {
      const result = await ctx.searchMap(input);
      toolContent = JSON.stringify(result);
    } catch (err) {
      // Surface the failure to the model so it can adapt instead of
      // crashing the whole turn — e.g. retry with a simpler query.
      // Also log so operational visibility doesn't depend on the
      // model's downstream behavior.
      console.warn(
        `[map-search-llm] search_map tool error at iter=${iter}:`,
        err instanceof Error ? err.message : String(err),
      );
      toolContent = JSON.stringify({
        error: err instanceof Error ? err.message : String(err),
      });
    }
    messages.push(
      new ToolMessage({
        tool_call_id: toolCallId,
        content: toolContent,
      }),
    );
  } else if (call.name === "propose_scenario_draft" && ctx.proposeScenarioDraft) {
    let toolContent: string;
    try {
      const input = ProposeScenarioDraftToolArgsSchema.parse(call.args);
      const result = await ctx.proposeScenarioDraft(input);
      ctx.successfulProposeCountRef.value++;
      toolContent = JSON.stringify(result);
    } catch (err) {
      // Same fail-soft pattern as search_map: surface the error to the
      // model so it can choose to apologize and call respond_to_user
      // rather than crashing the turn. The wrapped callable rejects
      // with a useful message for the unknown-id case (no corpus doc).
      console.warn(
        `[map-search-llm] propose_scenario_draft tool error at iter=${iter}:`,
        err instanceof Error ? err.message : String(err),
      );
      toolContent = JSON.stringify({
        error: err instanceof Error ? err.message : String(err),
      });
    }
    messages.push(
      new ToolMessage({
        tool_call_id: toolCallId,
        content: toolContent,
      }),
    );
  } else if (call.name === "inspect_location_geometry" && ctx.inspectLocationGeometry) {
    let toolContent: string;
    try {
      const input = InspectLocationGeometryToolArgsSchema.parse(call.args);
      const result = await ctx.inspectLocationGeometry(input);
      if (isViableGeometryReport(result)) {
        ctx.viableInspectCountRef.value++;
        ctx.lastViableInspectDocumentIdRef.value = input.documentId;
      }
      toolContent = JSON.stringify(result);
    } catch (err) {
      // Fail-soft so the model can recover by picking a different
      // document or apologizing via respond_to_user.
      console.warn(
        `[map-search-llm] inspect_location_geometry tool error at iter=${iter}:`,
        err instanceof Error ? err.message : String(err),
      );
      toolContent = JSON.stringify({
        error: err instanceof Error ? err.message : String(err),
      });
    }
    messages.push(
      new ToolMessage({
        tool_call_id: toolCallId,
        content: toolContent,
      }),
    );
  } else {
    console.warn(
      `[map-search-llm] unknown tool call '${call.name}' at iter=${iter}; replying with error`,
    );
    messages.push(
      new ToolMessage({
        tool_call_id: toolCallId,
        content: JSON.stringify({ error: `unknown tool: ${call.name}` }),
      }),
    );
  }
}
