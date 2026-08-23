"use client";

import { useCallback, useEffect, useState } from "react";
import {
  Building2,
  TreePine,
  Sun,
  ChevronRight,
  AlertTriangle,
  Check,
  Info,
  X,
  Trash2,
} from "lucide-react";
import { cn } from "@/app/lib/utils";
import { clearMapAssetCache } from "@/app/lib/maps/frontend/map-asset-cache";
import { detectQuality, type QualitySettings, type QualityTier } from "@/app/components/city-viewer/quality";
import {
  loadVisualConfig,
  saveVisualConfig,
} from "@/app/components/city-viewer/visual-config";

// ---------------------------------------------------------------------------
// Layer status indicator
// ---------------------------------------------------------------------------

function LayerStatus({
  label,
  enabled,
  reducedNote,
  disabledReason,
}: {
  label: string;
  enabled: boolean;
  /** When enabled but at reduced quality — shown instead of the green check */
  reducedNote?: string;
  disabledReason?: string;
}) {
  return (
    <div className="flex items-center justify-between py-0.5">
      <span className={cn("text-xs", enabled ? "text-foreground" : "text-muted-foreground/60")}>
        {label}
      </span>
      {enabled ? (
        reducedNote ? (
          <span className="text-[10px] text-yellow-500">{reducedNote}</span>
        ) : (
          <Check className="size-3 text-green-500" />
        )
      ) : (
        <span className="flex items-center gap-1">
          <X className="size-3 text-muted-foreground/40" />
          {disabledReason && (
            <span className="text-[10px] text-muted-foreground/50">{disabledReason}</span>
          )}
        </span>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Collapsible section
// ---------------------------------------------------------------------------

function LayerGroup({
  icon: Icon,
  label,
  open,
  onToggle,
  children,
}: {
  icon: React.ComponentType<{ className?: string }>;
  label: string;
  open: boolean;
  onToggle: () => void;
  children: React.ReactNode;
}) {
  return (
    <div>
      <button
        type="button"
        onClick={onToggle}
        className="flex w-full items-center gap-1.5 pb-1.5 group"
        aria-expanded={open}
      >
        <ChevronRight
          className={cn(
            "size-3 shrink-0 text-muted-foreground transition-transform duration-150",
            open && "rotate-90",
          )}
        />
        <Icon className="size-3 text-muted-foreground shrink-0" />
        <span className="text-xs font-semibold">{label}</span>
      </button>
      {open && <div className="ml-[18px] space-y-0.5">{children}</div>}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------

/**
 * Shows which 3D scene layers are currently active based on the detected
 * GPU quality tier. Read-only for now — runtime layer toggling will be
 * added when the CityViewer exposes a visibility API.
 */
type QualityMode = 'auto' | QualityTier;

const QUALITY_OPTIONS: { value: QualityMode; label: string }[] = [
  { value: 'auto', label: 'Auto' },
  { value: 'low', label: 'Low' },
  { value: 'high', label: 'High' },
];

function getActiveQualityMode(): QualityMode {
  if (typeof window === 'undefined') return 'auto';
  const override = new URLSearchParams(window.location.search).get('quality');
  if (override === 'low' || override === 'high') return override;
  return 'auto';
}

function switchQualityMode(mode: QualityMode): void {
  const url = new URL(window.location.href);
  if (mode === 'auto') {
    url.searchParams.delete('quality');
  } else {
    url.searchParams.set('quality', mode);
  }
  window.location.href = url.toString();
}

export function DigitalTwinLayersPanel() {
  const [quality, setQuality] = useState<QualitySettings | null>(null);
  const [qualityMode, setQualityMode] = useState<QualityMode>(getActiveQualityMode);
  const [geometryOpen, setGeometryOpen] = useState(true);
  const [vegetationOpen, setVegetationOpen] = useState(true);
  const [renderingOpen, setRenderingOpen] = useState(true);
  // Initial value reads from the visual-config bus so the customer-facing
  // slider stays in sync with any persisted setting from the dev HUD's
  // Vegetation tab (and vice versa). The detected quality preset is only
  // used as a fallback when the saved config is at the schema default of 1.
  const [vegDensity, setVegDensity] = useState(() =>
    Math.round(loadVisualConfig().layers.vegetation.density * 100),
  );
  const [cacheState, setCacheState] = useState<"idle" | "clearing" | "cleared">(
    "idle",
  );

  const handleClearCache = useCallback(async () => {
    setCacheState("clearing");
    await clearMapAssetCache();
    setCacheState("cleared");
    setTimeout(() => setCacheState("idle"), 2500);
  }, []);

  useEffect(() => {
    detectQuality()
      .then((q) => {
        setQuality(q);
        // Only override the stored config if no user-tuned value has been
        // persisted (config still at default = 1). Otherwise respect the
        // saved density — same handling as the dev HUD.
        const saved = loadVisualConfig();
        if (saved.layers.vegetation.density === 1 && q.vegetationDensityScale !== 1) {
          setVegDensity(Math.round(q.vegetationDensityScale * 100));
        }
      })
      .catch((err) => {
        console.warn("[DigitalTwinLayersPanel] Quality detection failed:", err);
      });
  }, []);

  // Stay in sync via the legacy `city-viewer:vegetation-density` event so the
  // dev HUD's Vegetation tab and this panel mirror each other in-session
  // without forcing `subscribeVisualConfig` (dev-only) into the prod bundle.
  useEffect(() => {
    if (typeof window === "undefined") return;
    const handler = (e: Event) => {
      const density = (e as CustomEvent<number>).detail;
      if (typeof density !== "number") return;
      setVegDensity(Math.round(density * 100));
    };
    window.addEventListener("city-viewer:vegetation-density", handler);
    return () => window.removeEventListener("city-viewer:vegetation-density", handler);
  }, []);

  const handleVegDensityChange = useCallback((pct: number) => {
    setVegDensity(pct);
    const density = pct / 100;
    saveVisualConfig({ layers: { vegetation: { density } } });
    window.dispatchEvent(
      new CustomEvent("city-viewer:vegetation-density", { detail: density }),
    );
  }, []);

  if (!quality) return null;

  const isLow = quality.tier === "low";
  const gpuReason = "GPU";

  return (
    <div className="space-y-3">
      {/* Quality tier selector */}
      <div className="space-y-1.5">
        <div className="flex items-center justify-between">
          <span className="text-xs font-semibold">Render quality</span>
          {qualityMode === "auto" && (
            <span className="text-[10px] text-muted-foreground">
              detected: {quality.tier}
            </span>
          )}
        </div>
        <div className="flex rounded-lg border border-border bg-muted/30 p-0.5">
          {QUALITY_OPTIONS.map(({ value, label }) => (
            <button
              key={value}
              onClick={() => {
                if (value === qualityMode) return;
                setQualityMode(value);
                switchQualityMode(value);
              }}
              className={cn(
                "flex-1 rounded-md px-2 py-1 text-xs transition-colors",
                qualityMode === value
                  ? "bg-background text-foreground shadow-sm font-medium"
                  : "text-muted-foreground hover:text-foreground",
              )}
            >
              {label}
            </button>
          ))}
        </div>
        {/* Contextual guidance based on detected GPU vs selected mode */}
        {qualityMode === "high" && quality.gpuInfo.detectionMethod !== "none" && isLow && (
          <div className="flex items-start gap-1.5 rounded-md border border-yellow-500/30 bg-yellow-500/5 px-2 py-1.5">
            <AlertTriangle className="size-3 text-yellow-500 shrink-0 mt-0.5" />
            <p className="text-[11px] text-yellow-600 dark:text-yellow-400 leading-relaxed">
              Your GPU was detected as low-end. High quality may cause poor performance or crashes.
            </p>
          </div>
        )}
        {qualityMode === "low" && !isLow && (
          <p className="text-[11px] text-muted-foreground leading-relaxed">
            Your machine supports higher quality rendering. Low quality reduces detail for inspecting the model.
          </p>
        )}
        {qualityMode === "auto" && isLow && (
          <p className="text-[11px] text-muted-foreground leading-relaxed">
            {quality.gpuInfo.reason} Some effects are reduced to keep the viewer responsive.
          </p>
        )}
      </div>

      {/* Scene Geometry — always on */}
      <LayerGroup
        icon={Building2}
        label="Scene Geometry"
        open={geometryOpen}
        onToggle={() => setGeometryOpen((o) => !o)}
      >
        <LayerStatus label="Roads" enabled />
        <LayerStatus label="Buildings" enabled />
        <LayerStatus label="Terrain / Ground" enabled />
      </LayerGroup>

      {/* Vegetation — depends on quality tier */}
      <LayerGroup
        icon={TreePine}
        label="Vegetation"
        open={vegetationOpen}
        onToggle={() => setVegetationOpen((o) => !o)}
      >
        {quality.vegetation ? (
          <div className="space-y-1.5">
            <div className="flex items-center justify-between">
              <span className="text-xs text-foreground">Tree density</span>
              <span className="text-[10px] tabular-nums text-muted-foreground">{vegDensity}%</span>
            </div>
            <input
              type="range"
              min={5}
              max={100}
              step={5}
              value={vegDensity}
              onChange={(e) => handleVegDensityChange(Number(e.target.value))}
              className="w-full h-1 rounded-full appearance-none cursor-pointer bg-border accent-primary"
            />
          </div>
        ) : (
          <LayerStatus label="Trees" enabled={false} disabledReason={gpuReason} />
        )}
      </LayerGroup>

      {/* Rendering / Display — depends on quality tier */}
      <LayerGroup
        icon={Sun}
        label="Rendering"
        open={renderingOpen}
        onToggle={() => setRenderingOpen((o) => !o)}
      >
        <LayerStatus
          label="Anti-aliasing"
          enabled
          reducedNote={!quality.postProcessing ? "MSAA" : "MSAA + SMAA"}
        />
        <LayerStatus
          label="Shadows"
          enabled={quality.shadows}
          disabledReason={!quality.shadows ? gpuReason : undefined}
        />
        <LayerStatus
          label="Post-processing"
          enabled={quality.postProcessing}
          disabledReason={!quality.postProcessing ? gpuReason : undefined}
        />
        <LayerStatus
          label="Environment lighting"
          enabled={!quality.skipEnvironment}
          disabledReason={quality.skipEnvironment ? gpuReason : undefined}
        />
      </LayerGroup>

      {/* Cached 3D model data */}
      <div className="space-y-1.5">
        <span className="text-xs font-semibold">Cached 3D data</span>
        <button
          type="button"
          onClick={handleClearCache}
          disabled={cacheState === "clearing"}
          className={cn(
            "flex w-full items-center justify-center gap-1.5 rounded-md border px-2 py-1.5 text-xs transition-colors",
            cacheState === "cleared"
              ? "border-green-500/40 text-green-600 dark:text-green-400"
              : "border-border text-muted-foreground hover:border-foreground/40 hover:text-foreground",
          )}
        >
          {cacheState === "cleared" ? (
            <>
              <Check className="size-3" /> Cache cleared — reload to refetch
            </>
          ) : (
            <>
              <Trash2 className="size-3" />
              {cacheState === "clearing" ? "Clearing…" : "Clear cached 3D models"}
            </>
          )}
        </button>
        <p className="text-[11px] text-muted-foreground leading-relaxed">
          Road geometry is cached in your browser for faster reloads (auto-refreshes
          when a map is rebuilt). Use this if a model looks stale after a deploy.
        </p>
      </div>

      {/* Web display disclaimer */}
      <div className="rounded-lg border border-border/50 bg-muted/30 px-3 py-2">
        <div className="flex items-start gap-2">
          <Info className="size-3.5 text-muted-foreground shrink-0 mt-0.5" />
          <p className="text-[11px] text-muted-foreground leading-relaxed">
            This 3D view is optimized for web display. The actual photorealistic model is much higher quality and is used in the scenario simulation videos.
          </p>
        </div>
      </div>
    </div>
  );
}
