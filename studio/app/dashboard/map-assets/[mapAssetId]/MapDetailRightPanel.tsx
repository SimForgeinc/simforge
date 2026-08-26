"use client";

import { BarChart3, LayoutDashboard, Layers, Lightbulb, PanelRightClose, PanelRightOpen } from "lucide-react";
import type { MapAsset } from "@simforge-oss/studio-shared";
import type { AppRouterInstance } from "next/dist/shared/lib/app-router-context.shared-runtime";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/app/components/ui/tabs";
import { MapAssetEditPanel } from "@/app/dashboard/map-assets/MapAssetEditPanel";
import { OverviewTab } from "./detail-tabs/OverviewTab";
import { LayersTab } from "./detail-tabs/LayersTab";
import { AnalyticsTab } from "./detail-tabs/AnalyticsTab";
import { InsightsTab } from "./detail-tabs/InsightsTab";
import type { MapDetailData } from "@/app/lib/maps/frontend/use-map-asset-detail-data";
import type { useScenarioOverlayState } from "./useScenarioOverlayState";
import type { useMapAssetOperations } from "./useMapAssetOperations";
import type { ScenarioSummary } from "@/app/lib/scenarios";

type DetailTab = "overview" | "layers" | "analytics" | "insights";

interface MapDetailRightPanelProps {
  panelOpen: boolean;
  setPanelOpen: (open: boolean) => void;
  editMode: boolean;
  setEditMode: (mode: boolean) => void;
  currentAsset: MapAsset;
  router: AppRouterInstance;
  refreshMapAssets: () => void;
  activeTab: DetailTab;
  handleTabChange: (tab: string) => void;
  focusFamilyId: string | null;
  setFocusFamilyId: (id: string | null) => void;
  data: MapDetailData;
  ops: ReturnType<typeof useMapAssetOperations>;
  overtureCrosswalkSurvivorCount: number | undefined;
  handleSelectCandidateFromPanel: (id: string | null) => void;
  setActiveMedia: (info: { proxyUrl: string; label?: string } | null) => void;
  runs: ScenarioSummary[];
  scenarioOverlay: ReturnType<typeof useScenarioOverlayState>;
  manualHighlightedFeatureIds: number[];
  setManualHighlightedFeatureIds: (ids: number[]) => void;
  handleHighlightGuid: (guid: string) => void;
  handleSelectGuid: (guid: string) => void;
  hasGeoJSON: boolean;
}

