"use client";

import { CloudActivityIndicator } from "@/app/components/CloudLoadingSurface";
import { cn } from "@/app/lib/utils";
import {
  renderProgressBar,
  renderStateChipClass,
  renderStateVisual,
} from "./render-view-model";
import type { UniScenarioRenderJobState } from "@/app/lib/uniscenario/render/contracts";

/**
 * The two visual atoms every render surface repeats: a state chip and a progress bar.
 *
 * Extracted because the gallery tile, the details header and the postprocess child tile all show the
 * same two things, and three copies is three places for the accessible name to drift.
 */

export function RenderStateChip({
  state,
  className,
}: {
  state: UniScenarioRenderJobState;
  className?: string;
}) {
  const visual = renderStateVisual(state);
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 px-1.5 py-0.5 text-micro font-medium uppercase tracking-meta",
        renderStateChipClass(visual.tone),
        className,
      )}
      data-render-state={state}
    >
      {visual.live ? (
        <CloudActivityIndicator iconClassName="size-2.5" />
      ) : null}
      {visual.label}
    </span>
  );
}

/**
 * A `role="progressbar"` that stays honest.
 *
 * When the worker has reported no percentage the bar is indeterminate: it carries no
 * `aria-valuenow`, and it pulses through `.editor-pulse` rather than a bare `animate-*` so
 * `prefers-reduced-motion` is respected (parity plan §5.4 flags v2's unguarded `animate-pulse`).
 * A terminal state renders nothing — a bar sitting at 0 next to the word "Failed" is noise.
 */
export function RenderProgressBar({
  state,
  progressPercent,
  label,
  className,
}: {
  state: UniScenarioRenderJobState;
  progressPercent: number | null;
  label: string;
  className?: string;
}) {
  const bar = renderProgressBar({ jobState: state, progressPercent });
  if (!renderStateVisual(state).live && state !== "succeeded") return null;

  return (
    <div
      aria-label={label}
      aria-valuemax={100}
      aria-valuemin={0}
      aria-valuenow={bar.percent ?? undefined}
      aria-valuetext={bar.indeterminate ? "In progress, no percentage reported" : undefined}
      className={cn("render-chip h-1 overflow-hidden", className)}
      role="progressbar"
    >
      {bar.indeterminate ? (
        <div className="editor-pulse h-full w-1/3 bg-primary" />
      ) : (
        <div className="h-full bg-primary" style={{ width: `${bar.widthPercent}%` }} />
      )}
    </div>
  );
}
