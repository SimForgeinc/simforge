import { create } from "zustand";
import type { CarlaSessionStatus } from "@/app/lib/runtime/runtime-types";
import {
  BUILDINGS_ONLY_BASEMAP_LAYER_VISIBILITY,
  type BasemapLayerGroupId,
  type BasemapLayerVisibility,
} from "@/app/lib/maps/frontend/basemap-visibility";
import {
  DEFAULT_RUNTIME_LANE_TYPE_VISIBILITY,
  type RuntimeLaneTypeId,
  type RuntimeLaneTypeVisibility,
} from "@/app/lib/editor-map/runtime-layer-visibility";
import type { MapBundleResponse } from "@/app/lib/scenario-editor/types";
import type { RuntimeAssistMode } from "@/app/lib/scenario-editor/map-presentation-policy";
import type { MapMarkerSizingMode } from "@/app/lib/maps/frontend/map-marker-sizing";

interface SceneState {
  bundle: MapBundleResponse | null;
  bundleLoading: boolean;
  bundleError: string | null;
  runtimeStatus: CarlaSessionStatus | null;
  runtimeLoading: boolean;
  showAuthoredMapLayers: boolean;
  /**
   * Placed intersection markers and armed candidate fans. Its own switch: a
   * placed control is authored content, and it used to ride on the runtime and
   * authored flags, so hiding the road overlay silently hid it too.
   */
  showIntersectionControls: boolean;
  runtimeAssistMode: RuntimeAssistMode;
  showRuntimeLaneCenterlines: boolean;
  showRuntimeLaneMarkings: boolean;
  showRuntimeLaneSurfaces: boolean;
  runtimeLaneTypeVisibility: RuntimeLaneTypeVisibility;
  basemapLayerVisibility: BasemapLayerVisibility;
  authoredGeoJsonOffsetMeters: { x: number; y: number };
  markerScale: number;
  markerSizingMode: MapMarkerSizingMode;
  labelScale: number;
  setMarkerScale: (scale: number) => void;
  setMarkerSizingMode: (mode: MapMarkerSizingMode) => void;
  setLabelScale: (scale: number) => void;
  setBundle: (bundle: MapBundleResponse | null) => void;
  setBundleLoading: (loading: boolean) => void;
  setBundleError: (error: string | null) => void;
  setRuntimeStatus: (status: CarlaSessionStatus | null) => void;
  setRuntimeLoading: (loading: boolean) => void;
  setShowAuthoredMapLayers: (
    show: boolean | ((current: boolean) => boolean),
  ) => void;
  setShowIntersectionControls: (
    show: boolean | ((current: boolean) => boolean),
  ) => void;
  setRuntimeAssistMode: (
    mode:
      | RuntimeAssistMode
      | ((current: RuntimeAssistMode) => RuntimeAssistMode),
  ) => void;
  setShowRuntimeLaneCenterlines: (show: boolean | ((current: boolean) => boolean)) => void;
  setShowRuntimeLaneMarkings: (show: boolean | ((current: boolean) => boolean)) => void;
  setShowRuntimeLaneSurfaces: (show: boolean | ((current: boolean) => boolean)) => void;
  setRuntimeLaneTypeVisibility: (
    visibility:
      | RuntimeLaneTypeVisibility
      | ((current: RuntimeLaneTypeVisibility) => RuntimeLaneTypeVisibility)
  ) => void;
  toggleRuntimeLaneType: (laneTypeId: RuntimeLaneTypeId) => void;
  setBasemapLayerVisibility: (
    visibility:
      | BasemapLayerVisibility
      | ((current: BasemapLayerVisibility) => BasemapLayerVisibility)
  ) => void;
  setAuthoredGeoJsonOffsetMeters: (
    offset:
      | { x: number; y: number }
      | ((current: { x: number; y: number }) => { x: number; y: number }),
  ) => void;
  toggleBasemapLayerGroup: (groupId: BasemapLayerGroupId) => void;
}