export function MapDetailRightPanel({
  panelOpen,
  setPanelOpen,
  editMode,
  setEditMode,
  currentAsset,
  router,
  refreshMapAssets,
  activeTab,
  handleTabChange,
  focusFamilyId,
  setFocusFamilyId,
  data,
  ops,
  overtureCrosswalkSurvivorCount,
  handleSelectCandidateFromPanel,
  setActiveMedia,
  runs,
  scenarioOverlay: _scenarioOverlay,
  setManualHighlightedFeatureIds,
  handleHighlightGuid,
  handleSelectGuid,
  hasGeoJSON,
}: MapDetailRightPanelProps) {
  // The lane filled/centerline toggle only applies when the map actually has a
  // lane-polygon sidecar to switch to.
  const lanePolygonsAvailable =
    Array.isArray(
      (data.lanePolygonsGeoJSON as { features?: unknown[] } | null)?.features,
    ) &&
    ((data.lanePolygonsGeoJSON as { features?: unknown[] }).features?.length ?? 0) >
      0;

  if (!panelOpen) {
    return (
      <button
        onClick={() => setPanelOpen(true)}
        className="shrink-0 border-l border-border bg-background hover:bg-muted transition-colors flex items-center px-1.5"
      >
        <div className="flex items-center gap-1.5 [writing-mode:vertical-lr] rotate-180 text-xs text-muted-foreground hover:text-foreground py-3">
          <PanelRightOpen className="size-3.5 rotate-90" />
          Map Attributes
        </div>
      </button>
    );
  }

  return (
    <div className="relative w-[24rem] shrink-0 min-h-0 overflow-hidden flex flex-col">
      {/* Collapse rail */}
      {!editMode && (
        <button
          onClick={() => setPanelOpen(false)}
          className="absolute inset-y-0 left-0 z-20 w-4 -translate-x-1/2 transition-all ease-linear after:absolute after:inset-y-0 after:left-1/2 after:-translate-x-1/2 after:w-[2px] after:rounded-full after:transition-all hover:after:w-1 hover:after:bg-primary/40 cursor-e-resize flex items-center justify-center group/rail"
          aria-label="Collapse panel"
        >
          <PanelRightClose className="size-3 text-muted-foreground opacity-0 group-hover/rail:opacity-100 transition-opacity" />
        </button>
      )}
      <div className="w-full border-l border-border bg-background flex flex-col min-h-0">
        {editMode ? (
          <MapAssetEditPanel
            asset={currentAsset}
            onBack={() => setEditMode(false)}
            onSaved={() => {
              setEditMode(false);
              refreshMapAssets();
            }}
            onDeleted={() => {
              setEditMode(false);
              router.push("/dashboard/map-assets");
              refreshMapAssets();
            }}
          />
        ) : (
          <Tabs
            value={activeTab}
            onValueChange={handleTabChange}
            className="flex-1 flex flex-col min-h-0"
          >
            <TabsList className="grid grid-cols-4 shrink-0 w-full rounded-none border-b border-border h-10 bg-transparent p-0">
              {([
                { value: "overview", label: "Overview", Icon: LayoutDashboard, disabled: false },
                { value: "layers", label: "Layers", Icon: Layers, disabled: false },
                { value: "analytics", label: "Stats", Icon: BarChart3, disabled: false },
                { value: "insights", label: "Insights", Icon: Lightbulb, disabled: false },
              ] as const).map(({ value, label, Icon, disabled }) => (
                <TabsTrigger
                  key={value}
                  value={value}
                  disabled={disabled}
                  className="gap-1 rounded-none border-b-2 border-transparent text-xs text-muted-foreground data-[state=active]:border-primary data-[state=active]:bg-transparent data-[state=active]:text-foreground data-[state=active]:shadow-none min-w-0 px-1"
                >
                  <Icon className="size-3.5 shrink-0" />
                  <span className="truncate">{label}</span>
                </TabsTrigger>
              ))}
            </TabsList>

            <TabsContent
              value="overview"
              className="flex-1 overflow-y-auto p-3 mt-0 data-[state=inactive]:hidden"
            >
              <OverviewTab
                asset={currentAsset}
                runs={[]}
                enrichment={data.selectedEnrichment}
                enrichmentLoading={data.enrichmentLoading}
                candidateLocations={data.candidateLocations}
                candidateLocationsLoading={data.candidateLocationsLoading}
                selectedCandidateLocationId={data.selectedCandidateLocationId}
                onSelectCandidateLocationId={handleSelectCandidateFromPanel}
                onViewArtifact={(info) => setActiveMedia(info)}
                onPopulateMetadata={() => void ops.handlePopulateMetadata()}
                populateBusy={ops.populateBusy}
                populateErr={ops.populateErr}
                onSwitchToInsightsTab={(familyId) => {
                  setFocusFamilyId(familyId ?? null);
                  handleTabChange("insights");
                }}
                onSwitchToStatsTab={() => handleTabChange("analytics")}
                overtureCrosswalkSurvivors={overtureCrosswalkSurvivorCount}
              />
            </TabsContent>

            <TabsContent
              value="layers"
              className="flex-1 overflow-y-auto p-3 mt-0 data-[state=inactive]:hidden"
            >
              <LayersTab
                asset={currentAsset}
                enrichment={data.selectedEnrichment}
                enrichmentLoading={data.enrichmentLoading}
                enabledFeatureTypeIds={data.enabledFeatureTypeIds}
                featureTypeCounts={data.featureTypeCounts}
                onToggleFeatureType={hasGeoJSON ? data.toggleFeatureType : undefined}
                onToggleAllFeatureTypes={hasGeoJSON ? data.toggleAllFeatureTypes : undefined}
                laneRenderMode={data.laneRenderMode}
                onSetLaneRenderMode={data.setLaneRenderMode}
                lanePolygonsAvailable={lanePolygonsAvailable}
                geojsonLoading={data.geojsonLoading}
                enabledOverlayLayerIds={data.enabledOverlayLayerIds}
                onToggleOverlayLayer={data.toggleOverlayLayer}
                candidateFamilyLayers={data.candidateFamilyLayers}
                enabledCandidateFamilyIds={data.enabledCandidateFamilyIds}
                onToggleCandidateFamily={data.toggleCandidateFamily}
                candidateLocationsLoading={data.candidateLocationsLoading}
                twinFidelityScorecard={data.twinFidelityScorecard}
                enabledTwinFidelityLayerIds={data.enabledTwinFidelityLayerIds}
                onToggleTwinFidelityLayer={data.toggleTwinFidelityLayer}
                twinFidelityRes={data.twinFidelityRes}
                onSetTwinFidelityRes={data.setTwinFidelityRes}
                speedLimitsEnabled={data.speedLimitsEnabled}
                onToggleSpeedLimits={data.toggleSpeedLimits}
                speedLimitCount={data.speedLimitCount}
                inHouseSpeedLimitsEnabled={data.inHouseSpeedLimitsEnabled}
                onToggleInHouseSpeedLimits={data.toggleInHouseSpeedLimits}
                inHouseSpeedLimitCount={data.inHouseSpeedLimitCount}
                signalOverlayGeoJSON={data.signalOverlayGeoJSON}
                enabledSignalCategories={data.enabledSignalCategories}
                signalOverlayLoading={data.signalOverlayLoading}
                onToggleSignalCategory={data.toggleSignalCategory}
                onToggleAllSignalCategories={data.toggleAllSignalCategories}
                selectedFeatures={data.selectedFeatures}
                selectedFeatureId={data.selectedFeatureId}
                onSelectFeatureId={data.setSelectedFeatureId}
                onClearSelection={() => {
                  data.setSelectedFeatures([]);
                  data.setSelectedFeatureId(null);
                  setManualHighlightedFeatureIds([]);
                  data.setSelectedCandidateLocationId(null);
                }}
                onHighlightId={handleHighlightGuid}
                onSelectId={handleSelectGuid}
                knownGuids={data.knownGuids}
                onEnrich={() => void ops.handleEnrich()}
                enrichBusy={ops.enrichBusy}
                enrichErr={ops.enrichErr}
                userGeoJsonLayers={data.userGeoJsonLayers}
                onAddUserGeoJson={data.addUserGeoJsonLayer}
                onRemoveUserGeoJson={data.removeUserGeoJsonLayer}
                onToggleUserGeoJson={data.toggleUserGeoJsonLayer}
                onSetUserGeoJsonColor={data.setUserGeoJsonLayerColor}
                onSetUserGeoJsonOpacity={data.setUserGeoJsonLayerOpacity}
                onSetUserGeoJsonThickness={data.setUserGeoJsonLayerThickness}
              />
            </TabsContent>

            <TabsContent
              value="analytics"
              className="flex-1 overflow-y-auto p-3 mt-0 data-[state=inactive]:hidden"
            >
              <AnalyticsTab
                asset={currentAsset}
                candidateLocations={data.candidateLocations}
                overtureCrosswalkSurvivors={overtureCrosswalkSurvivorCount}
                enrichment={data.selectedEnrichment}
              />
            </TabsContent>

            <TabsContent
              value="insights"
              className="flex-1 overflow-y-auto p-3 mt-0 data-[state=inactive]:hidden"
            >
              <InsightsTab
                asset={currentAsset}
                runs={runs}
                enrichment={data.selectedEnrichment}
                enrichmentLoading={data.enrichmentLoading}
                candidateLocations={data.candidateLocations}
                candidateLocationsLoading={data.candidateLocationsLoading}
                selectedCandidateLocationId={data.selectedCandidateLocationId}
                onSelectCandidateLocationId={handleSelectCandidateFromPanel}
                focusFamilyId={focusFamilyId}
                onClearFocusFamily={() => setFocusFamilyId(null)}
              />
            </TabsContent>
          </Tabs>
        )}
      </div>
    </div>
  );
}
