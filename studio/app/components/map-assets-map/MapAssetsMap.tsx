"use client";

import { Layer as MapLayer } from "react-map-gl/maplibre";
import type { MapLayerMouseEvent } from "react-map-gl/maplibre";
import type { Map as MapLibreMap } from "maplibre-gl";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
  MapAsset,
  MapAssetEnrichmentSnapshot,
  MapOverlayLayerId,
  CandidateLocation,
} from "@simforge/studio-shared";
import {
  ALL_FEATURE_TYPE_IDS,
  type RoadNetworkFeatureTypeId,
} from "@/app/lib/maps/frontend/road-network-feature-types";
import "maplibre-gl/dist/maplibre-gl.css";
import { JunctionSignalGlyphLayer } from "./layers/JunctionSignalGlyphLayer";
import { IntersectionCandidateLayer } from "./layers/IntersectionCandidateLayer";
import type { SelectedGeoJSONFeaturePayload } from "@/app/lib/maps/frontend/feature-inspection-types";
import {
  type UserGeoJsonLayer,
  userGeoJsonLayerIds as userGeoJsonLayerIdsFor,
} from "@/app/lib/maps/frontend/user-geojson-layers";
import type { LaneRenderMode } from "@/app/lib/maps/frontend/lane-render-mode";
import type { ScenarioCandidateFamilyLayer } from "@/app/lib/maps/frontend/scenario-candidate-layers";
import {
  twinFidelityLayerId,
  TWIN_FIDELITY_SUBLAYERS,
  type TwinFidelityScorecard,
  type TwinFidelitySubLayerId,
} from "@/app/lib/maps/frontend/twin-fidelity-layers";
import type { RuntimeLaneSelection } from "@/app/lib/editor-map/types";
import {
  DEFAULT_SEMANTIC_LAYER_VISIBILITY,
  type SemanticFeatureSelection,
  type SemanticLayerVisibility,
} from "@/app/lib/editor-map/semantic-overlay";
import {
  ALL_RUNTIME_LANE_TYPE_IDS,
  type RuntimeLaneTypeId,
} from "@/app/lib/editor-map/runtime-layer-visibility";
import { DEFAULT_BASEMAP, type BasemapId } from "@/app/lib/maps/frontend/basemaps";
import {
  DEFAULT_BASEMAP_LAYER_VISIBILITY,
  type BasemapLayerVisibility,
} from "@/app/lib/maps/frontend/basemap-visibility";
import { satelliteImageryLayersForAsset } from "@/app/lib/maps/frontend/satellite-imagery";
import {
  assetToBboxGeoJSON,
  assetsToPointsGeoJSON,
  assetsToPolygonGeoJSON,
  computeAllBounds,
  computeInitialViewState,
  featureByMapId,
  featurePropertiesForPanel,
  getFeatureSummaryLine,
  getGeometryType,
} from "@/app/lib/maps/frontend/map-assets-map-utils";
import {
  candidateLocationGeoJSON,
  candidateLocationBounds,
  candidateLocationsGeoJSONFor,
} from "@/app/lib/maps/frontend/candidate-location-utils";
import { computeTooltipPosition } from "@/app/lib/maps/frontend/tooltip-positioning";
import type { MapMarkerSizingMode } from "@/app/lib/maps/frontend/map-marker-sizing";
import { C } from "./map-layer-constants";
import { MapAssetsMapView } from "./MapAssetsMapView";
import {
  AssetPolygonLayers,
  SelectedBboxLayers,
  GeoJsonFeatureLayers,
  LanePolygonLayers,
  EnrichmentOverlayLayers,
  UserGeoJsonLayers,
  SignalOverlayLayers,
  TrafficLightLayers,
  WorldSensorLayers,
  SelectedOverlayHighlight,
  RelatedOverlayHighlights,
  PlacementAnchorLayers,
  ActorTrajectoryLayers,
  BehaviorTriggerLayers,
  EsminiTrajectoryLayers,
  TimedPointHighlightLayers,
  DerivedRunwayLayers,
  ScheduleLagLayers,
  PlacementBandLayers,
  CandidateLocationLayers,
  RelatedCandidateLocationLayers,
  ScenarioCandidateLayers,
  TwinFidelityLayers,
  scenarioCandidateSourceId,
  ProximityArrowLayers,
  TopologyPathLayers,
  AssetClusterLayers,
  RuntimeGeometryShellLayers,
  RuntimeRoadOverlayLayers,
  RuntimeActorLayers,
  SearchResultMarkersLayer,
  SemanticOverlayLayers,
  MeasureDistanceLayers,
} from "./layers";
import { SemanticSiteQueryLayers } from "./layers/SemanticSiteQueryLayers";
import { SemanticScenarioProofLayers } from "./layers/SemanticScenarioProofLayers";
import type { RuntimeActorMarker } from "./layers/RuntimeActorLayers";
import {
  CollisionPointMarker,
  type CollisionPointOverlay,
} from "./layers/CollisionPointMarker";
import { ActorSpawnLayer } from "./layers/ActorSpawnLayer";
import { SpeedLimitLayers } from "./layers/SpeedLimitLayers";
import { SPEED_SIGN_OVERTURE_ICON, SPEED_SIGN_XODR_ICON } from "./map-icons";
import type { ActorSpawn2D } from "@/app/lib/maps/frontend/scenario-actor-spawns";
import type { SearchResultMarker } from "./layers/SearchResultMarkersLayer";
import type {
  EnrichmentLayerStyle,
  RoadNetworkLayerStyle,
  RuntimeLaneLayerStyle,
  SignalLayerStyle,
} from "@/app/lib/scenario-editor/layer-styles";
const TRAFFIC_LIGHT_HIGHLIGHT_STYLE: SignalLayerStyle = {
  color: "#facc15",
  radius: 12,
  opacity: 1,
  strokeColor: "#E8E044",
  strokeWidth: 3,
  textColor: "#0a0a0a",
  textHaloColor: "#facc15",
};

const PLACEMENT_ANCHOR_LAYER_STACK = [
  "placement-anchor-route-casing",
  "placement-anchor-line",
  "placement-anchor-circle",
  "placement-anchor-label",
] as const;

function elevatePlacementAnchorLayers(map: MapLibreMap) {
  for (const layerId of PLACEMENT_ANCHOR_LAYER_STACK) {
    if (map.getLayer(layerId)) map.moveLayer(layerId);
  }

  const layers = map.getStyle().layers ?? [];
  const routeIndex = layers.findIndex(
    (layer) => layer.id === "placement-anchor-line",
  );
  const runtimeRoadIndexes = layers.flatMap((layer, index) =>
    "source" in layer &&
    (layer.source === "runtime-road-overlay" ||
      layer.source === "runtime-road-centerlines")
      ? [index]
      : [],
  );
  return (
    routeIndex >= 0 &&
    runtimeRoadIndexes.length > 0 &&
    runtimeRoadIndexes.every((index) => index < routeIndex)
  );
}

import { useMapViewportController } from "./hooks/useMapViewportController";
import { useGeoJsonFeatureState } from "./hooks/useGeoJsonFeatureState";
import { useGeoJsonHover, useGeoJsonSelection } from "./hooks/useGeoJsonInteraction";
import { useAssetClusterClick, useAssetHover } from "./hooks/useAssetClusterInteraction";
import {
  useRuntimeActorContextMenu,
  useRuntimeActorMouseDown,
  useTimedPathSegmentClick,
  useTimedPointMouseDown,
  useRuntimeLaneHover,
  useRuntimeLaneSelect,
} from "./hooks/useRuntimeLaneInteraction";
import {
  useSemanticFeatureHover,
  useSemanticFeatureSelect,
} from "./hooks/useSemanticFeatureInteraction";
import { useMeasureTool } from "./hooks/useMeasureTool";
import { useMapViewModeCamera } from "./hooks/useMapViewModeCamera";
import { useMapWasdPan } from "./hooks/useMapWasdPan";
import { useHorizonSafeDragPan } from "./hooks/useHorizonSafeDragPan";
import { unprojectGroundPoint } from "@/app/lib/maps/frontend/ground-unproject";
import { useMapViewModeStore } from "@/app/lib/scenario-editor/stores";
import {
  Map3DLayer,
  type Map3DLoadState,
  type Map3DWorldSensor,
} from "./layers/Map3DLayer";
import { SIGNAL_HIT_LAYER_ID } from "@/app/lib/scenario-editor/map-3d/signal-hit-features";
import { pickSignalHeadAt } from "@/app/lib/scenario-editor/map-3d/signal-picking";

/** Re-export the payload type for selected GeoJSON feature inspection. */
export type { SelectedGeoJSONFeaturePayload } from "@/app/lib/maps/frontend/feature-inspection-types";

