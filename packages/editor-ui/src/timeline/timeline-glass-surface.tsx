"use client";

/** Glass chrome for the editor timeline card, as one co-styled CSS class. */
export const TIMELINE_GLASS_SURFACE_CLASSNAME = "ueui-timeline-glass-surface";

/** Ambient layers keep the timeline legible while letting the active map tint the glass. */
export function TimelineGlassBackdrop() {
  return (
    <div
      aria-hidden="true"
      className="ueui-timeline-backdrop"
      data-testid="timeline-glass-backdrop"
    >
      <div className="ueui-timeline-backdrop-wash" />
      <div className="ueui-timeline-backdrop-glow-accent" />
      <div className="ueui-timeline-backdrop-glow-cool" />
      <div className="ueui-timeline-backdrop-hairline" />
    </div>
  );
}
