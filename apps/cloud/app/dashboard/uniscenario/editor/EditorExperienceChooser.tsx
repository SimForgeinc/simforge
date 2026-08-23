"use client";

import { Clock3, SlidersHorizontal } from "lucide-react";
import type { EditorExperience } from "./simple-timed-routes";

export function EditorExperienceChooser({ onChoose }: { onChoose: (mode: EditorExperience) => void }) {
  return (
    <div className="pointer-events-auto absolute inset-0 z-[80] grid place-items-center bg-black/65 p-6 backdrop-blur-sm" data-testid="editor-experience-chooser">
      <div className="w-full max-w-xl rounded-2xl border border-white/15 bg-[#111317] p-6 shadow-2xl">
        <h2 className="text-xl font-semibold text-white">How do you want to build this scenario?</h2>
        <p className="mt-2 text-sm text-white/55">You can switch views later without changing the simulation format.</p>
        <div className="mt-5 grid gap-3 sm:grid-cols-2">
          <button className="rounded-xl border border-[#E8E044]/50 bg-[#E8E044]/8 p-4 text-left hover:bg-[#E8E044]/12" onClick={() => onChoose("simple")} type="button">
            <Clock3 className="size-6 text-[#E8E044]" />
            <strong className="mt-3 block text-sm text-white">Simple</strong>
            <span className="mt-1 block text-xs leading-5 text-white/55">Every movable actor gets one custom timed route. After its final authored point, the actor brakes under physics; the timeline stays visible but locked.</span>
          </button>
          <button className="rounded-xl border border-white/15 bg-white/[0.03] p-4 text-left hover:bg-white/[0.06]" onClick={() => onChoose("advanced")} type="button">
            <SlidersHorizontal className="size-6 text-white/70" />
            <strong className="mt-3 block text-sm text-white">Advanced</strong>
            <span className="mt-1 block text-xs leading-5 text-white/55">Use the current multi-track timeline, triggers, actions, signals, and detailed controls.</span>
          </button>
        </div>
      </div>
    </div>
  );
}
