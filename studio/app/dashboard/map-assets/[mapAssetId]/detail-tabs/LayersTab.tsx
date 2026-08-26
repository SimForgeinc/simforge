"use client";

import { useState } from "react";
import type {
  MapAsset,
  MapAssetEnrichmentSnapshot,
  MapOverlayLayerId,
} from "@simforge-oss/studio-shared";
import type { SelectedGeoJSONFeaturePayload } from "@/app/lib/maps/frontend/feature-inspection-types";
import type { LaneRenderMode } from "@/app/lib/maps/frontend/lane-render-mode";
import type { ScenarioCandidateFamilyLayer } from "@/app/lib/maps/frontend/scenario-candidate-layers";
import type {
  TwinFidelityScorecard,
  TwinFidelitySubLayerId,
} from "@/app/lib/maps/frontend/twin-fidelity-layers";
import {
  ALL_FEATURE_TYPE_IDS,
  type RoadNetworkFeatureTypeId,
} from "@/app/lib/maps/frontend/road-network-feature-types";
import type { ViewMode } from "../MapDetailHeader";
import { countSignalCategories } from "@/app/lib/maps/frontend/signal-overlay";
import { MapLayersSection } from "@/app/dashboard/map-assets/map-detail-sections/MapLayersSection";
import { MapElementInspector } from "@/app/dashboard/map-assets/map-detail-sections/MapElementInspector";
import { UserGeoJsonSection } from "@/app/dashboard/map-assets/map-detail-sections/UserGeoJsonSection";
import { DigitalTwinLayersPanel } from "@/app/dashboard/map-assets/map-detail-sections/DigitalTwinLayersPanel";
import type { UserGeoJsonLayer } from "@/app/lib/maps/frontend/user-geojson-layers";


interface LayersTabProps {
  asset: MapAsset;
  enrichment: MapAssetEnrichmentSnapshot | null;
  enrichmentLoading: boolean;

  // Feature toggles
  enabledFeatureTypeIds: RoadNetworkFeatureTypeId[];
  featureTypeCounts: Record<RoadNetworkFeatureTypeId, number> | null;
  onToggleFeatureType?: (id: RoadNetworkFeatureTypeId) => void;
  onToggleAllFeatureTypes?: () => void;
  laneRenderMode?: LaneRenderMode;
  onSetLaneRenderMode?: (mode: LaneRenderMode) => void;
  lanePolygonsAvailable?: boolean;
  geojsonLoading: boolean;

  // Overlay layer toggles
  enabledOverlayLayerIds: MapOverlayLayerId[];
  onToggleOverlayLayer?: (layerId: MapOverlayLayerId) => void;

  // Scenario-candidate family layers
  candidateFamilyLayers: ScenarioCandidateFamilyLayer[];
  enabledCandidateFamilyIds: string[];
  onToggleCandidateFamily?: (familyId: string) => void;
  candidateLocationsLoading?: boolean;

  // Twin fidelity
  twinFidelityScorecard?: TwinFidelityScorecard | null;
  enabledTwinFidelityLayerIds?: TwinFidelitySubLayerId[];
  onToggleTwinFidelityLayer?: (id: TwinFidelitySubLayerId) => void;
  twinFidelityRes?: number;
  onSetTwinFidelityRes?: (res: number) => void;
  speedLimitsEnabled?: boolean;
  onToggleSpeedLimits?: () => void;
  speedLimitCount?: number;
  inHouseSpeedLimitsEnabled?: boolean;
  onToggleInHouseSpeedLimits?: () => void;
  inHouseSpeedLimitCount?: number;

  // Signal toggles
  signalOverlayGeoJSON: object | null;
  enabledSignalCategories: Set<string>;
  signalOverlayLoading: boolean;
  onToggleSignalCategory?: (cat: string) => void;
  onToggleAllSignalCategories?: () => void;

  // Inspector
  selectedFeatures: SelectedGeoJSONFeaturePayload[];
  selectedFeatureId: number | null;
  onSelectFeatureId?: (id: number) => void;
  onClearSelection?: () => void;
  onHighlightId?: (guid: string) => void;
  onSelectId?: (guid: string) => void;
  knownGuids?: Set<string>;

