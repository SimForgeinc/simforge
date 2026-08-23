"use client";

import { useEffect, useState } from "react";

import {
  getTwinDetailMode,
  setTwinDetailMode,
  type TwinDetailMode,
} from "./twin-detail-mode";

const MODES: Array<{
  mode: TwinDetailMode;
  label: string;
  blurb: string;
}> = [
  {
    mode: "light",
    label: "Lightweight",
    blurb:
      "Current renderer. Vegetation decimated per LOD, frustum-culled, and refined only once the camera settles. ~13.7M triangles on Belmont.",
  },
  {
    mode: "heavy",
    label: "Heavy",
    blurb:
      "The previous renderer, kept for comparison. Full-detail vegetation pinned to LOD0, never culled, refined immediately. ~93M triangles on Belmont.",
  },
];

/**
 * A/B switch between the current twin renderer and the one it replaced.
 *
 * Switching reloads the page on purpose: decimation happens as tiles load, so
 * flipping live would leave a scene built half by each pipeline and measure
 * neither. The reload is what makes the comparison honest.
 */
export function TwinDetailModePanel() {
  // Read on mount rather than during render — the mode comes from localStorage
  // and the URL, so touching it while server-rendering would mismatch.
  const [mode, setMode] = useState<TwinDetailMode | null>(null);
  useEffect(() => setMode(getTwinDetailMode()), []);

  return (
    <div className="flex flex-col gap-2 px-3 py-2" data-testid="twin-detail-mode">
      <div className="flex items-center gap-1">
        {MODES.map((option) => {
          const active = mode === option.mode;
          return (
            <button
              key={option.mode}
              type="button"
              aria-pressed={active}
              data-testid={`twin-detail-mode-${option.mode}`}
              disabled={mode === null}
              onClick={() => setTwinDetailMode(option.mode)}
              className={
                active
                  ? "flex-1 rounded border border-primary/60 bg-primary/20 px-2 py-1 text-xs font-semibold text-foreground"
                  : "flex-1 rounded border border-border bg-background/60 px-2 py-1 text-xs text-muted-foreground hover:text-foreground"
              }
            >
              {option.label}
            </button>
          );
        })}
      </div>
      <p className="text-[11px] leading-relaxed text-muted-foreground">
        {MODES.find((m) => m.mode === mode)?.blurb ?? "Reading current mode…"}
      </p>
      <p className="text-[11px] leading-relaxed text-muted-foreground/70">
        Switching reloads the page so the whole scene streams through one
        pipeline. Also settable with <code>?detail=heavy</code>.
      </p>
    </div>
  );
}

export default TwinDetailModePanel;
