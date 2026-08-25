"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import type { MapAsset } from "@simforge/studio-shared";
import {
  featurePropertiesForPanel,
  getFeatureSummaryLine,
  getGeometryType,
} from "@/app/lib/maps/frontend/map-assets-map-utils";
import MapAssetsMapDynamic from "@/app/components/map-assets-map/MapAssetsMapDynamic";
import { MapMediaPanel } from "@/app/dashboard/map-assets/MapMediaPanel";
import { MapDetailHeader } from "./MapDetailHeader";
import { ThumbnailGenerator } from "@/app/dashboard/map-assets/map-detail-sections/ThumbnailGenerator";
import { isSimulationReady } from "@/app/dashboard/map-assets/catalog/map-card-data";
import { useMapAssetDetailData } from "@/app/lib/maps/frontend/use-map-asset-detail-data";
import { countOvertureCrosswalkSurvivors } from "@/app/lib/maps/frontend/signal-overlay";
import { resolvePlaceHighlight } from "@/app/lib/maps/frontend/place-highlight";
import { SearchPanelTabs } from "./detail-tabs/SearchPanelTabs";
import type { SearchResultMarker as SearchResultMarkerSpec } from "@/app/components/map-assets-map/layers/SearchResultMarkersLayer";
import { useMapSearchServer } from "@/app/lib/maps/frontend/use-map-search-server";
import { useMapSearchLlm } from "@/app/lib/maps/frontend/use-map-search-llm";
import type { MapSearchResult } from "@/app/lib/maps/search/map-search";
import { Home, Loader2, PanelLeftClose, Search, X } from "lucide-react";
import type { SelectedGeoJSONFeaturePayload } from "@/app/lib/maps/frontend/feature-inspection-types";
import type { MapTemplateScenarioRow } from "@/app/lib/db/scenario-query-store";
import { GEOJSON_FEATURE_ID_PROP } from "@/app/lib/maps/frontend/feature-inspection-types";
import type { ScenarioSummary } from "@/app/lib/scenarios";
import { useProximityArrows } from "./useProximityArrows";
import { useScenarioOverlayState } from "./useScenarioOverlayState";
import { useMapAssetOperations } from "./useMapAssetOperations";
import { MapDetailRightPanel } from "./MapDetailRightPanel";
import { DigitalTwinViewerPanel } from "./DigitalTwinViewerPanel";

type DetailTab = "overview" | "layers" | "analytics" | "insights";

function isDetailTab(value: string | null): value is DetailTab {
  return value === "overview" || value === "layers" || value === "analytics" || value === "insights";
}

interface MapDetailPageClientProps {
  asset: MapAsset;
  allAssets: MapAsset[];
  runs: ScenarioSummary[];
  initialTemplateScenarios: MapTemplateScenarioRow[];
  presentation?: "page" | "overlay";
  onClose?: () => void;
  onSwitchMap?: (mapAssetId: string) => void;
}

