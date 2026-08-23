import { cn } from "@/app/lib/utils";
import { UNISCENARIO_FLOATING_CARD_CLASSNAME } from "../../floating-card";

export const TIMELINE_GLASS_SURFACE_CLASSNAME = cn(
  UNISCENARIO_FLOATING_CARD_CLASSNAME,
  "relative isolate overflow-hidden rounded-t-[24px] rounded-b-none border-white/25 bg-black/15 ring-1 ring-inset ring-white/[0.08]",
  "shadow-[0_24px_80px_-24px_rgba(0,0,0,0.85)]",
  "backdrop-blur-[72px] backdrop-saturate-[1.85] backdrop-contrast-[1.05]",
);

/** Ambient layers keep the timeline legible while letting the active map tint the glass. */
export function TimelineGlassBackdrop() {
  return (
    <div
      aria-hidden="true"
      className="pointer-events-none absolute inset-0 z-0 overflow-hidden rounded-[inherit]"
      data-testid="timeline-glass-backdrop"
    >
      <div className="absolute inset-0 bg-gradient-to-br from-white/[0.12] via-white/[0.025] to-sky-400/[0.1]" />
      <div className="absolute -left-16 -top-24 h-52 w-52 rounded-full bg-[#E8E044]/12 blur-3xl" />
      <div className="absolute -bottom-28 right-[-3rem] h-56 w-56 rounded-full bg-sky-400/15 blur-3xl" />
      <div className="absolute inset-x-5 top-0 h-px bg-gradient-to-r from-transparent via-white/60 to-transparent" />
    </div>
  );
}
