"use client";

import { ChevronRight, Loader2, Sparkles } from "lucide-react";
import { Button } from "@/app/components/ui/button";
import { Switch } from "@/app/components/ui/switch";
import {
  ROAD_NETWORK_FEATURE_TYPES,
  type RoadNetworkFeatureTypeId,
} from "@/app/lib/maps/frontend/road-network-feature-types";
import { SIGNAL_CATEGORY_CONFIG } from "@/app/lib/maps/frontend/signal-overlay";
import { enrichmentGlyphPath } from "@/app/components/map-assets-map/map-icons";
import { cn } from "@/app/lib/utils";
import type { LaneRenderMode } from "@/app/lib/maps/frontend/lane-render-mode";
import type { MapOverlayLayer, MapOverlayLayerId } from "@simforge-oss/studio-shared";
import type { ScenarioCandidateFamilyLayer } from "@/app/lib/maps/frontend/scenario-candidate-layers";
import {
  TWIN_FIDELITY_RESOLUTIONS,
  TWIN_FIDELITY_SUBLAYERS,
  twinFidelityCounts,
  type TwinFidelityScorecard,
  type TwinFidelitySubLayerId,
} from "@/app/lib/maps/frontend/twin-fidelity-layers";

/** Insights-orange dot used for every scenario-candidate family row. */
const SCENARIO_CANDIDATE_DOT = "#f97316";

const ENRICHMENT_DOTS: Record<string, string> = {
  bus_stops: "#60a5fa",
  schools: "#34d399",
  hospitals: "#f87171",
  gas_stations: "#fbbf24",
  parking_lots: "#c084fc",
  retail: "#f472b6",
  restaurant: "#fb923c",
  hotel: "#a78bfa",
  airport: "#22d3ee",
  shopping_mall: "#ec4899",
  transit_stop: "#3b82f6",
  crosswalks: "#facc15",
  sidewalks: "#4ade80",
};

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

/** Props for the MapLayersSection component. */
export type MapLayersSectionProps = {
  open: boolean;
  onToggleOpen: () => void;
  // Road network
  onToggleFeatureType?: (id: RoadNetworkFeatureTypeId) => void;
  enabledFeatureTypeIds: RoadNetworkFeatureTypeId[];
  featureTypeCounts: Record<RoadNetworkFeatureTypeId, number> | null;
  onToggleAllFeatureTypes?: () => void;
  geojsonLoading: boolean;
  allFeatureTypesEnabled: boolean;
  someFeatureTypesEnabled: boolean;
  roadNetworkExpanded: boolean;
  onToggleRoadNetworkExpanded: () => void;
  /** How lanes draw: filled polygons vs. authored centerlines. */
  laneRenderMode?: LaneRenderMode;
  onSetLaneRenderMode?: (mode: LaneRenderMode) => void;
  /** Whether this map has a lane-polygon sidecar (controls if the toggle shows). */
  lanePolygonsAvailable?: boolean;
  // Signals
  signalCategoryCounts: Record<string, number>;
  signalFeatureCount: number;
  enabledSignalCategories: Set<string>;
  onToggleSignalCategory?: (cat: string) => void;
  onToggleAllSignalCategories?: () => void;
  signalOverlayLoading: boolean;
  signalsLayerExpanded: boolean;
  onToggleSignalsExpanded: () => void;
  // Enrichment
  enrichmentLayers: MapOverlayLayer[];
  enrichmentProviderRelease?: string;
  enabledOverlayLayerIds: MapOverlayLayerId[];
  onToggleOverlayLayer?: (layerId: MapOverlayLayerId) => void;
  enrichmentLayersExpanded: boolean;
  onToggleEnrichmentExpanded: () => void;
  /** Optional: trigger enrichment run when no enrichment data exists yet. */
  onEnrich?: () => void;
  enrichBusy?: boolean;
  // Scenario candidates (one layer per scenario family)
  candidateFamilyLayers: ScenarioCandidateFamilyLayer[];
  enabledCandidateFamilyIds: string[];
  onToggleCandidateFamily?: (familyId: string) => void;
  candidateLocationsLoading?: boolean;
  candidatesLayerExpanded: boolean;
  onToggleCandidatesExpanded: () => void;
  // Twin fidelity (digital-twin-eval scorecard sub-layers)
  twinFidelityScorecard?: TwinFidelityScorecard | null;
  enabledTwinFidelityLayerIds?: TwinFidelitySubLayerId[];
  onToggleTwinFidelityLayer?: (id: TwinFidelitySubLayerId) => void;
  twinFidelityExpanded?: boolean;
  onToggleTwinFidelityExpanded?: () => void;
  twinFidelityRes?: number;
  onSetTwinFidelityRes?: (res: number) => void;
  // Speed limits (Overture posted limits labelled on driving lanes)
  speedLimitsEnabled?: boolean;
  onToggleSpeedLimits?: () => void;
  speedLimitCount?: number;
  // In-house (XODR) speed limits — lives in the Road Network group
  inHouseSpeedLimitsEnabled?: boolean;
  onToggleInHouseSpeedLimits?: () => void;
  inHouseSpeedLimitCount?: number;
};

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