export const useSceneStore = create<SceneState>()((set) => ({
  bundle: null,
  bundleLoading: false,
  bundleError: null,
  runtimeStatus: null,
  runtimeLoading: false,
  // The authored GeoJSON is the operator-facing road map. Semantic placement
  // layers are opt-in/interaction-scoped and must not replace it in browse
  // mode.
  showAuthoredMapLayers: true,
  showIntersectionControls: true,
  runtimeAssistMode: "auto",
  showRuntimeLaneCenterlines: true,
  showRuntimeLaneMarkings: false,
  showRuntimeLaneSurfaces: false,
  runtimeLaneTypeVisibility: DEFAULT_RUNTIME_LANE_TYPE_VISIBILITY,
  basemapLayerVisibility: BUILDINGS_ONLY_BASEMAP_LAYER_VISIBILITY,
  authoredGeoJsonOffsetMeters: { x: 0, y: 5 },
  markerScale: 1,
  markerSizingMode: "screen",
  labelScale: 1,
  setMarkerScale: (scale) => set({ markerScale: scale }),
  setMarkerSizingMode: (mode) => set({ markerSizingMode: mode }),
  setLabelScale: (scale) => set({ labelScale: scale }),
  setBundle: (bundle) => set({ bundle }),
  setBundleLoading: (loading) => set({ bundleLoading: loading }),
  setBundleError: (error) => set({ bundleError: error }),
  setRuntimeStatus: (status) => set({ runtimeStatus: status }),
  setRuntimeLoading: (loading) => set({ runtimeLoading: loading }),
  setShowAuthoredMapLayers: (showOrFn) =>
    set((state) => ({
      showAuthoredMapLayers:
        typeof showOrFn === "function"
          ? showOrFn(state.showAuthoredMapLayers)
          : showOrFn,
    })),
  setShowIntersectionControls: (showOrFn) =>
    set((state) => ({
      showIntersectionControls:
        typeof showOrFn === "function"
          ? showOrFn(state.showIntersectionControls)
          : showOrFn,
    })),
  setRuntimeAssistMode: (modeOrFn) =>
    set((state) => ({
      runtimeAssistMode:
        typeof modeOrFn === "function"
          ? modeOrFn(state.runtimeAssistMode)
          : modeOrFn,
    })),
  setShowRuntimeLaneCenterlines: (showOrFn) =>
    set((state) => ({
      showRuntimeLaneCenterlines:
        typeof showOrFn === "function"
          ? showOrFn(state.showRuntimeLaneCenterlines)
          : showOrFn,
    })),
  setShowRuntimeLaneMarkings: (showOrFn) =>
    set((state) => ({
      showRuntimeLaneMarkings:
        typeof showOrFn === "function"
          ? showOrFn(state.showRuntimeLaneMarkings)
          : showOrFn,
    })),
  setShowRuntimeLaneSurfaces: (showOrFn) =>
    set((state) => ({
      showRuntimeLaneSurfaces:
        typeof showOrFn === "function"
          ? showOrFn(state.showRuntimeLaneSurfaces)
          : showOrFn,
    })),
  setRuntimeLaneTypeVisibility: (visibilityOrFn) =>
    set((state) => ({
      runtimeLaneTypeVisibility:
        typeof visibilityOrFn === "function"
          ? visibilityOrFn(state.runtimeLaneTypeVisibility)
          : visibilityOrFn,
    })),
  toggleRuntimeLaneType: (laneTypeId) =>
    set((state) => ({
      runtimeLaneTypeVisibility: {
        ...state.runtimeLaneTypeVisibility,
        [laneTypeId]: !state.runtimeLaneTypeVisibility[laneTypeId],
      },
    })),
  setBasemapLayerVisibility: (visibilityOrFn) =>
    set((state) => ({
      basemapLayerVisibility:
        typeof visibilityOrFn === "function"
          ? visibilityOrFn(state.basemapLayerVisibility)
          : visibilityOrFn,
    })),
  setAuthoredGeoJsonOffsetMeters: (offsetOrFn) =>
    set((state) => ({
      authoredGeoJsonOffsetMeters:
        typeof offsetOrFn === "function"
          ? offsetOrFn(state.authoredGeoJsonOffsetMeters)
          : offsetOrFn,
    })),
  toggleBasemapLayerGroup: (groupId) =>
    set((state) => ({
      basemapLayerVisibility: {
        ...state.basemapLayerVisibility,
        [groupId]: !state.basemapLayerVisibility[groupId],
      },
    })),
}));
