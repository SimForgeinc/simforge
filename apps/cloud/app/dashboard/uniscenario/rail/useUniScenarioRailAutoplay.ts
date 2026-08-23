"use client";

import { useCallback, useEffect, useRef, useState } from "react";

/** How long a scenario stays on screen before autoplay advances. */
export const RAIL_AUTOPLAY_DWELL_MS = 6_000;

export type UniScenarioRailAutoplay = {
  playing: boolean;
  /** 0–1 through the current dwell, for the progress affordance. */
  progress: number;
  toggle: () => void;
  stop: () => void;
};

/**
 * Step automatically through a dataset's scenarios — the review loop.
 *
 * **Reshaped from v1, and the difference matters.** v1's `useDatasetScenarioAutoplay` pressed play on a
 * *simulation*: it waited for a map-settle window, checked that the staged frames came from the draft
 * actually open, and refused when a saved worker timeline was queued for the same window. It could do
 * that because v1 had a browser preview engine to press play on.
 *
 * v2 has no playback engine yet — preview simulation is a later wave (manifest §7, items 123–133). So
 * autoplay here advances the *selection* on a dwell rather than driving a clip, which is the part of
 * the review loop that works today: the reviewer rates, autoplay moves on. Two properties from v1 are
 * kept because they are what makes it usable rather than annoying:
 *
 * - It stops at the end rather than wrapping. A loop that silently restarts makes a reviewer lose
 *   their place in a long dataset.
 * - It pauses on `document.hidden`, so a backgrounded tab does not burn through the queue unseen.
 *
 * When the preview engine lands, the gate belongs here: hold the dwell until the clip has actually
 * played once, instead of advancing on wall-clock.
 */
export function useUniScenarioRailAutoplay({
  canAdvance,
  onAdvance,
  dwellMs = RAIL_AUTOPLAY_DWELL_MS,
  /** Held true while the newly selected document is still loading, which pauses the dwell. */
  waiting = false,
  /**
   * Restarts the dwell when it changes — pass the active document id.
   *
   * The dwell deliberately does NOT re-arm on `onAdvance` changing identity. A caller that rebuilds
   * that callback per render (the common case, since it closes over the selection) would otherwise
   * reset the timer on every render and never reach the end of a dwell.
   */
  advanceKey = null,
}: {
  canAdvance: boolean;
  onAdvance: () => void;
  dwellMs?: number;
  waiting?: boolean;
  advanceKey?: string | null;
}): UniScenarioRailAutoplay {
  const [playing, setPlaying] = useState(false);
  const [progress, setProgress] = useState(0);
  const startedAtRef = useRef<number | null>(null);
  const onAdvanceRef = useRef(onAdvance);
  onAdvanceRef.current = onAdvance;

  const stop = useCallback(() => {
    setPlaying(false);
    setProgress(0);
    startedAtRef.current = null;
  }, []);

  // Reaching the end of the dataset ends the run rather than wrapping.
  useEffect(() => {
    if (playing && !canAdvance) stop();
  }, [canAdvance, playing, stop]);

  useEffect(() => {
    if (!playing || waiting) return;
    if (typeof document !== "undefined" && document.hidden) return;

    startedAtRef.current = Date.now();
    setProgress(0);
    // A ~10Hz tick rather than a RAF loop: the only thing being animated is a progress bar, and a
    // background-tab RAF is throttled in ways that would make the dwell length unpredictable.
    const tick = window.setInterval(() => {
      const startedAt = startedAtRef.current;
      if (startedAt === null) return;
      setProgress(Math.min(1, (Date.now() - startedAt) / dwellMs));
    }, 100);
    const advance = window.setTimeout(() => {
      if (!canAdvance) {
        stop();
        return;
      }
      onAdvanceRef.current();
    }, dwellMs);

    return () => {
      window.clearInterval(tick);
      window.clearTimeout(advance);
    };
  }, [advanceKey, canAdvance, dwellMs, playing, stop, waiting]);

  useEffect(() => {
    if (!playing) return;
    const onVisibilityChange = () => {
      // Re-running the effect above is what resumes; pausing is simply not ticking while hidden.
      if (document.hidden) startedAtRef.current = null;
      else startedAtRef.current = Date.now();
    };
    document.addEventListener("visibilitychange", onVisibilityChange);
    return () => document.removeEventListener("visibilitychange", onVisibilityChange);
  }, [playing]);

  const toggle = useCallback(() => {
    setPlaying((current) => {
      if (current) {
        startedAtRef.current = null;
        setProgress(0);
        return false;
      }
      return canAdvance;
    });
  }, [canAdvance]);

  return { playing, progress, toggle, stop };
}