export type MapAssetsMapProps = {
  assets: MapAsset[];
  selectedAssetId?: string | null;
  selectedGeoJSON?: object | null;
  showAuthoredLayers?: boolean;
  selectedEnrichment?: MapAssetEnrichmentSnapshot | null;
  enabledOverlayLayerIds?: MapOverlayLayerId[];
  overlayStyleOverrides?: Partial<Record<MapOverlayLayerId, EnrichmentLayerStyle>>;
  enabledFeatureTypeIds?: RoadNetworkFeatureTypeId[];
  featureTypeStyleOverrides?: Partial<Record<RoadNetworkFeatureTypeId, RoadNetworkLayerStyle>>;
  /** Filled lane-area polygons reconstructed from XODR widths (lane_polygons sidecar). */
  lanePolygonsGeoJSON?: object | null;
  /** Whether lanes draw as filled polygons or authored centerlines (user toggle). */
  laneRenderMode?: LaneRenderMode;
  geojsonLoading?: boolean;
  onSelectAsset?: (id: string | null) => void;
  onSelectFeature?: (payload: SelectedGeoJSONFeaturePayload[]) => void;
  selectedFeatureId?: number | null;
  /** Unique lane_poly_id of the clicked filled lane polygon (highlight target). */
  selectedLanePolygonId?: number | null;
  candidateLocations?: CandidateLocation[];
  selectedCandidateLocationId?: string | null;
  /** Scenario-candidate family layers (all families with candidates). */
  candidateFamilyLayers?: ScenarioCandidateFamilyLayer[];
  /** Family ids whose candidate layer is toggled on in the Layers panel. */
  enabledCandidateFamilyIds?: string[];
  /** Twin-fidelity scorecard artifact for the selected asset (if imported). */
  twinFidelityScorecard?: TwinFidelityScorecard | null;
  /** Twin-fidelity sub-layers toggled on in the Layers panel. */
  enabledTwinFidelityLayerIds?: TwinFidelitySubLayerId[];
  /** User-uploaded GeoJSON overlays (session-only, co-visualization). */
  userGeoJsonLayers?: UserGeoJsonLayer[];
  signalOverlayGeoJSON?: object | null;
  /** Overture driving-lane lines carrying `speed_limit_mph`; rendered as signs when non-empty. */
  speedLimitOverlayGeoJSON?: object | null;
  /** In-house (XODR) driving-lane lines carrying `speed_limit_mph`; rendered as signs when non-empty. */
  inHouseSpeedLimitOverlayGeoJSON?: object | null;
  runtimeTrafficLightGeoJSON?: object | null;
  highlightRuntimeTrafficLights?: boolean;
  worldSensorGeoJSON?: object | null;
  markerScale?: number;
  markerSizingMode?: MapMarkerSizingMode;
  labelScale?: number;
  enabledSignalCategories?: Set<string>;
  signalStyleOverrides?: Record<string, SignalLayerStyle>;
  selectedOverlayCoords?: [number, number] | null;
  /** Full geometry of the focused selected feature (used for polygon outlines). */
  selectedOverlayGeometry?: Record<string, unknown> | null;
  placementAnchorOverlay?: object | null;
  /** Trigger geometry for the selected behavior clip (dashed radius rings and
   *  actor-to-actor link lines). Absent (null) whenever no clip is selected. */
  behaviorTriggerOverlay?: object | null;
  /** Planned actor trajectories for an AI-proposed scenario draft (GeoJSON
   *  LineStrings + start points). Rendered solid, distinct from the dashed
   *  placement-anchor overlay. */
  actorTrajectoryOverlay?: object | null;
  /** Actual esmini-simulated trajectories (GeoJSON) for the highlighted
   *  scenario — the ground-truth paths + collision points from a validation
   *  run, overlaid on the planned trajectories for comparison. */
  esminiTrajectoryOverlay?: object | null;
  /** Per-actor paths the local/CARLA simulation produced (GeoJSON
   *  LineStrings), drawn dashed and translucent under the ghost markers so a
   *  parameter tweak visibly bends the path without playing the scene back. */
  /** The authored drive-by-points marker each scheduled actor is driving
   *  toward at the current playhead. Its own overlay rather than a property on
   *  `placementAnchorOverlay` because it updates with the playhead, not the
   *  draft (plan 2026-07-25 section 6.7). */
  timedPointHighlightOverlay?: object | null;
  /** Where each drive-by-points actor's SCHEDULE says it should be at the
   *  playhead, tethered to where the simulation actually put it. The gap is
   *  the physics story an infeasible spacing tells, and it is invisible
   *  without this (plan 2026-07-25 section 6). */
  /**
   * Where a placed car will actually go, from `buildDerivedRunwayOverlay`.
   *
   * Its own overlay because it comes from the SERVER (the lane-graph walk needs
   * the whole semantic graph) and refreshes when the placement or a `turn` clip
   * changes — not with the playhead like `scheduleLagOverlay`, and not with the
   * draft like `placementAnchorOverlay`.
   */
  derivedRunwayOverlay?: object | null;
  scheduleLagOverlay?: object | null;
  /** The annulus the next drive-by-points click can land in and still be
   *  drivable — outer edge is flat-out acceleration, inner edge is maximum
   *  braking. Drawn only while placement or a point drag is live. */
  placementBandOverlay?: object | null;
  /** Diagnostic collision-point marker — a single red X at the closest-
   *  approach point between two actor trajectories. Absent (null) when no
   *  draft is proposed, or when no pair came within the diagnostic
   *  threshold. Derived client-side from the draft actors; see
   *  `deriveCollisionPoint` in `scenario-collision-point.ts`. */
  collisionPointOverlay?: CollisionPointOverlay | null;
  /** Per-actor spawn markers for the highlighted AI-proposed scenario.
   *  Empty/absent when no scenario is highlighted. Renders the editor's
   *  `ActorIcon` SVGs tinted per-actor so the marker, the trajectory
   *  line, and the heading arrowhead all share the same color. */
  actorSpawnOverlay?: ActorSpawn2D[] | null;
  highlightedFeatureIds?: number[];
  /**
   * Subtle-tier feature ids — render with a muted blue instead of the bright
   * yellow used for the selected object. Used to surface spatial-relation
   * neighbors of the focused search result.
   */
  relatedHighlightedFeatureIds?: number[];
  /** Overlay coords for subtle POI rings on related neighbors. */
  relatedOverlayCoords?: readonly [number, number][];
  /** Candidate-backed related neighbors rendered as dashed polygons. */
  relatedCandidateIds?: readonly string[];
  /**
   * Optional arrow GeoJSON showing "this subject matched because of that
   * neighbor" for spatial-search results. Built by the parent from the
   * selected result's centroid + the centroid of each of its top-K
   * `relatedObjectRefs`. See `ProximityArrowLayers` for the expected shape.
   */
  proximityArrows?: object | null;
  /**
   * Optional GeoJSON for topology relations (`leads_to` and friends). Each
   * feature is a LineString tracing the actual route from the subject
   * through every intermediate hop to the matched neighbor. Rendered as a
   * solid line with ▶ markers along it — the geometric counterpart to the
   * dashed straight arrow used for spatial relations. See `TopologyPathLayers`.
   */
  topologyPaths?: object | null;
  /** Exact CARLA runtime lane polygons rendered below authored/semantic
   *  layers. This is display-only and intentionally has no hit target. */
  runtimeGeometryShell?: object | null;
  runtimeRoadOverlay?: object | null;
  showRuntimeOverlayLayers?: boolean;
  /**
   * Intersection-control markers and armed candidates. Its own switch rather
   * than riding on the runtime/authored flags: a placed control is authored
   * content, and turning the road overlay off must not hide it.
   */
  showIntersectionControls?: boolean;
  /** Armed placement: fade non-candidate chrome rather than hiding it. */
  dimNonCandidateLayers?: boolean;
  highlightedRuntimeRoadIds?: string[];
  selectedRuntimeLane?: RuntimeLaneSelection | null;
  runtimeRoadOverlayShowCenterlines?: boolean;
  runtimeRoadOverlayShowBoundaries?: boolean;
  runtimeRoadOverlayShowSurfaces?: boolean;
  enabledRuntimeLaneTypeIds?: RuntimeLaneTypeId[];
  runtimeLaneStyleOverrides?: Partial<Record<RuntimeLaneTypeId, RuntimeLaneLayerStyle>>;
  runtimeActorOverlay?: RuntimeActorMarker[] | null;
  /** Semantic authoring overlay (corridors/movements/conflicts) as GeoJSON
   *  built by `buildSemanticOverlayGeoJSON`. When present with a select or
   *  hover callback, semantic features are the default hit target and the raw
   *  runtime lane overlay becomes non-interactive debug display. */
  semanticOverlayGeoJSON?: object | null;
  semanticInspectionEnabled?: boolean;
  semanticSiteQueryGeoJSON?: object | null;
  semanticScenarioProofGeoJSON?: object | null;
  semanticLayersVisible?: SemanticLayerVisibility;
  /** `semanticFeatureKey` of the selected semantic feature (highlighted). */
  selectedSemanticFeatureKey?: string | null;
  /** `semanticFeatureKey` of the hovered semantic feature (highlighted). */
  hoveredSemanticFeatureKey?: string | null;
  onSelectSemanticFeature?: (payload: SemanticFeatureSelection) => void;
  onHoverSemanticFeature?: (payload: SemanticFeatureSelection | null) => void;
  semanticSelectableKinds?: SemanticFeatureSelection["kind"][];
  onClickWorldSensor?: (sensorId: string) => void;
  /**
   * A physical traffic-light head was clicked. Return true if it was consumed,
   * so the click does not fall through to the road under the light.
   */
  onClickSignalHead?: (signalId: string) => boolean;
  onMapClick?: (payload: {
    lng: number;
    lat: number;
    /** Alt/option was held: the drive-by-points clamp treats this as "place it
     *  exactly here", which is the escape hatch collision authoring needs. */
    altKey?: boolean;
  }) => boolean | void;
  onMapPointerMove?: (payload: { lng: number; lat: number }) => void;
  onMapPointerLeave?: () => void;
  onZoomChange?: (zoom: number) => void;
  onUserViewportChange?: () => void;
  /** Visible WGS84 bounds, fired on load and after every move end. */
  onViewportBoundsChange?: (bounds: {
    west: number;
    south: number;
    east: number;
    north: number;
  }) => void;
  onMouseDownRuntimeActor?: (payload: {
    actorId: string;
    clientX: number;
    clientY: number;
  }) => void;
  /** Right-click an actor: opens its details panel. */
  onContextMenuRuntimeActor?: (payload: {
    actorId: string;
    clientX: number;
    clientY: number;
  }) => void;
  /** Pick up an authored drive-by-points marker. Returning true claims the
   *  gesture, which suppresses the map's own pan (plan 2026-07-25 §6.3). */
  onMouseDownTimedPoint?: (payload: {
    actorId: string;
    index: number;
    clientX: number;
    clientY: number;
  }) => boolean | void;
  /** Click a drive-by-points segment to insert a point into it. Returning true
   *  claims the click before placement appends a new point at the end. */
  onClickTimedPathSegment?: (payload: {
    actorId: string;
    waypointIndex: number;
    lng: number;
    lat: number;
  }) => boolean | void;
  runtimeActorInteractionMode?: "select" | "move";
  /**
   * Offer the 2D/3D mode toggle on this surface.
   *
   * Opt-in rather than always-on: 3D mode reads editor stores for signal plans
   * and the map bundle, and the catalog and detail pages have neither. It also
   * gates `antialias`, which MapLibre only honours at construction time, so
   * surfaces that can never show a model do not pay for MSAA.
   */
  enable3DViewMode?: boolean;
  /**
   * Zoom floor for this surface, applied to gestures AND to every `fitBounds`.
   *
   * Per-surface rather than global: the catalog has to reach world zoom to show
   * where the assets are, and the scenario editor never usefully leaves the
   * metre scale it authors at.
   */
  minZoom?: number;
  /**
   * Zoom ceiling for this surface, applied to gestures AND to every `fitBounds`.
   * Defaults to `MAX_MAP_ZOOM` when unset.
   */
  maxZoom?: number;
  onSelectRuntimeLane?: (payload: RuntimeLaneSelection) => void;
  onHoverRuntimeLane?: (payload: RuntimeLaneSelection | null) => void;
  hoveredRuntimeLane?: RuntimeLaneSelection | null;
  preferRuntimeSelection?: boolean;
  interactionLocked?: boolean;
  focusBounds?: [[number, number], [number, number]] | null;
  /** Zoom ceiling for the `focusBounds` fit. Defaults to 18. */
  focusMaxZoom?: number;
  /**
   * World sensors as 3D mode needs them — typed poses, not the flattened
   * GeoJSON `worldSensorGeoJSON` the 2D layer draws. Empty everywhere except
   * the editor, so the catalog and detail maps pay nothing for it.
   */
  worldSensors3D?: readonly Map3DWorldSensor[];
  /** Selected world sensor, so 3D can highlight it the way 2D does. */
  selectedWorldSensorId?: string | null;
  /** Point markers for every search result, rendered on top of the map. */
  searchResultMarkers?: SearchResultMarker[];
  /** Id of the currently-hovered search result; that marker renders emphasized. */
  hoveredSearchResultId?: string | null;
  /**
   * Id of the currently-selected search result. The matching pin renders
   * emphasized (same treatment as hover) so the map and panel always agree
   * on what's selected, regardless of which side initiated the selection.
   */
  selectedSearchResultId?: string | null;
  /**
   * Reverse of the panel→map flow: clicking a search-result pin selects
   * the result in the side list. Omit to keep pins purely decorative.
   */
  onSelectSearchResult?: (id: string) => void;
  /** Bumped by the parent to request a refit to the full map bounds. */
  resetViewNonce?: number;
  onMapReady?: (map: MapLibreMap) => void;
  onMapError?: (message: string) => void;
  /** Keep the WebGL framebuffer readable for explicit editor snapshot capture. */
  enableSnapshotCapture?: boolean;
  basemapLayerVisibility?: BasemapLayerVisibility;
  pathEditingActive?: boolean;
  showCameraLabels?: boolean;
  /**
   * Render the round glyph chips stamped along sidewalk/bike/parking lanes,
   * enrichment lines, and crosswalks. Only the map asset detail view enables
   * these — the scenario editor and catalog leave them off to avoid cluttering
   * the authoring canvas.
   */
  showLaneChips?: boolean;
  /**
   * Controlled satellite-basemap toggle. When provided, the parent owns whether
   * the satellite layer is shown (e.g. to persist the choice across map switches
   * and in the URL); omit both to let the map manage the toggle internally.
   */
  satelliteEnabled?: boolean;
  onSatelliteEnabledChange?: (enabled: boolean) => void;
  /**
   * Offer the two-point distance-measure tool (ruler button bottom-right).
   * Only the map asset detail view enables it — the scenario editor has its
   * own click-driven placement modes that would fight over map clicks.
   */
  enableMeasureTool?: boolean;
};