/** Render toggleable map layer groups for road network, signals, and enrichment overlays. */
export function MapLayersSection(props: MapLayersSectionProps) {
  const {
    open,
    onToggleOpen,
    // Road network
    onToggleFeatureType,
    enabledFeatureTypeIds,
    featureTypeCounts,
    onToggleAllFeatureTypes,
    geojsonLoading,
    allFeatureTypesEnabled,
    someFeatureTypesEnabled,
    roadNetworkExpanded,
    onToggleRoadNetworkExpanded,
    laneRenderMode = "filled",
    onSetLaneRenderMode,
    lanePolygonsAvailable = false,
    // Signals
    signalCategoryCounts,
    signalFeatureCount,
    enabledSignalCategories,
    onToggleSignalCategory,
    onToggleAllSignalCategories,
    signalOverlayLoading,
    signalsLayerExpanded,
    onToggleSignalsExpanded,
    // Enrichment
    enrichmentLayers,
    enrichmentProviderRelease,
    enabledOverlayLayerIds,
    onToggleOverlayLayer,
    enrichmentLayersExpanded,
    onToggleEnrichmentExpanded,
    onEnrich,
    enrichBusy = false,
    // Scenario candidates
    candidateFamilyLayers,
    enabledCandidateFamilyIds,
    onToggleCandidateFamily,
    candidateLocationsLoading = false,
    candidatesLayerExpanded,
    onToggleCandidatesExpanded,
    // Twin fidelity
    twinFidelityScorecard = null,
    enabledTwinFidelityLayerIds = [],
    onToggleTwinFidelityLayer,
    twinFidelityExpanded = false,
    onToggleTwinFidelityExpanded,
    twinFidelityRes = 11,
    onSetTwinFidelityRes,
    speedLimitsEnabled = false,
    onToggleSpeedLimits,
    speedLimitCount,
    inHouseSpeedLimitsEnabled = false,
    onToggleInHouseSpeedLimits,
    inHouseSpeedLimitCount,
  } = props;

  const twinCellCounts = twinFidelityCounts(twinFidelityScorecard);
  const allTwinLayersEnabled =
    TWIN_FIDELITY_SUBLAYERS.every((sub) =>
      enabledTwinFidelityLayerIds.includes(sub.id),
    );
  const someTwinLayersEnabled = enabledTwinFidelityLayerIds.length > 0;

  // Signals derived state
  const activeCats = SIGNAL_CATEGORY_CONFIG.filter(
    (cat) => (signalCategoryCounts[cat.id] ?? 0) > 0,
  );
  const allSignalsEnabled = activeCats.every((cat) =>
    enabledSignalCategories.has(cat.id),
  );
  const someSignalsEnabled = activeCats.some((cat) =>
    enabledSignalCategories.has(cat.id),
  );

  // Enrichment derived state — exclude zero-count layers from bulk toggle
  const actionableEnrichmentLayerIds = enrichmentLayers
    .filter((layer) => layer.feature_count > 0)
    .map((layer) => layer.layer_id);
  const allEnrichmentEnabled =
    actionableEnrichmentLayerIds.length > 0 &&
    actionableEnrichmentLayerIds.every((id) =>
      enabledOverlayLayerIds.includes(id),
    );
  const someEnrichmentEnabled = actionableEnrichmentLayerIds.some((id) =>
    enabledOverlayLayerIds.includes(id),
  );

  // Scenario-candidate derived state — every family here has candidates, so
  // all rows are actionable.
  const actionableCandidateFamilyIds = candidateFamilyLayers.map((l) => l.familyId);
  const allCandidateFamiliesEnabled =
    actionableCandidateFamilyIds.length > 0 &&
    actionableCandidateFamilyIds.every((id) => enabledCandidateFamilyIds.includes(id));
  const someCandidateFamiliesEnabled = actionableCandidateFamilyIds.some((id) =>
    enabledCandidateFamilyIds.includes(id),
  );

  return (
    <section>
      <button
        type="button"
        onClick={onToggleOpen}
        className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-muted-foreground transition-colors hover:text-foreground"
        aria-expanded={open}
      >
        <ChevronRight
          className={cn(
            "size-3 shrink-0 transition-transform duration-150",
            open && "rotate-90",
          )}
        />
        Map Layers
      </button>
      {open && (
        <ul className="mt-2 space-y-2">
          {/* ── Road Network group ── */}
          {onToggleFeatureType && (
            <>
              <li className="flex items-center gap-2.5 rounded border border-border bg-muted/20 px-2.5 py-1.5">
                <button
                  type="button"
                  onClick={onToggleRoadNetworkExpanded}
                  className="shrink-0"
                  aria-expanded={roadNetworkExpanded}
                  aria-label="Toggle Road Network"
                >
                  <ChevronRight
                    className={cn(
                      "size-3 text-muted-foreground transition-transform duration-150",
                      roadNetworkExpanded && "rotate-90",
                    )}
                  />
                </button>
                <span className="min-w-0 flex-1 truncate text-xs font-medium text-foreground/90">
                  Road Network
                </span>
                {geojsonLoading && (
                  <Loader2 className="size-3.5 shrink-0 animate-spin text-muted-foreground" />
                )}
                <Switch
                  checked={allFeatureTypesEnabled}
                  className={cn(
                    !allFeatureTypesEnabled &&
                      someFeatureTypesEnabled &&
                      "opacity-60",
                  )}
                  onCheckedChange={onToggleAllFeatureTypes}
                  aria-label="Toggle all road network layers"
                />
              </li>
              {roadNetworkExpanded && (
                <ul className="ml-4 space-y-1.5">
                  {/* Lane display mode: filled lane polygons vs. centerlines.
                      Only meaningful when the map has a lane-polygon sidecar. */}
                  {lanePolygonsAvailable && (
                    <li className="flex items-center gap-2.5 rounded border border-border bg-muted/20 px-2.5 py-1.5">
                      <span className="min-w-0 flex-1 truncate text-xs text-foreground/90">
                        Lane display
                      </span>
                      <div
                        className="flex shrink-0 overflow-hidden rounded border border-border"
                        role="group"
                        aria-label="Lane display mode"
                      >
                        {([
                          ["filled", "Filled"],
                          ["centerlines", "Lines"],
                        ] as const).map(([mode, label]) => (
                          <button
                            key={mode}
                            type="button"
                            onClick={() => onSetLaneRenderMode?.(mode)}
                            aria-pressed={laneRenderMode === mode}
                            className={cn(
                              "px-2 py-0.5 text-[11px] font-medium transition-colors",
                              laneRenderMode === mode
                                ? "bg-primary text-primary-foreground"
                                : "bg-muted/30 text-muted-foreground hover:text-foreground",
                            )}
                          >
                            {label}
                          </button>
                        ))}
                      </div>
                    </li>
                  )}
                  {ROAD_NETWORK_FEATURE_TYPES.map((ft) => {
                    const count = featureTypeCounts?.[ft.id] ?? 0;
                    const isEnabled = enabledFeatureTypeIds.includes(ft.id);
                    return (
                      <li
                        key={ft.id}
                        className={cn(
                          "flex items-center gap-2.5 rounded border border-border bg-muted/20 px-2.5 py-1",
                          count === 0 && "opacity-40",
                        )}
                      >
                        <span
                          className="size-2 shrink-0 rounded-full"
                          style={{ backgroundColor: ft.color }}
                          aria-hidden="true"
                        />
                        <span className="min-w-0 flex-1 truncate text-xs text-foreground/90">
                          {ft.label}
                        </span>
                        <span className="shrink-0 font-mono text-[11px] text-muted-foreground">
                          {count.toLocaleString()}
                        </span>
                        <Switch
                          checked={isEnabled}
                          onCheckedChange={() => onToggleFeatureType(ft.id)}
                          disabled={count === 0}
                          aria-label={`Toggle ${ft.label}`}
                        />
                      </li>
                    );
                  })}
                  {/* In-house speed limits — the XODR-authored per-lane SpeedLimit
                      (the map's own data), labelled as US-style signs. Sits with
                      the road-network layers, distinct from the Overture one. */}
                  {onToggleInHouseSpeedLimits && (
                    <li className="flex items-center gap-2.5 rounded border border-border bg-muted/20 px-2.5 py-1">
                      <span
                        className="size-2 shrink-0 rounded-full"
                        style={{ backgroundColor: "#111111" }}
                        aria-hidden="true"
                      />
                      <span
                        className="min-w-0 flex-1 truncate text-xs text-foreground/90"
                        title="XODR-authored per-lane speed limits, labelled in mph on driving lanes"
                      >
                        Speed limits (XODR)
                      </span>
                      {inHouseSpeedLimitsEnabled && inHouseSpeedLimitCount != null && (
                        <span className="shrink-0 font-mono text-[11px] text-muted-foreground">
                          {inHouseSpeedLimitCount}
                        </span>
                      )}
                      <Switch
                        checked={inHouseSpeedLimitsEnabled}
                        onCheckedChange={onToggleInHouseSpeedLimits}
                        aria-label="Toggle in-house (XODR) speed limit signs"
                      />
                    </li>
                  )}
                </ul>
              )}
            </>
          )}

          {/* ── Signals & Signs group ── */}
          {signalFeatureCount > 0 && onToggleSignalCategory && (
            <>
              <li className="flex items-center gap-2.5 rounded border border-border bg-muted/20 px-2.5 py-1.5">
                <button
                  type="button"
                  onClick={onToggleSignalsExpanded}
                  className="shrink-0"
                  aria-expanded={signalsLayerExpanded}
                  aria-label="Toggle Signals and Signs"
                >
                  <ChevronRight
                    className={cn(
                      "size-3 text-muted-foreground transition-transform duration-150",
                      signalsLayerExpanded && "rotate-90",
                    )}
                  />
                </button>
                <span className="min-w-0 flex-1 truncate text-xs font-medium text-foreground/90">
                  Signals & Signs
                </span>
                <span className="shrink-0 font-mono text-[11px] text-muted-foreground">
                  {signalFeatureCount}
                </span>
                {signalOverlayLoading && (
                  <Loader2 className="size-3.5 shrink-0 animate-spin text-muted-foreground" />
                )}
                <Switch
                  checked={allSignalsEnabled}
                  className={cn(
                    !allSignalsEnabled &&
                      someSignalsEnabled &&
                      "opacity-60",
                  )}
                  onCheckedChange={onToggleAllSignalCategories}
                  aria-label="Toggle all signals"
                />
              </li>
              {signalsLayerExpanded && (
                <ul className="ml-4 space-y-1.5">
                  {activeCats.map((cat) => {
                    const count = signalCategoryCounts[cat.id] ?? 0;
                    const isEnabled = enabledSignalCategories.has(cat.id);
                    return (
                      <li
                        key={cat.id}
                        className={cn(
                          "flex items-center gap-2.5 rounded border border-border bg-muted/20 px-2.5 py-1",
                          count === 0 && "opacity-40",
                        )}
                      >
                        <span
                          className="size-2 shrink-0 rounded-full"
                          style={{ backgroundColor: cat.color }}
                          aria-hidden="true"
                        />
                        <span className="min-w-0 flex-1 truncate text-xs text-foreground/90">
                          {cat.label}
                        </span>
                        <span className="shrink-0 font-mono text-[11px] text-muted-foreground">
                          {count.toLocaleString()}
                        </span>
                        <Switch
                          checked={isEnabled}
                          onCheckedChange={() => onToggleSignalCategory(cat.id)}
                          disabled={count === 0}
                          aria-label={`Toggle ${cat.label}`}
                        />
                      </li>
                    );
                  })}
                </ul>
              )}
            </>
          )}

          {/* ── Enrichment Layers group ── */}
          {enrichmentLayers.length === 0 && onEnrich && (
            <li className="rounded border border-dashed border-border px-2.5 py-2.5">
              <p className="text-xs text-muted-foreground mb-2">
                No enrichment layers yet. Run enrichment to add bus stops, schools, and hospitals.
              </p>
              <Button
                type="button"
                variant="secondary"
                size="sm"
                className="w-full"
                disabled={enrichBusy}
                onClick={onEnrich}
              >
                {enrichBusy ? (
                  <>
                    <Loader2 className="mr-1.5 size-3.5 animate-spin" />
                    Enriching…
                  </>
                ) : (
                  <>
                    <Sparkles className="mr-1.5 size-3.5" />
                    Run Enrichment
                  </>
                )}
              </Button>
            </li>
          )}
          {enrichmentLayers.length > 0 && (
            <>
              <li className="flex items-center gap-2.5 rounded border border-border bg-muted/20 px-2.5 py-1.5">
                <button
                  type="button"
                  onClick={onToggleEnrichmentExpanded}
                  className="shrink-0"
                  aria-expanded={enrichmentLayersExpanded}
                  aria-label="Toggle Enrichment Layers"
                >
                  <ChevronRight
                    className={cn(
                      "size-3 text-muted-foreground transition-transform duration-150",
                      enrichmentLayersExpanded && "rotate-90",
                    )}
                  />
                </button>
                <span className="min-w-0 flex-1 truncate text-xs font-medium text-foreground/90">
                  Enrichment Layers
                </span>
                <Switch
                  checked={allEnrichmentEnabled}
                  className={cn(
                    !allEnrichmentEnabled &&
                      someEnrichmentEnabled &&
                      "opacity-60",
                  )}
                  onCheckedChange={() => {
                    for (const id of actionableEnrichmentLayerIds) {
                      const isOn = enabledOverlayLayerIds.includes(
                        id,
                      );
                      if (allEnrichmentEnabled ? isOn : !isOn) {
                        onToggleOverlayLayer?.(id);
                      }
                    }
                  }}
                  aria-label="Toggle all enrichment layers"
                />
              </li>
              {enrichmentLayersExpanded && (
                <ul className="ml-4 space-y-1.5">
                  {enrichmentProviderRelease && (
                    <li className="flex items-center gap-1.5 px-1 text-[10px] uppercase tracking-wider text-muted-foreground">
                      <span>Overture</span>
                      <span className="font-mono text-muted-foreground/70">
                        ({enrichmentProviderRelease})
                      </span>
                    </li>
                  )}
                  {enrichmentLayers.map((layer) => {
                    const dot = ENRICHMENT_DOTS[layer.layer_id] ?? "#a3a3a3";
                    const glyphPath = enrichmentGlyphPath(layer.layer_id);
                    const isEmpty = layer.feature_count === 0;
                    return (
                      <li
                        key={layer.layer_id}
                        className={cn(
                          "flex items-center gap-2.5 rounded border border-border bg-muted/20 px-2.5 py-1",
                          isEmpty && "opacity-40",
                        )}
                      >
                        {glyphPath ? (
                          <span
                            className="flex size-4 shrink-0 items-center justify-center rounded-full"
                            style={{ backgroundColor: dot }}
                            aria-hidden="true"
                          >
                            <svg
                              viewBox="0 0 15 15"
                              className="size-2.5"
                              fill="#ffffff"
                            >
                              <path d={glyphPath} />
                            </svg>
                          </span>
                        ) : (
                          <span
                            className="size-2 shrink-0 rounded-full"
                            style={{ backgroundColor: dot }}
                            aria-hidden="true"
                          />
                        )}
                        <span className="min-w-0 flex-1 truncate text-xs text-foreground/90">
                          {layer.label}
                        </span>
                        <span className="shrink-0 font-mono text-[11px] text-muted-foreground">
                          {layer.feature_count}
                        </span>
                        <Switch
                          checked={enabledOverlayLayerIds.includes(
                            layer.layer_id,
                          )}
                          onCheckedChange={() =>
                            onToggleOverlayLayer?.(
                              layer.layer_id,
                            )
                          }
                          disabled={isEmpty}
                          aria-label={`Toggle ${layer.label} overlay`}
                        />
                      </li>
                    );
                  })}
                  {/* Overture posted speed limits, drawn as mph labels on lanes.
                      A street fact (not an overlay_payload layer), so it rides
                      its own toggle/fetch but lives with the Overture layers. */}
                  {onToggleSpeedLimits && (
                    <li className="flex items-center gap-2.5 rounded border border-border bg-muted/20 px-2.5 py-1">
                      <span
                        className="size-2 shrink-0 rounded-full"
                        style={{ backgroundColor: "#2563eb" }}
                        aria-hidden="true"
                      />
                      <span
                        className="min-w-0 flex-1 truncate text-xs text-foreground/90"
                        title="Overture posted speed limits (blue border), labelled on driving lanes"
                      >
                        Speed limits (Overture)
                      </span>
                      {speedLimitsEnabled && speedLimitCount != null && (
                        <span
                          className="shrink-0 font-mono text-[11px] text-muted-foreground"
                          title="driving lanes with a posted Overture limit"
                        >
                          {speedLimitCount}
                        </span>
                      )}
                      <Switch
                        checked={speedLimitsEnabled}
                        onCheckedChange={onToggleSpeedLimits}
                        aria-label="Toggle speed limit labels"
                      />
                    </li>
                  )}
                </ul>
              )}
            </>
          )}

          {/* ── Scenario Candidates group ── */}
          {candidateFamilyLayers.length > 0 && (
            <>
              <li className="flex items-center gap-2.5 rounded border border-border bg-muted/20 px-2.5 py-1.5">
                <button
                  type="button"
                  onClick={onToggleCandidatesExpanded}
                  className="shrink-0"
                  aria-expanded={candidatesLayerExpanded}
                  aria-label="Toggle Scenario Candidates"
                >
                  <ChevronRight
                    className={cn(
                      "size-3 text-muted-foreground transition-transform duration-150",
                      candidatesLayerExpanded && "rotate-90",
                    )}
                  />
                </button>
                <span className="min-w-0 flex-1 truncate text-xs font-medium text-foreground/90">
                  Scenario Candidates
                </span>
                {candidateLocationsLoading && (
                  <Loader2 className="size-3.5 shrink-0 animate-spin text-muted-foreground" />
                )}
                <Switch
                  checked={allCandidateFamiliesEnabled}
                  className={cn(
                    !allCandidateFamiliesEnabled &&
                      someCandidateFamiliesEnabled &&
                      "opacity-60",
                  )}
                  onCheckedChange={() => {
                    for (const id of actionableCandidateFamilyIds) {
                      const isOn = enabledCandidateFamilyIds.includes(id);
                      if (allCandidateFamiliesEnabled ? isOn : !isOn) {
                        onToggleCandidateFamily?.(id);
                      }
                    }
                  }}
                  aria-label="Toggle all scenario candidate layers"
                />
              </li>
              {candidatesLayerExpanded && (
                <ul className="ml-4 space-y-1.5">
                  {candidateFamilyLayers.map((layer) => (
                    <li
                      key={layer.familyId}
                      className="flex items-center gap-2.5 rounded border border-border bg-muted/20 px-2.5 py-1"
                    >
                      <span
                        className="size-2 shrink-0 rounded-full"
                        style={{ backgroundColor: SCENARIO_CANDIDATE_DOT }}
                        aria-hidden="true"
                      />
                      <span className="min-w-0 flex-1 truncate text-xs text-foreground/90">
                        {layer.label}
                      </span>
                      <span className="shrink-0 font-mono text-[11px] text-muted-foreground">
                        {layer.count.toLocaleString()}
                      </span>
                      <Switch
                        checked={enabledCandidateFamilyIds.includes(layer.familyId)}
                        onCheckedChange={() => onToggleCandidateFamily?.(layer.familyId)}
                        aria-label={`Toggle ${layer.label} candidates`}
                      />
                    </li>
                  ))}
                </ul>
              )}
            </>
          )}

          {/* ── Twin Fidelity group (digital-twin-eval scorecard) ── */}
          {twinFidelityScorecard && (
            <>
              <li className="flex items-center gap-2.5 rounded border border-border bg-muted/20 px-2.5 py-1.5">
                <button
                  type="button"
                  onClick={onToggleTwinFidelityExpanded}
                  className="shrink-0"
                  aria-expanded={twinFidelityExpanded}
                  aria-label="Toggle Twin Fidelity"
                >
                  <ChevronRight
                    className={cn(
                      "size-3 text-muted-foreground transition-transform duration-150",
                      twinFidelityExpanded && "rotate-90",
                    )}
                  />
                </button>
                <span className="min-w-0 flex-1 truncate text-xs font-medium text-foreground/90">
                  Twin Fidelity
                </span>
                <span
                  className="shrink-0 font-mono text-[11px] text-muted-foreground"
                  title="scored cells / total cells with drive coverage"
                >
                  {twinCellCounts.scored}/{twinCellCounts.total}
                </span>
                <Switch
                  checked={allTwinLayersEnabled}
                  className={cn(
                    !allTwinLayersEnabled && someTwinLayersEnabled && "opacity-60",
                  )}
                  onCheckedChange={() => {
                    for (const sub of TWIN_FIDELITY_SUBLAYERS) {
                      const isOn = enabledTwinFidelityLayerIds.includes(sub.id);
                      if (allTwinLayersEnabled ? isOn : !isOn) {
                        onToggleTwinFidelityLayer?.(sub.id);
                      }
                    }
                  }}
                  aria-label="Toggle all twin fidelity layers"
                />
              </li>
              {twinFidelityExpanded && (
                <ul className="ml-4 space-y-1.5">
                  <li className="px-1 text-[10px] uppercase tracking-wider text-muted-foreground">
                    {twinFidelityScorecard.properties.twin_build_id}
                    <span className="ml-1 font-mono text-muted-foreground/70">
                      vs {twinFidelityScorecard.properties.ref_version}
                    </span>
                  </li>
                  {TWIN_FIDELITY_SUBLAYERS.map((sub) => (
                    <li
                      key={sub.id}
                      className="flex items-center gap-2.5 rounded border border-border bg-muted/20 px-2.5 py-1"
                    >
                      <span
                        className="size-2 shrink-0 rounded-full"
                        style={{ backgroundColor: sub.dot }}
                        aria-hidden="true"
                      />
                      <span
                        className="min-w-0 flex-1 truncate text-xs text-foreground/90"
                        title={sub.description}
                      >
                        {sub.label}
                      </span>
                      <Switch
                        checked={enabledTwinFidelityLayerIds.includes(sub.id)}
                        onCheckedChange={() => onToggleTwinFidelityLayer?.(sub.id)}
                        aria-label={`Toggle ${sub.label} layer`}
                      />
                    </li>
                  ))}
                  <li className="flex items-center gap-1.5 px-1">
                    <span className="text-[10px] uppercase tracking-wider text-muted-foreground">
                      Cell size
                    </span>
                    {TWIN_FIDELITY_RESOLUTIONS.map((r) => (
                      <button
                        key={r.res}
                        type="button"
                        onClick={() => onSetTwinFidelityRes?.(r.res)}
                        className={cn(
                          "rounded border px-1.5 py-0.5 text-[10px] font-mono",
                          twinFidelityRes === r.res
                            ? "border-primary/60 bg-primary/15 text-foreground"
                            : "border-border bg-muted/20 text-muted-foreground hover:text-foreground",
                        )}
                        aria-pressed={twinFidelityRes === r.res}
                        aria-label={`Set twin fidelity cell size to ${r.label}`}
                      >
                        {r.label}
                      </button>
                    ))}
                  </li>
                  <li className="px-1 text-[10px] text-muted-foreground">
                    0–100 = % of real lidar within 1 m of the twin · grey = no
                    twin coverage
                  </li>
                </ul>
              )}
            </>
          )}
        </ul>
      )}
    </section>
  );
}