  // Enrichment actions
  onEnrich: () => void;
  enrichBusy: boolean;
  enrichErr: string | null;

  // User-uploaded GeoJSON overlays
  userGeoJsonLayers: UserGeoJsonLayer[];
  onAddUserGeoJson: (name: string, data: object, featureCount: number) => void;
  onRemoveUserGeoJson: (id: string) => void;
  onToggleUserGeoJson: (id: string) => void;
  onSetUserGeoJsonColor: (id: string, color: string) => void;
  onSetUserGeoJsonOpacity: (id: string, opacity: number) => void;
  onSetUserGeoJsonThickness: (id: string, thickness: number) => void;

  // View mode
  viewMode?: ViewMode;
}

export function LayersTab({
  asset,
  enrichment,
  enrichmentLoading: _enrichmentLoading,
  enabledFeatureTypeIds,
  featureTypeCounts,
  onToggleFeatureType,
  onToggleAllFeatureTypes,
  laneRenderMode,
  onSetLaneRenderMode,
  lanePolygonsAvailable,
  geojsonLoading,
  enabledOverlayLayerIds,
  onToggleOverlayLayer,
  candidateFamilyLayers,
  enabledCandidateFamilyIds,
  onToggleCandidateFamily,
  candidateLocationsLoading,
  twinFidelityScorecard = null,
  enabledTwinFidelityLayerIds = [],
  onToggleTwinFidelityLayer,
  twinFidelityRes = 11,
  onSetTwinFidelityRes,
  speedLimitsEnabled = false,
  onToggleSpeedLimits,
  speedLimitCount,
  inHouseSpeedLimitsEnabled = false,
  onToggleInHouseSpeedLimits,
  inHouseSpeedLimitCount,
  signalOverlayGeoJSON,
  enabledSignalCategories,
  signalOverlayLoading,
  onToggleSignalCategory,
  onToggleAllSignalCategories,
  selectedFeatures,
  selectedFeatureId,
  onSelectFeatureId,
  onClearSelection,
  onHighlightId,
  onSelectId,
  knownGuids,
  onEnrich,
  enrichBusy,
  enrichErr: _enrichErr,
  userGeoJsonLayers,
  onAddUserGeoJson,
  onRemoveUserGeoJson,
  onToggleUserGeoJson,
  onSetUserGeoJsonColor,
  onSetUserGeoJsonOpacity,
  onSetUserGeoJsonThickness,
  viewMode = "2d",
}: LayersTabProps) {
  const [mapLayersOpen, setMapLayersOpen] = useState(true);
  const [roadNetworkExpanded, setRoadNetworkExpanded] = useState(true);
  const [enrichmentLayersExpanded, setEnrichmentLayersExpanded] = useState(true);
  const [signalsLayerExpanded, setSignalsLayerExpanded] = useState(false);
  const [candidatesLayerExpanded, setCandidatesLayerExpanded] = useState(false);
  const [twinFidelityExpanded, setTwinFidelityExpanded] = useState(true);

  // 3D mode: show digital twin layer controls
  if (viewMode === "3d") {
    return <DigitalTwinLayersPanel />;
  }

  const enrichmentLayers = enrichment?.overlay_payload.layers ?? [];
  const { featureCount: signalFeatureCount, categoryCounts: signalCategoryCounts } =
    countSignalCategories(signalOverlayGeoJSON);

  const hasMapLayers = !!(
    onToggleFeatureType ||
    enrichmentLayers.length > 0 ||
    signalFeatureCount > 0 ||
    candidateFamilyLayers.length > 0 ||
    twinFidelityScorecard
  );
  const allFeatureTypesEnabled =
    enabledFeatureTypeIds.length === ALL_FEATURE_TYPE_IDS.length;
  const someFeatureTypesEnabled = enabledFeatureTypeIds.length > 0;

  const hasSelectedFeatures = selectedFeatures.length > 0;

  return (
    <div className="space-y-5">
      {/* Inspector sub-panel — slides in at top when features are selected */}
      {hasSelectedFeatures && (
        <div className="rounded-lg border border-primary/20 bg-primary/5 p-3">
          <MapElementInspector
            selectedFeatures={selectedFeatures}
            selectedFeatureId={selectedFeatureId}
            onSelectFeatureId={onSelectFeatureId}
            onClearSelection={onClearSelection}
            onHighlightId={onHighlightId}
            onSelectId={onSelectId}
            knownGuids={knownGuids}
            mapAssetId={asset.map_asset_id}
          />
        </div>
      )}

      {/* User-uploaded GeoJSON overlays — sit above the built-in map layers */}
      <UserGeoJsonSection
        layers={userGeoJsonLayers}
        onAddLayer={onAddUserGeoJson}
        onRemoveLayer={onRemoveUserGeoJson}
        onToggleLayer={onToggleUserGeoJson}
        onSetColor={onSetUserGeoJsonColor}
        onSetOpacity={onSetUserGeoJsonOpacity}
        onSetThickness={onSetUserGeoJsonThickness}
      />

      {/* Layer toggles */}
      {hasMapLayers && (
        <MapLayersSection
          open={mapLayersOpen}
          onToggleOpen={() => setMapLayersOpen((o) => !o)}
          onToggleFeatureType={onToggleFeatureType}
          enabledFeatureTypeIds={enabledFeatureTypeIds}
          featureTypeCounts={featureTypeCounts ?? null}
          onToggleAllFeatureTypes={onToggleAllFeatureTypes}
          geojsonLoading={geojsonLoading}
          allFeatureTypesEnabled={allFeatureTypesEnabled}
          someFeatureTypesEnabled={someFeatureTypesEnabled}
          roadNetworkExpanded={roadNetworkExpanded}
          onToggleRoadNetworkExpanded={() => setRoadNetworkExpanded((o) => !o)}
          laneRenderMode={laneRenderMode}
          onSetLaneRenderMode={onSetLaneRenderMode}
          lanePolygonsAvailable={lanePolygonsAvailable}
          signalCategoryCounts={signalCategoryCounts}
          signalFeatureCount={signalFeatureCount}
          enabledSignalCategories={enabledSignalCategories}
          onToggleSignalCategory={onToggleSignalCategory}
          onToggleAllSignalCategories={onToggleAllSignalCategories}
          signalOverlayLoading={signalOverlayLoading}
          signalsLayerExpanded={signalsLayerExpanded}
          onToggleSignalsExpanded={() => setSignalsLayerExpanded((o) => !o)}
          enrichmentLayers={enrichmentLayers}
          enrichmentProviderRelease={enrichment?.provider_release}
          enabledOverlayLayerIds={enabledOverlayLayerIds}
          onToggleOverlayLayer={onToggleOverlayLayer}
          enrichmentLayersExpanded={enrichmentLayersExpanded}
          onToggleEnrichmentExpanded={() => setEnrichmentLayersExpanded((o) => !o)}
          onEnrich={enrichmentLayers.length === 0 ? onEnrich : undefined}
          enrichBusy={enrichBusy}
          candidateFamilyLayers={candidateFamilyLayers}
          enabledCandidateFamilyIds={enabledCandidateFamilyIds}
          onToggleCandidateFamily={onToggleCandidateFamily}
          candidateLocationsLoading={candidateLocationsLoading}
          candidatesLayerExpanded={candidatesLayerExpanded}
          onToggleCandidatesExpanded={() => setCandidatesLayerExpanded((o) => !o)}
          twinFidelityScorecard={twinFidelityScorecard}
          enabledTwinFidelityLayerIds={enabledTwinFidelityLayerIds}
          onToggleTwinFidelityLayer={onToggleTwinFidelityLayer}
          twinFidelityExpanded={twinFidelityExpanded}
          onToggleTwinFidelityExpanded={() => setTwinFidelityExpanded((o) => !o)}
          twinFidelityRes={twinFidelityRes}
          onSetTwinFidelityRes={onSetTwinFidelityRes}
          speedLimitsEnabled={speedLimitsEnabled}
          onToggleSpeedLimits={onToggleSpeedLimits}
          speedLimitCount={speedLimitCount}
          inHouseSpeedLimitsEnabled={inHouseSpeedLimitsEnabled}
          onToggleInHouseSpeedLimits={onToggleInHouseSpeedLimits}
          inHouseSpeedLimitCount={inHouseSpeedLimitCount}
        />
      )}

    </div>
  );
}