/** Render the interactive map for browsing and inspecting map assets. */
export default function MapAssetsMap({
  assets,
  selectedAssetId,
  selectedGeoJSON,
  showAuthoredLayers = true,
  selectedEnrichment,
  enabledOverlayLayerIds = [],
  overlayStyleOverrides = {},
  enabledFeatureTypeIds = ALL_FEATURE_TYPE_IDS,
  featureTypeStyleOverrides = {},
  lanePolygonsGeoJSON = null,
  laneRenderMode = "filled",
  geojsonLoading,
  onSelectAsset,
  onSelectFeature,
  selectedFeatureId = null,
  selectedLanePolygonId = null,
  candidateLocations = [],
  selectedCandidateLocationId = null,
  candidateFamilyLayers = [],
  enabledCandidateFamilyIds = [],
  twinFidelityScorecard = null,
  enabledTwinFidelityLayerIds = [],
  userGeoJsonLayers = [],
  signalOverlayGeoJSON = null,
  speedLimitOverlayGeoJSON = null,
  inHouseSpeedLimitOverlayGeoJSON = null,
  runtimeTrafficLightGeoJSON = null,
  highlightRuntimeTrafficLights = false,
  worldSensorGeoJSON = null,
  markerScale = 1,
  markerSizingMode = "map",
  labelScale = 1,
  enabledSignalCategories = new Set<string>(),
  signalStyleOverrides = {},
  selectedOverlayCoords = null,
  selectedOverlayGeometry = null,
  placementAnchorOverlay = null,
  behaviorTriggerOverlay = null,
  actorTrajectoryOverlay = null,
  esminiTrajectoryOverlay = null,
  timedPointHighlightOverlay = null,
  derivedRunwayOverlay = null,
  scheduleLagOverlay = null,
  placementBandOverlay = null,
  collisionPointOverlay = null,
  actorSpawnOverlay = null,
  highlightedFeatureIds = [],
  relatedHighlightedFeatureIds = [],
  relatedOverlayCoords = [],
  relatedCandidateIds = [],
  proximityArrows = null,
  topologyPaths = null,
  runtimeGeometryShell = null,
  runtimeRoadOverlay = null,
  showRuntimeOverlayLayers = true,
  showIntersectionControls = true,
  dimNonCandidateLayers = false,
  highlightedRuntimeRoadIds = [],
  selectedRuntimeLane = null,
  runtimeRoadOverlayShowCenterlines = true,
  runtimeRoadOverlayShowBoundaries = true,
  runtimeRoadOverlayShowSurfaces = true,
  enabledRuntimeLaneTypeIds = ALL_RUNTIME_LANE_TYPE_IDS,
  runtimeLaneStyleOverrides = {},
  runtimeActorOverlay = null,
  semanticOverlayGeoJSON = null,
  semanticInspectionEnabled = false,
  semanticSiteQueryGeoJSON = null,
  semanticScenarioProofGeoJSON = null,
  semanticLayersVisible = DEFAULT_SEMANTIC_LAYER_VISIBILITY,
  selectedSemanticFeatureKey = null,
  hoveredSemanticFeatureKey = null,
  onSelectSemanticFeature,
  onHoverSemanticFeature,
  semanticSelectableKinds,
  onClickWorldSensor,
  onClickSignalHead,
  onMapClick,
  onMapPointerMove,
  onMapPointerLeave,
  onZoomChange,
  onUserViewportChange,
  onViewportBoundsChange,
  onMouseDownRuntimeActor,
  onContextMenuRuntimeActor,
  onMouseDownTimedPoint,
  onClickTimedPathSegment,
  runtimeActorInteractionMode = "select",
  enable3DViewMode = false,
  minZoom,
  maxZoom,
  onSelectRuntimeLane,
  onHoverRuntimeLane,
  hoveredRuntimeLane = null,
  preferRuntimeSelection = false,
  interactionLocked = false,
  focusBounds = null,
  focusMaxZoom,
  worldSensors3D = [],
  selectedWorldSensorId = null,
  searchResultMarkers = [],
  hoveredSearchResultId = null,
  selectedSearchResultId = null,
  onSelectSearchResult,
  resetViewNonce = 0,
  onMapReady,
  onMapError,
  enableSnapshotCapture = false,
  basemapLayerVisibility = DEFAULT_BASEMAP_LAYER_VISIBILITY,
  pathEditingActive = false,
  showCameraLabels = false,
  showLaneChips = false,
  satelliteEnabled: controlledSatelliteEnabled,
  onSatelliteEnabledChange,
  enableMeasureTool = false,
}: MapAssetsMapProps) {
  const [basemapId, _setBasemapId] = useState<BasemapId>(DEFAULT_BASEMAP);
  // Satellite toggle is controllable: when the parent passes `satelliteEnabled`
  // (to persist across map switches / in the URL) it wins; otherwise fall back
  // to internal state so uncontrolled consumers keep working.
  const [internalSatelliteEnabled, setInternalSatelliteEnabled] = useState(false);
  const satelliteEnabled = controlledSatelliteEnabled ?? internalSatelliteEnabled;
  const setSatelliteEnabled = onSatelliteEnabledChange ?? setInternalSatelliteEnabled;
  const [hoverInfo, setHoverInfo] = useState<{ count: number; name?: string } | null>(null);
  const [tooltipPosition, setTooltipPosition] = useState<{ x: number; y: number } | null>(null);
  const [geojsonHoverInfo, setGeojsonHoverInfo] = useState<{
    items: { id: number; summary: string }[];
    x: number;
    y: number;
  } | null>(null);
  const [clusterAssets, setClusterAssets] = useState<MapAsset[] | null>(null);
  const [clusterPosition, setClusterPosition] = useState<{ x: number; y: number } | null>(null);

  const assetsRef = useRef(assets);
  const clearTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  assetsRef.current = assets;

  // Satellite imagery follows the viewed asset (single-asset views pass one
  // asset without necessarily selecting it). Memoized off the asset object so
  // parents recreating the `assets` array each render don't re-style the map.
  const imageryAsset = useMemo(() => {
    if (selectedAssetId) {
      return assets.find((asset) => asset.map_asset_id === selectedAssetId) ?? null;
    }
    return assets.length === 1 ? assets[0] ?? null : null;
  }, [assets, selectedAssetId]);
  const availableSatelliteImagery = useMemo(
    () => satelliteImageryLayersForAsset(imageryAsset),
    [imageryAsset],
  );
  const hasSatelliteImagery = availableSatelliteImagery.length > 0;

  const allBounds = useMemo(() => computeAllBounds(assets), [assets]);
  const initialViewState = useMemo(
    () =>
      computeInitialViewState(assets) ?? {
        longitude: 0,
        latitude: 0,
        zoom: 2,
      },
    [assets],
  );
  const [viewZoom, setViewZoom] = useState(initialViewState.zoom);
  const polygonGeoJSON = useMemo(() => assetsToPolygonGeoJSON(assets), [assets]);
  const pointsGeoJSON = useMemo(() => assetsToPointsGeoJSON(assets), [assets]);
  const overlayLayers = useMemo(
    () =>
      (selectedEnrichment?.overlay_payload.layers ?? []).filter((layer) =>
        enabledOverlayLayerIds.includes(layer.layer_id),
      ),
    [enabledOverlayLayerIds, selectedEnrichment],
  );
  /** Layer IDs of currently-rendered enrichment overlays (for click/hover
   *  queries). Must mirror the sublayer IDs created in EnrichmentOverlayLayers
   *  exactly — anything missing here passes clicks through to the layer
   *  underneath instead of selecting the feature. */
  const enrichmentLayerIds = useMemo(() => {
    const ids: string[] = [];
    for (const layer of overlayLayers) {
      const sourceId = `enrichment-${layer.layer_id}`;
      if (layer.geometry_type === "Point") {
        ids.push(`${sourceId}-circle`);
      } else if (layer.geometry_type === "LineString") {
        ids.push(`${sourceId}-line`);
        // Chip symbols (sidewalks/crosswalks) extend past the thin line, so
        // make them selectable too; filtered to existing layers downstream.
        ids.push(`${sourceId}-chip`);
      } else if (layer.geometry_type === "GeoJSON") {
        // Heterogeneous layer renders as four stacked filtered sublayers;
        // every one of them needs to be queryable so clicking a Point
        // feature in a layer that ALSO contains polygons still selects.
        ids.push(`${sourceId}-fill`);
        ids.push(`${sourceId}-polygon-outline`);
        ids.push(`${sourceId}-line`);
        ids.push(`${sourceId}-circle`);
      } else {
        // Polygon (default branch in the renderer): fill + outline.
        ids.push(`${sourceId}-fill`);
        ids.push(`${sourceId}-line`);
      }
    }
    return ids;
  }, [overlayLayers]);

  /** Click/hover query targets for the visible user-uploaded GeoJSON layers. */
  const userGeoJsonQueryLayerIds = useMemo(
    () =>
      userGeoJsonLayers
        .filter((l) => l.visible)
        .flatMap((l) => userGeoJsonLayerIdsFor(l.id)),
    [userGeoJsonLayers],
  );

  useEffect(() => {
    setViewZoom(initialViewState.zoom);
  }, [initialViewState.zoom]);

  // Split traffic lights into a separate GeoJSON for clustering
  const trafficLightGeoJSON = useMemo(() => {
    if (!signalOverlayGeoJSON || !enabledSignalCategories.has("traffic_light")) return null;
    const src = signalOverlayGeoJSON as { type: string; features: Array<{ type: string; geometry: unknown; properties: Record<string, unknown> }> };
    if (!src.features) return null;
    const features = src.features.filter((f) => f.properties?.signal_category === "traffic_light");
    return features.length > 0 ? { type: "FeatureCollection" as const, features } : null;
  }, [signalOverlayGeoJSON, enabledSignalCategories]);

  // Wrap the selected feature's full geometry into a singleton FeatureCollection
  // so SelectedOverlayHighlight can render a circle ring (Point), line outline
  // (LineString), or polygon outline (Polygon/MultiPolygon) over it. Falls back
  // to a Point at selectedOverlayCoords when a search-derived overlay coord
  // exists without an underlying selected feature (e.g. place highlight).
  const selectedOverlayHighlightGeoJSON = useMemo(() => {
    const geom = selectedOverlayGeometry;
    if (geom && typeof geom === "object" && "type" in geom) {
      return {
        type: "FeatureCollection" as const,
        features: [{
          type: "Feature" as const,
          geometry: geom as never,
          properties: {},
        }],
      };
    }
    if (!selectedOverlayCoords) return null;
    return {
      type: "FeatureCollection" as const,
      features: [{
        type: "Feature" as const,
        geometry: { type: "Point" as const, coordinates: selectedOverlayCoords },
        properties: {},
      }],
    };
  }, [selectedOverlayCoords, selectedOverlayGeometry]);

  const selectedCandidateGeoJSON = useMemo(
    () => candidateLocationGeoJSON(candidateLocations, selectedCandidateLocationId),
    [selectedCandidateLocationId, candidateLocations],
  );

  // Scenario-candidate family layers the user has toggled on. Filtered here
  // (mirroring the enrichment-overlay pattern) so only enabled families render
  // and only their sublayers are queried for clicks/hovers.
  const enabledCandidateLayers = useMemo(
    () => candidateFamilyLayers.filter((layer) => enabledCandidateFamilyIds.includes(layer.familyId)),
    [candidateFamilyLayers, enabledCandidateFamilyIds],
  );
  /** Sublayer ids of the currently-rendered scenario-candidate layers, for
   *  click/hover queries — must mirror ScenarioCandidateLayers exactly. */
  const scenarioCandidateLayerIds = useMemo(
    () =>
      enabledCandidateLayers.flatMap((layer) => {
        const sourceId = scenarioCandidateSourceId(layer.familyId);
        return [`${sourceId}-fill`, `${sourceId}-line`];
      }),
    [enabledCandidateLayers],
  );
  /** Sublayer ids of the enabled twin-fidelity layers, for click queries —
   *  must mirror TwinFidelityLayers exactly. */
  const twinFidelityLayerIds = useMemo(
    () =>
      twinFidelityScorecard
        ? TWIN_FIDELITY_SUBLAYERS.filter((sub) =>
            enabledTwinFidelityLayerIds.includes(sub.id),
          ).map((sub) => twinFidelityLayerId(sub.id))
        : [],
    [twinFidelityScorecard, enabledTwinFidelityLayerIds],
  );
  const relatedOverlayHighlightGeoJSON = useMemo(() => {
    if (relatedOverlayCoords.length === 0) return null;
    return {
      type: "FeatureCollection" as const,
      features: relatedOverlayCoords.map((coords, index) => ({
        type: "Feature" as const,
        geometry: { type: "Point" as const, coordinates: [coords[0], coords[1]] },
        properties: { index },
      })),
    };
  }, [relatedOverlayCoords]);
  const relatedCandidateGeoJSON = useMemo(
    () => candidateLocationsGeoJSONFor(candidateLocations, relatedCandidateIds),
    [candidateLocations, relatedCandidateIds],
  );
  const selectedCandidateBounds = useMemo(
    () => candidateLocationBounds(candidateLocations, selectedCandidateLocationId),
    [selectedCandidateLocationId, candidateLocations],
  );
  const selectedBboxGeoJSON = useMemo(() => {
    if (!selectedAssetId) return null;
    const asset = assets.find((entry) => entry.map_asset_id === selectedAssetId);
    return asset ? assetToBboxGeoJSON(asset) : null;
  }, [selectedAssetId, assets]);
  const { mapRef, onMapLoad, handleResetView } = useMapViewportController({
    assets,
    allBounds,
    selectedAssetId,
    focusBounds,
    focusMaxZoom,
    selectedCandidateBounds,
    onMapReady,
    onSelectAsset,
  });
  const [placementLayerAboveRuntimeRoad, setPlacementLayerAboveRuntimeRoad] =
    useState(false);
  const syncPlacementLayerOrder = useCallback(
    (map: MapLibreMap | null = mapRef.current) => {
      const ordered = map ? elevatePlacementAnchorLayers(map) : false;
      setPlacementLayerAboveRuntimeRoad((current) =>
        current === ordered ? current : ordered,
      );
    },
    [mapRef],
  );
  const [mapLoaded, setMapLoaded] = useState(false);
  const handleMapLoad = useCallback(
    (event: { target: MapLibreMap }) => {
      onMapLoad(event);
      setMapLoaded(true);
      window.requestAnimationFrame(() =>
        window.requestAnimationFrame(() =>
          syncPlacementLayerOrder(event.target),
        ),
      );
    },
    [onMapLoad, syncPlacementLayerOrder],
  );

  // -- 2D / 3D mode --------------------------------------------------------
  // One piece of state gates both actor renderers, and they are never both on.
  // Everything else about the map — sources, tiles, GL context, viewport,
  // selection, the playhead — is untouched by a toggle.
  const storeMapViewMode = useMapViewModeStore((state) => state.mode);
  const mapViewMode = enable3DViewMode ? storeMapViewMode : "2d";
  const is3DMode = mapViewMode === "3d";
  const [map3DLoadState, setMap3DLoadState] = useState<Map3DLoadState>("idle");
  useMapViewModeCamera({
    mapRef,
    ready: mapLoaded,
    enabled: enable3DViewMode,
    interactionLocked,
  });
  // WASD flies the 3D camera. Off in 2D, where the map is a flat authoring
  // surface and a stray `d` should do nothing, and off while a drag owns the
  // pointer so the camera cannot slide out from under an actor being placed.
  useMapWasdPan({
    mapRef,
    enabled: is3DMode && mapLoaded && !interactionLocked,
  });
  // Drag-pan is ours in 3D and MapLibre's in 2D. See `useHorizonSafeDragPan`:
  // MapLibre's cursor-anchored pan is exact on a flat map and degenerate under a
  // pitched one, so the two modes get the handler each deserves.
  const horizonSafePan = is3DMode && mapLoaded && !interactionLocked;
  const publishViewportBounds = useCallback(() => {
    const map = mapRef.current;
    if (!map || !onViewportBoundsChange) return;
    const bounds = map.getBounds();
    onViewportBoundsChange({
      west: bounds.getWest(),
      south: bounds.getSouth(),
      east: bounds.getEast(),
      north: bounds.getNorth(),
    });
  }, [mapRef, onViewportBoundsChange]);
  const { panningRef } = useHorizonSafeDragPan({
    mapRef,
    enabled: horizonSafePan,
    onPanEnd: publishViewportBounds,
  });
  // Every `panBy` frame ends its own camera animation and so fires `moveend`,
  // which is what publishes these bounds — and editor consumers FETCH on them.
  // Hold them for the gesture and let `onPanEnd` publish once.
  const handleViewportBoundsChange = useCallback(
    (bounds: Parameters<NonNullable<typeof onViewportBoundsChange>>[0]) => {
      if (panningRef.current) return;
      onViewportBoundsChange?.(bounds);
    },
    [onViewportBoundsChange, panningRef],
  );
  const selected3DAsset = useMemo(
    () =>
      selectedAssetId
        ? (assets.find((entry) => entry.map_asset_id === selectedAssetId) ?? null)
        : null,
    [assets, selectedAssetId],
  );

  useEffect(() => {
    const map = mapRef.current;
    if (!placementAnchorOverlay || !map) {
      setPlacementLayerAboveRuntimeRoad(false);
      return;
    }

    let secondFrame: number | null = null;
    const firstFrame = window.requestAnimationFrame(() => {
      secondFrame = window.requestAnimationFrame(() =>
        syncPlacementLayerOrder(map),
      );
    });
    const handleIdle = () => syncPlacementLayerOrder(map);
    map.once("idle", handleIdle);
    return () => {
      window.cancelAnimationFrame(firstFrame);
      if (secondFrame != null) window.cancelAnimationFrame(secondFrame);
      map.off("idle", handleIdle);
    };
  }, [
    mapRef,
    placementAnchorOverlay,
    runtimeRoadOverlay,
    runtimeRoadOverlayShowBoundaries,
    runtimeRoadOverlayShowCenterlines,
    runtimeRoadOverlayShowSurfaces,
    showRuntimeOverlayLayers,
    syncPlacementLayerOrder,
  ]);
  const resetView = useCallback(() => {
    handleResetView();
    setClusterAssets(null);
    setClusterPosition(null);
  }, [handleResetView]);

  // External reset trigger — fire whenever the parent bumps the nonce.
  const prevResetNonceRef = useRef(resetViewNonce);
  useEffect(() => {
    if (resetViewNonce === prevResetNonceRef.current) return;
    prevResetNonceRef.current = resetViewNonce;
    resetView();
  }, [resetViewNonce, resetView]);
  const prevSelectedAssetIdRef = useRef(selectedAssetId);
  useEffect(() => {
    if (prevSelectedAssetIdRef.current === selectedAssetId) return;
    prevSelectedAssetIdRef.current = selectedAssetId;
    setClusterAssets(null);
    setClusterPosition(null);
  }, [selectedAssetId]);

  useGeoJsonFeatureState({
    mapRef,
    selectedGeoJSON,
    selectedFeatureId,
    highlightedFeatureIds,
    relatedFeatureIds: relatedHighlightedFeatureIds,
    selectedLanePolygonId,
  });

  const clearHover = useCallback(() => {
    if (clearTimeoutRef.current) {
      clearTimeout(clearTimeoutRef.current);
      clearTimeoutRef.current = null;
    }
    setHoverInfo(null);
    setTooltipPosition(null);
    setGeojsonHoverInfo(null);
  }, []);

  const scheduleClearHover = useCallback(() => {
    if (clearTimeoutRef.current) clearTimeout(clearTimeoutRef.current);
    clearTimeoutRef.current = setTimeout(clearHover, 150);
  }, [clearHover]);

  const cancelClearHover = useCallback(() => {
    if (clearTimeoutRef.current) {
      clearTimeout(clearTimeoutRef.current);
      clearTimeoutRef.current = null;
    }
  }, []);
  // Semantic authoring hit testing wins over every raw runtime lane query.
  // While it is active the runtime overlay remains display-only debug: its
  // hover/select hooks are disabled entirely rather than merely reordered.
  const semanticInteractionActive = Boolean(
    semanticOverlayGeoJSON &&
      (onSelectSemanticFeature || onHoverSemanticFeature),
  );
  const runtimeSelectionActive =
    preferRuntimeSelection && !semanticInteractionActive;
  const handleSemanticFeatureHover = useSemanticFeatureHover({
    semanticInteractionActive,
    semanticInspectionEnabled,
    onHoverSemanticFeature,
    selectableKinds: semanticSelectableKinds,
  });
  const trySelectSemanticFeature = useSemanticFeatureSelect({
    semanticInteractionActive,
    semanticInspectionEnabled,
    onSelectSemanticFeature,
    selectableKinds: semanticSelectableKinds,
  });
  const handleRuntimeLaneHover = useRuntimeLaneHover({
    preferRuntimeSelection: runtimeSelectionActive,
    onHoverRuntimeLane,
  });
  const handleGeoJsonHover = useGeoJsonHover({
    selectedGeoJSON,
    enrichmentLayerIds,
    userGeoJsonLayerIds: userGeoJsonQueryLayerIds,
    scenarioCandidateLayerIds,
    enabledSignalCategories,
    setGeojsonHoverInfo,
    setHoverInfo,
    setTooltipPosition,
  });
  const trySelectGeoJson = useGeoJsonSelection({
    selectedGeoJSON,
    enrichmentLayerIds,
    userGeoJsonLayerIds: userGeoJsonQueryLayerIds,
    scenarioCandidateLayerIds,
    twinFidelityLayerIds,
    enabledSignalCategories,
    onSelectFeature,
  });
  const trySelectRuntimeLane = useRuntimeLaneSelect({
    preferRuntimeSelection: runtimeSelectionActive,
    onSelectRuntimeLane,
  });
  const onMouseDownRuntimeActorHandler = useRuntimeActorMouseDown({
    onMouseDownRuntimeActor,
  });
  const onContextMenuRuntimeActorHandler = useRuntimeActorContextMenu({
    onContextMenuRuntimeActor,
  });
  const onMouseDownTimedPointHandler = useTimedPointMouseDown({
    onMouseDownTimedPoint,
  });
  // Authored path points sit on top of the actors they belong to, so they get
  // first refusal on the press; an unclaimed press falls through unchanged.
  const onMouseDown = useCallback(
    (evt: MapLayerMouseEvent) => {
      if (onMouseDownTimedPointHandler(evt)) return;
      onMouseDownRuntimeActorHandler(evt);
    },
    [onMouseDownRuntimeActorHandler, onMouseDownTimedPointHandler],
  );
  const tryClickTimedPathSegment = useTimedPathSegmentClick({
    onClickTimedPathSegment,
  });
  const handleAssetHover = useAssetHover({
    assetsRef,
    scheduleClearHover,
    setHoverInfo,
    setTooltipPosition,
  });
  const handleAssetClusterClick = useAssetClusterClick({
    assetsRef,
    onSelectAsset,
    onSelectFeature,
    setClusterAssets,
    setClusterPosition,
  });
  const {
    active: measureActive,
    points: measurePoints,
    cursor: measureCursor,
    toggle: toggleMeasure,
    clear: clearMeasure,
    handleMapClick: handleMeasureClick,
    handlePointerMove: handleMeasurePointerMove,
    handlePointerLeave: handleMeasurePointerLeave,
  } = useMeasureTool(enableMeasureTool);

  const onMouseMove = useCallback(
    (evt: MapLayerMouseEvent) => {
      cancelClearHover();
      onMapPointerMove?.({ lng: evt.lngLat.lng, lat: evt.lngLat.lat });
      if (measureActive) {
        // Measure mode owns the pointer: feed the rubber band and keep hover
        // tooltips out of the way of the crosshair.
        handleMeasurePointerMove({ lng: evt.lngLat.lng, lat: evt.lngLat.lat });
        clearHover();
        return;
      }
      const map = evt.target;
      const semanticHit = handleSemanticFeatureHover(evt);
      handleRuntimeLaneHover(evt);
      if (semanticHit) {
        // A semantic feature owns the hover — retire any lingering asset or
        // GeoJSON tooltip rather than leaving it frozen on screen.
        scheduleClearHover();
        return;
      }
      if (handleGeoJsonHover(evt)) return;
      handleAssetHover(map, evt);
    },
    [
      cancelClearHover,
      clearHover,
      handleAssetHover,
      handleGeoJsonHover,
      handleMeasurePointerMove,
      handleRuntimeLaneHover,
      handleSemanticFeatureHover,
      measureActive,
      onMapPointerMove,
      scheduleClearHover,
    ],
  );

  const handleZoomChange = useCallback(
    (zoom: number) => {
      setViewZoom(zoom);
      onZoomChange?.(zoom);
    },
    [onZoomChange],
  );

  const onMouseLeave = useCallback(() => {
    onMapPointerLeave?.();
    handleMeasurePointerLeave();
    onHoverRuntimeLane?.(null);
    onHoverSemanticFeature?.(null);
    scheduleClearHover();
  }, [handleMeasurePointerLeave, onHoverRuntimeLane, onHoverSemanticFeature, onMapPointerLeave, scheduleClearHover]);

  // Right-click belongs to the actor under the cursor: it opens that actor's
  // details. Right-clicking bare map does nothing at all — it used to copy the
  // coordinates under the cursor, which is a debugging affordance that fired on
  // every stray right-click and put a toast over the map to say so.
  const onContextMenu = useCallback(
    (evt: MapLayerMouseEvent) => {
      evt.preventDefault();
      onContextMenuRuntimeActorHandler(evt);
    },
    [onContextMenuRuntimeActorHandler],
  );

  const onClick = useCallback(
    async (evt: MapLayerMouseEvent) => {
      const map = evt.target;

      // While measure mode is active it owns every map click — nothing
      // underneath (signs, semantic features, lanes, clusters) may select.
      if (handleMeasureClick({ lng: evt.lngLat.lng, lat: evt.lngLat.lat })) {
        setClusterAssets(null);
        setClusterPosition(null);
        return;
      }

      // A speed-limit sign sits on the lane's thin centerline, so falling
      // through to the geometry hit-test misses it. Resolve the sign's OWN lane
      // by its __mapId and route it into the standard selection (Selected
      // Features panel + lane highlight + relation navigation).
      if (onSelectFeature && selectedGeoJSON) {
        const signLayerIds = ["speed-limit-xodr-signs", "speed-limit-overture-signs"].filter(
          (id) => map.getLayer(id),
        );
        if (signLayerIds.length > 0) {
          const hit = map.queryRenderedFeatures(evt.point, { layers: signLayerIds })[0];
          const rawId = hit?.properties?.__mapId;
          const mapId = typeof rawId === "number" ? rawId : Number(rawId);
          if (hit && Number.isFinite(mapId)) {
            const canonical = featureByMapId(selectedGeoJSON, mapId);
            if (canonical) {
              onSelectFeature([
                {
                  id: mapId,
                  summary: getFeatureSummaryLine(canonical),
                  geometryType: getGeometryType(canonical),
                  properties: featurePropertiesForPanel(canonical.properties ?? null),
                  geometry: canonical.geometry as unknown as Record<string, unknown>,
                },
              ]);
              setClusterAssets(null);
              setClusterPosition(null);
              return;
            }
          }
        }
      }

      // A traffic-light head outranks the semantic feature under it. A light
      // always stands over a road, so resolving the road first would mean the
      // light could never be clicked at all — and unlike a road, a head is a
      // small deliberate target nobody hits by accident.
      if (onClickSignalHead) {
        // THE LAMPS FIRST, in 3D. The housing hangs 5.75 m up on a mast arm, so
        // under any pitch the lights an author is looking at are far from the
        // ground beneath them — picking the ground meant aiming at the base of
        // the pole to select a light you could see six metres away. This asks
        // the renderer which head's lenses are actually under the pointer.
        const canvas = map.getCanvas();
        const lamp = pickSignalHeadAt(
          { x: evt.point.x, y: evt.point.y },
          { width: canvas.clientWidth, height: canvas.clientHeight },
        );
        if (lamp?.signalId && onClickSignalHead(lamp.signalId)) {
          setClusterAssets(null);
          setClusterPosition(null);
          return;
        }

        // Then the flat targets: the pole's ground disc in 3D (so the mast is
        // still clickable) and the clustered dots in 2D. The dots carry
        // `opendrive_id`; the 3D discs carry the same value as `signalId`.
        const signalLayerIds = [
          SIGNAL_HIT_LAYER_ID,
          "runtime-traffic-light-single",
        ].filter((id) => map.getLayer(id));
        if (signalLayerIds.length > 0) {
          const [head] = map.queryRenderedFeatures(evt.point, {
            layers: signalLayerIds,
          });
          const signalId =
            head?.properties?.signalId ?? head?.properties?.opendrive_id;
          if (
            signalId != null &&
            String(signalId).length > 0 &&
            onClickSignalHead(String(signalId))
          ) {
            setClusterAssets(null);
            setClusterPosition(null);
            return;
          }
        }
      }

      // Semantic features are the default authoring hit target: resolve them
      // before world sensors, generic map clicks, GeoJSON, and runtime lanes.
      if (trySelectSemanticFeature(evt)) {
        setClusterAssets(null);
        setClusterPosition(null);
        return;
      }

      if (runtimeSelectionActive && trySelectRuntimeLane(evt)) {
        setClusterAssets(null);
        setClusterPosition(null);
        return;
      }

      if (onClickWorldSensor) {
        const sensorLayerIds = ["world-sensor-ring"].filter((id) => map.getLayer(id));
        if (sensorLayerIds.length > 0) {
          const features = map.queryRenderedFeatures(evt.point, { layers: sensorLayerIds });
          const sensorId = features[0]?.properties?.id;
          if (typeof sensorId === "string" && sensorId.length > 0) {
            onClickWorldSensor(sensorId);
            setClusterAssets(null);
            setClusterPosition(null);
            return;
          }
        }
      }

      // An insert lands BEFORE the append: a click on an existing segment is
      // unambiguously meant for that segment, and falling through would put the
      // point at the end of the path instead of inside it.
      if (tryClickTimedPathSegment(evt)) {
        setClusterAssets(null);
        setClusterPosition(null);
        return;
      }

      // `onMapClick` AUTHORS a ground coordinate — it is how an armed placement
      // lands. `evt.lngLat` is MapLibre's unguarded unprojection, which invents a
      // point behind the camera for any pixel above the horizon, so a click on
      // sky under a near-horizon camera used to place an actor there. Re-derive
      // it, and drop the click when the pixel is not looking at ground.
      //
      // Only this branch. Feature picking below must NOT be gated on it: a tall
      // model draws above the horizon line and its roof is a fair click target.
      const groundPoint = onMapClick
        ? unprojectGroundPoint(evt.target, [evt.point.x, evt.point.y])
        : null;
      if (onMapClick && groundPoint) {
        const handled = onMapClick({
          lng: groundPoint.lng,
          lat: groundPoint.lat,
          altKey: Boolean(evt.originalEvent?.altKey),
        });
        if (handled) {
          setClusterAssets(null);
          setClusterPosition(null);
          return;
        }
      }

      if (await trySelectGeoJson(evt)) {
        setClusterAssets(null);
        setClusterPosition(null);
        return;
      }

      if (trySelectRuntimeLane(evt)) {
        setClusterAssets(null);
        setClusterPosition(null);
        return;
      }
      await handleAssetClusterClick(map, evt);
    },
    [handleAssetClusterClick, handleMeasureClick, onClickSignalHead, onClickWorldSensor, onMapClick, onSelectFeature, runtimeSelectionActive, selectedGeoJSON, tryClickTimedPathSegment, trySelectGeoJson, trySelectRuntimeLane, trySelectSemanticFeature],
  );

  const containerRef = useRef<HTMLDivElement>(null);

  function getContainerDims() {
    const el = containerRef.current;
    return { width: el?.offsetWidth ?? 400, height: el?.offsetHeight ?? 400 };
  }

  const hoverTooltipStyle = useMemo(() => {
    if (!tooltipPosition) return undefined;
    const { left, top } = computeTooltipPosition({
      position: tooltipPosition,
      container: getContainerDims(),
      tooltip: { width: 140, height: 40 },
    });
    return {
      position: "absolute" as const, left, top, zIndex: 999,
      pointerEvents: "none" as const, fontFamily: C.font,
      padding: "0.35rem 0.6rem", background: `${C.bg}f2`, color: C.fg,
      borderRadius: "6px", fontSize: "0.8125rem",
      boxShadow: "0 2px 8px rgba(0,0,0,0.5)", border: `1px solid ${C.border}`,
    };
  }, [tooltipPosition]);

  const geojsonTooltipStyle = useMemo(() => {
    if (!geojsonHoverInfo) return undefined;
    const { left, top } = computeTooltipPosition({
      position: { x: geojsonHoverInfo.x, y: geojsonHoverInfo.y },
      container: getContainerDims(),
      tooltip: { width: 200, height: 120 },
    });
    return {
      position: "absolute" as const, left, top, zIndex: 999,
      pointerEvents: "none" as const, fontFamily: C.font,
      padding: "0.4rem 0.65rem", background: `${C.bg}f2`, color: C.fg,
      borderRadius: "6px", fontSize: "0.75rem",
      boxShadow: "0 2px 8px rgba(0,0,0,0.5)", border: `1px solid ${C.border}`,
      maxWidth: 280, maxHeight: 160, overflow: "auto",
    };
  }, [geojsonHoverInfo]);

  // Only treat lanes as polygons when the sidecar actually has geometry. An
  // empty collection (e.g. a map whose XODR has no usable projection) must not
  // suppress the authored centerlines — that would leave the map with no
  // visible lanes at all.
  const hasLanePolygonFeatures = useMemo(() => {
    const features = (lanePolygonsGeoJSON as { features?: unknown[] } | null)?.features;
    return Array.isArray(features) && features.length > 0;
  }, [lanePolygonsGeoJSON]);

  // Lanes draw as filled polygons only when the user has the Filled mode on AND
  // the sidecar has geometry; otherwise we fall back to authored centerlines.
  const showFilledLanes = laneRenderMode === "filled" && hasLanePolygonFeatures;

  const clusterPopoverStyle = useMemo(() => {
    if (!clusterPosition) return undefined;
    const { left, top } = computeTooltipPosition({
      position: clusterPosition,
      container: getContainerDims(),
      tooltip: { width: 300, height: 240 },
    });
    return {
      position: "absolute" as const, left, top, zIndex: 1000,
      pointerEvents: "auto" as const, fontFamily: C.font,
      minWidth: 220, maxWidth: 300, padding: "0.75rem 1rem",
      background: `${C.bg}fa`, color: C.fg, borderRadius: "8px",
      fontSize: "0.8125rem", boxShadow: "0 4px 16px rgba(0,0,0,0.6)",
      border: `1px solid ${C.border}`,
    };
  }, [clusterPosition]);

  // In `twin` mode the editor's digital-twin canvas covers this map entirely.
  // Its basemap and measure controls would then be offering to restyle and
  // measure something nobody can see, so they come off; the view-mode toggle
  // stays, because it is the way back out.
  return (
    <MapAssetsMapView
      basemapId={basemapId}
      basemapLayerVisibility={basemapLayerVisibility}
      satelliteImagery={satelliteEnabled ? availableSatelliteImagery : null}
      showSatelliteToggle={hasSatelliteImagery && mapViewMode !== "twin"}
      satelliteEnabled={satelliteEnabled}
      onSatelliteToggle={setSatelliteEnabled}
      showMeasureTool={enableMeasureTool && mapViewMode !== "twin"}
      measureActive={measureActive}
      onToggleMeasure={toggleMeasure}
      showViewModeToggle={enable3DViewMode}
      viewModeLoading={is3DMode && map3DLoadState === "loading"}
      antialias={enable3DViewMode}
      containerRef={containerRef}
      dimNonCandidateLayers={dimNonCandidateLayers}
      initialViewState={initialViewState}
      minZoom={minZoom}
      maxZoom={maxZoom}
      interactionLocked={interactionLocked}
      onMapLoad={handleMapLoad}
      onMouseDown={onMouseDown}
      onMouseMove={onMouseMove}
      onMouseLeave={onMouseLeave}
      onClick={onClick}
      onContextMenu={onContextMenu}
      onZoomChange={handleZoomChange}
      onUserViewportChange={onUserViewportChange}
      onViewportBoundsChange={handleViewportBoundsChange}
      horizonSafePan={horizonSafePan}
      onLockedPointerPosition={(point) => {
        if (point) {
          onMapPointerMove?.({ lng: point.lng, lat: point.lat });
          const syntheticEvent = {
            target: point.map,
            point: { x: point.x, y: point.y },
            lngLat: { lng: point.lng, lat: point.lat },
          } as MapLayerMouseEvent;
          handleSemanticFeatureHover(syntheticEvent);
          handleRuntimeLaneHover(syntheticEvent);
        } else {
          onMapPointerLeave?.();
          onHoverSemanticFeature?.(null);
          onHoverRuntimeLane?.(null);
        }
      }}
      cursor={
        measureActive
          ? "crosshair"
          : hoverInfo != null ||
              geojsonHoverInfo != null ||
              hoveredSemanticFeatureKey != null
            ? "pointer"
            : "grab"
      }
      selectedAssetId={selectedAssetId}
      assetsLength={assets.length}
      geojsonLoading={geojsonLoading}
      onResetView={resetView}
      onMapError={onMapError}
      placementLayerAboveRuntimeRoad={placementLayerAboveRuntimeRoad}
      enableSnapshotCapture={enableSnapshotCapture}
      snapshotFocusPoints={
        enableSnapshotCapture
          ? (runtimeActorOverlay ?? []).map((actor) => ({
              longitude: actor.longitude,
              latitude: actor.latitude,
            }))
          : []
      }
      hoverInfo={hoverInfo}
      hoverTooltipStyle={hoverTooltipStyle}
      geojsonHoverInfo={geojsonHoverInfo}
      geojsonTooltipStyle={geojsonTooltipStyle}
      clusterAssets={clusterAssets}
      clusterPosition={clusterPosition}
      clusterPopoverStyle={clusterPopoverStyle}
      onSelectAsset={onSelectAsset}
      onCloseClusterPopover={() => {
        setClusterAssets(null);
        setClusterPosition(null);
      }}
    >
        <AssetPolygonLayers
          data={polygonGeoJSON}
          selectedAssetId={selectedAssetId ?? null}
          hasSelectedGeoJSON={!!selectedGeoJSON}
        />

        {selectedAssetId && selectedBboxGeoJSON && !selectedGeoJSON && geojsonLoading && (
          <SelectedBboxLayers data={selectedBboxGeoJSON} geojsonLoading={geojsonLoading} />
        )}

        {/* Exact CARLA runtime geometry is the continuous physical shell.
            It renders below GeoJSON context and semantic meaning, and never
            participates in hit testing. */}
        {runtimeGeometryShell && (
          <RuntimeGeometryShellLayers data={runtimeGeometryShell} />
        )}

        {/* Filled lane areas (from XODR widths) render beneath the authored
            road-network layers so direction arrows / chips / selection
            highlights still draw on top. */}
        {showFilledLanes && lanePolygonsGeoJSON && (
          <LanePolygonLayers
            data={lanePolygonsGeoJSON}
            enabledFeatureTypeIds={enabledFeatureTypeIds}
            styleOverrides={featureTypeStyleOverrides}
            visible={showAuthoredLayers}
          />
        )}

        {selectedAssetId && selectedGeoJSON && (
          <GeoJsonFeatureLayers
            data={selectedGeoJSON}
            enabledFeatureTypeIds={enabledFeatureTypeIds}
            showLineChips={showLaneChips}
            styleOverrides={featureTypeStyleOverrides}
            visible={showAuthoredLayers}
            renderLanesAsPolygons={showFilledLanes}
          />
        )}

        <EnrichmentOverlayLayers
          layers={overlayLayers}
          showLineChips={showLaneChips}
          styleOverrides={overlayStyleOverrides}
          visible={showAuthoredLayers}
        />

        {userGeoJsonLayers.length > 0 && (
          <UserGeoJsonLayers layers={userGeoJsonLayers} />
        )}

        {enabledSignalCategories.size > 0 && signalOverlayGeoJSON && (
          <SignalOverlayLayers
            data={signalOverlayGeoJSON}
            enabledSignalCategories={enabledSignalCategories}
            showLineChips={showLaneChips}
            styleOverrides={signalStyleOverrides}
            visible={showAuthoredLayers}
          />
        )}

        {speedLimitOverlayGeoJSON &&
          (speedLimitOverlayGeoJSON as { features?: unknown[] }).features?.length ? (
          <SpeedLimitLayers
            data={speedLimitOverlayGeoJSON}
            idPrefix="speed-limit-overture"
            iconId={SPEED_SIGN_OVERTURE_ICON}
            visible={showAuthoredLayers}
          />
        ) : null}

        {inHouseSpeedLimitOverlayGeoJSON &&
          (inHouseSpeedLimitOverlayGeoJSON as { features?: unknown[] }).features?.length ? (
          <SpeedLimitLayers
            data={inHouseSpeedLimitOverlayGeoJSON}
            idPrefix="speed-limit-xodr"
            iconId={SPEED_SIGN_XODR_ICON}
            visible={showAuthoredLayers}
          />
        ) : null}

        {trafficLightGeoJSON && (
          <TrafficLightLayers
            data={trafficLightGeoJSON}
            styleOverride={signalStyleOverrides.traffic_light}
            visible={showAuthoredLayers}
          />
        )}

        {runtimeTrafficLightGeoJSON && (
          <TrafficLightLayers
            data={runtimeTrafficLightGeoJSON}
            sourceId="runtime-traffic-lights"
            layerPrefix="runtime-traffic-light"
            styleOverride={
              highlightRuntimeTrafficLights
                ? TRAFFIC_LIGHT_HIGHLIGHT_STYLE
                : signalStyleOverrides.traffic_light
            }
            /* The clustered dots are 2D mode's traffic-light rendering. In 3D
               they are replaced by physical heads, not layered under them.

               Visible whenever the map HAS lights, rather than only under the
               runtime-lane overlay or a traffic-light focus mode. A light is now
               a thing you click to time its whole intersection, and a control
               you cannot see is a control you cannot use: before this, an
               ordinary 2D session on a map with 103 lights drew none of them and
               the click had nothing to land on. Focus modes still EMPHASISE
               them, which is the job that flag should have had all along. */
            visible={!is3DMode}
            emphasized={highlightRuntimeTrafficLights}
          />
        )}

        {worldSensorGeoJSON && (
          <WorldSensorLayers
            data={worldSensorGeoJSON}
            visible={showRuntimeOverlayLayers || showAuthoredLayers || showCameraLabels}
            showLabels={showCameraLabels}
            markerScale={markerScale}
            markerSizingMode={markerSizingMode}
            mapZoom={viewZoom}
            labelScale={labelScale}
          />
        )}

        <JunctionSignalGlyphLayer
          mapZoom={viewZoom}
          markerScale={markerScale}
          visible={showIntersectionControls}
        />

        {/* Above the persistent markers in DOM order, so an armed candidate's
            fan is what a click lands on. */}
        <IntersectionCandidateLayer
          compact={is3DMode}
          mapZoom={viewZoom}
          markerScale={markerScale}
          visible={showIntersectionControls}
        />

        {relatedCandidateGeoJSON && (
          <RelatedCandidateLocationLayers data={relatedCandidateGeoJSON} />
        )}

        {relatedOverlayHighlightGeoJSON && (
          <RelatedOverlayHighlights data={relatedOverlayHighlightGeoJSON} />
        )}

        {proximityArrows && <ProximityArrowLayers data={proximityArrows} />}

        {topologyPaths && <TopologyPathLayers data={topologyPaths} />}

        {selectedOverlayHighlightGeoJSON && (
          <SelectedOverlayHighlight data={selectedOverlayHighlightGeoJSON} />
        )}

        {enabledCandidateLayers.length > 0 && (
          <ScenarioCandidateLayers
            layers={enabledCandidateLayers}
            visible={showAuthoredLayers}
          />
        )}

        {twinFidelityScorecard && (
          <TwinFidelityLayers
            scorecard={twinFidelityScorecard}
            enabledLayerIds={enabledTwinFidelityLayerIds}
            visible={showAuthoredLayers}
          />
        )}

        {selectedCandidateGeoJSON && (
          <CandidateLocationLayers data={selectedCandidateGeoJSON} />
        )}

        {runtimeRoadOverlay && (
          <RuntimeRoadOverlayLayers
            data={runtimeRoadOverlay}
            enabledLaneTypeIds={enabledRuntimeLaneTypeIds}
            highlightedRoadIds={highlightedRuntimeRoadIds}
            selectedRuntimeLane={selectedRuntimeLane}
            hoveredRuntimeLane={hoveredRuntimeLane}
            showCenterlines={runtimeRoadOverlayShowCenterlines}
            showBoundaries={runtimeRoadOverlayShowBoundaries}
            showSurfaces={runtimeRoadOverlayShowSurfaces}
            styleOverrides={runtimeLaneStyleOverrides}
            visible={showRuntimeOverlayLayers}
          />
        )}

        {/* Semantic authoring surface renders above the raw runtime overlay so
            corridor ribbons/movements/conflicts always sit on top of debug
            lane geometry. */}
        {semanticOverlayGeoJSON && (
          <SemanticOverlayLayers
            data={semanticOverlayGeoJSON}
            visibility={semanticLayersVisible}
            selectedFeatureKey={selectedSemanticFeatureKey}
            hoveredFeatureKey={hoveredSemanticFeatureKey}
            inspectionEnabled={semanticInspectionEnabled}
          />
        )}

        {semanticSiteQueryGeoJSON && (
          <SemanticSiteQueryLayers data={semanticSiteQueryGeoJSON} />
        )}

        {semanticScenarioProofGeoJSON && (
          <SemanticScenarioProofLayers data={semanticScenarioProofGeoJSON} />
        )}

        {pathEditingActive && (
          <MapLayer
            id="path-editing-dim-overlay"
            type="background"
            paint={{
              "background-color": "#000000",
              "background-opacity": 0.4,
            }}
          />
        )}

        {/* Under everything authored: it is the lane's continuation, not content. */}
        {derivedRunwayOverlay && (
          <DerivedRunwayLayers data={derivedRunwayOverlay} />
        )}

        {placementAnchorOverlay && (
          <PlacementAnchorLayers data={placementAnchorOverlay} />
        )}

        {actorTrajectoryOverlay && (
          <ActorTrajectoryLayers data={actorTrajectoryOverlay} />
        )}

        {behaviorTriggerOverlay && (
          <BehaviorTriggerLayers data={behaviorTriggerOverlay} />
        )}

        {esminiTrajectoryOverlay && (
          <EsminiTrajectoryLayers data={esminiTrajectoryOverlay} />
        )}


        {timedPointHighlightOverlay && (
          <TimedPointHighlightLayers data={timedPointHighlightOverlay} />
        )}

        {scheduleLagOverlay && <ScheduleLagLayers data={scheduleLagOverlay} />}

        {placementBandOverlay && <PlacementBandLayers data={placementBandOverlay} />}

        {actorSpawnOverlay && actorSpawnOverlay.length > 0 && (
          <ActorSpawnLayer spawns={actorSpawnOverlay} />
        )}

        <CollisionPointMarker overlay={collisionPointOverlay} />

        {/* The two actor renderers are never both on. `mapViewMode` gates each
            and that is the whole mechanism — no zoom crossover, no cross-fade,
            and therefore no window in which two position pipelines, two
            hit-testing paths and two heading conventions are live at once. */}
        {runtimeActorOverlay && runtimeActorOverlay.length > 0 && !is3DMode && (
          <RuntimeActorLayers
            actors={runtimeActorOverlay}
            markerScale={markerScale}
            markerSizingMode={markerSizingMode}
            mapZoom={viewZoom}
            labelScale={labelScale}
            interactionMode={runtimeActorInteractionMode}
            onMouseDownActor={onMouseDownRuntimeActor}
            onContextMenuActor={onContextMenuRuntimeActor}
          />
        )}

        {is3DMode && (
          <Map3DLayer
            actors={runtimeActorOverlay ?? []}
            asset={selected3DAsset}
            mapZoom={viewZoom}
            selectedWorldSensorId={selectedWorldSensorId}
            worldSensors={worldSensors3D}
            onLoadStateChange={setMap3DLoadState}
          />
        )}

        {searchResultMarkers.length > 0 && (
          <SearchResultMarkersLayer
            markers={searchResultMarkers}
            hoveredId={hoveredSearchResultId}
            selectedId={selectedSearchResultId}
            onSelect={onSelectSearchResult}
          />
        )}

        <AssetClusterLayers data={pointsGeoJSON} selectedAssetId={selectedAssetId ?? null} />

        {/* Measure overlay renders last so the segment and distance pill sit
            above every data layer. */}
        {measurePoints.length > 0 && (
          <MeasureDistanceLayers
            points={measurePoints}
            cursor={measureCursor}
            onClear={clearMeasure}
          />
        )}
    </MapAssetsMapView>
  );
}
