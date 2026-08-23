import { create } from "zustand";
import type { MapLocation, RuntimeLaneSelection } from "@/app/lib/editor-map/types";
import type { CameraPlacementMode } from "@/app/lib/scenario-editor/types";

interface SelectionState {
  selectedActorId: string | null;
  selectedWorldSensorId: string | null;
  placementToolId: string | null;
  cameraPlacementMode: CameraPlacementMode | null;
  /**
   * Armed: the next click on an intersection candidate creates its control.
   *
   * ONE state, not two. `Add Cameras` splits arming across `addCameraModeActive`
   * and `cameraPlacementMode`, so the toolbar button alone places nothing and
   * the author has to find a palette in the sidebar to finish arming. There is
   * only one kind of intersection control, so the button IS the arm.
   */
  intersectionControlPlacementActive: boolean;
  timedPathPlacementActorId: string | null;
  staticDistributionActorId: string | null;
  selectedResult: MapLocation | null;
  selectedRuntimeLane: RuntimeLaneSelection | null;
  selectedRoadIds: string[];
  highlightedFeatureIds: number[];
  setSelectedActorId: (
    id: string | null | ((current: string | null) => string | null),
  ) => void;
  setSelectedWorldSensorId: (id: string | null) => void;
  setPlacementToolId: (id: string | null) => void;
  setCameraPlacementMode: (mode: CameraPlacementMode | null) => void;
  setIntersectionControlPlacement: (active: boolean) => void;
  setTimedPathPlacementActorId: (id: string | null) => void;
  setStaticDistributionActorId: (id: string | null) => void;
  setSelectedResult: (result: MapLocation | null) => void;
  setSelectedRuntimeLane: (lane: RuntimeLaneSelection | null) => void;
  setSelectedRoadIds: (roadIds: string[]) => void;
  addSelectedRoads: (roadIds: string[]) => void;
  removeSelectedRoads: (roadIds: string[]) => void;
  clearSelectedRoads: () => void;
  setHighlightedFeatureIds: (ids: number[]) => void;
}

export const useSelectionStore = create<SelectionState>()((set) => ({
  selectedActorId: null,
  selectedWorldSensorId: null,
  placementToolId: null,
  cameraPlacementMode: null,
  intersectionControlPlacementActive: false,
  timedPathPlacementActorId: null,
  staticDistributionActorId: null,
  selectedResult: null,
  selectedRuntimeLane: null,
  selectedRoadIds: [],
  highlightedFeatureIds: [],
  setSelectedActorId: (idOrFn) =>
    set((state) => ({
      selectedActorId:
        typeof idOrFn === "function" ? idOrFn(state.selectedActorId) : idOrFn,
    })),
  setSelectedWorldSensorId: (id) => set({ selectedWorldSensorId: id }),
  setPlacementToolId: (id) => set({ placementToolId: id }),
  setCameraPlacementMode: (mode) => set({ cameraPlacementMode: mode }),
  // Arming an intersection control clears every other placement intent: two
  // armed tools mean an ambiguous next click, and the map cue for one of them
  // is a lie.
  setIntersectionControlPlacement: (active) =>
    set(
      active
        ? {
            intersectionControlPlacementActive: true,
            cameraPlacementMode: null,
            placementToolId: null,
            timedPathPlacementActorId: null,
            staticDistributionActorId: null,
          }
        : { intersectionControlPlacementActive: false },
    ),
  setTimedPathPlacementActorId: (id) =>
    set({ timedPathPlacementActorId: id }),
  setStaticDistributionActorId: (id) =>
    set({ staticDistributionActorId: id }),
  setSelectedResult: (result) => set({ selectedResult: result }),
  setSelectedRuntimeLane: (lane) => set({ selectedRuntimeLane: lane }),
  setSelectedRoadIds: (roadIds) => set({ selectedRoadIds: [...new Set(roadIds)] }),
  addSelectedRoads: (roadIds) =>
    set((state) => ({
      selectedRoadIds: [...new Set([...state.selectedRoadIds, ...roadIds])],
    })),
  removeSelectedRoads: (roadIds) =>
    set((state) => ({
      selectedRoadIds: state.selectedRoadIds.filter((roadId) => !roadIds.includes(roadId)),
    })),
  clearSelectedRoads: () => set({ selectedRoadIds: [] }),
  setHighlightedFeatureIds: (ids) => set({ highlightedFeatureIds: ids }),
}));
