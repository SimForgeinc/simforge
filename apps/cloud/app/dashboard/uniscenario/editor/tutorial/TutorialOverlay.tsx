"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { X } from "lucide-react";
import { Button } from "@/app/components/ui/button";
import {
  markTutorialComplete,
  reachableSteps,
  shouldRunTutorial,
  tutorialStepsForMode,
  type TutorialStep,
} from "./tutorial-steps";
import type { EditorExperience } from "../simple-timed-routes";

type Rect = { top: number; left: number; width: number; height: number };

/**
 * The first-run walkthrough.
 *
 * It is a dialog, not decoration: focus moves into it, Escape closes it, and the
 * arrow keys step it. A tour that traps a keyboard user is worse than no tour, so
 * everything it does is reachable without a pointer.
 *
 * The spotlight is a ring drawn *around* the anchor rather than a mask cut out of
 * a backdrop. A masked backdrop has to sit above the editor to dim it, which
 * means it also eats the click the step is telling the author to make — v1 solved
 * this with `pointer-events-none` on the backdrop and re-enabling it per hole,
 * and the ring avoids the problem instead of managing it.
 */
export function TutorialOverlay({
  mode,
  onClose,
}: {
  mode: EditorExperience;
  onClose: () => void;
}) {
  const [index, setIndex] = useState(0);
  const [rect, setRect] = useState<Rect | null>(null);

  const steps = useMemo(
    () =>
      reachableSteps(tutorialStepsForMode(mode), (anchor) =>
        Boolean(document.querySelector(`[data-tutorial="${anchor}"]`)),
      ),
    [mode],
  );
  const step: TutorialStep | undefined = steps[index];

  const finish = useCallback(() => {
    markTutorialComplete(readStorage(), mode);
    onClose();
  }, [mode, onClose]);

  // Track the anchor's box. Scroll and resize both move it, and the rails are
  // independently scrollable, so a one-shot measurement drifts.
  useEffect(() => {
    if (!step?.anchor) {
      setRect(null);
      return;
    }
    const measure = () => {
      const node = document.querySelector(`[data-tutorial="${step.anchor}"]`);
      if (!node) return setRect(null);
      const box = node.getBoundingClientRect();
      setRect({
        top: box.top,
        left: box.left,
        width: box.width,
        height: box.height,
      });
    };
    measure();
    window.addEventListener("resize", measure);
    window.addEventListener("scroll", measure, true);
    return () => {
      window.removeEventListener("resize", measure);
      window.removeEventListener("scroll", measure, true);
    };
  }, [step?.anchor]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        finish();
        return;
      }
      if (event.key === "ArrowRight") {
        event.preventDefault();
        setIndex((current) => Math.min(current + 1, steps.length - 1));
        return;
      }
      if (event.key === "ArrowLeft") {
        event.preventDefault();
        setIndex((current) => Math.max(current - 1, 0));
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [finish, steps.length]);

  if (!step) return null;
  const last = index === steps.length - 1;

  return (
    <div className="pointer-events-none fixed inset-0 z-[80]">
      {rect ? (
        <div
          aria-hidden="true"
          className="tutorial-spotlight-ring absolute border-2 border-primary"
          style={{
            top: rect.top - 2,
            left: rect.left - 2,
            width: rect.width + 4,
            height: rect.height + 4,
          }}
        />
      ) : null}

      <div
        aria-labelledby="uniscenario-tutorial-title"
        aria-modal="false"
        className="pointer-events-auto absolute w-[min(22rem,calc(100vw-2rem))] border border-border bg-popover p-4 text-popover-foreground shadow-2xl"
        role="dialog"
        style={cardPosition(step, rect)}
      >
        <div className="flex items-start gap-2">
          <div className="min-w-0 flex-1">
            <p className="text-micro font-bold uppercase tracking-meta-wider text-primary">
              {mode} mode · Step {index + 1} of {steps.length}
            </p>
            <h2
              className="mt-1 text-sm font-semibold"
              id="uniscenario-tutorial-title"
            >
              {step.title}
            </h2>
          </div>
          <button
            type="button"
            aria-label="Skip the walkthrough"
            className="editor-motion -mr-1 -mt-1 inline-flex size-7 shrink-0 items-center justify-center text-muted-foreground hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-popover"
            onClick={finish}
          >
            <X aria-hidden="true" className="size-4" />
          </button>
        </div>
        <p className="mt-2 text-xs leading-5 text-muted-foreground">{step.body}</p>
        <div className="mt-4 flex items-center gap-2">
          <Button
            className="h-8"
            disabled={index === 0}
            size="sm"
            variant="outline"
            onClick={() => setIndex((current) => Math.max(current - 1, 0))}
          >
            Back
          </Button>
          <Button
            autoFocus
            className="ml-auto h-8"
            size="sm"
            onClick={() =>
              last ? finish() : setIndex((current) => current + 1)
            }
          >
            {last ? "Start authoring" : "Next"}
          </Button>
        </div>
        <p className="mt-2 text-micro text-muted-foreground">
          ← → to step · Esc to skip
        </p>
      </div>
    </div>
  );
}

/**
 * Place the card beside its anchor, clamped into the viewport.
 *
 * Clamping matters more than the requested side: the rails are 220px at the
 * narrow breakpoint and a 352px card anchored to one would otherwise hang off
 * screen with its buttons unreachable.
 */
function cardPosition(step: TutorialStep, rect: Rect | null) {
  if (!rect) {
    return { top: "50%", left: "50%", transform: "translate(-50%, -50%)" };
  }
  const GAP = 12;
  const CARD_W = 352;
  const CARD_H = 220;
  const vw = typeof window === "undefined" ? CARD_W : window.innerWidth;
  const vh = typeof window === "undefined" ? CARD_H : window.innerHeight;

  let top = rect.top;
  let left = rect.left + rect.width + GAP;
  if (step.side === "left") left = rect.left - CARD_W - GAP;
  if (step.side === "bottom") {
    top = rect.top + rect.height + GAP;
    left = rect.left;
  }
  if (step.side === "top") {
    top = rect.top - CARD_H - GAP;
    left = rect.left;
  }

  return {
    top: clamp(top, GAP, Math.max(GAP, vh - CARD_H - GAP)),
    left: clamp(left, GAP, Math.max(GAP, vw - CARD_W - GAP)),
  };
}

function clamp(value: number, min: number, max: number) {
  return Math.max(min, Math.min(max, value));
}

function readStorage(): Storage | null {
  try {
    return typeof window === "undefined" ? null : window.localStorage;
  } catch {
    return null;
  }
}

/** Whether this browser has already been walked through. */
export function tutorialPending(mode: EditorExperience): boolean {
  return shouldRunTutorial(readStorage(), mode);
}
