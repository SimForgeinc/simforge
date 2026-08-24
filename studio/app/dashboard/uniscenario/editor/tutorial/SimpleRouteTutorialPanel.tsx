"use client";

import { Clock3, MapPin, Pause, Route, X } from "lucide-react";

export function SimpleRouteTutorialPanel({
  onClose,
  onStart,
}: {
  onClose: () => void;
  onStart: () => void;
}) {
  return (
    <div
      className="fixed inset-0 z-[150] flex items-center justify-center bg-black/55 px-4 backdrop-blur-sm"
      data-testid="simple-route-tutorial-backdrop"
    >
      <section
        aria-describedby="simple-route-tutorial-description"
        aria-labelledby="simple-route-tutorial-title"
        aria-modal="true"
        className="w-full max-w-md border border-white/15 bg-[#111111]/95 p-5 text-white shadow-[0_24px_80px_rgba(0,0,0,0.7)]"
        role="dialog"
      >
        <div className="flex items-start gap-3">
          <span className="flex size-10 shrink-0 items-center justify-center bg-[#E8E044] text-black">
            <Route aria-hidden="true" className="size-5" />
          </span>
          <div className="min-w-0 flex-1">
            <p className="font-mono text-[10px] font-bold uppercase tracking-[0.18em] text-[#E8E044]">
              Simple route
            </p>
            <h2 className="mt-1 text-lg font-semibold" id="simple-route-tutorial-title">
              Draw where the actor moves
            </h2>
          </div>
          <button
            aria-label="Close route tutorial"
            className="flex size-8 shrink-0 items-center justify-center text-white/55 transition-colors hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#E8E044]"
            onClick={onClose}
            type="button"
          >
            <X aria-hidden="true" className="size-4" />
          </button>
        </div>

        <div className="mt-5 space-y-3" id="simple-route-tutorial-description">
          <div className="flex gap-3 border-t border-white/10 pt-3">
            <Clock3 aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-[#E8E044]" />
            <p className="text-sm leading-6 text-white/75">
              The starting position is 0 seconds. Each click appends the next point in order and represents
              <strong className="font-semibold text-white"> one second</strong>: the first point is
              1 second, the second is 2 seconds, and so on. Press Ctrl+Z or Cmd+Z to undo the latest point.
            </p>
          </div>
          <div className="flex gap-3 border-t border-white/10 pt-3">
            <Pause aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-[#E8E044]" />
            <p className="text-sm leading-6 text-white/75">
              Click directly on the highlighted last point again to add a
              <strong className="font-semibold text-white"> one-second wait</strong>. The actor
              stays in place and keeps facing the same direction.
            </p>
          </div>
          <div className="flex gap-3 border-t border-white/10 pt-3">
            <MapPin aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-[#E8E044]" />
            <p className="text-sm leading-6 text-white/75">
              If you end the path early, the actor stops at the last point and waits there
              for the rest of the scenario.
            </p>
          </div>
        </div>

        <div className="mt-5 flex items-center justify-between gap-3 border-t border-white/10 pt-4">
          <p className="font-mono text-[9px] uppercase tracking-[0.12em] text-white/40">
            Click map to place · Enter to finish
          </p>
          <button
            autoFocus
            className="h-10 shrink-0 bg-[#E8E044] px-5 text-xs font-bold uppercase tracking-[0.12em] text-black transition-colors hover:bg-[#f4ed55] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white"
            onClick={onStart}
            type="button"
          >
            Draw route
          </button>
        </div>
      </section>
    </div>
  );
}