/** Shared 2D map workspace used by both the detail route and gallery overlay. */
export function MapDetailPageClient({
  asset,
  allAssets,
  runs,
  presentation = "page",
  onClose,
  onSwitchMap,
}: MapDetailPageClientProps) {
  const router = useRouter();
  // Dynamic route identity is server-owned. App Router navigation replaces the
  // asset prop atomically, so the client does not need a second asset source of
  // truth or a compensating template-scenario fetch.
  const currentAsset = asset;
  // Basemap choice (dark vector vs satellite imagery) — preserved across map
  // switches and mirrored in the URL (`?basemap=satellite`), like the tab/view.
  const [satelliteBasemap, setSatelliteBasemap] = useState(false);

  // Active tab — preserved across map switches
  const [activeTab, setActiveTab] = useState<DetailTab>("overview");
  const [viewMode, setViewMode] = useState<"2d" | "3d">("2d");
  const [focusFamilyId, setFocusFamilyId] = useState<string | null>(null);
  const [searchDraft, setSearchDraft] = useState("");
  const [searchQuery, setSearchQuery] = useState("");
  const [selectedSearchResultId, setSelectedSearchResultId] = useState<string | null>(null);
  const [hoveredSearchResultId, setHoveredSearchResultId] = useState<string | null>(null);
  const [highlightedRelatedObjectId, setHighlightedRelatedObjectId] = useState<string | null>(null);

  // Read URL-backed state after hydration to avoid server/client mismatch
  useEffect(() => {
    if (presentation !== "page") return;
    const params = new URLSearchParams(window.location.search);
    if (params.get("basemap") === "satellite") setSatelliteBasemap(true);
    const urlTab = params.get("tab");
    if (isDetailTab(urlTab)) setActiveTab(urlTab);
    const urlSearch = params.get("search");
    if (urlSearch) {
      setSearchDraft(urlSearch);
      setSearchQuery(urlSearch);
      setSearchPanelOpen(true);
    }
    const urlSearchResult = params.get("searchResult");
    if (urlSearchResult) {
      setSelectedSearchResultId(urlSearchResult);
      setSearchPanelOpen(true);
    }

    // Local publication is synchronous and has no enrichment fleet to poll.
    // Clear legacy cloud redirects immediately and render the stored snapshot,
    // or the normal absent state when no snapshot exists.
    if (params.get("enriching") === "1") {
      data.refreshEnrichment();
      refreshMapAssets();
      toast.info("Map upload complete. Third-party enrichment is unavailable in local mode.");
      params.delete("enriching");
      const qs = params.toString();
      window.history.replaceState(
        null,
        "",
        `${window.location.pathname}${qs ? `?${qs}` : ""}`,
      );
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (presentation !== "page") return;
    const params = new URLSearchParams(window.location.search);

    params.delete("view");

    if (satelliteBasemap) params.set("basemap", "satellite");
    else params.delete("basemap");

    if (activeTab !== "overview") params.set("tab", activeTab);
    else params.delete("tab");

    const trimmedSearch = searchQuery.trim();
    if (trimmedSearch) params.set("search", trimmedSearch);
    else params.delete("search");

    if (selectedSearchResultId) params.set("searchResult", selectedSearchResultId);
    else params.delete("searchResult");

    const qs = params.toString();
    window.history.replaceState(null, "", `${window.location.pathname}${qs ? `?${qs}` : ""}`);
  }, [activeTab, presentation, searchQuery, selectedSearchResultId, satelliteBasemap]);

  // Edit mode
  const [editMode, setEditMode] = useState(false);

  // Right panel collapsed state
  const [panelOpen, setPanelOpen] = useState(true);

  // Reset-view nonce
  const [resetViewNonce, setResetViewNonce] = useState(0);
  const requestResetView = useCallback(() => setResetViewNonce((n) => n + 1), []);

  // Left search panel
  const [searchPanelOpen, setSearchPanelOpen] = useState(false);
  const [searchPanelOpenNonce, setSearchPanelOpenNonce] = useState(0);
  const openSearchPanel = useCallback(() => {
    setSearchPanelOpen(true);
    setSearchPanelOpenNonce((n) => n + 1);
  }, []);

  // Media panel
  const [activeMedia, setActiveMedia] = useState<{ proxyUrl: string; label?: string } | null>(null);
  const [mediaPanelWidth, setMediaPanelWidth] = useState(480);

  const [thumbnailBusy, setThumbnailBusy] = useState(false);
  const [createBlankBusy, setCreateBlankBusy] = useState(false);
  const thumbnailTriggerRef = useRef<{ generate: () => void } | null>(null);

  // Highlighted feature IDs (from inspector "highlight" buttons).
  const [manualHighlightedFeatureIds, setManualHighlightedFeatureIds] = useState<number[]>([]);

  // All map detail data from the extracted hook
  const data = useMapAssetDetailData(currentAsset);

  // Server-side search
  const { data: searchState, isLoading: searchLoading } = useMapSearchServer(
    currentAsset.map_asset_id,
    searchQuery,
    data.enrichmentVersion,
  );

  // LLM-driven candidate search
  const aiSearch = useMapSearchLlm(currentAsset.map_asset_id);

  // Flatten candidates across the entire AI chat thread
  const aiChatCandidates = useMemo(() => {
    const out: MapSearchResult[] = [];
    for (const message of aiSearch.messages) {
      if (message.role === "assistant") out.push(...message.candidates);
    }
    return out;
  }, [aiSearch.messages]);

  // Scenario overlay state (extracted hook)
  const scenarioOverlay = useScenarioOverlayState({
    currentAsset,
    aiSearchMessages: aiSearch.messages,
    viewMode,
  });

  // Map asset operations (extracted hook)
  function refreshMapAssets() {
    router.refresh();
  }

  const ops = useMapAssetOperations({
    currentAsset,
    onEnrichmentSucceeded: () => data.refreshEnrichment(),
    onRefreshMapAssets: refreshMapAssets,
  });

  // Resolve the active place ref.
  const selectedPlaceRef = useMemo(() => {
    if (selectedSearchResultId) {
      const fromKeyword = searchState.results.find((r) => r.id === selectedSearchResultId);
      if (fromKeyword?.geometryReference) return fromKeyword.geometryReference;
      const fromAi = aiChatCandidates.find((r) => r.id === selectedSearchResultId);
      if (fromAi?.geometryReference) return fromAi.geometryReference;
    }
    if (data.selectedCandidateLocationId) {
      return { kind: "candidate" as const, candidateId: data.selectedCandidateLocationId };
    }
    return null;
  }, [
    selectedSearchResultId,
    searchState.results,
    aiChatCandidates,
    data.selectedCandidateLocationId,
  ]);

  const placeHighlight = useMemo(
    () =>
      resolvePlaceHighlight(selectedPlaceRef, {
        candidates: data.candidateLocations,
        roadNetwork: data.selectedGeoJSON,
        enrichment: data.selectedEnrichment,
        coordRef: currentAsset.map_coordinate_ref,
      }),
    [
      selectedPlaceRef,
      data.candidateLocations,
      data.selectedGeoJSON,
      data.selectedEnrichment,
      currentAsset.map_coordinate_ref,
    ],
  );

  // Point marker per search result
  const searchResultMarkers = useMemo(() => {
    const ctx = {
      candidates: data.candidateLocations,
      roadNetwork: data.selectedGeoJSON,
      enrichment: data.selectedEnrichment,
      coordRef: currentAsset.map_coordinate_ref,
    };
    const markers: SearchResultMarkerSpec[] = [];
    const seen = new Set<string>();
    const pushMarker = (result: MapSearchResult) => {
      if (seen.has(result.id)) return;
      if (!result.geometryReference) return;
      const hl = resolvePlaceHighlight(result.geometryReference, ctx);
      let lng: number | null = null;
      let lat: number | null = null;
      if (hl.overlayCoords) {
        [lng, lat] = hl.overlayCoords;
      } else if (hl.bounds) {
        const [[minLng, minLat], [maxLng, maxLat]] = hl.bounds;
        lng = (minLng + maxLng) / 2;
        lat = (minLat + maxLat) / 2;
      }
      if (lng == null || lat == null) return;
      seen.add(result.id);
      markers.push({
        id: result.id,
        lng,
        lat,
        scenePosition: hl.focusTarget ? hl.focusTarget.position : null,
      });
    };
    for (const result of searchState.results) pushMarker(result);
    for (const candidate of aiChatCandidates) pushMarker(candidate);
    return markers;
  }, [
    searchState.results,
    aiChatCandidates,
    data.candidateLocations,
    data.selectedGeoJSON,
    data.selectedEnrichment,
    currentAsset.map_coordinate_ref,
  ]);

  const highlightedFeatureIds = useMemo(() => {
    if (placeHighlight.highlightedFeatureIds.length === 0) return manualHighlightedFeatureIds;
    const combined = new Set(manualHighlightedFeatureIds);
    for (const id of placeHighlight.highlightedFeatureIds) combined.add(id);
    return [...combined];
  }, [manualHighlightedFeatureIds, placeHighlight.highlightedFeatureIds]);

  const mergedOverlayCoords = placeHighlight.overlayCoords ?? data.selectedOverlayCoords;

  const overtureCrosswalkSurvivorCount = useMemo(() => {
    const crosswalksLayer = data.selectedEnrichment?.overlay_payload.layers.find(
      (l) => l.layer_id === "crosswalks",
    );
    if (!crosswalksLayer) return undefined;
    return countOvertureCrosswalkSurvivors(data.signalOverlayGeoJSON, crosswalksLayer);
  }, [data.selectedEnrichment, data.signalOverlayGeoJSON]);

  // Proximity arrows (extracted hook)
  const {
    proximityArrowGeoJSON,
    topologyPathGeoJSON,
    proximityArrows3D,
    relatedHighlights,
  } = useProximityArrows({
    selectedSearchResultId,
    placeHighlight,
    highlightedRelatedObjectId,
    searchResults: searchState.results,
    aiChatCandidates,
    viewMode,
    currentAsset,
    ctx: {
      candidates: data.candidateLocations,
      roadNetwork: data.selectedGeoJSON,
      enrichment: data.selectedEnrichment,
      coordRef: currentAsset.map_coordinate_ref,
    },
  });

  useEffect(() => {
    if (searchState.results.length === 0) {
      if (!searchQuery.trim()) return;
      setSelectedSearchResultId(null);
      setHoveredSearchResultId(null);
      return;
    }
    const isKnown = (id: string) =>
      searchState.results.some((result) => result.id === id) ||
      aiChatCandidates.some((candidate) => candidate.id === id);
    setSelectedSearchResultId((current) =>
      current && isKnown(current) ? current : null,
    );
    setHoveredSearchResultId((current) =>
      current && isKnown(current) ? current : null,
    );
  }, [searchState.results, aiChatCandidates, searchQuery]);

  useEffect(() => {
    if (highlightedRelatedObjectId == null) return;
    if (!selectedSearchResultId) {
      setHighlightedRelatedObjectId(null);
      return;
    }
    const result =
      searchState.results.find((r) => r.id === selectedSearchResultId) ??
      aiChatCandidates.find((r) => r.id === selectedSearchResultId);
    if (!result) {
      setHighlightedRelatedObjectId(null);
      return;
    }
    const refs = result.relatedObjectRefs ?? [];
    const reachable =
      refs.some((r) => r.objectId === highlightedRelatedObjectId) ||
      refs.some((r) =>
        r.path?.some((s) => s.objectId === highlightedRelatedObjectId),
      );
    if (!reachable) setHighlightedRelatedObjectId(null);
  }, [
    selectedSearchResultId,
    searchState.results,
    aiChatCandidates,
    highlightedRelatedObjectId,
  ]);

  const syncedCandidateFromSearchRef = useRef<string | null>(null);
  useEffect(() => {
    if (!selectedSearchResultId) {
      if (
        searchPanelOpen &&
        data.selectedCandidateLocationId !== null &&
        data.selectedCandidateLocationId === syncedCandidateFromSearchRef.current
      ) {
        data.setSelectedCandidateLocationId(null);
      }
      syncedCandidateFromSearchRef.current = null;
      return;
    }
    if (!searchState.results.some((result) => result.id === selectedSearchResultId)) return;
    const nextCandidateId = placeHighlight.candidateId;
    if (data.selectedCandidateLocationId !== nextCandidateId) {
      data.setSelectedCandidateLocationId(nextCandidateId);
    }
    syncedCandidateFromSearchRef.current = nextCandidateId;
  }, [searchPanelOpen, data, placeHighlight.candidateId, searchState.results, selectedSearchResultId]);

  // Switch the server-backed dynamic route through the App Router.
  const handleSwitchMap = useCallback(
    (mapAssetId: string) => {
      const newAsset = allAssets.find((a) => a.map_asset_id === mapAssetId);
      if (!newAsset || newAsset.map_asset_id === currentAsset.map_asset_id) return;
      setEditMode(false);
      setManualHighlightedFeatureIds([]);
      setSelectedSearchResultId(null);
      data.setSelectedFeatures([]);
      data.setSelectedFeatureId(null);
      data.setSelectedCandidateLocationId(null);
      if (onSwitchMap) {
        onSwitchMap(mapAssetId);
        return;
      }
      const params = new URLSearchParams(window.location.search);
      params.delete("searchResult");
      const qs = params.toString();
      router.replace(
        `/dashboard/map-assets/${encodeURIComponent(mapAssetId)}${qs ? `?${qs}` : ""}`,
        { scroll: false },
      );
    },
    [allAssets, currentAsset.map_asset_id, data, onSwitchMap, router],
  );

  function handleTabChange(tab: string) {
    setActiveTab(tab as DetailTab);
  }

  function handleSubmitSearch(nextQuery?: string) {
    const trimmed = (nextQuery ?? searchDraft).trim();
    setSearchDraft(trimmed);
    setSearchQuery(trimmed);
    setSearchPanelOpen(true);
  }

  const handleSelectFeature = useCallback(
    (features: SelectedGeoJSONFeaturePayload[]) => {
      data.setSelectedFeatures(features);
      setManualHighlightedFeatureIds([]);
      data.setSelectedCandidateLocationId(null);
      if (features.length === 0) {
        data.setSelectedFeatureId(null);
      } else {
        const prevId = data.selectedFeatureId;
        const newId =
          prevId !== null && features.some((f) => f.id === prevId)
            ? prevId
            : features[0]!.id;
        data.setSelectedFeatureId(newId);
        handleTabChange("layers");
      }
    },
    [data],
  );

  const handleHighlightGuid = useCallback(
    (guid: string) => {
      const mapId = data.guidToMapId.get(guid);
      if (mapId === undefined) return;
      setManualHighlightedFeatureIds((prev) =>
        prev.length === 1 && prev[0] === mapId ? [] : [mapId],
      );
    },
    [data.guidToMapId],
  );

  const handleSelectGuid = useCallback(
    (guid: string) => {
      const mapId = data.guidToMapId.get(guid);
      if (mapId === undefined) return;

      const fc = data.selectedGeoJSON as {
        features?: Array<{ properties?: Record<string, unknown>; geometry?: { type?: string } }>;
      } | null;
      const feature = fc?.features?.find(
        (f) => f.properties?.[GEOJSON_FEATURE_ID_PROP] === mapId,
      );
      if (!feature) return;

      const payload: SelectedGeoJSONFeaturePayload = {
        id: mapId,
        summary: getFeatureSummaryLine(feature as never),
        geometryType: getGeometryType(feature as never),
        properties: featurePropertiesForPanel(
          (feature.properties ?? {}) as Record<string, unknown>,
        ),
      };

      data.setSelectedFeatures([payload]);
      data.setSelectedFeatureId(mapId);
      setManualHighlightedFeatureIds([]);
      data.setSelectedCandidateLocationId(null);
      handleTabChange("layers");
    },
    [data],
  );

  const hasGeoJSON = currentAsset.artifacts.some((a) => a.artifact_type === "geojson");
  const scenariosReady = isSimulationReady(currentAsset);

  const createScenarioFromMap = useCallback(async () => {
    const query = new URLSearchParams({ map: currentAsset.map_asset_id });
    return `/dashboard/scenario?${query}`;
  }, [currentAsset.map_asset_id]);

  const handleCreateBlankScenario = useCallback(async () => {
    if (!scenariosReady) {
      toast.error("This map is not ready for SimForge authoring yet.");
      return;
    }
    setCreateBlankBusy(true);
    try {
      const editorHref = await createScenarioFromMap();
      router.push(editorHref);
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : "Failed to create blank scenario",
      );
    } finally {
      setCreateBlankBusy(false);
    }
  }, [createScenarioFromMap, router, scenariosReady]);

  const handleSelectSearchResult = useCallback(
    (resultId: string) => {
      setSelectedSearchResultId(resultId);
      data.setSelectedFeatures([]);
      data.setSelectedFeatureId(null);
      setManualHighlightedFeatureIds([]);
    },
    [data],
  );

  const handleToggleSelectSearchResult = useCallback(
    (resultId: string) => {
      if (selectedSearchResultId === resultId) {
        setSelectedSearchResultId(null);
        return;
      }
      handleSelectSearchResult(resultId);
    },
    [selectedSearchResultId, handleSelectSearchResult],
  );

  const handleSelectCandidateFromPanel = useCallback(
    (id: string | null) => {
      setSelectedSearchResultId(null);
      setHoveredSearchResultId(null);
      data.setSelectedCandidateLocationId(id);
    },
    [data],
  );

  const handleZoomToSearchResult = useCallback(
    (resultId: string) => {
      handleSelectSearchResult(resultId);
    },
    [handleSelectSearchResult],
  );

  const handleToggleHighlightRelated = useCallback(
    (resultId: string, objectId: string | null) => {
      if (selectedSearchResultId !== resultId) {
        handleSelectSearchResult(resultId);
      }
      setHighlightedRelatedObjectId(objectId);
    },
    [selectedSearchResultId, handleSelectSearchResult],
  );

  const handleUseSearchResultInScenario = useCallback(
    (resultId: string) => {
      handleSelectSearchResult(resultId);
      void handleCreateBlankScenario();
    },
    [handleCreateBlankScenario, handleSelectSearchResult],
  );

  return (
    <div className="relative flex h-full flex-col">
      {/* Header bar */}
      {presentation === "page" ? <MapDetailHeader
        asset={currentAsset}
        allAssets={allAssets}
        onEdit={() => setEditMode(true)}
        onPopulateMetadata={() => void ops.handlePopulateMetadata()}
        onEnrich={() => void ops.handleEnrich()}
        onRefreshSearchIndex={() => void ops.handleRefreshSearchIndex()}
        onGenerateThumbnail={() => thumbnailTriggerRef.current?.generate()}
        onSwitchMap={handleSwitchMap}
        onCreateBlankScenario={() => void handleCreateBlankScenario()}
        canCreateBlankScenario={scenariosReady}
        populateBusy={ops.populateBusy}
        enrichBusy={ops.enrichBusy}
        refreshSearchIndexBusy={ops.refreshSearchIndexBusy}
        thumbnailBusy={thumbnailBusy}
        createBlankBusy={createBlankBusy}
      /> : (
        <div className="flex h-12 shrink-0 items-center justify-between border-b border-border bg-background px-3">
          <span className="text-xs text-muted-foreground">2D map workspace</span>
          <button
            type="button"
            aria-label="Close 2D map"
            onClick={onClose}
            className="grid size-8 place-items-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <X className="size-4" />
          </button>
        </div>
      )}

      {/* Finalizing banner */}
      {ops.enrichBusy ? (
        <div
          role="status"
          aria-live="polite"
          className="flex items-center gap-2 border-b border-amber-500/30 bg-amber-500/10 px-4 py-2 text-sm text-amber-700 dark:text-amber-300"
        >
          <Loader2 className="h-4 w-4 shrink-0 animate-spin" />
          <span>
            Finalizing this map — extracting locations and building the search
            index. Locations and search results fill in automatically when
            this completes (usually ~1–3&nbsp;min); you can keep using the map
            meanwhile.
          </span>
        </div>
      ) : null}

      {/* Main content: left search panel + map canvas + right panel */}
      <div className="relative flex-1 flex min-h-0">
        {/* Left search panel */}
        {searchPanelOpen && !editMode ? (
          <div className="relative w-[30rem] shrink-0 min-h-0">
            <div className="absolute inset-0 overflow-hidden flex flex-col border-r border-border bg-background">
              <SearchPanelTabs
                key={searchPanelOpenNonce}
                keyword={{
                  draftQuery: searchDraft,
                  query: searchQuery,
                  chips: searchState.chips,
                  results: searchState.results,
                  freeText: searchState.freeText,
                  selectedResultId: selectedSearchResultId,
                  highlightedRelatedObjectId: highlightedRelatedObjectId,
                  loading: searchLoading,
                  onDraftQueryChange: setSearchDraft,
                  onSubmitSearch: handleSubmitSearch,
                  onSelectResult: handleToggleSelectSearchResult,
                  onZoomToResult: handleZoomToSearchResult,
                  onUseInScenario: handleUseSearchResultInScenario,
                  onHoverResult: setHoveredSearchResultId,
                  onToggleHighlightRelated: handleToggleHighlightRelated,
                  autoFocus: searchPanelOpenNonce > 0,
                }}
                ai={{
                  search: aiSearch,
                  selectedResultId: selectedSearchResultId,
                  highlightedRelatedObjectId: highlightedRelatedObjectId,
                  onSelectResult: handleToggleSelectSearchResult,
                  onZoomToResult: handleZoomToSearchResult,
                  onUseInScenario: handleUseSearchResultInScenario,
                  onHoverResult: setHoveredSearchResultId,
                  onToggleHighlightRelated: handleToggleHighlightRelated,
                  selectedScenarioId: scenarioOverlay.selectedScenarioId,
                  onSelectScenario: scenarioOverlay.handleSelectScenario,
                  validation: scenarioOverlay.validation,
                }}
              />
            </div>
            <button
              type="button"
              onClick={() => setSearchPanelOpen(false)}
              aria-label="Collapse search panel"
              className="absolute top-5 -right-4 z-20 flex size-8 items-center justify-center text-muted-foreground transition-colors hover:text-foreground"
            >
              <PanelLeftClose className="size-4" />
            </button>
          </div>
        ) : null}

        {/* 2D map canvas */}
        <div className="flex-1 relative">
          {/* Floating reset-view control */}
          <div className="absolute top-3 right-3 z-20 flex items-center gap-1.5">
            <button
              type="button"
              onClick={requestResetView}
              className="inline-flex size-8 items-center justify-center rounded-md border border-border bg-background/95 backdrop-blur shadow-sm text-muted-foreground hover:text-foreground transition-colors"
              aria-label="Reset view"
              title="Reset view"
            >
              <Home className="size-3.5" />
            </button>
            <div className="flex rounded-md border border-border bg-background/95 p-0.5 shadow-sm">
              {(["2d", "3d"] as const).map((mode) => (
                <button
                  key={mode}
                  type="button"
                  onClick={() => setViewMode(mode)}
                  className={`rounded px-2 py-1 text-[11px] font-medium uppercase transition-colors ${
                    viewMode === mode
                      ? "bg-foreground text-background"
                      : "text-muted-foreground hover:text-foreground"
                  }`}
                  aria-pressed={viewMode === mode}
                >
                  {mode}
                </button>
              ))}
            </div>
          </div>

          {/* Floating search bar */}
          {!searchPanelOpen && !editMode ? (
            <div className="absolute top-3 left-3 z-20 w-[30rem]">
              <button
                type="button"
                onClick={openSearchPanel}
                className="relative w-full h-10 pl-9 pr-3 rounded-md border border-primary/50 bg-background/95 backdrop-blur shadow-[0_0_0_1px_hsl(var(--primary)/0.15),0_4px_12px_-2px_hsl(var(--primary)/0.25)] flex items-center text-sm text-foreground/80 hover:border-primary hover:bg-background hover:text-foreground hover:shadow-[0_0_0_1px_hsl(var(--primary)/0.25),0_6px_16px_-2px_hsl(var(--primary)/0.35)] transition"
                aria-label="Open search"
              >
                <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-primary" />
                {searchDraft.trim() || "Search this map..."}
              </button>
              {searchQuery.trim() ? (
                <p className="mt-1 pl-1 text-[11px] text-muted-foreground">
                  {searchLoading
                    ? "Searching…"
                    : `${searchState.results.length} ${
                        searchState.results.length === 1 ? "result" : "results"
                      }`}
                </p>
              ) : null}
            </div>
          ) : null}

          <div className="absolute inset-0">
            {viewMode === "3d" ? (
              <DigitalTwinViewerPanel
                asset={currentAsset}
                focusTarget={
                  scenarioOverlay.scenarioFocusTarget3D ?? placeHighlight.focusTarget
                }
                resetViewNonce={resetViewNonce}
                searchResultMarkers={searchResultMarkers}
                hoveredSearchResultId={hoveredSearchResultId}
                proximityArrows={proximityArrows3D}
                actorTrajectories={scenarioOverlay.actorTrajectories3D}
                collisionMarker={scenarioOverlay.collisionMarker3D}
                actorSpawns={scenarioOverlay.actorSpawns3D}
              />
            ) : (
              <MapAssetsMapDynamic
                  assets={[currentAsset]}
                  selectedAssetId={currentAsset.map_asset_id}
                  showLaneChips
                  selectedGeoJSON={data.selectedGeoJSON}
                  selectedEnrichment={data.selectedEnrichment}
                  enabledOverlayLayerIds={data.enabledOverlayLayerIds}
                  enabledFeatureTypeIds={data.enabledFeatureTypeIds}
                  lanePolygonsGeoJSON={data.lanePolygonsGeoJSON}
                  laneRenderMode={data.laneRenderMode}
                  geojsonLoading={data.geojsonLoading}
                  onSelectAsset={() => {}}
                  onSelectFeature={handleSelectFeature}
                  selectedFeatureId={data.selectedFeatureId}
                  selectedLanePolygonId={
                    data.selectedFeatures.find((f) => f.id === data.selectedFeatureId)
                      ?.lanePolygonId ?? null
                  }
                  candidateLocations={data.candidateLocations}
                  selectedCandidateLocationId={data.selectedCandidateLocationId}
                  candidateFamilyLayers={data.candidateFamilyLayers}
                  enabledCandidateFamilyIds={data.enabledCandidateFamilyIds}
                  twinFidelityScorecard={data.twinFidelityScorecard}
                  enabledTwinFidelityLayerIds={data.enabledTwinFidelityLayerIds}
                  signalOverlayGeoJSON={data.signalOverlayGeoJSON}
                  speedLimitOverlayGeoJSON={data.speedLimitOverlayGeoJSON}
                  inHouseSpeedLimitOverlayGeoJSON={data.inHouseSpeedLimitOverlayGeoJSON}
                  enabledSignalCategories={data.enabledSignalCategories}
                  userGeoJsonLayers={data.userGeoJsonLayers}
                  selectedOverlayCoords={mergedOverlayCoords}
                  selectedOverlayGeometry={data.selectedOverlayGeometry}
                  highlightedFeatureIds={highlightedFeatureIds}
                  relatedHighlightedFeatureIds={relatedHighlights.featureIds}
                  relatedOverlayCoords={relatedHighlights.overlayCoords}
                  relatedCandidateIds={relatedHighlights.candidateIds}
                  proximityArrows={proximityArrowGeoJSON}
                  topologyPaths={topologyPathGeoJSON}
                  actorTrajectoryOverlay={scenarioOverlay.actorTrajectoryOverlay}
                  esminiTrajectoryOverlay={scenarioOverlay.esminiTrajectoryOverlay}
                  actorSpawnOverlay={scenarioOverlay.actorSpawnOverlay}
                  collisionPointOverlay={scenarioOverlay.collisionPointOverlay}
                  focusBounds={scenarioOverlay.scenarioFocusBounds?.bounds ?? placeHighlight.bounds}
                  searchResultMarkers={searchResultMarkers}
                  hoveredSearchResultId={hoveredSearchResultId}
                  selectedSearchResultId={selectedSearchResultId}
                  onSelectSearchResult={handleSelectSearchResult}
                  resetViewNonce={resetViewNonce}
                  satelliteEnabled={satelliteBasemap}
                  onSatelliteEnabledChange={setSatelliteBasemap}
                  enableMeasureTool
              />
            )}
          </div>

          {/* Fly-by media player */}
          {activeMedia && (
            <MapMediaPanel
              proxyUrl={activeMedia.proxyUrl}
              label={activeMedia.label}
              assetName={currentAsset.name}
              width={mediaPanelWidth}
              onWidthChange={setMediaPanelWidth}
              onClose={() => setActiveMedia(null)}
            />
          )}
        </div>

        {/* Right panel with tabs — collapsible */}
        <MapDetailRightPanel
          panelOpen={panelOpen}
          setPanelOpen={setPanelOpen}
          editMode={editMode}
          setEditMode={setEditMode}
          currentAsset={currentAsset}
          router={router}
          refreshMapAssets={refreshMapAssets}
          activeTab={activeTab}
          handleTabChange={handleTabChange}
          focusFamilyId={focusFamilyId}
          setFocusFamilyId={setFocusFamilyId}
          data={data}
          ops={ops}
          overtureCrosswalkSurvivorCount={overtureCrosswalkSurvivorCount}
          handleSelectCandidateFromPanel={handleSelectCandidateFromPanel}
          setActiveMedia={setActiveMedia}
          runs={runs}
          scenarioOverlay={scenarioOverlay}
          manualHighlightedFeatureIds={manualHighlightedFeatureIds}
          setManualHighlightedFeatureIds={setManualHighlightedFeatureIds}
          handleHighlightGuid={handleHighlightGuid}
          handleSelectGuid={handleSelectGuid}
          hasGeoJSON={hasGeoJSON}
        />
      </div>

      {/* Hidden thumbnail generator */}
      <ThumbnailGenerator
        asset={currentAsset}
        hasThumbnail={currentAsset.artifacts?.some((a) => a.artifact_type === "thumbnail") ?? false}
        onGenerated={refreshMapAssets}
        hidden
        onBusyChange={setThumbnailBusy}
        triggerRef={thumbnailTriggerRef}
      />
    </div>
  );
}
