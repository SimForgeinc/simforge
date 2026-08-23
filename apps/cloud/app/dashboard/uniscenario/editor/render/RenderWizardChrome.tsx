"use client";

import type { LucideIcon } from "lucide-react";
import type { ReactNode } from "react";
import { ArrowLeft, ArrowRight, Check } from "lucide-react";
import { cn } from "@/app/lib/utils";

/**
 * The chrome every step of the new-render flow shares.
 *
 * Creating a render used to be one screen holding every control at once — engine, sensors, kinds,
 * clip window, outputs, resolution, FPS, quality, preflight and the submit button — which at pane
 * width meant an author scrolled a form to find out what they were even choosing. It is now a short
 * sequence of decisions, and these three pieces are what makes each step look like the same surface:
 * a rail that says where you are, a body that must fit, and a footer that owns movement.
 *
 * The body deliberately clips instead of scrolling. A step that does not fit is a step that is
 * asking for too much at once, and the fix is to split it rather than to hand the author a scrollbar
 * — the render pane's only scrollable region is the gallery.
 */

export type RenderWizardStep = { id: string; label: string };

export function RenderWizardStepRail({
  steps,
  activeIndex,
  onSelect,
}: {
  steps: readonly RenderWizardStep[];
  activeIndex: number;
  /** Called for an already-completed step only; later steps stay disabled. */
  onSelect: (index: number) => void;
}) {
  return (
    <ol className="flex flex-wrap items-center gap-x-1 gap-y-1" data-testid="render-wizard-steps">
      {steps.map((step, index) => {
        const state = index === activeIndex ? "active" : index < activeIndex ? "done" : "todo";
        return (
          <li className="flex items-center gap-1" key={step.id}>
            {index > 0 ? <span aria-hidden="true" className="w-3 border-t render-hairline" /> : null}
            <button
              aria-current={state === "active" ? "step" : undefined}
              className={cn(
                "editor-motion inline-flex items-center gap-1.5 px-2 py-1 text-micro font-bold uppercase tracking-meta focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                state === "active"
                  ? "bg-primary text-primary-foreground"
                  : state === "done"
                    ? "text-foreground/80 hover:text-primary"
                    : "cursor-default text-muted-foreground/50",
              )}
              data-state={state}
              data-testid={`render-wizard-step-${step.id}`}
              disabled={state === "todo"}
              onClick={() => onSelect(index)}
              type="button"
            >
              {state === "done" ? (
                <Check aria-hidden="true" className="size-3" />
              ) : (
                <span className="font-mono">{String(index + 1).padStart(2, "0")}</span>
              )}
              {step.label}
            </button>
          </li>
        );
      })}
    </ol>
  );
}

/**
 * One step's content area: fills the pane, never scrolls.
 *
 * `overflow-hidden` is the constraint that keeps the flow honest. `min-h-0` is what makes it apply
 * at all inside the pane's flex column.
 *
 * The step's decisions sit in the middle of that area rather than pinned to its top. The render
 * pane is as tall as the workspace, and a two-card step aligned to the top left a single choice
 * stranded above roughly a thousand pixels of blurred scene — the flow read as a fragment of a
 * form rather than a question being asked. Centring is `safe`, not plain, because plain `center`
 * overflows a clipped box in *both* directions: measured in Chrome, an overflowing column starts
 * 80px above its own top edge, so the step's heading would be the first thing lost on a scenario
 * with many sensors. `safe center` falls back to start alignment exactly then, and browsers that
 * do not know the keyword drop the declaration and keep the old top alignment.
 */
export function RenderWizardBody({
  children,
  className,
  testId,
}: {
  children: ReactNode;
  className?: string;
  testId?: string;
}) {
  return (
    <div
      className={cn(
        "render-step-center flex min-h-0 flex-1 flex-col overflow-hidden px-6 py-5",
        className,
      )}
      data-testid={testId}
    >
      {children}
    </div>
  );
}

/**
 * The footer: a note about the step on the left, movement on the right.
 *
 * `primary` replaces the Next button on the last step, so the one button that submits a render is
 * always in the same place rather than buried under whichever section the author scrolled to.
 */
export function RenderWizardFooter({
  note,
  onBack,
  backLabel = "Back",
  onNext,
  nextLabel = "Next",
  nextDisabled = false,
  primary,
}: {
  note?: ReactNode;
  onBack?: () => void;
  backLabel?: string;
  onNext?: () => void;
  nextLabel?: string;
  nextDisabled?: boolean;
  primary?: ReactNode;
}) {
  return (
    <footer className="flex shrink-0 items-center justify-between gap-4 render-glass-raised border-t px-6 py-3.5">
      <div className="min-w-0 text-micro text-muted-foreground">{note}</div>
      <div className="flex shrink-0 items-center gap-2">
        {onBack ? (
          <button
            className="editor-motion inline-flex h-9 items-center gap-1.5 border render-hairline render-glass px-3 text-micro font-bold uppercase tracking-meta text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            data-testid="render-wizard-back"
            onClick={onBack}
            type="button"
          >
            <ArrowLeft aria-hidden="true" className="size-3.5" />
            {backLabel}
          </button>
        ) : null}
        {primary ?? (onNext ? (
          <button
            className={cn(
              "editor-motion inline-flex h-9 items-center gap-1.5 px-5 text-micro font-bold uppercase tracking-meta focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
              nextDisabled
                ? "cursor-not-allowed border render-hairline render-glass text-muted-foreground"
                : "bg-primary text-primary-foreground hover:bg-primary/90",
            )}
            data-testid="render-wizard-next"
            disabled={nextDisabled}
            onClick={onNext}
            type="button"
          >
            {nextLabel}
            <ArrowRight aria-hidden="true" className="size-3.5" />
          </button>
        ) : null)}
      </div>
    </footer>
  );
}

/**
 * A selectable card: an engine, a camera, an output.
 *
 * Exclusive choices pass `role="radio"`, multi-selects `aria-pressed`. Both look identical on
 * purpose — the step's heading says which one it is, so the card does not have to.
 */
export function RenderOptionCard({
  badge,
  disabled = false,
  hint,
  icon: Icon,
  label,
  onClick,
  selected,
  selection,
  testId,
}: {
  badge?: ReactNode;
  disabled?: boolean;
  hint?: ReactNode;
  icon?: LucideIcon;
  label: ReactNode;
  onClick: () => void;
  selected: boolean;
  selection: "single" | "multi";
  testId?: string;
}) {
  return (
    <button
      aria-checked={selection === "single" ? selected : undefined}
      aria-pressed={selection === "multi" ? selected : undefined}
      className={cn(
        "editor-motion flex min-w-0 flex-col items-start gap-1 border p-3 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
        selected ? "border-primary bg-primary/10" : "render-glass hover:border-primary/40",
        disabled && "cursor-not-allowed opacity-50",
      )}
      data-selected={selected}
      data-testid={testId}
      disabled={disabled}
      onClick={onClick}
      role={selection === "single" ? "radio" : undefined}
      type="button"
    >
      <span className="flex w-full min-w-0 items-center gap-2">
        {Icon ? (
          <Icon
            aria-hidden="true"
            className={cn("size-4 shrink-0", selected ? "text-primary" : "text-muted-foreground")}
          />
        ) : null}
        <span className="min-w-0 flex-1 truncate text-xs font-semibold text-foreground">{label}</span>
        {badge}
      </span>
      {hint ? (
        <span className="text-micro leading-relaxed text-muted-foreground">{hint}</span>
      ) : null}
    </button>
  );
}
