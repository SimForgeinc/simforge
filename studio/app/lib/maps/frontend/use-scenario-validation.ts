import { useCallback, useEffect, useRef, useState } from "react";

import type {
  EsminiValidationMetrics,
  ScenarioValidationJob,
  ScenarioValidationVerdict,
} from "@simcloud/shared";

import { useVisiblePolling } from "@/app/lib/use-visible-polling";

/**
 * Drives esmini validation for the AI panel's currently-highlighted scenario.
 *
 * Non-blocking (decision D2): the panel stays interactive while this runs in
 * the background. Auto-triggering (decision D1): when a freshly-finalized
 * draft becomes the selected scenario it has no prior attempt, so the first
 * status read kicks off attempt 1; re-selecting an already-validated draft
 * just displays its stored verdict without restarting. The poll loop both
 * surfaces progress and (server-side, via /validate/status) advances the
 * auto-repair loop until a verdict lands or the budget is exhausted.
 */

type StatusResponse = {
  latest: ScenarioValidationJob | null;
  history: ScenarioValidationJob[];
  working: boolean;
  maxAttempts: number;
  advance: string | null;
};

export interface ScenarioValidationState {
  latest: ScenarioValidationJob | null;
  history: ScenarioValidationJob[];
  /** True while an attempt is pending/running or a repair was just enqueued. */
  working: boolean;
  maxAttempts: number;
  attemptsUsed: number;
  verdict: ScenarioValidationVerdict | null;
  metrics: EsminiValidationMetrics | null;
  /** What the last poll's server-side repair-advance decided ("repair_enqueued"
   *  / "budget_exhausted" / "no_action"), or null if it threw (transient). */
  advance: string | null;
  /** Non-null when starting or polling failed (e.g. a compile 422). */
  error: string | null;
}

const INITIAL: ScenarioValidationState = {
  latest: null,
  history: [],
  working: false,
  maxAttempts: 0,
  attemptsUsed: 0,
  verdict: null,
  metrics: null,
  advance: null,
  error: null,
};

const POLL_INTERVAL_MS = 2000;

export function useScenarioValidation(
  scenarioId: string | null,
): ScenarioValidationState {
  const [state, setState] = useState<ScenarioValidationState>(INITIAL);

  // The scenario we've already issued a POST /validate for, so re-selecting or
  // re-polling never double-dispatches a fresh run.
  const startedRef = useRef<string | null>(null);

  useEffect(() => {
    setState(INITIAL);
    startedRef.current = null;
  }, [scenarioId]);

  const refresh = useCallback(async () => {
    if (!scenarioId) return;
    const base = `/api/scenarios/${encodeURIComponent(scenarioId)}/validate`;
    try {
      const res = await fetch(`${base}/status`, { cache: "no-store" });
      if (!res.ok) {
        setState((s) => ({ ...s, error: `status ${res.status}` }));
        return;
      }
      const data = (await res.json()) as StatusResponse;
      setState({
        latest: data.latest,
        history: data.history ?? [],
        working: data.working,
        maxAttempts: data.maxAttempts,
        attemptsUsed: data.latest?.attempt ?? 0,
        verdict: data.latest?.verdict ?? null,
        metrics: data.latest?.metrics ?? null,
        advance: data.advance ?? null,
        error: null,
      });

      // Auto-start (D1): no attempt exists yet for a freshly-finalized draft.
      if (data.latest == null && startedRef.current !== scenarioId) {
        startedRef.current = scenarioId;
        const post = await fetch(base, { method: "POST" });
        if (!post.ok) {
          const body = (await post.json().catch(() => null)) as
            | { error?: string }
            | null;
          setState((s) => ({
            ...s,
            error: body?.error ?? `validate start failed (${post.status})`,
          }));
        }
      }
    } catch {
      setState((s) => ({ ...s, error: "network error" }));
    }
  }, [scenarioId]);

  // Immediate read on selection change instead of waiting a full interval.
  useEffect(() => {
    void refresh();
  }, [refresh]);

  // Keep polling until the auto-repair loop is *truly* terminal. Stopping as
  // soon as `latest` exists and `working` is false would prematurely halt the
  // loop after a transient repair/enqueue hiccup: the status route swallows
  // `advanceRepairIfNeeded` errors to retry on the next poll, so we must give
  // it that next poll. We stop only on:
  //   - a passing verdict,
  //   - the budget being exhausted, or
  //   - the server settling on "no further action" for a completed attempt
  //     (e.g. no repair available, or a non-repairable failure).
  // A null `advance` means the advance threw (transient) → keep polling.
  const exhausted =
    state.advance === "budget_exhausted" ||
    (state.maxAttempts > 0 && state.attemptsUsed >= state.maxAttempts);
  const serverSettled =
    state.advance === "no_action" && !state.working && state.latest != null;
  const polling =
    scenarioId != null &&
    state.error == null &&
    state.verdict !== "pass" &&
    !exhausted &&
    !serverSettled;
  useVisiblePolling(refresh, POLL_INTERVAL_MS, polling);

  return state;
}
