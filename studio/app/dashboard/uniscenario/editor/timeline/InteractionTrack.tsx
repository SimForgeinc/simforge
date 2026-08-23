"use client";

import { rangePercent, type ResolvedInteraction, type TimelineRange } from "@/app/lib/uniscenario/timeline";

/**
 * One interaction drawn as a bar on the shared time axis — manifest 84.
 *
 * The bar's *appearance* carries what the static analysis could and could not determine, because those
 * are different claims and drawing them identically is a lie the author cannot detect:
 *
 * - a solid bar is an exact start and an authored end;
 * - a dashed left edge means `armed` — the start on screen is the earliest instant it *could* fire, not
 *   a time anything claims. A condition trigger, a back-solved arrival, or an expression reading a
 *   site fact no template knows yet;
 * - a faded right edge means `openEnded` — no `until` was authored, so it runs until something preempts
 *   it or the clip ends. The bar reaching the right edge is not an authored value.
 *
 * A zero-width bar is a real state, not a bug: an `until` earlier than its own trigger collapses to
 * nothing, and the validator reports it as `until_before_trigger`. `min-w-px` keeps it visible so the
 * author can find the row the error names.
 */
export function InteractionTrack({
  resolved,
  window,
}: {
  resolved: ResolvedInteraction;
  window: TimelineRange;
}) {
  const startPercent = rangePercent(resolved.range.startMs, window);
  const endPercent = rangePercent(resolved.range.endMs, window);

  return (
    <div className="relative h-2.5 overflow-hidden bg-black/30" aria-hidden="true" data-testid="interaction-track">
      <div className="absolute inset-x-0 top-1/2 h-px -translate-y-1/2 bg-white/10" />
      <div
        className={`absolute inset-y-0.5 min-w-px rounded-[2px] shadow-[0_0_12px_rgba(232,224,68,0.14)] ${
          resolved.armed
            ? "border-y border-l border-dashed border-[#E8E044] bg-[#E8E044]/20"
            : "bg-[#E8E044]/75"
        } ${resolved.openEnded ? "opacity-70" : ""}`}
        style={{
          left: `${startPercent}%`,
          width: `${Math.max(0, endPercent - startPercent)}%`,
        }}
      />
    </div>
  );
}
