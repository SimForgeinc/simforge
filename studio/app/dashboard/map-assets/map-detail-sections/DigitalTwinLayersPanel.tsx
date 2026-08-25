"use client";

import { useCallback, useState } from "react";
import { Building2, Check, Sun, Trash2, TreePine } from "lucide-react";
import { clearMapAssetCache } from "@/app/lib/maps/frontend/map-asset-cache";
import {
  readRenderingPreference,
  saveRenderingPreference,
  type RenderingPreference,
} from "@/app/components/rendering-preference";

const QUALITY_OPTIONS: Array<{ value: RenderingPreference; label: string }> = [
  { value: "roads-only", label: "Roads" },
  { value: "ultra-low-3d", label: "Low" },
  { value: "minimal", label: "Balanced" },
  { value: "high", label: "High" },
];

/** Controls shared authoring quality for the packaged @simforge/viewer. */
export function DigitalTwinLayersPanel() {
  const [quality, setQuality] = useState<RenderingPreference>(
    () => readRenderingPreference() ?? "minimal",
  );
  const [cacheState, setCacheState] = useState<"idle" | "clearing" | "cleared">("idle");

  const handleClearCache = useCallback(async () => {
    setCacheState("clearing");
    await clearMapAssetCache();
    setCacheState("cleared");
    window.setTimeout(() => setCacheState("idle"), 2500);
  }, []);

  const chooseQuality = (next: RenderingPreference) => {
    setQuality(next);
    saveRenderingPreference(next);
  };

  return (
    <div className="space-y-4">
      <div className="space-y-1.5">
        <span className="text-xs font-semibold">Render quality</span>
        <div className="flex rounded-lg border border-border bg-muted/30 p-0.5">
          {QUALITY_OPTIONS.map(({ value, label }) => (
            <button
              key={value}
              type="button"
              onClick={() => chooseQuality(value)}
              className={`flex-1 rounded-md px-2 py-1 text-xs transition-colors ${
                quality === value
                  ? "bg-background font-medium text-foreground shadow-sm"
                  : "text-muted-foreground hover:text-foreground"
              }`}
            >
              {label}
            </button>
          ))}
        </div>
        <p className="text-[11px] leading-relaxed text-muted-foreground">
          Changes apply to the shared scenario-editor and digital-twin viewer on reload.
        </p>
      </div>

      <div className="space-y-2 rounded-md border border-border/70 p-2.5">
        <LayerStatus icon={Building2} label="Streamed city geometry and road surface" />
        <LayerStatus icon={TreePine} label="Distance-admitted vegetation" />
        <LayerStatus icon={Sun} label="Sky, sun shadows, and street luminaires" />
      </div>

      <button
        type="button"
        onClick={handleClearCache}
        disabled={cacheState === "clearing"}
        className="flex w-full items-center justify-center gap-1.5 rounded-md border border-border px-2 py-1.5 text-xs text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:opacity-50"
      >
        <Trash2 className="size-3" />
        {cacheState === "clearing"
          ? "Clearing cache…"
          : cacheState === "cleared"
            ? "Cache cleared"
            : "Clear downloaded map cache"}
      </button>
    </div>
  );
}

function LayerStatus({
  icon: Icon,
  label,
}: {
  icon: React.ComponentType<{ className?: string }>;
  label: string;
}) {
  return (
    <div className="flex items-center gap-2 text-xs text-foreground">
      <Icon className="size-3 text-muted-foreground" />
      <span className="flex-1">{label}</span>
      <Check className="size-3 text-green-500" />
    </div>
  );
}
