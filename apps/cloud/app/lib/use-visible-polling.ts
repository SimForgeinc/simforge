import { useEffect, useRef } from "react";

/**
 * Run an abortable poll immediately and then `intervalMs` after each request
 * settles, but only while the tab is visible.
 *
 * The callback lives in a ref so an ordinary render never resets the cadence.
 * `requestKey` identifies the resource being polled; changing it aborts the old
 * request before starting the new resource's initial refresh.
 */
export function useVisiblePolling(
  callback: (signal: AbortSignal) => void | Promise<void>,
  intervalMs: number,
  enabled: boolean = true,
  requestKey?: unknown,
): void {
  const callbackRef = useRef(callback);
  callbackRef.current = callback;

  useEffect(() => {
    if (!enabled) return;

    let disposed = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let controller: AbortController | null = null;
    let runGeneration = 0;
    let foregroundRefreshIssued = false;

    const visible = () =>
      typeof document === "undefined" || document.visibilityState === "visible";

    const clearTimer = () => {
      if (timer !== null) {
        clearTimeout(timer);
        timer = null;
      }
    };

    const abortRequest = () => {
      runGeneration += 1;
      controller?.abort();
      controller = null;
    };

    const schedule = () => {
      clearTimer();
      if (disposed || !visible()) return;
      timer = setTimeout(() => {
        timer = null;
        void run();
      }, intervalMs);
    };

    const run = async () => {
      if (disposed || !visible() || controller) return;
      const generation = ++runGeneration;
      const nextController = new AbortController();
      controller = nextController;
      try {
        await callbackRef.current(nextController.signal);
      } catch {
        // The owning surface decides how to retain data and expose retry errors.
        // Keeping the scheduler alive here makes retry behavior consistent.
      } finally {
        if (
          !disposed &&
          generation === runGeneration &&
          controller === nextController
        ) {
          controller = null;
          if (!nextController.signal.aborted) schedule();
        }
      }
    };

    const refreshForeground = () => {
      if (!visible() || foregroundRefreshIssued) return;
      foregroundRefreshIssued = true;
      clearTimer();
      void run();
    };

    const pause = () => {
      foregroundRefreshIssued = false;
      clearTimer();
      abortRequest();
    };

    const onVisibility = () => {
      if (visible()) refreshForeground();
      else pause();
    };
    const onFocus = () => refreshForeground();
    const onBlur = () => {
      foregroundRefreshIssued = false;
    };

    if (visible()) refreshForeground();

    if (typeof document !== "undefined") {
      document.addEventListener("visibilitychange", onVisibility);
      window.addEventListener("focus", onFocus);
      window.addEventListener("blur", onBlur);
    }

    return () => {
      disposed = true;
      clearTimer();
      abortRequest();
      if (typeof document !== "undefined") {
        document.removeEventListener("visibilitychange", onVisibility);
        window.removeEventListener("focus", onFocus);
        window.removeEventListener("blur", onBlur);
      }
    };
  }, [enabled, intervalMs, requestKey]);
}
